import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { hello } from './hello.ts';

export const CLI_NAME = 'plugin-template';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Commands:
  hello [name]   Greet someone (default: world)

Options:
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

Exit codes: 0 success, 1 command failed, 2 usage error (message on stderr).
`;

class UsageError extends Error {}

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
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
  try {
    switch (command) {
      case 'hello': {
        if (rest.length > 1) throw new UsageError(`hello takes at most one name, got ${rest.length}`);
        const result = hello(rest[0] ?? 'world');
        io.stdout(values.json ? `${JSON.stringify(result)}\n` : `${result.greeting}\n`);
        return EXIT.ok;
      }
      case undefined:
        return usageError(io, 'missing command');
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
