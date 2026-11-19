// The PreToolUse hook on Bash (hooks/hooks.json runs `node src/cli.ts hook`). For a command that
// creates commits (`git commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, also with
// `git -C <dir>` and `-c k=v`, and the factory CLI's state-changing commands in remote mode), in a
// repository that requires signing, it denies the call when signing cannot work or the command would
// turn it off. Everywhere else it prints nothing. It never rewrites a command, and any failure of its
// own (an exception, a subprocess that times out) means nothing is printed: it never blocks because
// it broke. Claude Code itself ends it after the 5 s timeout in hooks.json, which also allows.
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { findRepo, requirement, unusable } from './signing.ts';

/** Git subcommands that create commits. */
export const COMMIT_COMMANDS: ReadonlySet<string> = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am']);

/** The factory CLI's commands that make state commits in remote mode. */
const FACTORY_STATE = new Set([
  'init', 'new', 'start', 'spec', 'approve', 'built', 'proof', 'round', 'verdict', 'human', 'resume',
  'merge', 'rework', 'close', 'note', 'claim',
]);
const FACTORY_SUB: Record<string, ReadonlySet<string>> = { followup: new Set(['add', 'done', 'drop']), remote: new Set(['push']) };

/** Git global options that take their value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '--list-cmds', '--attr-source']);

/**
 * Splits a shell command into simple commands (on `&&`, `||`, `;`, `|`, `&`, newlines and
 * parentheses outside quotes), each a list of words with quotes removed. Not a full shell parser:
 * enough to find the commands and their arguments.
 */
export function segments(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1] as string)) i++;
        word += command[i];
      }
    } else if (c === '\\') {
      if (command[i + 1] === '\n') i++;
      else if (i + 1 < command.length) {
        word += command[++i];
        inWord = true;
      }
    } else if (c === '#' && !inWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<')) {
      word += c;
      inWord = true;
    } else if (';&|\n()'.includes(c)) {
      endSegment();
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return out;
}

/** One command that makes commits, and where it runs. */
export interface CommitCommand {
  kind: 'git' | 'factory';
  /** The directory it acts on (after `cd` and `git -C`). */
  dir: string;
  /** git's global options other than -C (`-c k=v`, `--git-dir=...`), as words. */
  gitArgs: string[];
  /** The `-c key=value` pairs, keys lowercased. */
  configs: [string, string][];
  /** The subcommand and its arguments. */
  args: string[];
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup']);

/** Where a `factory` CLI call's subcommand starts in `words`, or -1. */
function factoryAt(words: string[]): number {
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i] as string;
    if (w.startsWith('-')) continue;
    const parts = w.split('/');
    const isBin = basename(w) === 'factory';
    // node <...>/factory/src/cli.ts, or the plugin cache's <...>/factory/<version>/src/cli.ts
    const n = parts.length;
    const isEntry = w.endsWith('src/cli.ts') && (parts[n - 3] === 'factory' || (parts[n - 4] === 'factory' && /^\d/.test(parts[n - 3] ?? '')));
    if (!isBin && !isEntry) continue;
    const sub = words[i + 1] as string;
    if (FACTORY_STATE.has(sub)) return i + 1;
    const second = FACTORY_SUB[sub];
    if (second?.has(words[i + 2] ?? '')) return i + 1;
  }
  return -1;
}

/** The commands in `command` (run from `cwd`) that create commits. */
export function commitCommands(command: string, cwd: string): CommitCommand[] {
  const found: CommitCommand[] = [];
  let dir = cwd;
  for (const seg of segments(command)) {
    let i = 0;
    while (i < seg.length && (ASSIGNMENT.test(seg[i] as string) || WRAPPERS.has(seg[i] as string))) i++;
    const words = seg.slice(i);
    const head = words[0];
    if (head === undefined) continue;
    if (head === 'cd' || head === 'pushd') {
      const to = words[1];
      if (to === undefined) dir = homedir();
      else if (to !== '-') dir = resolve(dir, to.startsWith('~') ? `${homedir()}${to.slice(1)}` : to);
      continue;
    }
    if (basename(head) === 'git') {
      let gitDir = dir;
      const gitArgs: string[] = [];
      const configs: [string, string][] = [];
      let j = 1;
      for (; j < words.length; j++) {
        const w = words[j] as string;
        if (w === '-C') {
          const to = words[++j] ?? '';
          gitDir = isAbsolute(to) ? to : resolve(gitDir, to);
        } else if (w === '-c') {
          const kv = words[++j] ?? '';
          gitArgs.push('-c', kv);
          const eq = kv.indexOf('=');
          configs.push(eq === -1 ? [kv.toLowerCase(), 'true'] : [kv.slice(0, eq).toLowerCase(), kv.slice(eq + 1)]);
        } else if (GIT_VALUE_OPTIONS.has(w)) {
          gitArgs.push(w, words[++j] ?? '');
        } else if (w.startsWith('-')) {
          gitArgs.push(w);
        } else break;
      }
      const args = words.slice(j);
      const sub = args[0];
      if (sub === undefined || !COMMIT_COMMANDS.has(sub)) continue;
      if (args.includes('--abort') || args.includes('--quit')) continue;
      found.push({ kind: 'git', dir: gitDir, gitArgs, configs, args });
      continue;
    }
    const at = factoryAt(words);
    if (at !== -1) found.push({ kind: 'factory', dir, gitArgs: [], configs: [], args: words.slice(at) });
  }
  return found;
}

const FALSE = new Set(['false', 'no', 'off', '0', '']);

/** How a git command would turn signing off, or null. */
export function turnsOff(c: CommitCommand): string | null {
  if (c.args.includes('--no-gpg-sign')) return '--no-gpg-sign';
  for (const [k, v] of c.configs) {
    if (k === 'commit.gpgsign' && FALSE.has(v.toLowerCase())) return `-c commit.gpgsign=${v}`;
    if (k === 'gpg.format' && v.toLowerCase() !== 'ssh') return `-c gpg.format=${v}`;
  }
  return null;
}

const FIX = 'Run `factory-signing status` (the factory-signing skill) for the fix; never bypass signing.';

/** The reason to deny `command`, or null to allow. Throws on its own failures (the caller allows). */
export function denyReason(command: string, cwd: string): string | null {
  for (const c of commitCommands(command, cwd)) {
    const gitArgs = c.gitArgs.filter((_, i, all) => all[i] !== '-c' && all[i - 1] !== '-c');
    const repo = findRepo(c.dir, gitArgs);
    if (repo === null) continue;
    const req = requirement(repo, gitArgs);
    if (c.kind === 'factory' ? !req.factoryRemote : !req.required) continue;
    const what = c.kind === 'git' ? `git ${c.args[0]}` : `factory ${c.args.slice(0, FACTORY_SUB[c.args[0] ?? ''] ? 2 : 1).join(' ')}`;
    const why = `${repo.top} requires signed commits (${req.reasons.join('; ')})`;
    if (c.kind === 'git') {
      const off = turnsOff(c);
      if (off) return `factory-signing: ${what} with ${off} would make an unsigned commit, but ${why}. ${FIX}`;
    }
    const problem = unusable(repo, c.gitArgs);
    if (problem) return `factory-signing: ${what} would fail or make an unsigned commit: ${problem}, and ${why}. ${FIX}`;
  }
  return null;
}

/** The hook's output for a raw PreToolUse payload: a deny decision, or '' to allow silently. */
export function decide(payload: string): string {
  try {
    const data: unknown = JSON.parse(payload);
    if (typeof data !== 'object' || data === null) return '';
    const d = data as Record<string, unknown>;
    if (d.tool_name !== undefined && d.tool_name !== 'Bash') return '';
    const input = d.tool_input;
    const command = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined;
    if (typeof command !== 'string') return '';
    const cwd = typeof d.cwd === 'string' && d.cwd !== '' ? d.cwd : process.cwd();
    const reason = denyReason(command, cwd);
    if (reason === null) return '';
    const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.replace(/\s*\n\s*/g, ' ') } };
    return `${JSON.stringify(out)}\n`;
  } catch {
    return '';
  }
}
