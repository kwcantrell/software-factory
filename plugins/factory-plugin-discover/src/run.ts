import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Catalog, MARKETPLACE_NAME, ownRoot, readCatalog } from './catalog.ts';
import { DEFAULT_MODE, type Env, isMode, MODES, readSettings, setMode, type Settings } from './config.ts';
import { hookOutput } from './hook.ts';
import { install, type InstallResult, UsageError } from './install.ts';
import { ADVISOR, match, type MatchResult, THRESHOLD } from './match.ts';

export const CLI_NAME = 'factory-plugin-discover';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads all of stdin (hook). */
  stdin?: () => string;
  env?: Env;
  cwd?: string;
  /** This plugin's folder, used to find the marketplace manifest. */
  pluginRoot?: string;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Finds the installed plugin or skill that fits a software-factory task, and the ${MARKETPLACE_NAME}
marketplace plugins that would fit but are not installed. Reads Claude Code's own records; never the
network.

Commands:
  catalog                    Every installed plugin (with its skills; disabled ones marked), plugins
                             installed only for another project, the user's own skills, and the
                             ${MARKETPLACE_NAME} marketplace plugins not installed
  match <task text>          Rank them against a one-line task summary: 'installed', 'available'
                             and 'elsewhere' (installed for another project) lists, each entry with
                             a score and the matched terms. An entry needs a score of at least
                             ${THRESHOLD}; if none does, none_applicable is true, with the
                             ${ADVISOR} record and suggest commands
                             when it is installed and enabled. Also prints the mode; with mode
                             off, 'available' and 'elsewhere' are always empty
  settings                   Show the mode (default ${DEFAULT_MODE})
  settings set mode <mode>   Change it: ${MODES.join(', ')}
  install <name> [--confirmed]
                             Run 'claude plugin install <name>@${MARKETPLACE_NAME}' if <name> is
                             in that marketplace and not installed (here or for another project),
                             and the mode allows it: auto-install, or ask with --confirmed (pass
                             it only after the user said yes). The only command that runs claude.
  hook                       Read a UserPromptSubmit hook input on stdin and print a one-line hint
                             when it is about software-factory (used by hooks/hooks.json)

Options:
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

Claude Code's records are read from $CLAUDE_CONFIG_DIR, else ~/.claude. The mode lives in
$FACTORY_PLUGIN_DISCOVER_CONFIG_DIR, else $XDG_CONFIG_HOME/factory-plugin-discover, else
~/.config/factory-plugin-discover.

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  catalog: [],
  match: [],
  settings: [],
  install: ['confirmed'],
  hook: [],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function catalogText(c: Catalog): string {
  const lines = ['Installed plugins:'];
  for (const p of c.installed) {
    lines.push(`  ${p.id}${p.version === undefined ? '' : ` ${p.version}`}${p.enabled ? '' : ' (disabled)'}: ${p.description}`);
    for (const s of p.skills) lines.push(`    skill ${s.name}: ${s.description}`);
  }
  if (c.installed.length === 0) lines.push('  (none)');
  if (c.installedElsewhere.length > 0) {
    lines.push('Installed for another project only:');
    for (const p of c.installedElsewhere) lines.push(`  ${p.id} (${p.scope} scope, ${p.projectPath}): ${p.description}`);
  }
  lines.push('User skills:');
  for (const s of c.userSkills) lines.push(`  ${s.name}: ${s.description}`);
  if (c.userSkills.length === 0) lines.push('  (none)');
  lines.push(`Available in the ${MARKETPLACE_NAME} marketplace, not installed:`);
  for (const p of c.available) lines.push(`  ${p.name}: ${p.description}\n    install: ${p.installCommand}`);
  if (c.available.length === 0) lines.push(c.manifest === null ? '  (marketplace manifest not found)' : '  (none)');
  return `${lines.join('\n')}\n`;
}

function matchText(m: MatchResult): string {
  const lines: string[] = [];
  for (const e of m.installed) {
    const skill = e.skill !== undefined && e.skill !== e.name ? ` (skill ${e.skill})` : '';
    lines.push(`installed ${e.name}${skill}${e.enabled ? '' : ' [disabled]'}  score ${e.score}  matched ${e.reason.join(', ')}`);
  }
  for (const e of m.available) lines.push(`available ${e.name}  score ${e.score}  matched ${e.reason.join(', ')}\n  install: ${e.installCommand}`);
  for (const e of m.elsewhere) lines.push(`installed elsewhere ${e.id} (${e.scope} scope, ${e.projectPath})  score ${e.score}  matched ${e.reason.join(', ')}`);
  if (!m.none_applicable && lines.length === 0) lines.push('Nothing installed here fits (mode off: plugins that are not installed are not suggested).');
  if (m.none_applicable) {
    lines.push(`Nothing scores ${m.threshold} or more: no installed or marketplace plugin fits.`);
    if (m.advisor !== undefined) lines.push(`Record the gap with ${ADVISOR}:\n  ${m.advisor.record}\nAt the end of the task:\n  ${m.advisor.suggest}`);
  }
  return `${lines.join('\n')}\n`;
}

function settingsJson(s: Settings): Record<string, unknown> {
  return { mode: s.mode, default: s.isDefault, modes: MODES, path: s.path };
}

function settingsText(s: Settings): string {
  return `mode: ${s.mode}${s.isDefault ? ' (default)' : ''}  (${s.path})\n`;
}

function installText(r: InstallResult): string {
  return `Installed ${r.plugin}@${r.marketplace}. ${r.reload}\n`;
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
        confirmed: { type: 'boolean' },
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
  const [command, ...rest] = positionals;
  if (command === undefined) return usageError(io, 'missing command');
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) return usageError(io, `unknown command '${command}'`);
  for (const [key, value] of Object.entries(values)) {
    if (['json', 'help', 'version'].includes(key) || value === undefined) continue;
    if (!allowed.includes(key)) return usageError(io, `${command} does not take --${key}`);
  }
  const out = (json: unknown, text: string): number => {
    io.stdout(values.json ? `${JSON.stringify(json)}\n` : text);
    return EXIT.ok;
  };

  if (command === 'hook') {
    // Never fails and never blocks the prompt (see hook.ts); --json changes nothing here.
    let text = '';
    try {
      text = hookOutput(io.stdin?.() ?? '', env);
    } catch {
      text = '';
    }
    io.stdout(text);
    return EXIT.ok;
  }

  try {
    const catalog = (): Catalog => readCatalog(env, { pluginRoot: io.pluginRoot ?? ownRoot(), cwd: io.cwd ?? process.cwd() });
    switch (command) {
      case 'catalog': {
        if (rest.length > 0) throw new UsageError(`catalog takes no arguments, got ${rest.length}`);
        const c = catalog();
        return out(c, catalogText(c));
      }
      case 'match': {
        const task = rest.join(' ').trim();
        if (task === '') throw new UsageError('match needs a one-line task summary, for example: match "cut a release"');
        const m = match(catalog(), task, readSettings(env).mode);
        return out(m, matchText(m));
      }
      case 'settings': {
        if (rest.length === 0) {
          const s = readSettings(env);
          return out(settingsJson(s), settingsText(s));
        }
        const [verb, key, value, ...extra] = rest;
        if (verb !== 'set' || key !== 'mode' || value === undefined || extra.length > 0) {
          throw new UsageError(`settings takes no arguments, or: set mode <${MODES.join('|')}>`);
        }
        if (!isMode(value)) throw new UsageError(`mode must be one of ${MODES.join(', ')}, got ${JSON.stringify(value)}`);
        const s = setMode(env, value);
        return out(settingsJson(s), settingsText(s));
      }
      case 'install': {
        if (rest.length !== 1) throw new UsageError(`install takes exactly one plugin name, got ${rest.length}`);
        const r = install(catalog(), rest[0] ?? '', { mode: readSettings(env).mode, confirmed: values.confirmed === true, env });
        return out(r, installText(r));
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
