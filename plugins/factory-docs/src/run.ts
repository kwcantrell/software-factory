import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { describeBase, formatProblem, formatStale, lint, stale, which } from './docs.ts';
import type { LintResult, StaleResult } from './docs.ts';
import { CommandError, MAP_PATH, NotARepoError, UsageError, findRepo, loadMap } from './repo.ts';

export const CLI_NAME = 'factory-docs';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The directory the CLI was run from; the checkout is found from it unless --repo is given. */
  cwd: string;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Keeps the docs of the git checkout containing the current directory in sync with its code, using
the doc map ${MAP_PATH} (each doc and the globs of the code it describes).

Commands:
  which <path>...   Print, for each path (relative to the current directory), the docs whose globs
                    cover it
  stale [--base <ref>]
                    List each doc that did not change although files it covers did: files changed
                    since the merge-base with <ref> (default origin/main, then main), plus staged,
                    unstaged and untracked files. A changed doc counts only for the changelog doc.
                    Exit 1 if any doc is stale
  lint              Check the map: every doc exists and every glob matches a file; every *.md file
                    outside docs/research/ and factory/ is a doc or ignored; every command each
                    marketplace plugin's CLI lists in --help is mentioned in its README. Exit 1 with
                    one line per problem (file, what, fix)
  gate [--base <ref>]
                    lint, then stale; exit 1 if either fails

Options:
  --repo <path>     The checkout (default: the git checkout containing the current directory)
  --base <ref>      stale, gate: measure changes from the merge-base of HEAD and <ref>
  --json            Print machine-readable JSON on stdout
  -h, --help        Show this help
  --version         Print the CLI version

Exit codes: 0 success, 1 stale docs, lint problems or the command failed, 2 usage error or not
inside a git checkout with ${MAP_PATH} (message on stderr, stdout empty).
`;

const TAKES_BASE = ['stale', 'gate'];

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function staleSummary(r: StaleResult): string {
  return `no stale docs: ${r.changed.length} changed file(s) against ${describeBase(r)}`;
}

function staleFailure(r: StaleResult): string {
  const lines = r.stale.map(formatStale);
  return `${CLI_NAME}: ${r.stale.length} doc(s) not updated for the code they cover, against ${describeBase(r)}:\n${lines.join('\n')}\n`;
}

function lintSummary(r: LintResult): string {
  const commands = Object.values(r.clis).reduce((n, c) => n + c.length, 0);
  return `doc map ok: ${r.docs} doc(s); ${commands} command(s) of ${Object.keys(r.clis).length} plugin CLI(s) documented`;
}

function lintFailure(r: LintResult): string {
  return `${CLI_NAME}: lint found ${r.problems.length} problem(s):\n${r.problems.map(formatProblem).join('\n')}\n`;
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
        repo: { type: 'string' },
        base: { type: 'string' },
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
  if (!['which', 'stale', 'lint', 'gate'].includes(command)) return usageError(io, `unknown command '${command}'`);
  if (values.base !== undefined && !TAKES_BASE.includes(command)) return usageError(io, `${command} does not take --base`);
  if (command === 'which' && rest.length === 0) return usageError(io, 'which needs at least one <path>');
  if (command !== 'which' && rest.length > 0) return usageError(io, `${command} takes no arguments, got ${rest.join(' ')}`);

  try {
    const repo = findRepo(io.cwd, values.repo);
    const map = loadMap(repo.root);
    switch (command) {
      case 'which': {
        const result = which(repo, rest, map);
        if (values.json) io.stdout(`${JSON.stringify(result)}\n`);
        else io.stdout(Object.entries(result).map(([path, docs]) => `${path}: ${docs.length > 0 ? docs.join(', ') : '(no docs)'}\n`).join(''));
        return EXIT.ok;
      }
      case 'stale': {
        const result = stale(repo, values.base, map);
        if (result.stale.length > 0) {
          io.stderr(staleFailure(result));
          return EXIT.failure;
        }
        io.stdout(values.json ? `${JSON.stringify(result)}\n` : `${staleSummary(result)}\n`);
        return EXIT.ok;
      }
      case 'lint': {
        const result = lint(repo, map);
        if (result.problems.length > 0) {
          io.stderr(lintFailure(result));
          return EXIT.failure;
        }
        io.stdout(values.json ? `${JSON.stringify(result)}\n` : `${lintSummary(result)}\n`);
        return EXIT.ok;
      }
      default: {
        // gate: lint, then stale, one exit code.
        const linted = lint(repo, map);
        const staled = stale(repo, values.base, map);
        const failures = [linted.problems.length > 0 ? lintFailure(linted) : '', staled.stale.length > 0 ? staleFailure(staled) : ''].join('');
        if (failures !== '') {
          const okParts = [linted.problems.length === 0 ? lintSummary(linted) : '', staled.stale.length === 0 ? staleSummary(staled) : ''].filter(Boolean);
          io.stderr(`${okParts.map((l) => `${l}\n`).join('')}${failures}${CLI_NAME}: gate failed\n`);
          return EXIT.failure;
        }
        io.stdout(values.json ? `${JSON.stringify({ lint: linted, stale: staled })}\n` : `${lintSummary(linted)}\n${staleSummary(staled)}\ngate passed\n`);
        return EXIT.ok;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) return usageError(io, error.message);
    if (error instanceof NotARepoError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof CommandError) {
      io.stderr(`${CLI_NAME}: ${error.message}\n`);
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
