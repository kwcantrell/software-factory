// Shared setup of the remote-factory suites (remote*.test.ts): a bare state remote and a bare code
// remote in a temp dir (World), and two clones as two people (Person). Each test gets its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI, cleanEnv, sshKey, TASK, useKey } from './helpers.ts';
import type { Result } from './helpers.ts';

export const BRANCH = 'factory-state';

export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const p = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(p.status, 0, `git ${args.join(' ')} in ${cwd}: ${p.stderr}`);
  return p.stdout.trim();
}

/** A temp dir with a bare state remote and a bare code remote holding one commit on main. */
export class World {
  readonly tmp: string;
  readonly state: string;
  readonly code: string;
  readonly env: NodeJS.ProcessEnv;
  constructor() {
    this.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'factory-remote-')));
    this.env = cleanEnv(this.tmp);
    this.state = join(this.tmp, 'state.git');
    this.code = join(this.tmp, 'code.git');
    git(['init', '-q', '--bare', '-b', 'main', this.state], this.tmp, this.env);
    git(['init', '-q', '--bare', '-b', 'main', this.code], this.tmp, this.env);
    const seed = join(this.tmp, 'seed');
    git(['init', '-q', '-b', 'main', seed], this.tmp, this.env);
    writeFileSync(join(seed, 'README.md'), 'project\n');
    git(['add', 'README.md'], seed, this.env);
    git(['commit', '-q', '-m', 'initial'], seed, this.env);
    git(['push', '-q', this.code, 'main'], seed, this.env);
  }
  /** git in the bare state remote. */
  remote(args: string[]): string {
    return git(args, this.state, this.env);
  }
  /** Every path ever committed to the state branch. */
  pathsInHistory(): string[] {
    return [...new Set(this.remote(['log', '--format=', '--name-only', BRANCH]).split('\n').filter(Boolean))];
  }
  /** Job directories on the state branch's tip. */
  jobsOnRemote(): string[] {
    return this.remote(['ls-tree', '--name-only', BRANCH]).split('\n').filter((n) => /^\d+-/.test(n));
  }
  cleanup(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

/**
 * One person: a clone of the code remote, their own factory dir, git identity and SSH signing key
 * (a throwaway one, set in the clone's own git config, as each person sets up signing).
 */
export class Person {
  readonly name: string;
  readonly repo: string;
  readonly fdir: string;
  readonly env: NodeJS.ProcessEnv;
  /** The private key's path, and the person's line for an allowed-signers file. */
  readonly key: string;
  readonly signer: string;
  constructor(w: World, name: string, remote: unknown = { url: w.state, branch: BRANCH }) {
    this.name = name;
    this.repo = join(w.tmp, name.toLowerCase());
    this.fdir = join(this.repo, 'factory');
    const email = `${name.toLowerCase()}@example.invalid`;
    this.env = cleanEnv(w.tmp, {
      FACTORY_DIR: this.fdir,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    });
    git(['clone', '-q', w.code, this.repo], w.tmp, this.env);
    ({ key: this.key, signer: this.signer } = sshKey(join(w.tmp, 'keys'), name.toLowerCase(), email));
    useKey(this.repo, this.env, this.key);
    this.config({ remote });
  }
  config(cfg: Record<string, unknown>): void {
    writeFileSync(join(this.repo, 'factory.json'), `${JSON.stringify(cfg)}\n`);
  }
  get jobs(): string {
    return join(this.fdir, 'jobs');
  }
  git(args: string[], cwd = this.repo): string {
    return git(args, cwd, this.env);
  }
  factory(args: string[]): Result {
    const p = spawnSync(process.execPath, [CLI, ...args], { cwd: this.repo, env: this.env, encoding: 'utf8' });
    return { status: p.status, stdout: p.stdout, stderr: p.stderr };
  }
  ok(args: string[]): string {
    const p = this.factory(args);
    assert.equal(p.status, 0, `${this.name}: factory ${args.join(' ')}\n${p.stdout}${p.stderr}`);
    return p.stdout;
  }
  refused(args: string[], message: RegExp): Result {
    const p = this.factory(args);
    assert.equal(p.status, 1, `${this.name}: factory ${args.join(' ')}\n${p.stdout}${p.stderr}`);
    assert.equal(p.stdout, '');
    assert.match(p.stderr, message);
    return p;
  }
  newJob(title: string): string {
    return this.ok(['new', title]).split('\n')[0] as string;
  }
  job(id: string): Record<string, any> {
    return JSON.parse(readFileSync(join(this.jobs, id, 'job.json'), 'utf8'));
  }
  write(id: string, name: string, text: string): void {
    writeFileSync(join(this.jobs, id, name), text);
  }
  startedJob(title: string): string {
    const id = this.newJob(title);
    this.write(id, 'task.md', TASK);
    this.ok(['start', id]);
    return id;
  }
  /** The state checkout has no uncommitted changes and sits exactly on the remote's branch tip. */
  assertInSync(w: World): void {
    assert.equal(this.git(['status', '--porcelain', '--untracked-files=all'], this.jobs), '');
    assert.equal(this.git(['rev-parse', 'HEAD'], this.jobs), w.remote(['rev-parse', BRANCH]));
  }
  /**
   * Make this person's next `times` pushes lose a race: a pre-push hook in their state checkout runs
   * `factory <args>` as `other` first (each of the first `times` pushes), so the other push lands
   * between this one's pull and push.
   */
  raceWith(other: Person, args: string[], times = 1): void {
    const marker = join(this.fdir, 'raced');
    const count = join(this.fdir, 'raced-count');
    rmSync(marker, { force: true });
    writeFileSync(count, '0');
    const hook = join(this.jobs, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      `#!${process.execPath}\n` +
        `const { readFileSync, writeFileSync } = require('node:fs');\n` +
        `const { spawnSync } = require('node:child_process');\n` +
        `const n = Number(readFileSync(${JSON.stringify(count)}, 'utf8'));\n` +
        `if (n < ${times}) {\n` +
        `  writeFileSync(${JSON.stringify(count)}, String(n + 1));\n` +
        `  const p = spawnSync(${JSON.stringify(process.execPath)}, ${JSON.stringify([CLI, ...args])}, ` +
        `{ cwd: ${JSON.stringify(other.repo)}, env: ${JSON.stringify(other.env)}, encoding: 'utf8' });\n` +
        `  writeFileSync(${JSON.stringify(marker)}, String(p.status) + '\\n' + p.stdout + p.stderr);\n` +
        `}\n`,
    );
    chmodSync(hook, 0o755);
  }
  /** What the raced command printed (its exit status first). */
  raced(): string {
    return readFileSync(join(this.fdir, 'raced'), 'utf8');
  }
}

export function withWorld(fn: (w: World) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const w = new World();
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  };
}

// ---------------------------------------------------------------- 1. configuration


/** Someone with push access to the state branch, using plain git: a clone they commit to by hand. */
export function intruder(w: World): { dir: string; git: (args: string[]) => string; edit: (path: string, fn: (job: Record<string, any>) => void) => void } {
  const dir = join(w.tmp, 'mallory');
  const env = cleanEnv(w.tmp, {
    GIT_AUTHOR_NAME: 'Mallory',
    GIT_AUTHOR_EMAIL: 'mallory@example.invalid',
    GIT_COMMITTER_NAME: 'Mallory',
    GIT_COMMITTER_EMAIL: 'mallory@example.invalid',
  });
  git(['clone', '-q', '--branch', BRANCH, w.state, dir], w.tmp, env);
  const run = (args: string[]): string => git(args, dir, env);
  return {
    dir,
    git: run,
    edit: (path, fn) => {
      const job = JSON.parse(readFileSync(join(dir, path), 'utf8'));
      fn(job);
      writeFileSync(join(dir, path), `${JSON.stringify(job, null, 2)}\n`);
    },
  };
}
