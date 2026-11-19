import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decide } from './hook.ts';
import { allowedSigners, apply, formatPlan, plan, Refused, type Scope } from './setup.ts';
import { findRepo, type Repo } from './signing.ts';
import { formatStatus, status } from './status.ts';

export const CLI_NAME = 'factory-signing';

/** Exit codes shared by every plugin CLI in this marketplace. */
export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The hook's payload; read from stdin when not given. */
  stdin?: () => string;
}

export const USAGE = `Usage: ${CLI_NAME} <command> [options]

Makes the commits Claude makes signed with your own SSH key, through your ssh-agent.

Commands:
  status [--repo <path>]            Read-only: gpg.format, user.signingkey, commit.gpgsign,
                                    tag.gpgsign (with their config level), the ssh-agent and
                                    whether it holds the key, a test signature, whether the
                                    repo requires signing and why, the allowed-signers file;
                                    one fix line per problem. Exit 0 whatever it finds.
  setup [--repo <path>] [--key <public key path>] [--scope repo|global] [--confirm]
                                    Print the git config changes (gpg.format ssh,
                                    user.signingkey, commit.gpgsign true, tag.gpgsign true);
                                    a dry run unless --confirm, which applies them and runs
                                    status. Default scope: repo (its local config, shared by
                                    its worktrees). Without --key: the one key in the agent.
  allowed-signers [--repo <path>]   Print your allowed-signers line: <user.email> <public key>.
                                    Writes nothing; add it to the file by pull request.
  hook                              The PreToolUse hook (reads its payload on stdin).

Never generates a key, never reads or copies a private key, never enters a passphrase:
load your key yourself with \`! ssh-add <key>\` at the Claude Code prompt.

Options:
  --repo <path>  The repository (default: the current directory)
  --json         Print machine-readable JSON on stdout
  -h, --help     Show this help
  --version      Print the CLI version

Exit codes: 0 success, 1 command failed or refused, 2 usage error (message on stderr).
`;

class UsageError extends Error {}

function version(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg ? String(pkg.version) : 'unknown';
}

function repoAt(path: string | undefined): Repo {
  const dir = resolve(process.cwd(), path ?? '.');
  const repo = findRepo(dir);
  if (repo === null) throw new Refused(`not inside a git working tree: ${dir}`);
  return repo;
}

export function run(argv: readonly string[], io: Io): number {
  if (argv[0] === 'hook') {
    // Never fails the tool call: any error means no output and exit 0.
    try {
      io.stdout(decide(io.stdin ? io.stdin() : readFileSync(0, 'utf8')));
    } catch {
      // allow silently
    }
    return EXIT.ok;
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
        repo: { type: 'string' },
        key: { type: 'string' },
        scope: { type: 'string' },
        confirm: { type: 'boolean', default: false },
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
  const only = (allowed: string[]): void => {
    if (rest.length > 0) throw new UsageError(`${command} takes no arguments, got ${JSON.stringify(rest[0])}`);
    for (const name of ['key', 'scope', 'confirm'] as const) {
      if (!allowed.includes(name) && values[name] !== undefined && values[name] !== false) throw new UsageError(`${command} does not take --${name}`);
    }
  };
  try {
    switch (command) {
      case 'status': {
        only([]);
        const s = status(repoAt(values.repo));
        io.stdout(values.json ? `${JSON.stringify(s)}\n` : formatStatus(s));
        return EXIT.ok;
      }
      case 'setup': {
        only(['key', 'scope', 'confirm']);
        const scope = values.scope ?? 'repo';
        if (scope !== 'repo' && scope !== 'global') throw new UsageError(`--scope must be repo or global, got '${scope}'`);
        const repo = repoAt(values.repo);
        const p = plan(repo, { key: values.key, scope: scope as Scope, cwd: process.cwd() });
        if (!values.confirm) {
          io.stdout(values.json ? `${JSON.stringify({ dryRun: true, ...p })}\n` : formatPlan(p, false));
          return EXIT.ok;
        }
        apply(p);
        const s = status(repo);
        io.stdout(values.json ? `${JSON.stringify({ dryRun: false, ...p, status: s })}\n` : `${formatPlan(p, true)}\n${formatStatus(s)}`);
        return EXIT.ok;
      }
      case 'allowed-signers': {
        only([]);
        const line = allowedSigners(repoAt(values.repo));
        io.stdout(values.json ? `${JSON.stringify(line)}\n` : `${line.line}\n`);
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
