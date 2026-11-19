import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_THRESHOLD,
  dismiss,
  type Issue,
  type IssueDetail,
  KINDS,
  list,
  MARKETPLACE_REPO,
  record,
  type RecordInput,
  show,
  type Suggestion,
  suggest,
  UsageError,
} from './advisor.ts';
import { fileIssue, type FileResult } from './file.ts';
import { handleHookInput } from './hook.ts';
import { type Env, marketplacePlugins, ownRoot, reservedNames } from './plugins.ts';
import { identityOf, osIdentity, type SystemIdentity } from './redact.ts';
import { Store } from './store.ts';

export const CLI_NAME = 'factory-plugin-advisor';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads all of stdin (record --stdin, hook). */
  stdin?: () => string;
  env?: Env;
  now?: () => Date;
  /** This plugin's folder, used to find the marketplace manifest. */
  pluginRoot?: string;
  /** The OS's view of the current user (home, username), masked with `env`'s; defaults to node:os. */
  system?: SystemIdentity;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Tracks recurring friction with the software-factory marketplace plugins in a local, redacted log
and drafts a suggested plugin change once an issue recurs.

Commands:
  record --plugin <name> --kind <kind> --summary <text> [--detail <text>]
  record --stdin             Record one occurrence; --stdin reads {"plugin","kind","summary","detail"}
                             as JSON. <name> is a marketplace plugin, a proposed new plugin name, or
                             'none'. <kind> is one of: ${Object.keys(KINDS).join(', ')}.
  list [--min <n>] [--plugin <name>]
                             Issues grouped by signature, with count, first and last seen
  show <signature>           One issue with all its (redacted) occurrences; a unique prefix of 4+
                             characters works too
  suggest [--threshold <n>]  Write a draft for every issue seen at least <n> times (default
                             ${DEFAULT_THRESHOLD}) that has not been suggested, or has grown by <n> since
  dismiss <signature>        Never suggest this issue again
  file <signature> [--repo <owner/name>] [--confirm]
                             Open the draft as a GitHub issue on ${MARKETPLACE_REPO} (public)
                             with gh. Without --confirm, only prints what would be filed.
  hook                       Read a Claude Code PostToolUseFailure hook input on stdin and record a
                             failed marketplace CLI call (used by hooks/hooks.json; prints nothing).
                             A factory exit 2 (escalated to a human) is not a failure.

Options:
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

The log lives in $FACTORY_PLUGIN_ADVISOR_CONFIG_DIR, else $XDG_CONFIG_HOME/factory-plugin-advisor,
else ~/.config/factory-plugin-advisor (owner-only), never inside a git checkout.

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

/** Options each command accepts (besides --json, --help and --version). */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  record: ['plugin', 'kind', 'summary', 'detail', 'stdin'],
  list: ['min', 'plugin'],
  show: [],
  suggest: ['threshold'],
  dismiss: [],
  file: ['repo', 'confirm'],
  hook: [],
};
const POSITIONALS: Record<string, number> = { record: 0, list: 0, show: 1, suggest: 0, dismiss: 1, file: 1, hook: 0 };

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new UsageError(`--${name} must be a whole number from 1 to 999999, got ${JSON.stringify(value)}`);
  return Number(value);
}

function stdinRecord(text: string): RecordInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('--stdin expects one JSON object: {"plugin","kind","summary","detail"}');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UsageError('--stdin expects a JSON object');
  const o = parsed as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!['plugin', 'kind', 'summary', 'detail'].includes(key)) throw new UsageError(`--stdin: unknown field '${key}'`);
  }
  for (const key of ['plugin', 'kind', 'summary']) {
    if (typeof o[key] !== 'string') throw new UsageError(`--stdin: "${key}" must be a string`);
  }
  if (o.detail !== undefined && typeof o.detail !== 'string') throw new UsageError('--stdin: "detail" must be a string');
  return { plugin: o.plugin as string, kind: o.kind as string, summary: o.summary as string, ...(o.detail === undefined ? {} : { detail: o.detail as string }) };
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function issueLine(i: Issue): string {
  return `${i.signature}  ${String(i.count).padStart(3)}x  ${i.plugin}  ${i.kind}  ${day(i.firstSeen)}..${day(i.lastSeen)}  ${i.status}  ${i.summary}`;
}

function showText(d: IssueDetail): string {
  const lines = [
    `${d.signature}: ${d.summary}`,
    `  plugin ${d.plugin}, kind ${d.kind}, seen ${d.count} times (${d.firstSeen} to ${d.lastSeen}), ${d.status}${d.issueUrl === undefined ? '' : ` as ${d.issueUrl}`}`,
    ...(d.draft === undefined ? [] : [`  draft: ${d.draft}`]),
    'Occurrences:',
  ];
  for (const o of d.occurrences) {
    const extra = [o.subcommand === undefined ? '' : `command ${o.subcommand}`, o.exitCode === undefined ? '' : `exit ${o.exitCode}`, o.source === 'hook' ? 'hook' : '']
      .filter((x) => x !== '')
      .join(', ');
    lines.push(`  ${o.at}  ${o.summary}${extra === '' ? '' : ` (${extra})`}`);
    if (o.detail !== undefined) for (const l of o.detail.split('\n')) lines.push(`      ${l}`);
  }
  return `${lines.join('\n')}\n`;
}

function suggestText(threshold: number, out: Suggestion[]): string {
  if (out.length === 0) return `No new suggestions: nothing has crossed the threshold (${threshold}) since it was last suggested.\n`;
  return out
    .map((s) => `${s.signature}  ${s.count}x  ${s.target.kind === 'existing' ? s.plugin : `new plugin (${s.plugin})`}: ${s.summary}\n  draft: ${s.draft}\n  ${s.factoryRun}\n`)
    .join('');
}

function fileText(r: FileResult): string {
  if (r.filed) return `Filed ${r.url ?? ''}\n`;
  return [
    'Dry run: nothing was filed.',
    `Repository: ${r.repo}${r.knownPublic ? ' (public: anyone can read what is filed)' : ' (check whether it is public)'}`,
    `Title: ${r.title}`,
    'Body:',
    r.body.trimEnd(),
    '',
    'Run file again with --confirm to file exactly this.',
    '',
  ].join('\n');
}

export function run(argv: readonly string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
        plugin: { type: 'string' },
        kind: { type: 'string' },
        summary: { type: 'string' },
        detail: { type: 'string' },
        stdin: { type: 'boolean' },
        min: { type: 'string' },
        threshold: { type: 'string' },
        repo: { type: 'string' },
        confirm: { type: 'boolean' },
      },
    });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (values.version) {
    io.stdout(`${version()}\n`);
    return EXIT.ok;
  }

  const env = io.env ?? process.env;
  const now = (): Date => (io.now ?? (() => new Date()))();
  const pluginRoot = io.pluginRoot ?? ownRoot();
  // The only place the OS identity is read; a username that names a plugin, bin or factory command
  // is not masked as a word.
  const identity = identityOf(env, io.system ?? osIdentity(), reservedNames(marketplacePlugins(pluginRoot, env)));
  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) return usageError(io, `unknown command '${command}'`);
  for (const [key, value] of Object.entries(values)) {
    if (['json', 'help', 'version'].includes(key) || value === undefined) continue;
    if (!allowed.includes(key)) return usageError(io, `${command} does not take --${key}`);
  }
  const wanted = POSITIONALS[command] ?? 0;
  if (rest.length !== wanted) {
    return usageError(io, wanted === 0 ? `${command} takes no arguments, got ${rest.length}` : `${command} takes exactly one <signature>, got ${rest.length}`);
  }
  const out = (json: unknown, text: string): number => {
    io.stdout(values.json ? `${JSON.stringify(json)}\n` : text);
    return EXIT.ok;
  };

  if (command === 'hook') {
    // Never fails and never prints: see hook.ts.
    try {
      handleHookInput(io.stdin?.() ?? '', env, pluginRoot, now(), identity);
    } catch {
      // nothing recorded
    }
    return EXIT.ok;
  }

  try {
    const store = new Store(env);
    switch (command) {
      case 'record': {
        let input: RecordInput;
        if (values.stdin === true) {
          if (values.plugin !== undefined || values.kind !== undefined || values.summary !== undefined || values.detail !== undefined) {
            throw new UsageError('record takes either --stdin or --plugin/--kind/--summary/--detail, not both');
          }
          input = stdinRecord(io.stdin?.() ?? '');
        } else {
          if (values.plugin === undefined || values.kind === undefined || values.summary === undefined) {
            throw new UsageError('record needs --plugin, --kind and --summary (or --stdin)');
          }
          input = { plugin: values.plugin, kind: values.kind, summary: values.summary, ...(values.detail === undefined ? {} : { detail: values.detail }) };
        }
        const r = record(store, input, now(), 'record', identity);
        return out(r, `Recorded ${r.signature} (${r.plugin}, ${r.kind}): seen ${r.count} time${r.count === 1 ? '' : 's'}.${r.redacted ? ' Secret-looking text was redacted.' : ''}\n`);
      }
      case 'list': {
        const min = positiveInt('min', values.min, 1);
        const issues = list(store, { min, ...(values.plugin === undefined ? {} : { plugin: values.plugin }) });
        return out({ issues }, issues.length === 0 ? 'No issues recorded.\n' : `${issues.map(issueLine).join('\n')}\n`);
      }
      case 'show': {
        const d = show(store, rest[0] ?? '');
        return out(d, showText(d));
      }
      case 'suggest': {
        const threshold = positiveInt('threshold', values.threshold, DEFAULT_THRESHOLD);
        const s = suggest(store, threshold, marketplacePlugins(pluginRoot, env).plugins, now(), identity);
        return out({ threshold, suggestions: s }, suggestText(threshold, s));
      }
      case 'dismiss': {
        const i = dismiss(store, rest[0] ?? '', now());
        return out({ signature: i.signature, dismissed: true }, `Dismissed ${i.signature}; it will not be suggested again.\n`);
      }
      case 'file': {
        const r = fileIssue(store, rest[0] ?? '', { confirm: values.confirm === true, env, identity, ...(values.repo === undefined ? {} : { repo: values.repo }) });
        return out({ ...r, dryRun: !r.filed }, fileText(r));
      }
      default:
        return usageError(io, `unknown command '${command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    io.stderr(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
