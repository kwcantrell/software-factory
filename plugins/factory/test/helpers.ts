// Shared test setup: a throwaway git repo with FACTORY_DIR pointing inside it, and a way to run the
// real CLI as a subprocess. Never inherits the developer's git config, repo or factory dir.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(PLUGIN, 'src', 'cli.ts');
export const TASK = '# A job\n\n## Acceptance criteria\n\n1. It works.\n';

export interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The environment every test process gets: no inherited GIT_* / FACTORY_* / npm_* settings. */
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('FACTORY_') || k.toLowerCase().startsWith('npm_')) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

export class Repo {
  readonly tmp: string;
  readonly repo: string;
  readonly fdir: string;
  env: NodeJS.ProcessEnv;

  constructor() {
    this.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'factory-test-')));
    this.repo = join(this.tmp, 'repo');
    this.fdir = join(this.repo, 'factory');
    this.env = cleanEnv(this.tmp, { FACTORY_DIR: this.fdir });
    mkdirSync(this.repo);
    this.git(['init', '-q', '-b', 'main']);
    writeFileSync(join(this.repo, 'README.md'), 'test repo\n');
    this.git(['add', 'README.md']);
    this.git(['commit', '-q', '-m', 'initial']);
  }

  cleanup(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }

  git(args: string[], cwd?: string): string {
    const p = spawnSync('git', args, { cwd: cwd ?? this.repo, env: this.env, encoding: 'utf8' });
    assert.equal(p.status, 0, `git ${args.join(' ')}: ${p.stderr}`);
    return p.stdout.trim();
  }

  factory(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Result {
    const p = spawnSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? this.repo,
      env: opts.env ?? this.env,
      encoding: 'utf8',
    });
    return { status: p.status, stdout: p.stdout, stderr: p.stderr };
  }

  ok(args: string[], opts: { cwd?: string } = {}): string {
    const p = this.factory(args, opts);
    assert.equal(p.status, 0, p.stdout + p.stderr);
    return p.stdout;
  }

  jobDir(id: string): string {
    return join(this.fdir, 'jobs', id);
  }

  write(id: string, name: string, text: string): void {
    writeFileSync(join(this.jobDir(id), name), text);
  }

  /** The job's job.json, parsed. */
  job(id: string): Record<string, any> {
    return JSON.parse(readFileSync(join(this.jobDir(id), 'job.json'), 'utf8'));
  }

  newJob(title = 'Add a thing'): string {
    return this.ok(['new', title]).split('\n')[0] as string;
  }

  startedJob(): string {
    const id = this.newJob();
    this.write(id, 'task.md', TASK);
    this.ok(['start', id]);
    return id;
  }

  commitIn(id: string, filename = 'thing.txt', content = 'thing\n'): string {
    const wt = this.job(id).worktree as string;
    writeFileSync(join(wt, filename), content);
    this.git(['add', filename], wt);
    this.git(['commit', '-q', '-m', `Change ${filename}`], wt);
    return wt;
  }

  /** A job driven through build, proof and one approving review round to ship. */
  shippedJob(filename = 'thing.txt', content = 'thing\n'): string {
    const id = this.startedJob();
    this.commitIn(id, filename, content);
    for (const name of ['build.md', 'proof.md', 'review-1-solo.md']) this.write(id, name, '# notes\n');
    this.ok(['built', id]);
    this.ok(['proof', id, 'pass']);
    this.ok(['round', id, 'solo']);
    this.ok(['verdict', id, 'solo', 'approve']);
    assert.equal(this.job(id).stage, 'ship');
    return id;
  }
}

/** A fresh Repo per test, removed afterwards. */
export function withRepo(fn: (r: Repo) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const r = new Repo();
    try {
      await fn(r);
    } finally {
      r.cleanup();
    }
  };
}
