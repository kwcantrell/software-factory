import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { check, reportText } from './check.ts';
import type { Env } from './claude.ts';
import { add, addProfile, type AddOptions, changeText, fromProposal, init, remove, UsageError } from './edit.ts';
import { apply as applyMigration, applyText, MigrateRefused, MigrateUsage, type MigrateOptions, plan as planMigration, planText, SCOPES, type Scope, updatePlugins, updateText } from './migrate.ts';
import { locate } from './repo.ts';
import { DEFAULT_FILE, type DoctorFile, KINDS, load, parents, Refused, resolve as resolveProfile } from './requirements.ts';
import { proposals, scan, scanText } from './scan.ts';

export const CLI_NAME = 'factory-doctor';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: Env;
  cwd?: string;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Keeps a committed record of what running an application needs under each profile (dev, stage,
test, ...) in ${DEFAULT_FILE}, and checks this machine against it. Records names, never
values: it never stores, prints or sends the value of a variable.

Commands:
  check [<profile>]   Check every requirement of the profile (with its extends) on this machine:
                      one line per requirement (ok, missing or wrong) and a fix for each problem.
                      Exit 0 when everything required is in place, 1 when not (the report then
                      goes to stderr). The profile: <profile>, else $FACTORY_DOCTOR_PROFILE, else
                      the file's default_profile; an unknown one is a usage error (exit 2)
  scan                Read the repository for what running it needs (.env examples, env reads in
                      code and compose files, engines, version files, Dockerfiles, CI steps) and
                      propose requirements not yet recorded, each numbered, with its source and
                      profile. Read-only
  profiles            List the profiles
  add <kind> <name> --profile <p> --why "<text>" [options]
                      Add a requirement (dry run; --confirm writes it). Kinds: ${KINDS.join(', ')}
                      (a file is named by its path, a service by <host>:<port>), and profile
  add --from-scan <n> [--profile <p>] [--why "<text>"]
                      Add proposal <n> of scan
  remove <kind> <name> --profile <p>
                      Remove a requirement (dry run; --confirm writes it); remove profile <name>
  init                Write a starter file with dev and test profiles (dry run; --confirm writes it)
  migrate [--to <version>] [--repo <path>]
                      Move a repo between software-factory versions, up or down: detect the
                      version of the repo and of the installed plugins, and print the plan in
                      order (plugin, automatic and manual steps, the files each touches and why).
                      Read-only. Exit 1 when the move is refused (the reasons first). The target
                      defaults to the latest version this factory-doctor knows
  migrate --apply [--scope <s>]...
                      Make the automatic repo steps through the installed factory plugin's
                      migrate-repo (backups first), then print what is left
  migrate --update-plugins [--confirmed]
                      The claude commands that move every installed software-factory plugin to
                      the target together; only --confirmed runs them (then restart Claude Code)

Options:
  --file <path>              The requirements file (default: ${DEFAULT_FILE} in the repository root)
  --profile <p>              add, remove: the profile
  --why <text>               add: why running the app needs it
  --source <file:line>       add: where it was found
  --optional                 add: a problem with it does not fail check
  --description <text>       add env, add profile: what it is
  --format <f>               add env: non-empty, url, integer or regex:<pattern>
  --tool-version <c>         add tool: >=1.2.3, ^1.2 or 1.2.3
  --version-command <cmd>    add tool: "<tool> <probe>", the probe one of --version -version -v -V version (default <tool> --version)
  --version-pattern <re>     add tool: a regex whose first group is the version
  --extends <a,b>            add profile: the profiles it extends
  --from-scan <n>            add: proposal <n> from scan
  --confirm                  add, remove, init: write the change (without it, a dry run)
  --to <version>             migrate: the target (a version, unreleased or latest; default latest)
  --repo <path>              migrate: the repository (default: the one holding the current directory)
  --apply                    migrate: make the automatic repo steps
  --scope <s>                migrate --apply: settings scope to change, project, local or user;
                             repeatable (default project and local; user only when named)
  --update-plugins           migrate: update the installed software-factory plugins
  --confirmed                migrate --update-plugins: run the claude commands (without it, print them)
  --json                     Print machine-readable JSON
  -h, --help                 Show this help
  --version                  Print the CLI version

Never accepted: --value, --default, --secret, or an env name written NAME=value. Set values
yourself, in your shell or your dotenv files.

Exit codes: 0 success, 1 command failed (a requirement missing, a refused change), 2 usage error
(message on stderr).
`;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  check: ['file'],
  scan: ['file'],
  profiles: ['file'],
  add: ['file', 'profile', 'why', 'source', 'optional', 'description', 'format', 'tool-version', 'version-command', 'version-pattern', 'extends', 'from-scan', 'confirm'],
  remove: ['file', 'profile', 'confirm'],
  init: ['file', 'confirm'],
  migrate: ['to', 'repo', 'apply', 'scope', 'update-plugins', 'confirmed'],
};

/** Flags that would carry a value or secret: refused outright, never parsed. */
const VALUE_FLAGS = /^--(value|values|default|secret|secrets|val)(=|$)/i;

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function profileList(doc: DoctorFile): string {
  const names = Object.keys(doc.profiles);
  return names.length === 0 ? '(none)' : names.join(', ');
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const env: Env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const valueFlag = argv.find((a) => VALUE_FLAGS.test(a));
  if (valueFlag !== undefined) {
    // Name the flag, never what follows it.
    io.stderr(`${CLI_NAME}: ${valueFlag.split('=')[0]} is refused: factory-doctor records names, never values. Set the value yourself, in your shell or your dotenv files.\n`);
    return EXIT.failure;
  }
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
        file: { type: 'string' },
        profile: { type: 'string' },
        why: { type: 'string' },
        source: { type: 'string' },
        optional: { type: 'boolean' },
        description: { type: 'string' },
        format: { type: 'string' },
        'tool-version': { type: 'string' },
        'version-command': { type: 'string' },
        'version-pattern': { type: 'string' },
        extends: { type: 'string' },
        'from-scan': { type: 'string' },
        confirm: { type: 'boolean', default: false },
        to: { type: 'string' },
        repo: { type: 'string' },
        apply: { type: 'boolean', default: false },
        scope: { type: 'string', multiple: true },
        'update-plugins': { type: 'boolean', default: false },
        confirmed: { type: 'boolean', default: false },
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

  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) return usageError(io, `unknown command '${command}'`);
  for (const [k, v] of Object.entries(values)) {
    if (['json', 'help', 'version'].includes(k) || v === undefined || v === false) continue;
    if (!allowed.includes(k)) return usageError(io, `${command} does not take --${k}`);
  }
  if (command === 'migrate') return migrateCommand(rest, values, { cwd, env }, io);
  const loc = locate(cwd, values.file);
  const print = (value: unknown, text: string): void => io.stdout(values.json ? `${JSON.stringify(value)}\n` : text);

  try {
    switch (command) {
      case 'check': {
        if (rest.length > 1) throw new UsageError(`check takes at most one profile, got ${rest.length}`);
        const doc = load(loc.path, loc.label);
        if (doc === null) throw new Refused(`${loc.label} does not exist: run '${CLI_NAME} scan' to see what this repository needs, or '${CLI_NAME} init' for a starter file`);
        const fromEnv = env.FACTORY_DOCTOR_PROFILE !== undefined && env.FACTORY_DOCTOR_PROFILE !== '' ? env.FACTORY_DOCTOR_PROFILE : undefined;
        const name = rest[0] ?? fromEnv ?? doc.default_profile;
        if (name === undefined) throw new UsageError(`name a profile (or set FACTORY_DOCTOR_PROFILE, or default_profile in ${loc.label}); profiles: ${profileList(doc)}`);
        if (!Object.hasOwn(doc.profiles, name)) {
          const via = rest[0] !== undefined ? '' : fromEnv !== undefined ? ' (from FACTORY_DOCTOR_PROFILE)' : '';
          throw new UsageError(`no profile '${name}'${via} in ${loc.label}; profiles: ${profileList(doc)}`);
        }
        const report = await check(resolveProfile(doc, name), { root: loc.root, env }, loc.label);
        const out = values.json ? `${JSON.stringify(report)}\n` : reportText(report);
        if (report.ok) {
          io.stdout(out);
          return EXIT.ok;
        }
        // Exit 1: stdout stays empty and the report goes to stderr (the CLI convention).
        io.stderr(values.json ? out : `${out}${CLI_NAME}: profile ${name}: ${report.summary.required_problems} required ${report.summary.required_problems === 1 ? 'requirement is' : 'requirements are'} missing or wrong\n`);
        return EXIT.failure;
      }
      case 'scan': {
        if (rest.length > 0) throw new UsageError('scan takes no arguments');
        const result = scan(loc.root, load(loc.path, loc.label));
        print({ file: loc.label, ...result }, scanText(result, loc.label));
        return EXIT.ok;
      }
      case 'profiles': {
        if (rest.length > 0) throw new UsageError('profiles takes no arguments');
        const doc = load(loc.path, loc.label);
        if (doc === null) throw new Refused(`${loc.label} does not exist: run '${CLI_NAME} init' for a starter file`);
        const list = Object.entries(doc.profiles).map(([n, p]) => ({
          name: n,
          default: doc.default_profile === n,
          ...(p.description === undefined ? {} : { description: p.description }),
          extends: parents(p),
          requires: (p.requires ?? []).length,
          resolved: resolveProfile(doc, n).requires.length,
        }));
        const text = list.map((p) => `${p.name}${p.default ? ' (default)' : ''}${p.extends.length === 0 ? '' : ` extends ${p.extends.join(', ')}`}: ${p.resolved} requirement(s)${p.description === undefined ? '' : ` - ${p.description}`}`);
        print({ file: loc.label, default_profile: doc.default_profile ?? null, profiles: list }, `${text.length === 0 ? '(no profiles)' : text.join('\n')}\n`);
        return EXIT.ok;
      }
      case 'add': {
        let change;
        if (values['from-scan'] !== undefined) {
          if (rest.length > 0) throw new UsageError('add --from-scan <n> takes no kind or name');
          const n = Number(values['from-scan']);
          if (!Number.isInteger(n) || n < 1) throw new UsageError('--from-scan takes a proposal number from scan');
          const proposal = proposals(loc.root, load(loc.path, loc.label)).all.find((p) => p.n === n);
          if (proposal === undefined) throw new Refused(`scan has no proposal ${n} now; run scan again and use a number it prints`);
          if (proposal.kind === 'profile') change = addProfile(loc, proposal.name, values.why ?? values.description ?? proposal.why, undefined, values.confirm);
          else change = add(loc, fromProposal(proposal, values.profile, values.why), values.confirm);
        } else {
          if (rest.length !== 2) throw new UsageError(`add takes <kind> <name>, got ${rest.length} argument(s)`);
          const [kind = '', name = ''] = rest;
          if (kind === 'profile') {
            change = addProfile(loc, name, values.description ?? values.why, values.extends, values.confirm);
          } else {
            if (values.profile === undefined) throw new UsageError('add needs --profile <p>');
            const o: AddOptions = {
              kind,
              name,
              profile: values.profile,
              ...(values.why === undefined ? {} : { why: values.why }),
              ...(values.source === undefined ? {} : { source: values.source }),
              ...(values.optional === true ? { optional: true } : {}),
              ...(values.description === undefined ? {} : { description: values.description }),
              ...(values.format === undefined ? {} : { format: values.format }),
              ...(values['tool-version'] === undefined ? {} : { version: values['tool-version'] }),
              ...(values['version-command'] === undefined ? {} : { versionCommand: values['version-command'] }),
              ...(values['version-pattern'] === undefined ? {} : { versionPattern: values['version-pattern'] }),
              ...(values.extends === undefined ? {} : { extends: values.extends }),
            };
            change = add(loc, o, values.confirm);
          }
        }
        print(change, changeText(change));
        return EXIT.ok;
      }
      case 'remove': {
        if (rest.length !== 2) throw new UsageError(`remove takes <kind> <name>, got ${rest.length} argument(s)`);
        const change = remove(loc, rest[0] ?? '', rest[1] ?? '', values.profile, values.confirm);
        print(change, changeText(change));
        return EXIT.ok;
      }
      case 'init': {
        if (rest.length > 0) throw new UsageError('init takes no arguments');
        const change = init(loc, values.confirm);
        print(change, changeText(change));
        return EXIT.ok;
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

interface MigrateValues {
  json?: boolean;
  to?: string | undefined;
  repo?: string | undefined;
  apply?: boolean;
  scope?: string[] | undefined;
  'update-plugins'?: boolean;
  confirmed?: boolean;
}

function migrateCommand(rest: string[], values: MigrateValues, where: { cwd: string; env: Env }, io: Io): number {
  if (rest.length > 0) return usageError(io, 'migrate takes no arguments');
  if (values.apply && values['update-plugins']) {
    return usageError(io, 'run --apply and --update-plugins separately: an upgrade updates the plugins first (then restart Claude Code), a downgrade migrates the repo first');
  }
  if (values.confirmed && !values['update-plugins']) return usageError(io, '--confirmed goes with --update-plugins');
  const scopes = values.scope ?? null;
  for (const s of scopes ?? []) if (!(SCOPES as readonly string[]).includes(s)) return usageError(io, `--scope: '${s}' is not one of ${SCOPES.join(', ')}`);
  const opts: MigrateOptions = { cwd: where.cwd, env: where.env, repo: values.repo, to: values.to, scopes: scopes as Scope[] | null };
  const json = values.json === true;
  try {
    const p = planMigration(opts);
    if (values['update-plugins']) {
      const u = updatePlugins(opts, p, values.confirmed === true);
      const { text, ok } = updateText(u, p);
      const out = json ? `${JSON.stringify({ target: p.target, ...u })}\n` : text;
      if (ok) io.stdout(out);
      else io.stderr(out);
      return ok ? EXIT.ok : EXIT.failure;
    }
    if (values.apply) {
      const r = applyMigration(opts, p);
      const { text, ok } = applyText(r);
      const out = json ? `${JSON.stringify({ ...r, ok })}\n` : text;
      if (ok) io.stdout(out);
      else io.stderr(out);
      return ok ? EXIT.ok : EXIT.failure;
    }
    const out = json ? `${JSON.stringify(p)}\n` : planText(p, opts, 'dry-run');
    if (p.refused.length > 0) {
      io.stderr(out);
      return EXIT.failure;
    }
    io.stdout(out);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof MigrateUsage) return usageError(io, error.message);
    if (error instanceof MigrateRefused) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
      return EXIT.failure;
    }
    throw error;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
