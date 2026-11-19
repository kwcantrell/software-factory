import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { check, formatFinding } from './check.ts';
import { CommandError, NotACheckoutError, TEMPLATE_PATH, UsageError, findCheckout, validateName } from './repo.ts';
import { scaffold } from './scaffold.ts';
import { formatStep, verify } from './verify.ts';

export const CLI_NAME = 'factory-plugin-builder';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The directory the CLI was run from; the checkout is found from it unless --repo is given. */
  cwd: string;
  /** Environment for the commands `verify` runs (PATH decides whether `claude` is found). */
  env: NodeJS.ProcessEnv;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Builds plugins for the software-factory checkout that contains the current directory, following
the "Plugin layout" and "CLI convention" sections of its CLAUDE.md.

Commands:
  new <name> [--description <text>]
                    Create plugins/<name>/ from ${TEMPLATE_PATH} and list it in the marketplace
                    (the same as npm run new-plugin); exit 1 if the name is taken, 2 if it is
                    not kebab-case
  check <name>... | --all
                    Check plugins against the convention; each finding names the file, line,
                    rule and fix; exit 1 on any finding
  verify <name>     Run check, claude plugin validate (plugin and marketplace), npm run typecheck
                    and the plugin's tests; exit 1 if any step fails (claude missing: skipped)

Options:
  --repo <path>     The software-factory checkout (default: the one containing the current directory)
  --all             check: every plugin under plugins/ and every marketplace entry
  --description <text>
                    new: the plugin description for plugin.json and marketplace.json
  --json            Print machine-readable JSON on stdout
  -h, --help        Show this help
  --version         Print the CLI version

Exit codes: 0 success, 1 command failed (findings, a failing step, a taken name), 2 usage error or
not inside a software-factory checkout (message on stderr, stdout empty).
`;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  new: ['description'],
  check: ['all'],
  verify: [],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function pluginName(name: string | undefined): string {
  validateName(name ?? '');
  return name ?? '';
}

function requirePlugin(root: string, name: string): void {
  const dir = join(root, 'plugins', name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError(`plugins/${name} does not exist`);
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
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
        repo: { type: 'string' },
        all: { type: 'boolean', default: false },
        description: { type: 'string' },
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
  if (!allowed) return usageError(io, `unknown command '${command}'`);
  if (values.description !== undefined && !allowed.includes('description')) return usageError(io, `${command} does not take --description`);
  if (values.all && !allowed.includes('all')) return usageError(io, `${command} does not take --all`);
  const print = (value: unknown, text: string) => io.stdout(values.json ? `${JSON.stringify(value)}\n` : text);

  try {
    switch (command) {
      case 'new': {
        if (rest.length !== 1) throw new UsageError(`new takes exactly one plugin name, got ${rest.length}`);
        const name = pluginName(rest[0]);
        const root = findCheckout(io.cwd, values.repo);
        const created = scaffold(root, name, values.description);
        print(created, `Created ${created.path} and added '${name}' to ${created.marketplace}.\n`);
        return EXIT.ok;
      }
      case 'check': {
        if (values.all && rest.length > 0) throw new UsageError('check takes plugin names or --all, not both');
        if (!values.all && rest.length === 0) throw new UsageError('check needs a plugin name or --all');
        const names = values.all ? null : rest.map(pluginName);
        const root = findCheckout(io.cwd, values.repo);
        const result = check(root, names);
        if (result.findings.length > 0) {
          io.stderr(`${CLI_NAME}: ${result.findings.length} convention finding(s):\n${result.findings.map(formatFinding).join('\n')}\n`);
          return EXIT.failure;
        }
        print(result, `${result.plugins.length} plugin(s) follow the convention: ${result.plugins.join(', ')}\n`);
        return EXIT.ok;
      }
      case 'verify': {
        if (rest.length !== 1) throw new UsageError(`verify takes exactly one plugin name, got ${rest.length}`);
        const name = pluginName(rest[0]);
        const root = findCheckout(io.cwd, values.repo);
        requirePlugin(root, name);
        const result = await verify(root, name, io.env, io.stderr);
        const summary = result.steps.map(formatStep).join('\n');
        if (!result.ok) {
          const failed = result.steps.filter((s) => s.status === 'fail').map((s) => s.name);
          io.stderr(`${CLI_NAME}: verify ${name} failed: ${failed.join(', ')}\n${summary}\n`);
          return EXIT.failure;
        }
        print(result, `${summary}\nverify ${name}: every step passed or was skipped\n`);
        return EXIT.ok;
      }
      default:
        return usageError(io, `unknown command '${command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    if (error instanceof NotACheckoutError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
      return EXIT.usage;
    }
    io.stderr(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
