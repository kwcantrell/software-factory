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
import { applyStation, type ApplyResult, dismissStation, type Line, locateFactory, locateRepo, stationsReport, type StationsReport, suggestStations, type SuggestResult } from './station-drafts.ts';
import { DEFAULT_MIN } from './stations.ts';
import { openStore } from './store.ts';

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
  /** Where `stations` looks for the repository without --repo; defaults to process.cwd(). */
  cwd?: string;
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
  stations [--repo <path>]   How each factory station agent (builder, verifier, every reviewer) has
                             done across the repository's factory jobs: jobs, first-pass proof rate,
                             proof failures, verdicts, escalations and follow-ups (read-only)
  stations suggest [--min <n>] [--repo <path>]
                             Apply the documented rules to that history and write a draft for each
                             suggested new or changed station agent (default --min ${DEFAULT_MIN})
  stations apply <id> [--confirm] [--repo <path>]
                             Without --confirm, print the files and the diff a draft would write.
                             With --confirm, write them into .claude/agents/ (and factory.json),
                             back up what it overwrites, run factory agents check, roll back on
                             failure. Never commits.
  stations dismiss <id> [--repo <path>]
                             Never suggest or apply this station suggestion
  hook                       Read a Claude Code PostToolUseFailure hook input on stdin and record a
                             failed marketplace CLI call (used by hooks/hooks.json; prints nothing).
                             A factory exit 2 (escalated to a human) is not a failure.

Options:
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

The log lives in $FACTORY_PLUGIN_ADVISOR_CONFIG_DIR, else $XDG_CONFIG_HOME/factory-plugin-advisor,
else ~/.config/factory-plugin-advisor (owner-only), never inside a git checkout. With factory.json
"advisor": {"share": true} and a remote factory, occurrences and issue state are also shared in
advisor/ on the factory's state branch (see the README); set FACTORY_PLUGIN_ADVISOR_SHARE_AS=<name>
to add that name to what you share.

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
  stations: ['repo', 'min', 'confirm'],
  hook: [],
};
const POSITIONALS: Record<string, number> = { record: 0, list: 0, show: 1, suggest: 0, dismiss: 1, file: 1, hook: 0 };
/** `stations` subcommands: the options and positionals (an id) each takes. */
const STATIONS: Record<string, { options: readonly string[]; id: boolean }> = {
  '': { options: ['repo'], id: false },
  suggest: { options: ['repo', 'min'], id: false },
  apply: { options: ['repo', 'confirm'], id: true },
  dismiss: { options: ['repo'], id: true },
};

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

const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`);

function stationsText(r: StationsReport): string {
  const lines = [`${r.jobs} job${r.jobs === 1 ? '' : 's'} in ${r.factoryDir}${r.skipped.length > 0 ? ` (${r.skipped.length} unreadable skipped: ${r.skipped.join(', ')})` : ''}`];
  for (const s of r.stations) {
    lines.push(`${s.station}  ${s.agent} (${s.owner}${s.file === null ? '' : `, ${s.file}`})${s.note === null ? '' : `: ${s.note}`}`);
    const parts = [`jobs ${s.jobs}`];
    if (s.proof !== undefined) parts.push(`first-pass proof ${pct(s.proof.firstPassRate)}`, `proof passes ${s.proof.passes}`, `proof failures ${s.proof.failures}`);
    if (s.reviews !== undefined) parts.push(`approve ${s.reviews.approve}`, `changes ${s.reviews.changes}`, `changes then approved after rework ${s.reviews.changesThenApproved} (${pct(s.reviews.changesThenApprovedRate)})`);
    parts.push(`escalations ${s.escalations}`, `follow-ups ${s.followups}`);
    lines.push(`  ${parts.join(', ')}`);
    for (const f of s.proof?.failureReasons ?? []) lines.push(`  proof failure in ${f.job}: ${f.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

function stationSuggestText(r: SuggestResult): string {
  const lines = r.suggestions.length === 0 ? [`No station suggestions: no rule has reached ${r.min} jobs (or failures) that has not been applied or dismissed.`] : [];
  for (const s of r.suggestions) {
    lines.push(`${s.id}  (${s.letter}) ${s.title}`, `  files: ${s.files.map((f) => `${f.path} (${f.action})`).join(', ')}`, `  draft: ${s.draft}`, `  ${s.factoryRun}`);
  }
  for (const p of r.problems) lines.push(`${p.id}  ${p.station}: the drafted agent failed factory agents check, so no draft was written: ${p.problem}`);
  return `${lines.join('\n')}\n`;
}

function applyText(r: ApplyResult): string {
  const lines = [r.applied ? `Applied ${r.id} to ${r.repo}. Review and commit .claude/agents/ and factory.json; nothing was committed.` : `Dry run: nothing was written. Applying ${r.id} to ${r.repo} would write:`];
  for (const f of r.files) {
    lines.push(`${f.action === 'create' ? 'create' : 'overwrite'} ${f.path}${f.backup === undefined ? '' : ` (backup: ${f.backup})`}`);
    if (!r.applied) lines.push(f.diff.trimEnd());
  }
  if (!r.applied) lines.push(`Run stations apply ${r.id} --confirm to write exactly this.`);
  return `${lines.join('\n')}\n`;
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
  if (command === 'stations') {
    const [sub = '', ...ids] = rest;
    const spec = STATIONS[sub];
    if (spec === undefined) return usageError(io, `unknown stations command '${sub}' (use stations, stations suggest, stations apply <id> or stations dismiss <id>)`);
    for (const [key, value] of Object.entries(values)) {
      if (['json', 'help', 'version'].includes(key) || value === undefined) continue;
      if (!spec.options.includes(key)) return usageError(io, `stations${sub === '' ? '' : ` ${sub}`} does not take --${key}`);
    }
    if (ids.length !== (spec.id ? 1 : 0)) return usageError(io, spec.id ? `stations ${sub} takes exactly one <id>, got ${ids.length}` : `stations${sub === '' ? '' : ` ${sub}`} takes no arguments, got ${ids.length}`);
  } else if (rest.length !== wanted) {
    return usageError(io, wanted === 0 ? `${command} takes no arguments, got ${rest.length}` : `${command} takes exactly one <signature>, got ${rest.length}`);
  }
  const out = (json: unknown, text: string): number => {
    io.stdout(values.json ? `${JSON.stringify(json)}\n` : text);
    return EXIT.ok;
  };

  if (command === 'hook') {
    // Never fails and never prints: see hook.ts.
    try {
      handleHookInput(io.stdin?.() ?? '', env, pluginRoot, now(), identity, io.cwd);
    } catch {
      // nothing recorded
    }
    return EXIT.ok;
  }

  const store = openStore(env, io.cwd ?? process.cwd());
  try {
    return dispatch();
  } finally {
    // Sharing only (factory.json advisor.share): the public-remote warning, and what the shared log could not do.
    const lines = store.notes();
    if (store.shared !== null) {
      if (store.shared.share.byProblem !== undefined) lines.unshift(store.shared.share.byProblem);
      if (command === 'record' || command === 'suggest') {
        const warning = store.shared.warnOnce();
        if (warning !== null) io.stderr(`${warning}\n`);
      }
    }
    for (const line of lines) io.stderr(`${CLI_NAME}: ${line}\n`);
  }

  function dispatch(): number {
  try {
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
      case 'stations': {
        const [sub = '', id = ''] = rest;
        const min = positiveInt('min', values.min, DEFAULT_MIN);
        const where = locateRepo(values.repo, env, io.cwd ?? process.cwd());
        const line: Line = { ...where, factoryRoot: locateFactory(pluginRoot, env), env };
        if (sub === '') {
          const r = stationsReport(line);
          return out(r, stationsText(r));
        }
        if (sub === 'suggest') {
          const r = suggestStations(line, store, min, now(), identity);
          return out(r, stationSuggestText(r));
        }
        if (sub === 'apply') {
          const r = applyStation(line, store, id, values.confirm === true, now());
          return out(r, applyText(r));
        }
        const r = dismissStation(line, store, id, now());
        return out(r, `Dismissed station suggestion ${r.id}; it will not be suggested or applied again.\n`);
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
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
