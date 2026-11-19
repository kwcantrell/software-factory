// The UserPromptSubmit hook: when the prompt or the working directory is about software-factory, it
// adds one line of context telling Claude to run factory-plugin-discover's `match` first, at most once
// per session.
//
// Input (Claude Code's UserPromptSubmit hook input, https://code.claude.com/docs/en/hooks#userpromptsubmit-input):
//   {"session_id","transcript_path","cwd","permission_mode","hook_event_name":"UserPromptSubmit","prompt"}
// Output (exit 0, https://code.claude.com/docs/en/hooks#userpromptsubmit-decision-control):
//   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<line>"}}
//
// It never blocks (no `decision`, never exit 2), never throws and prints nothing when the prompt is not
// about software-factory. It imports only node built-ins and config.ts, to keep its start-up cheap.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type Env, hintedSessions, rememberSession } from './config.ts';

export const HINT =
  'factory-plugin-discover: this looks like software-factory work. Before starting, use the factory-plugin-discover skill: run its `match` command with a one-line summary of the task and use the installed plugin or skill it points to.';

/**
 * Prompt keywords, matched case-insensitively. Chosen from what the marketplace plugins cover: the
 * `/factory:<skill>` commands, the product name, `factory` CLI commands, the factory's own files
 * (`factory.json`, `factory/jobs`), and the marketplace plugin names. Bare generic words ("factory",
 * "job", "review", "merge", "docs", "release", "plugin") are left out on purpose: they would fire on
 * unrelated work in every other project. `factory` commands that read as plain English after the word
 * "factory" (`new`, `start`, `path`, `config`, ...) count only as code: in backticks or after `-- `.
 */
export const PROMPT_PATTERNS: readonly RegExp[] = [
  /(?:^|[^\w/])\/factory:[a-z]/i,
  /\bsoftware[ -]factory\b/i,
  /\bfactory (?:spec|approve|built|proof|round|verdict|resume|merge|rework|followups?|stats|upgrade|dashboard|status)\b/i,
  /(?:`|\s--\s)factory (?:init|new|start|human|close|config|note|path)\b/i,
  /\bfactory\.json\b/i,
  /\bfactory\/(?:jobs|worktrees)\b/i,
  /\bfactory-(?:dev|docs|plugin-(?:builder|advisor|discover))\b/i,
];

/** The git remote that makes a checkout software-factory work. */
export const REPOS: readonly RegExp[] = [/[/:]kwcantrell\/software-factory(?:\.git)?\/?$/i];

/** The marketplace name in a checkout's `.claude-plugin/marketplace.json`. */
export const MARKETPLACE = 'software-factory';

export function promptMatches(prompt: string): boolean {
  return PROMPT_PATTERNS.some((p) => p.test(prompt));
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The `[remote "origin"]` url in a git config file's text. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inOrigin = /^\[remote\s+"origin"\]$/.test(line);
    else if (inOrigin) {
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (m !== null) return (m[1] ?? '').trim();
    }
  }
  return undefined;
}

interface Git {
  /** The work tree's root (where `.git` is). */
  root: string;
  /** The git config file. */
  config: string;
  /** The main checkout's root: the same as `root`, except in a linked worktree. */
  main: string;
}

/** The repo roots and git config path for `cwd`'s work tree (also a linked worktree's `.git` file). */
function gitOf(cwd: string): Git | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    let isDir: boolean | undefined;
    try {
      isDir = statSync(dotGit).isDirectory();
    } catch {
      isDir = undefined;
    }
    if (isDir === true) return { root: dir, config: join(dotGit, 'config'), main: dir };
    if (isDir === false) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? '')?.[1]?.trim();
      if (gitdir === undefined) return null;
      const abs = resolve(dir, gitdir);
      const commondir = read(join(abs, 'commondir'))?.trim();
      const common = commondir === undefined ? abs : resolve(abs, commondir);
      return { root: dir, config: join(common, 'config'), main: basename(common) === '.git' ? dirname(common) : dir };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The top-level `name` of a marketplace manifest, or undefined. */
function marketplaceName(path: string): unknown {
  try {
    const parsed: unknown = JSON.parse(read(path) ?? '');
    return isObject(parsed) ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Does this checkout use the factory: a `factory.json`, or a `factory/jobs/` directory, at its root? */
function usesFactory(root: string): boolean {
  return existsSync(join(root, 'factory.json')) || isDirectory(join(root, 'factory', 'jobs'));
}

/**
 * Is `cwd` inside a software-factory checkout (its `origin`, or a `software-factory` marketplace
 * manifest), or inside a repo that uses the factory? Linked worktrees count, through their main
 * checkout.
 */
export function cwdMatches(cwd: string): boolean {
  const git = gitOf(cwd);
  if (git === null) return false;
  const url = originUrl(read(git.config) ?? '');
  if (url !== undefined && REPOS.some((r) => r.test(url))) return true;
  for (const root of new Set([git.root, git.main])) {
    // A checkout without that origin (a fork, a local clone) still has its manifest.
    if (marketplaceName(join(root, '.claude-plugin', 'marketplace.json')) === MARKETPLACE) return true;
    if (usesFactory(root)) return true;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The hook's stdout for one input: the additionalContext JSON line, or '' to add nothing. Never
 * throws; any problem means no hint.
 */
export function hookOutput(raw: string, env: Env): string {
  try {
    if (!raw.includes('UserPromptSubmit')) return '';
    const input: unknown = JSON.parse(raw);
    if (!isObject(input) || input.hook_event_name !== 'UserPromptSubmit') return '';
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined;
    if (!promptMatches(prompt) && (cwd === undefined || !cwdMatches(cwd))) return '';
    const session = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : undefined;
    if (session !== undefined) {
      if (hintedSessions(env).includes(session)) return '';
      // Remember it first: if it cannot be stored, the catch below drops the hint, so a broken
      // config dir never means a hint on every prompt.
      rememberSession(env, session);
    }
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: HINT } })}\n`;
  } catch {
    return '';
  }
}
