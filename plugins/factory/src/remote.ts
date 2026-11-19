// The remote factory: job state shared through a git remote and branch (factory.json `remote`).
//
// The factory dir's `jobs/` becomes a git checkout of that branch (the "state checkout"). The branch
// holds one directory per job (`<id>/job.json`, the station markdown files, `evidence/`) and a
// README.md; never the builders' worktrees, which stay in `<factory dir>/worktrees/`, outside the
// checkout. Every state-changing command pulls first, applies its change, commits only the job's
// directory (`factory: <command> <job id>`) and pushes; a push that loses a race re-pulls and
// retries, and a change to the same job on both sides is refused, never merged. This module is the
// git side of that; factory.ts decides what a command changes and who may change it.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { now, Refused } from './errors.ts';
import { commitArgs } from './signing.ts';

export interface RemoteConfig {
  /** A git URL or path. A path starting with ./ or ../ is relative to factory.json's directory. */
  url: string;
  /** The branch that holds the state, e.g. "factory-state". */
  branch: string;
  /**
   * Repo-relative path to the SSH allowed-signers file `factory merge` checks every state commit of a
   * job against, read from the project checkout's HEAD (src/signing.ts). Null: merge refuses.
   */
  allowed_signers?: string | null;
  /** True turns state commit signing and merge's signature check off (the README warns against it). */
  unsigned_ok?: boolean;
}

/** Who runs this command: the git identity its commits carry. */
export interface Person {
  name: string;
  email: string;
}

export const REMOTE_KEYS = ['url', 'branch', 'allowed_signers', 'unsigned_ok'] as const;

/** Defaults of the optional `remote` keys, filled in by factory.ts loadConfig when `remote` is set. */
export const REMOTE_DEFAULTS: Readonly<Pick<RemoteConfig, 'allowed_signers' | 'unsigned_ok'>> = {
  allowed_signers: null,
  unsigned_ok: false,
};

/** How many times a push that lost a race is retried before the command gives up. */
export const PUSH_ATTEMPTS = 5;

const STATE_README_TITLE = '# Software Factory state\n';
const STATE_README =
  `${STATE_README_TITLE}\n` +
  'This branch is written by the `factory` CLI: one directory per job (`job.json`, the station\n' +
  'markdown files, `evidence/`). Do not edit it by hand; every change is a `factory` command.\n';

/** The remote could not be reached (fetch, clone or push failed for a reason other than a race). */
export class Unreachable extends Refused {}

/** The same job changed here and on the remote, or a pull would overwrite uncommitted files. */
export class Conflict extends Refused {
  readonly jobs: string[];
  constructor(message: string, jobs: string[] = []) {
    super(message);
    this.jobs = jobs;
  }
}

/** A `new` lost the push race: its job was rolled back and the checkout pulled; allocate again. */
export class RaceLost extends Error {}

// ---------------------------------------------------------------- factory.json validation

const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function branchOk(b: string): boolean {
  return (
    b.length <= 200 &&
    BRANCH.test(b) &&
    b !== 'HEAD' &&
    !b.includes('..') &&
    !b.endsWith('/') &&
    !b.endsWith('.') &&
    !b.endsWith('.lock') &&
    !b.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))
  );
}

function urlOk(u: string): boolean {
  return (
    u.trim() !== '' &&
    u.length <= 2048 &&
    !/[\s\u0000-\u001f\u007f]/.test(u) &&
    !u.startsWith('-') &&
    // `<helper>::<address>` runs a remote helper (`ext::` runs a command); never accept one.
    !/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)
  );
}

/** Why a factory.json `remote` value is refused, or null when it is valid (null itself is valid). */
export function remoteProblem(value: unknown): string | null {
  if (value === null) return null;
  const shape = `'remote' must be null or an object like {"url": "git@github.com:org/project-factory.git", "branch": "factory-state"}`;
  if (typeof value !== 'object' || Array.isArray(value)) return shape;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(REMOTE_KEYS as readonly string[]).includes(key)) {
      return `'remote' has unknown key '${key}' (known: ${REMOTE_KEYS.join(', ')})`;
    }
  }
  if (typeof obj.url !== 'string' || !urlOk(obj.url)) {
    return `'remote.url' must be a git URL or path (no spaces or control characters, no leading '-', no '<helper>::' transport)`;
  }
  if (typeof obj.branch !== 'string' || !branchOk(obj.branch)) {
    return `'remote.branch' must be a git branch name like "factory-state"`;
  }
  const signers = obj.allowed_signers;
  if (signers !== undefined && signers !== null && (typeof signers !== 'string' || !signersPathOk(signers))) {
    return `'remote.allowed_signers' must be null or a path inside the repository, relative to its root, like ".factory/allowed_signers" (no leading '/', no '..')`;
  }
  if (obj.unsigned_ok !== undefined && typeof obj.unsigned_ok !== 'boolean') {
    return `'remote.unsigned_ok' must be true or false`;
  }
  if (obj.unsigned_ok === true && typeof signers === 'string') {
    return `'remote.unsigned_ok' is true, which turns signature checks off, but 'remote.allowed_signers' is set: keep only one`;
  }
  return null;
}

/** A repo-relative file path: no leading '/' or '-', no '.', '..' or '.git' segment, no backslash or control character. */
function signersPathOk(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= 1024 &&
    !/[\\\u0000-\u001f\u007f]/.test(p) &&
    !p.startsWith('/') &&
    !p.startsWith('-') &&
    !p.startsWith(':') &&
    p.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}

/** The remote with a ./ or ../ url made absolute against `base` (factory.json's directory). */
export function resolveRemote(remote: RemoteConfig, base: string): RemoteConfig {
  const rel = remote.url.startsWith('./') || remote.url.startsWith('../');
  return { ...remote, url: rel ? resolvePath(base, remote.url) : remote.url };
}

// ---------------------------------------------------------------- git

interface Proc {
  status: number;
  stdout: string;
  stderr: string;
}

function sh(args: string[], cwd: string): Proc {
  const p = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // Never wait on a credential prompt: a command either reaches the remote or says it cannot.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (p.error) return { status: 127, stdout: '', stderr: p.error.message };
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

const said = (p: Proc): string => (p.stderr.trim() || p.stdout.trim()).split(/\r?\n/).filter(Boolean).join(' | ');

function g(args: string[], cwd: string): string {
  const p = sh(args, cwd);
  if (p.status !== 0) throw new Refused(`git ${args.join(' ')} failed in ${cwd}: ${said(p)}`);
  return p.stdout.trim();
}

/** The git identity of whoever runs this command (git config or GIT_AUTHOR_* in the cwd's repo). */
export function identity(): Person {
  const p = sh(['var', 'GIT_AUTHOR_IDENT'], process.cwd());
  const m = /^(.*?) <(.*)> \d+ [+-]\d{4}$/.exec(p.stdout.trim());
  if (p.status !== 0 || !m || !(m[1] ?? '').trim() || !(m[2] ?? '').trim()) {
    throw new Refused(
      'the remote factory records who changed what: set your git identity (git config user.name "<name>"; git config user.email "<email>")',
    );
  }
  return { name: (m[1] as string).trim(), email: (m[2] as string).trim() };
}

export function samePerson(a: Person | null | undefined, b: Person): boolean {
  if (!a) return false;
  return a.email ? a.email.toLowerCase() === b.email.toLowerCase() : a.name === b.name;
}

export const personText = (p: Person): string => `${p.name} <${p.email}>`;

/** The state checkout: the factory dir's jobs/ directory. */
export function stateDir(root: string): string {
  return join(root, 'jobs');
}

export function attached(root: string): boolean {
  return existsSync(join(stateDir(root), '.git'));
}

/**
 * Settings every state checkout carries: `factory.state` marks it (so a command run from inside it
 * finds the project checkout, see factory.ts mainCheckout), and `core.symlinks=false` means a
 * symbolic link on the branch is never materialised as one (the tree check refuses it anyway).
 */
const STATE_CONFIG: [string, string][] = [
  ['factory.state', 'true'],
  ['core.symlinks', 'false'],
];

function markState(dir: string): void {
  for (const [key, value] of STATE_CONFIG) g(['config', key, value], dir);
}

/** Is `dir` (a repository's top level) a remote factory's state checkout, i.e. a factory dir's jobs/? */
export function isStateCheckout(dir: string): boolean {
  if (basename(dir) !== 'jobs') return false;
  const get = (key: string): string => sh(['config', '--local', '--get', key], dir).stdout.trim();
  // factory.lastsync also marks checkouts attached before factory.state existed; keep it.
  return get('factory.state') === 'true' || get('factory.lastsync') !== '';
}

const tracking = (remote: RemoteConfig): string => `refs/remotes/origin/${remote.branch}`;

/** A state commit, signed when this command signs (src/signing.ts; refused when signing is required but not set up). */
function commit(dir: string, me: Person, message: string): void {
  g(['-c', `user.name=${me.name}`, '-c', `user.email=${me.email}`, ...commitArgs(), '-q', '-m', message], dir);
}

function rev(dir: string, ref: string): string {
  return g(['rev-parse', '--verify', '-q', `${ref}^{commit}`], dir);
}

function isAncestor(dir: string, a: string, b: string): boolean {
  return sh(['merge-base', '--is-ancestor', a, b], dir).status === 0;
}

function changed(dir: string, a: string, b: string): string[] {
  return g(['diff', '--name-only', '-z', a, b], dir).split('\0').filter(Boolean);
}

/** Paths with uncommitted changes (tracked or not) in the state checkout. */
function uncommitted(dir: string): string[] {
  const tokens = sh(['status', '--porcelain', '-z', '--untracked-files=all'], dir).stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t.length < 4) continue;
    out.push(t.slice(3));
    if (t[0] === 'R' || t[0] === 'C') i++; // the next token is the original path
  }
  return out;
}

const jobOf = (path: string): string => path.split('/')[0] as string;
const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

function lastSync(dir: string): string {
  return sh(['config', '--get', 'factory.lastsync'], dir).stdout.trim() || 'never';
}

// ---------------------------------------------------------------- attach, pull

function unreachable(remote: RemoteConfig, p: Proc, what: string): Unreachable {
  return new Unreachable(
    `cannot reach the remote factory ${remote.url} (branch ${remote.branch}): ${what} failed: ${said(p) || `git exited ${p.status}`}; ` +
      'nothing was changed - retry the command when the remote is reachable (read commands take --offline to show the last-pulled state)',
  );
}

function emptyDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/**
 * The one directory on the state branch that is not a job: factory-plugin-advisor's shared, redacted
 * friction log (factory.json `advisor.share`). The factory never reads or writes it; a pull brings it
 * into jobs/ like any other file, and job listings skip it (it has no job.json).
 */
export const ADVISOR_DIR = 'advisor';

/** A job directory's name on the state branch: `NNN-slug`, as `factory new` makes it. */
export const JOB_DIR = /^\d+-[a-z0-9-]+$/;

/**
 * Refuse a branch that holds anything but job directories and the state README (say, the code's
 * `main`), and any tree holding a symbolic link or a submodule anywhere: the factory never writes
 * one, and a link checked out into jobs/ would let whoever can push to the branch make this
 * machine's commands write through it, or publish the files it points at.
 */
function checkStateTree(dir: string, remote: RemoteConfig, ref: string): void {
  const entries = g(['ls-tree', '-r', '-z', '--full-tree', ref], dir).split('\0').filter(Boolean);
  const links: string[] = [];
  const names = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const mode = entry.slice(0, entry.indexOf(' '));
    const path = entry.slice(tab + 1);
    if (mode === '120000' || mode === '160000') links.push(path);
    names.add(path.split('/')[0] as string);
    if (path.includes('/')) dirs.add(path.split('/')[0] as string);
  }
  if (links.length > 0) {
    throw new Refused(
      `branch '${remote.branch}' of ${remote.url} holds a symbolic link or submodule (${links.slice(0, 5).join(', ')}), ` +
        'which the factory never writes; refusing to check it out. Remove it from the branch (git rm), then retry',
    );
  }
  const ours = (n: string): boolean =>
    n === 'README.md'
      ? sh(['show', `${ref}:README.md`], dir).stdout.startsWith(STATE_README_TITLE)
      : JOB_DIR.test(n) || (n === ADVISOR_DIR && dirs.has(n));
  const bad = [...names].filter((n) => !ours(n));
  if (bad.length > 0) {
    throw new Refused(
      `branch '${remote.branch}' of ${remote.url} does not hold factory state (it has ${bad.slice(0, 5).join(', ')}); ` +
        'set remote.branch to a branch of its own, such as "factory-state"',
    );
  }
}

function branchExists(dir: string, remote: RemoteConfig): boolean {
  const p = sh(['ls-remote', '--heads', remote.url, `refs/heads/${remote.branch}`], dir);
  if (p.status !== 0) throw unreachable(remote, p, 'ls-remote');
  return p.stdout.trim() !== '';
}

function fetch(dir: string, remote: RemoteConfig): void {
  const p = sh(['fetch', '-q', 'origin', `+refs/heads/${remote.branch}:${tracking(remote)}`], dir);
  if (p.status !== 0) throw unreachable(remote, p, 'fetch');
  sh(['config', 'factory.lastsync', now()], dir);
}

/** Push HEAD to the branch: 'ok', 'race' (the remote moved on) or the failed Proc. */
function push(dir: string, remote: RemoteConfig): 'ok' | 'race' | Proc {
  const p = sh(['push', '-q', 'origin', `HEAD:refs/heads/${remote.branch}`], dir);
  if (p.status === 0) {
    sh(['update-ref', tracking(remote), 'HEAD'], dir);
    sh(['config', 'factory.lastsync', now()], dir);
    return 'ok';
  }
  // "! [rejected] ... (fetch first)" or "(non-fast-forward)", or "! [remote rejected] ... (cannot
  // lock ref ...)" when another push landed between our ref advertisement and our update. Any other
  // rejection (a pre-receive hook, a protected branch) is the server's policy, not a race.
  const race =
    /\[rejected\].*\((fetch first|non-fast-forward)\)/.test(p.stderr) ||
    /\[remote rejected\].*\((cannot lock ref|failed to update ref|incorrect old value)/.test(p.stderr);
  return race ? 'race' : p;
}

/**
 * Make `jobs/` a checkout of the remote branch: nothing to do when it already is; clone it into an
 * empty `jobs/`; or, when the branch does not exist yet, create it there as an orphan branch holding
 * only a README and push it. A `jobs/` that holds local jobs is refused: `factory remote push`
 * publishes those.
 */
export function attach(root: string, remote: RemoteConfig, me: () => Person): 'attached' | 'cloned' | 'created' {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  if (attached(root)) {
    const branch = sh(['symbolic-ref', '--short', '-q', 'HEAD'], dir).stdout.trim();
    if (branch !== remote.branch) {
      throw new Refused(
        `${dir} is a checkout of branch '${branch}', but factory.json's remote.branch is '${remote.branch}'; ` +
          `move ${dir} aside and run \`factory init\` to attach the configured branch`,
      );
    }
    if (sh(['config', '--get', 'remote.origin.url'], dir).stdout.trim() !== remote.url) {
      g(['remote', 'set-url', 'origin', remote.url], dir);
    }
    markState(dir);
    return 'attached';
  }
  if (readdirSync(dir).length > 0) {
    throw new Refused(
      `${dir} holds local jobs and is not a checkout of ${remote.url} (branch ${remote.branch}); ` +
        'run `factory remote push` to publish them there',
    );
  }
  if (branchExists(root, remote)) {
    const p = sh(
      ['clone', '-q', ...STATE_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]), '--single-branch', '--branch', remote.branch, '--', remote.url, dir],
      root,
    );
    if (p.status !== 0) {
      emptyDir(dir);
      throw unreachable(remote, p, 'clone');
    }
    try {
      checkStateTree(dir, remote, 'HEAD');
    } catch (error) {
      emptyDir(dir);
      throw error;
    }
    sh(['config', 'factory.lastsync', now()], dir);
    return 'cloned';
  }
  const person = me();
  try {
    g(['init', '-q', '-b', remote.branch], dir);
    markState(dir);
    g(['remote', 'add', '-t', remote.branch, 'origin', remote.url], dir);
    writeFileSync(join(dir, 'README.md'), STATE_README);
    g(['add', 'README.md'], dir);
    commit(dir, person, 'factory: init state branch');
    const pushed = push(dir, remote);
    if (pushed === 'race') {
      // Someone created the branch first: use theirs.
      fetch(dir, remote);
      checkStateTree(dir, remote, tracking(remote));
      g(['reset', '-q', '--hard', tracking(remote)], dir);
    } else if (pushed !== 'ok') {
      throw unreachable(remote, pushed, 'push');
    }
  } catch (error) {
    emptyDir(dir);
    throw error;
  }
  return 'created';
}

function jobDirs(dir: string, ref: string): string[] {
  return g(['ls-tree', '--name-only', '-z', ref], dir).split('\0').filter((n) => JOB_DIR.test(n));
}

/** The first of `mine` whose number another job of `theirs` already has. */
function numberClash(mine: string[], theirs: string[]): { mine: string; message: string } | null {
  for (const id of mine) {
    const other = theirs.find((t) => Number.parseInt(t, 10) === Number.parseInt(id, 10) && t !== id);
    if (other) {
      return {
        mine: id,
        message: `job number ${Number.parseInt(id, 10)} is ${id} here but ${other} on the remote; refusing to publish two jobs with one number`,
      };
    }
  }
  return null;
}

/**
 * Bring the remote's commits into the checkout. Fast-forwards when only the remote moved; keeps
 * local unpushed commits; when both moved, replays the local commits on top unless both touched the
 * same job (a Conflict naming it). Uncommitted files (station files waiting for their command) are
 * kept, and a pull that would overwrite one is a Conflict.
 */
function integrate(dir: string, remote: RemoteConfig): void {
  const theirs = tracking(remote);
  const head = rev(dir, 'HEAD');
  const up = rev(dir, theirs);
  if (head === up || isAncestor(dir, up, head)) return;
  checkStateTree(dir, remote, theirs);
  const local = uncommitted(dir);
  if (isAncestor(dir, head, up)) {
    const p = sh(['merge', '--ff-only', '-q', theirs], dir);
    if (p.status !== 0) {
      const theirPaths = changed(dir, head, up);
      const clash = uniq(local.filter((f) => theirPaths.includes(f)));
      throw new Conflict(
        `pulling ${remote.branch} would overwrite uncommitted files in ${dir}` +
          `${clash.length ? ` (${clash.join(', ')})` : ''}: ${said(p)}; ` +
          'publish them with `factory remote push`, or move them aside, then retry',
        uniq(clash.map(jobOf)),
      );
    }
    return;
  }
  const base = g(['merge-base', head, up], dir);
  const ours = changed(dir, base, head);
  const theirPaths = changed(dir, base, up);
  const clash = uniq(ours.map(jobOf)).filter((j) => theirPaths.some((f) => jobOf(f) === j));
  if (clash.length > 0) {
    const files = uniq([...ours, ...theirPaths].filter((f) => clash.includes(jobOf(f))));
    throw new Conflict(
      `${clash.join(', ')} changed both here and on the remote (${files.join(', ')}); refusing to merge job state`,
      clash,
    );
  }
  // A job created here whose number the remote now gives another job: replaying it would leave two
  // jobs with one number (`factory 7` ambiguous). `factory new` allocates afresh instead.
  const before = new Set(jobDirs(dir, base));
  const clashed = numberClash(jobDirs(dir, head).filter((n) => !before.has(n)), jobDirs(dir, up));
  if (clashed) throw new Conflict(clashed.message, [clashed.mine]);
  const dirty = uniq(local.filter((f) => theirPaths.includes(f)));
  if (dirty.length > 0) {
    throw new Conflict(
      `pulling ${remote.branch} would overwrite uncommitted files in ${dir} (${dirty.join(', ')}); ` +
        'publish them with `factory remote push`, or move them aside, then retry',
      uniq(dirty.map(jobOf)),
    );
  }
  const p = sh(['rebase', '-q', '--autostash', theirs], dir);
  if (p.status !== 0) {
    sh(['rebase', '--abort'], dir);
    throw new Conflict(`could not replay local state commits onto ${remote.branch}: ${said(p)}`);
  }
}

/** Attach if needed, fetch, and integrate: the first step of every state-changing command. */
export function pull(root: string, remote: RemoteConfig, me: () => Person): void {
  attach(root, remote, me);
  const dir = stateDir(root);
  fetch(dir, remote);
  integrate(dir, remote);
}

/**
 * The first step of a read command: pull, unless `offline`. When the pull cannot happen (offline,
 * unreachable, a local conflict) the command still runs, on the last-pulled state, and says so.
 */
export function pullForRead(root: string, remote: RemoteConfig, offline: boolean, me: () => Person): string | null {
  const dir = stateDir(root);
  const last = (): string => (attached(root) ? lastSync(dir) : 'never');
  if (offline) return `--offline: showing the last-pulled state of ${remote.url} (branch ${remote.branch}; last sync ${last()})`;
  try {
    pull(root, remote, me);
    return null;
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return `${error.message}\nshowing the last-pulled state (last sync ${last()})`;
  }
}

// ---------------------------------------------------------------- publish

/** A job directory's files, to put back exactly if the command cannot be published. */
export type Snapshot = Map<string, Buffer> | null;

export function snapshot(dir: string): Snapshot {
  if (!existsSync(dir)) return null;
  const files = new Map<string, Buffer>();
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) files.set(r, readFileSync(join(dir, r)));
      else {
        // Never follow a link: reading through it could publish the file it points at.
        throw new Refused(
          `${join(dir, r)} is not a regular file (a symbolic link?); the factory never writes one and refuses to read or publish it - remove it, then retry`,
        );
      }
    }
  };
  walk('');
  return files;
}

function restore(dir: string, snap: Snapshot): void {
  rmSync(dir, { recursive: true, force: true });
  if (snap === null) return;
  mkdirSync(dir, { recursive: true });
  for (const [rel, data] of snap) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }
}

export interface PublishOptions {
  /** The job dir as it was before the command, restored if the command cannot be published. */
  snap: Snapshot;
  /** Undo side effects outside the state checkout (a new worktree), newest first, on rollback. */
  undo: (() => void)[];
  /** On a lost race, roll back and throw RaceLost instead of replaying (for `new`: a fresh id). */
  redo?: boolean;
}

/**
 * Commit the job's directory as `factory: <command> <job id>` and push it. A push that loses a race
 * re-pulls and retries, up to PUSH_ATTEMPTS times. If the same job changed on the remote meanwhile,
 * the command is refused: the local copy of the job is reset to the remote's (the attempted version
 * is kept under <factory dir>/conflicts/) and the checkout matches the remote. Any other failure
 * puts the job dir and the checkout back as they were before the command: nothing is half-done.
 */
export function publish(root: string, remote: RemoteConfig, jobId: string, command: string, me: Person, opts: PublishOptions): void {
  const dir = stateDir(root);
  const pre = rev(dir, 'HEAD');
  const runUndo = (): void => {
    for (const step of [...opts.undo].reverse()) {
      try {
        step();
      } catch {
        // best effort: the refusal says what happened to the state
      }
    }
  };
  const rollback = (): void => {
    if (sh(['reset', '-q', '--keep', pre], dir).status !== 0) sh(['reset', '-q', '--mixed', pre], dir);
    restore(join(dir, jobId), opts.snap);
    runUndo();
  };
  try {
    g(['add', '-A', '--', jobId], dir);
    if (sh(['diff', '--cached', '--quiet'], dir).status !== 0) commit(dir, me, `factory: ${command} ${jobId}`);
  } catch (error) {
    rollback();
    throw error;
  }
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    if (g(['rev-list', '--count', `${tracking(remote)}..HEAD`], dir) === '0') return;
    const pushed = push(dir, remote);
    if (pushed === 'ok') return;
    if (pushed !== 'race') {
      rollback();
      throw unreachable(remote, pushed, 'push');
    }
    try {
      fetch(dir, remote);
    } catch (error) {
      rollback();
      throw error;
    }
    if (opts.redo) {
      rollback();
      integrate(dir, remote);
      throw new RaceLost();
    }
    try {
      integrate(dir, remote);
    } catch (error) {
      if (!(error instanceof Conflict) || !error.jobs.includes(jobId)) {
        rollback();
        throw error;
      }
      const kept = join(root, 'conflicts', `${jobId}-${now().replace(/[-:]/g, '')}`);
      cpSync(join(dir, jobId), kept, { recursive: true });
      if (sh(['reset', '-q', '--keep', tracking(remote)], dir).status !== 0) {
        g(['reset', '-q', '--mixed', tracking(remote)], dir);
        sh(['checkout', '-q', tracking(remote), '--', jobId], dir);
      }
      sh(['clean', '-q', '-fd', '--', jobId], dir);
      runUndo();
      throw new Conflict(
        `${error.message}. Your \`factory ${command}\` was not applied: ${jobId} is now the remote's version, ` +
          `and the version you tried to publish is in ${kept}. Read the remote's change, then re-run the command if it still applies`,
        error.jobs,
      );
    }
  }
  rollback();
  throw new Refused(`lost the race to push ${remote.branch} ${PUSH_ATTEMPTS} times; nothing was changed - retry the command`);
}

// ---------------------------------------------------------------- remote status / push

export function remoteStatus(root: string, remote: RemoteConfig, offline: boolean): { text: string; warning: string | null } {
  const dir = stateDir(root);
  let warning: string | null = null;
  if (!attached(root)) {
    return {
      text: `remote:     ${remote.url}\nbranch:     ${remote.branch}\ncheckout:   ${dir} (not attached; run \`factory init\`, or \`factory remote push\` to publish local jobs)\nlast sync:  never\n`,
      warning,
    };
  }
  if (offline) {
    warning = '--offline: ahead/behind are as of the last sync';
  } else {
    try {
      fetch(dir, remote);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      warning = `${error.message}\nahead/behind are as of the last sync`;
    }
  }
  const counts = sh(['rev-list', '--left-right', '--count', `HEAD...${tracking(remote)}`], dir).stdout.trim().split(/\s+/);
  const files = uncommitted(dir).length;
  return {
    text:
      `remote:     ${remote.url}\nbranch:     ${remote.branch}\ncheckout:   ${dir}\n` +
      `ahead:      ${counts[0] ?? '?'}\nbehind:     ${counts[1] ?? '?'}\n` +
      `uncommitted: ${files} file${files === 1 ? '' : 's'}\nlast sync:  ${lastSync(dir)}\n`,
    warning,
  };
}

/** Push HEAD, replaying onto the remote after a lost race; on failure, undo with `undo` and throw. */
function pushAll(dir: string, remote: RemoteConfig, undo: () => void): void {
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    if (g(['rev-list', '--count', `${tracking(remote)}..HEAD`], dir) === '0') return;
    const pushed = push(dir, remote);
    if (pushed === 'ok') return;
    try {
      if (pushed !== 'race') throw unreachable(remote, pushed, 'push');
      fetch(dir, remote);
      integrate(dir, remote);
    } catch (error) {
      undo();
      throw error;
    }
  }
  undo();
  throw new Refused(`lost the race to push ${remote.branch} ${PUSH_ATTEMPTS} times; nothing was changed - retry`);
}

/**
 * `factory remote push`: publish every local job to the remote. A `jobs/` that is not yet a checkout
 * (local mode until now) becomes one, keeping its job ids and history; job numbers already used on
 * the remote by a different job, or the same job with different content, are refused. An attached
 * checkout commits whatever is uncommitted (say, jobs changed while `remote` was removed) and pushes.
 */
export function remotePush(root: string, remote: RemoteConfig, me: Person): string {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  if (attached(root)) {
    fetch(dir, remote);
    integrate(dir, remote);
    // Jobs made here while the remote was off: one may carry a number the remote has since given away.
    const tracked = jobDirs(dir, 'HEAD');
    const fresh = uniq(uncommitted(dir).map(jobOf)).filter((n) => JOB_DIR.test(n) && !tracked.includes(n));
    const clashed = numberClash(fresh, tracked);
    if (clashed) throw new Refused(`${clashed.message}; nothing was pushed - close and recreate ${clashed.mine} in remote mode`);
    const pre = rev(dir, 'HEAD');
    g(['add', '-A'], dir);
    if (sh(['diff', '--cached', '--quiet'], dir).status !== 0) commit(dir, me, 'factory: remote push');
    pushAll(dir, remote, () => sh(['reset', '-q', '--mixed', pre], dir));
    return `${dir} is in sync with ${remote.url} (branch ${remote.branch})\n`;
  }
  const before = readdirSync(dir);
  const local = before.filter((n) => existsSync(join(dir, n, 'job.json')));
  if (before.length === 0) {
    attach(root, remote, () => me);
    return `attached ${dir} to ${remote.url} (branch ${remote.branch}); there were no local jobs to push\n`;
  }
  const exists = branchExists(root, remote);
  try {
    g(['init', '-q', '-b', remote.branch], dir);
    markState(dir);
    g(['remote', 'add', '-t', remote.branch, 'origin', remote.url], dir);
    if (exists) {
      fetch(dir, remote);
      checkStateTree(dir, remote, tracking(remote));
      const theirs = g(['ls-tree', '--name-only', '-z', tracking(remote)], dir).split('\0').filter((n) => /^\d+-/.test(n));
      const num = (id: string): number => Number.parseInt(id, 10);
      for (const id of local) {
        const other = theirs.find((t) => num(t) === num(id) && t !== id);
        if (other) {
          throw new Refused(
            `job number ${num(id)} is ${id} here but ${other} on ${remote.url} (branch ${remote.branch}); ` +
              'push into a new branch, or close and recreate one of them',
          );
        }
      }
      g(['reset', '-q', '--mixed', tracking(remote)], dir);
      const differ = local.filter((id) => theirs.includes(id) && g(['status', '--porcelain', '--', id], dir) !== '');
      if (differ.length > 0) {
        throw new Refused(
          `${differ.join(', ')} already exist on ${remote.url} (branch ${remote.branch}) with different content; nothing was pushed`,
        );
      }
      // Files only the remote has show up as deleted here: check them out.
      g(['checkout', '-q', '--', '.'], dir);
    } else if (!existsSync(join(dir, 'README.md'))) {
      writeFileSync(join(dir, 'README.md'), STATE_README);
    }
    g(['add', '-A'], dir);
    if (sh(['diff', '--cached', '--quiet'], dir).status !== 0) commit(dir, me, 'factory: remote push');
    if (!exists) {
      const pushed = push(dir, remote);
      if (pushed === 'race') throw new Refused(`branch ${remote.branch} appeared on ${remote.url} meanwhile; nothing was pushed - retry`);
      if (pushed !== 'ok') throw unreachable(remote, pushed, 'push');
    } else {
      pushAll(dir, remote, () => undefined);
    }
  } catch (error) {
    // Back to a plain local jobs/ dir, exactly as before (the working files were never changed,
    // except remote-only files checked out above, which are removed again).
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    for (const n of readdirSync(dir)) if (!before.includes(n)) rmSync(join(dir, n), { recursive: true, force: true });
    throw error;
  }
  sh(['config', 'factory.lastsync', now()], dir);
  return `pushed ${local.length} job${local.length === 1 ? '' : 's'} from ${dir} to ${remote.url} (branch ${remote.branch}); ${dir} is now its checkout\n`;
}
