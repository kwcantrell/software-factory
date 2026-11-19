import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkAll, formatStep } from './check.ts';
import { ReleaseError, releaseCheck } from './release.ts';
import { NotACheckoutError, UsageError, findCheckout } from './repo.ts';

export const CLI_NAME = 'factory-dev';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The directory the CLI was run from; the checkout is found from it unless --repo is given. */
  cwd: string;
  /** Environment for the commands `check` runs (PATH decides whether `claude` is found). */
  env: NodeJS.ProcessEnv;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Dev tooling for the software-factory checkout that contains the current directory.

Commands:
  check [--require-claude]
                    Run every check CI runs: every tracked or untracked-but-not-ignored JSON file
                    parses; claude plugin validate on the marketplace, each listed plugin and the
                    template; npm run typecheck; npm test; the release check;
                    factory-plugin-builder check --all; and factory-docs gate (lint only when no
                    origin/main or main resolves). Every step runs; exit 1 listing the failed
                    steps. Without claude on the PATH the validate steps are skipped (not passed)
  release [<tag>] [--notes-out <file>]
                    Check that every marketplace plugin has the same version in plugin.json and
                    package.json, that <tag> (if given) is v<version>, and that CHANGELOG.md has a
                    non-empty "## [<version>]" section; print that section (the release notes) or
                    write it to <file>. Exit 1, saying why, otherwise

Options:
  --repo <path>     The software-factory checkout (default: the one containing the current directory)
  --require-claude  check: fail the validate steps when claude is not on the PATH, instead of skipping
  --notes-out <file>
                    release: write the release notes to <file> instead of stdout
  --json            Print machine-readable JSON on stdout
  -h, --help        Show this help
  --version         Print the CLI version

Exit codes: 0 success, 1 a check failed or the release check refused, 2 usage error or not inside a
software-factory checkout (message on stderr, stdout empty).
`;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  check: ['require-claude'],
  release: ['notes-out'],
};

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
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
        'require-claude': { type: 'boolean', default: false },
        'notes-out': { type: 'string' },
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
  if (values['require-claude'] && !allowed.includes('require-claude')) return usageError(io, `${command} does not take --require-claude`);
  if (values['notes-out'] !== undefined && !allowed.includes('notes-out')) return usageError(io, `${command} does not take --notes-out`);

  try {
    switch (command) {
      case 'check': {
        if (rest.length > 0) throw new UsageError(`check takes no arguments, got ${rest.join(' ')}`);
        const root = findCheckout(io.cwd, values.repo);
        const result = await checkAll(root, { requireClaude: values['require-claude'], env: io.env, stream: io.stderr });
        const summary = result.steps.map(formatStep).join('\n');
        if (!result.ok) {
          const failed = result.steps.filter((s) => s.status === 'fail').map((s) => s.name);
          io.stderr(`\n${summary}\n${CLI_NAME}: check failed: ${failed.join(', ')}\n`);
          return EXIT.failure;
        }
        const skipped = result.steps.filter((s) => s.status === 'skipped').map((s) => s.name);
        const tail = skipped.length > 0 ? `all checks passed, but these were skipped (not passed): ${skipped.join(', ')}` : 'all checks passed';
        io.stdout(values.json ? `${JSON.stringify(result)}\n` : `${summary}\n${tail}\n`);
        return EXIT.ok;
      }
      case 'release': {
        if (rest.length > 1) throw new UsageError(`release takes at most one tag, got ${rest.length}`);
        const root = findCheckout(io.cwd, values.repo);
        const result = releaseCheck(root, rest[0] ?? null);
        const notesOut = values['notes-out'];
        if (notesOut !== undefined) writeFileSync(resolve(io.cwd, notesOut), result.notes);
        if (values.json) io.stdout(`${JSON.stringify(result)}\n`);
        else if (notesOut === undefined) io.stdout(result.notes);
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
    if (error instanceof ReleaseError) {
      io.stderr(`${CLI_NAME}: release check failed: ${error.message}\n`);
      return EXIT.failure;
    }
    io.stderr(`${CLI_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failure;
  }
}

function usageError(io: Io, message: string): number {
  io.stderr(`${CLI_NAME}: ${message}\nRun '${CLI_NAME} --help' for usage.\n`);
  return EXIT.usage;
}
