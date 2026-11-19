// The remote factory (factory.json `remote`): job state shared through a git branch. Every test
// drives the real CLI as a subprocess. The remote is a bare repo in a temp dir; two clones of a
// shared code repo act as two people (Ann and Bob), each with their own factory dir.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mapPath } from '../src/dashboard.ts';
import { CLI, cleanEnv, PLUGIN, Repo, TASK, withRepo } from './helpers.ts';
import type { Result } from './helpers.ts';

const BRANCH = 'factory-state';

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const p = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(p.status, 0, `git ${args.join(' ')} in ${cwd}: ${p.stderr}`);
  return p.stdout.trim();
}

/** A temp dir with a bare state remote and a bare code remote holding one commit on main. */
class World {
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

/** One person: a clone of the code remote, their own factory dir and git identity. */
class Person {
  readonly name: string;
  readonly repo: string;
  readonly fdir: string;
  readonly env: NodeJS.ProcessEnv;
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

function withWorld(fn: (w: World) => void | Promise<void>): () => Promise<void> {
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

test('remote config: valid values load, bad shapes and unknown sub-keys are refused', withRepo((r) => {
  const cfg = join(r.repo, 'factory.json');
  writeFileSync(cfg, JSON.stringify({ remote: { url: 'git@github.com:org/project-factory.git', branch: 'factory/state' } }));
  // A read command still runs when the remote cannot be reached; it says so on stderr.
  const p = r.factory(['config']);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout).remote, { url: 'git@github.com:org/project-factory.git', branch: 'factory/state' });
  assert.match(p.stderr, /showing the last-pulled state/);
  writeFileSync(cfg, '{"remote": null}');
  assert.equal(JSON.parse(r.ok(['config'])).remote, null);
  const bad: [unknown, RegExp][] = [
    ['https://x/y.git', /'remote' must be null or an object/],
    [[], /'remote' must be null or an object/],
    [{ url: 'x', branch: 'b', token: 'secret' }, /'remote' has unknown key 'token' \(known: url, branch\)/],
    [{ branch: 'b' }, /'remote\.url' must be a git URL or path/],
    [{ url: '', branch: 'b' }, /'remote\.url'/],
    [{ url: '--upload-pack=touch /tmp/x', branch: 'b' }, /'remote\.url'/],
    [{ url: 'ext::sh -c touch% /tmp/pwned', branch: 'b' }, /'remote\.url'/],
    [{ url: 'has space', branch: 'b' }, /'remote\.url'/],
    [{ url: 'x' }, /'remote\.branch' must be a git branch name/],
    [{ url: 'x', branch: '-b' }, /'remote\.branch'/],
    [{ url: 'x', branch: 'a..b' }, /'remote\.branch'/],
    [{ url: 'x', branch: 'a/.hidden' }, /'remote\.branch'/],
    [{ url: 'x', branch: 'x.lock' }, /'remote\.branch'/],
    [{ url: 'x', branch: 'a b' }, /'remote\.branch'/],
    [{ url: 'x', branch: 'HEAD' }, /'remote\.branch'/],
    [{ url: 'x', branch: 7 }, /'remote\.branch'/],
  ];
  for (const [value, message] of bad) {
    writeFileSync(cfg, JSON.stringify({ remote: value }));
    for (const command of [['config'], ['new', 'x']]) {
      const q = r.factory(command);
      assert.equal(q.status, 1, `${JSON.stringify(value)}: ${q.stdout}${q.stderr}`);
      assert.match(q.stderr, message, JSON.stringify(value));
    }
  }
  assert.deepEqual(readdirSync(join(r.fdir, 'jobs')), [], 'a refused config creates no job');
}));

test('advisor config: {"share": true|false} loads; other shapes and sub-keys are refused', withRepo((r) => {
  const cfg = join(r.repo, 'factory.json');
  assert.deepEqual(JSON.parse(r.ok(['config'])).advisor, { share: false }, 'off by default');
  writeFileSync(cfg, JSON.stringify({ advisor: { share: true } }));
  assert.deepEqual(JSON.parse(r.ok(['config'])).advisor, { share: true });
  const bad: [unknown, RegExp][] = [
    [true, /'advisor' must be an object like \{"share": true\}/],
    [null, /'advisor' must be an object/],
    [[], /'advisor' must be an object/],
    [{}, /'advisor\.share' must be true or false/],
    [{ share: 'yes' }, /'advisor\.share' must be true or false/],
    [{ share: true, identity: true }, /'advisor' has unknown key 'identity' \(known: share\)/],
  ];
  for (const [value, message] of bad) {
    writeFileSync(cfg, JSON.stringify({ advisor: value }));
    const q = r.factory(['config']);
    assert.equal(q.status, 1, `${JSON.stringify(value)}: ${q.stdout}${q.stderr}`);
    assert.match(q.stderr, message, JSON.stringify(value));
  }
}));

// ---------------------------------------------------------------- 2. state checkout

test('init creates an orphan state branch in the project repo itself, and attaches to it', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), JSON.stringify({ remote: { url: './', branch: BRANCH } }));
  const out = r.ok(['init']);
  assert.match(out, /created as a new branch on .* \(branch factory-state\)/);
  // An orphan: no history shared with the code.
  assert.deepEqual(r.git(['ls-tree', '--name-only', BRANCH]).split('\n'), ['README.md']);
  const mb = spawnSync('git', ['merge-base', 'main', BRANCH], { cwd: r.repo, env: r.env });
  assert.equal(mb.status, 1, 'the state branch shares no history with main');
  assert.equal(r.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'the project checkout stays on its branch');
  assert.equal(r.git(['status', '--porcelain']), '?? factory.json', 'factory/ (with jobs/ inside) stays ignored');
  // Running init again attaches to what is there.
  assert.match(r.ok(['init']), /jobs tracks /);
  const id = r.newJob('Shared state');
  assert.deepEqual(r.git(['ls-tree', '--name-only', BRANCH]).split('\n').sort(), [id, 'README.md'].sort());
  assert.equal(r.git(['log', '-1', '--format=%s', BRANCH]), `factory: new ${id}`);
}));

test('init refuses a branch that holds anything but factory state, and leaves jobs/ empty', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), JSON.stringify({ remote: { url: './', branch: 'main' } }));
  const p = r.factory(['init']);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  // main holds only a README.md, but not the state branch's own README.
  assert.match(p.stderr, /branch 'main' of .* does not hold factory state \(it has README\.md\)/);
  assert.deepEqual(readdirSync(join(r.fdir, 'jobs')), []);
}));

test('an advisor/ directory on the state branch (factory-plugin-advisor sharing) is accepted and never taken for a job', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Before the advisor');
  // What factory-plugin-advisor pushes: a commit adding advisor/occurrences.jsonl and advisor/state.json.
  const seed = join(w.tmp, 'advisor-seed');
  git(['clone', '-q', '--branch', BRANCH, w.state, seed], w.tmp, ann.env);
  mkdirSync(join(seed, 'advisor'));
  writeFileSync(join(seed, 'advisor', 'occurrences.jsonl'), '{"signature":"0123456789ab"}\n');
  writeFileSync(join(seed, 'advisor', 'state.json'), '{"version":1,"issues":{}}\n');
  git(['add', 'advisor'], seed, ann.env);
  git(['commit', '-q', '-m', 'factory-plugin-advisor: record 1 occurrence'], seed, ann.env);
  git(['push', '-q', 'origin', `HEAD:${BRANCH}`], seed, ann.env);
  // Bob clones it, Ann pulls it into a checkout with local commits of her own; both keep working.
  const bob = new Person(w, 'Bob');
  bob.ok(['init']);
  assert.ok(existsSync(join(bob.jobs, 'advisor', 'occurrences.jsonl')));
  const second = bob.newJob('After the advisor');
  ann.ok(['note', id, 'still mine']);
  assert.deepEqual(JSON.parse(ann.ok(['status', '--json'])).map((j: { id: string }) => j.id).sort(), [id, second].sort());
  assert.ok(existsSync(join(ann.jobs, 'advisor', 'state.json')));
  ann.assertInSync(w);
  // A plain file named advisor is still not factory state.
  rmSync(seed, { recursive: true, force: true });
  git(['clone', '-q', '--branch', BRANCH, w.state, seed], w.tmp, ann.env);
  git(['rm', '-q', '-r', 'advisor'], seed, ann.env);
  writeFileSync(join(seed, 'advisor'), 'not a directory\n');
  git(['add', 'advisor'], seed, ann.env);
  git(['commit', '-q', '-m', 'odd'], seed, ann.env);
  git(['push', '-q', 'origin', `HEAD:${BRANCH}`], seed, ann.env);
  bob.refused(['note', second, 'x'], /does not hold factory state \(it has advisor\)/);
}));

test('init clones an existing state branch; worktrees are never part of it', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  assert.match(ann.ok(['init']), /created as a new branch/);
  const bob = new Person(w, 'Bob');
  assert.match(bob.ok(['init']), /cloned from/);
  assert.equal(bob.git(['rev-parse', '--abbrev-ref', 'HEAD'], bob.jobs), BRANCH);
  // Ann drives a job to proof: the worktree holds files and commits of its own.
  const id = ann.startedJob('Worktree stays local');
  const wt = ann.job(id).worktree as string;
  assert.ok(wt.startsWith(join(ann.fdir, 'worktrees')));
  writeFileSync(join(wt, 'secret-code.txt'), 'built\n');
  ann.git(['add', 'secret-code.txt'], wt);
  ann.git(['commit', '-q', '-m', 'build'], wt);
  ann.write(id, 'build.md', '# Build\n');
  ann.ok(['built', id]);
  writeFileSync(join(wt, 'untracked-scratch.txt'), 'x\n');
  ann.ok(['note', id, 'scratch file left in the worktree']);
  const paths = w.pathsInHistory();
  assert.deepEqual(paths.sort(), ['README.md', `${id}/build.md`, `${id}/job.json`, `${id}/task.md`].sort());
  assert.ok(!paths.some((p) => p.includes('secret-code') || p.includes('scratch') || p.includes('worktrees')));
  // The worktree is still where it was, outside the state checkout.
  assert.ok(statSync(join(wt, 'secret-code.txt')).isFile());
  assert.equal(existsSync(join(ann.jobs, 'worktrees')), false);
}));

// ---------------------------------------------------------------- 3. sync on every command

test('every state-changing command pulls, commits only its job as "factory: <command> <id>" and pushes', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.startedJob('Through the line');
  const other = ann.newJob('Untouched neighbour');
  ann.write(other, 'task.md', TASK); // uncommitted: belongs to the next command on that job
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'thing.txt'), 'thing\n');
  ann.git(['add', 'thing.txt'], wt);
  ann.git(['commit', '-q', '-m', 'thing'], wt);
  ann.write(id, 'build.md', '# Build\n');
  ann.ok(['built', id]);
  ann.write(id, 'proof.md', '# Proof\n');
  ann.ok(['proof', id, 'pass']);
  ann.ok(['round', id, 'solo']);
  ann.write(id, 'review-1-solo.md', '# Review\n');
  ann.ok(['followup', 'add', id, '--by', 'solo', 'a loose end']);
  ann.ok(['followup', 'done', id, '1', 'fixed']);
  ann.ok(['note', id, 'reviewing']);
  ann.ok(['verdict', id, 'solo', 'approve']);
  ann.ok(['rework', id, 'one more thing']);
  const subjects = w.remote(['log', '--format=%s|%an <%ae>', BRANCH]).split('\n').reverse();
  assert.deepEqual(subjects.map((s) => s.split('|')[0]), [
    'factory: init state branch',
    `factory: new ${id}`,
    `factory: start ${id}`,
    `factory: new ${other}`,
    `factory: built ${id}`,
    `factory: proof ${id}`,
    `factory: round ${id}`,
    `factory: followup add ${id}`,
    `factory: followup done ${id}`,
    `factory: note ${id}`,
    `factory: verdict ${id}`,
    `factory: rework ${id}`,
  ]);
  assert.ok(subjects.every((s) => s.endsWith('|Ann <ann@example.invalid>')));
  // Each commit touches only its own job's directory.
  for (const sha of w.remote(['rev-list', BRANCH]).split('\n')) {
    const subject = w.remote(['log', '-1', '--format=%s', sha]);
    const touched = w.remote(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n');
    const job = subject.split(' ').at(-1) as string;
    if (subject.startsWith('factory: init')) continue;
    assert.ok(touched.every((p) => p.startsWith(`${job}/`)), `${subject}: ${touched.join(', ')}`);
  }
  assert.ok(w.pathsInHistory().includes(`${id}/rework-1.md`));
  assert.ok(!w.pathsInHistory().includes(`${other}/task.md`), "the neighbour's task.md waits for its own command");
}));

test('an escalation is published too, and still exits 2', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.startedJob('Escalates');
  const p = ann.factory(['human', id, 'need', 'a', 'person']);
  assert.equal(p.status, 2, p.stderr);
  assert.equal(w.remote(['log', '-1', '--format=%s', BRANCH]), `factory: human ${id}`);
  assert.equal(JSON.parse(w.remote(['show', `${BRANCH}:${id}/job.json`])).status, 'needs-human');
  ann.assertInSync(w);
}));

test('the other person sees the change after a pull; read commands pull first', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  const id = ann.newJob('Seen by Bob');
  assert.match(bob.ok(['status']), new RegExp(id));
  ann.ok(['note', id, 'hello bob']);
  assert.equal(JSON.parse(bob.ok(['status', id, '--json'])).activity, 'hello bob');
  ann.ok(['followup', 'add', id, '--by', 'human', 'check this']);
  assert.match(bob.ok(['followup', 'list']), /check this/);
  assert.match(bob.ok(['stats']), /jobs +1/);
  assert.equal(bob.ok(['path', id]).trim(), join(bob.jobs, id));
  bob.assertInSync(w);
}));

test('a race on different jobs re-pulls, replays and retries; both changes land', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  const a = ann.newJob('Anns job');
  const b = ann.newJob('Bobs job');
  bob.ok(['init']);
  bob.raceWith(ann, ['note', a, 'ann was first']);
  bob.ok(['note', b, 'bob second']);
  assert.match(bob.raced(), /^0\n/);
  const log = w.remote(['log', '--format=%s', BRANCH]).split('\n');
  assert.deepEqual(log.slice(0, 2), [`factory: note ${b}`, `factory: note ${a}`]);
  assert.equal(JSON.parse(w.remote(['show', `${BRANCH}:${a}/job.json`])).activity, 'ann was first');
  assert.equal(JSON.parse(w.remote(['show', `${BRANCH}:${b}/job.json`])).activity, 'bob second');
  bob.assertInSync(w);
}));

test('the same job changed on both sides is refused, never merged; the checkout matches the remote', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  const id = ann.newJob('Contended');
  bob.ok(['init']);
  bob.write(id, 'task.md', '# Bobs task\n\n## Acceptance criteria\n\n1. Bob.\n');
  bob.raceWith(ann, ['note', id, 'ann edits it']);
  const p = bob.refused(['note', id, 'bob edits it'], new RegExp(`${id} changed both here and on the remote`));
  assert.match(p.stderr, /job\.json/);
  assert.match(p.stderr, /was not applied/);
  assert.match(bob.raced(), /^0\n/);
  bob.assertInSync(w);
  assert.equal(bob.job(id).activity, 'ann edits it');
  // Bob's attempt is kept, so his task.md is not lost.
  const kept = readdirSync(join(bob.fdir, 'conflicts'));
  assert.equal(kept.length, 1);
  assert.match(readFileSync(join(bob.fdir, 'conflicts', kept[0] as string, 'task.md'), 'utf8'), /Bobs task/);
  assert.equal(w.remote(['log', '-1', '--format=%s', BRANCH]), `factory: note ${id}`);
  assert.equal(w.remote(['log', '-1', '--format=%an', BRANCH]), 'Ann');
}));

test('with no network a state-changing command refuses and changes nothing; reads show the last-pulled state', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Offline');
  ann.write(id, 'task.md', TASK);
  const before = readFileSync(join(ann.jobs, id, 'job.json'), 'utf8');
  const head = ann.git(['rev-parse', 'HEAD'], ann.jobs);
  renameSync(w.state, `${w.state}.away`);
  for (const args of [['note', id, 'x'], ['start', id], ['new', 'Another'], ['followup', 'add', id, '--by', 'human', 'x']]) {
    const p = ann.refused(args, /cannot reach the remote factory/);
    assert.match(p.stderr, /nothing was changed - retry/);
  }
  assert.equal(readFileSync(join(ann.jobs, id, 'job.json'), 'utf8'), before);
  assert.equal(ann.git(['rev-parse', 'HEAD'], ann.jobs), head);
  assert.deepEqual(readdirSync(ann.jobs).filter((n) => /^\d+-/.test(n)), [id]);
  assert.equal(existsSync(join(ann.fdir, 'worktrees', id)), false, 'start created no worktree');
  assert.equal(ann.git(['status', '--porcelain'], ann.jobs), `?? ${id}/task.md`);
  // Reads still answer, from the last pull, and say so.
  let p = ann.factory(['status']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, new RegExp(id));
  assert.match(p.stderr, /cannot reach the remote factory/);
  assert.match(p.stderr, /showing the last-pulled state \(last sync \d{4}-/);
  p = ann.factory(['status', '--offline']);
  assert.equal(p.status, 0);
  assert.match(p.stderr, /--offline: showing the last-pulled state/);
  for (const args of [['followup', 'list', '--offline'], ['stats', '--offline'], ['path', id, '--offline'], ['config', '--offline']]) {
    p = ann.factory(args);
    assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`);
    assert.match(p.stderr, /--offline/);
  }
  // Back online, the same command works.
  renameSync(`${w.state}.away`, w.state);
  ann.ok(['start', id]);
  assert.equal(w.remote(['log', '-1', '--format=%s', BRANCH]), `factory: start ${id}`);
}));

test('--offline does not touch the remote even when it is reachable', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  const id = ann.newJob('Not pulled');
  assert.doesNotMatch(bob.ok(['status', '--offline']), new RegExp(id));
  assert.match(bob.ok(['status']), new RegExp(id));
}));

// ---------------------------------------------------------------- 4. job ids never collide

test('two people creating a job at the same moment get two distinct jobs (forced race)', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  ann.newJob('First');
  bob.ok(['status']);
  // Bob's pull sees 001; Ann's 002 lands before Bob pushes, and Bob's push loses.
  bob.raceWith(ann, ['new', 'Same', 'title']);
  const mine = bob.newJob('Same title');
  assert.match(bob.raced(), /^0\n002-same-title\n/);
  assert.equal(mine, '003-same-title');
  assert.deepEqual(w.jobsOnRemote(), ['001-first', '002-same-title', '003-same-title']);
  assert.equal(JSON.parse(w.remote(['show', `${BRANCH}:002-same-title/job.json`])).history[0].event, 'created');
  assert.equal(w.remote(['log', '-1', '--format=%an', BRANCH, '--', '003-same-title']), 'Bob');
  bob.assertInSync(w);
}));

test('two clones racing several new jobs in parallel lose none and reuse no number', withWorld(async (w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  const runNew = (p: Person, title: string): Promise<Result> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'new', title], { cwd: p.repo, env: p.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  const results = await Promise.all(
    [0, 1, 2].flatMap((i) => [runNew(ann, `ann ${i}`), runNew(bob, `bob ${i}`)]),
  );
  for (const r of results) assert.equal(r.status, 0, r.stdout + r.stderr);
  const ids = results.map((r) => r.stdout.split('\n')[0] as string);
  const onRemote = w.jobsOnRemote();
  assert.deepEqual([...ids].sort(), [...onRemote].sort());
  const numbers = onRemote.map((id) => Number.parseInt(id, 10));
  assert.deepEqual(numbers.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  for (const id of onRemote) assert.match(id, /^\d{3}-(ann|bob)-\d$/);
}));

test('a new that keeps losing the race never replays its number: it renumbers, then refuses after PUSH_ATTEMPTS', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  // Ann lands a job before each of Bob's first 4 pushes: Bob's 5th allocation (005) wins.
  bob.raceWith(ann, ['new', 'ann job'], 4);
  assert.equal(bob.newJob('bob job'), '005-bob-job');
  assert.deepEqual(w.jobsOnRemote(), ['001-ann-job', '002-ann-job', '003-ann-job', '004-ann-job', '005-bob-job']);
  bob.assertInSync(w);
  // Ann lands a job before each of Bob's 5 pushes: Bob refuses instead of replaying 010 onto Ann's.
  bob.raceWith(ann, ['new', 'ann job'], 5);
  const p = bob.refused(['new', 'bob two'], /lost the race to push factory-state 5 times while numbering the job; nothing was created - retry/);
  assert.equal(p.stdout, '');
  const onRemote = w.jobsOnRemote();
  const numbers = onRemote.map((id) => Number.parseInt(id, 10));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'every number is used exactly once');
  assert.equal(onRemote.filter((id) => id.endsWith('bob-two')).length, 0);
  bob.assertInSync(w);
  assert.deepEqual(readdirSync(bob.jobs).filter((n) => /^\d+-/.test(n)), onRemote);
  // And the retry the refusal asks for works.
  assert.equal(bob.newJob('bob two'), '011-bob-two');
}));

// ---------------------------------------------------------------- 5. claims

test('start records the owner; others are refused except the human gates', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  const id = ann.startedJob('Anns claim');
  assert.deepEqual(ann.job(id).owner, { name: 'Ann', email: 'ann@example.invalid' });
  assert.match(ann.ok(['status', id]), /owner: +Ann <ann@example\.invalid>/);
  bob.ok(['status']);
  for (const args of [['note', id, 'mine now'], ['followup', 'add', id, '--by', 'human', 'x'], ['human', id, 'help'], ['resume', id]]) {
    const p = bob.refused(args, new RegExp(`${id} is claimed by Ann <ann@example\\.invalid>`));
    assert.match(p.stderr, /factory claim .* --take-over/);
  }
  bob.assertInSync(w);
  // Reading is fine, and the human-only gates are anyone's: Bob closes it.
  assert.match(bob.ok(['status', id]), /owner: +Ann/);
  bob.ok(['close', id, 'not needed']);
  assert.equal(JSON.parse(w.remote(['show', `${BRANCH}:${id}/job.json`])).status, 'closed');
  assert.equal(w.remote(['log', '-1', '--format=%s|%an', BRANCH]), `factory: close ${id}|Bob`);
}));

test('claim --take-over is refused until the branch is on the code remote, then recreates the worktree', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  const id = ann.startedJob('Handed over');
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'work.txt'), 'half done\n');
  ann.git(['add', 'work.txt'], wt);
  ann.git(['commit', '-q', '-m', 'half'], wt);
  bob.refused(['claim', id], /--take-over/);
  let p = bob.refused(['claim', id, '--take-over'], new RegExp(`factory/${id} is not on the code remote`));
  assert.match(p.stderr, /Ann <ann@example\.invalid> must push it first/);
  assert.deepEqual(bob.job(id).owner, { name: 'Ann', email: 'ann@example.invalid' });
  bob.assertInSync(w);
  ann.git(['push', '-q', 'origin', `factory/${id}`], wt);
  const out = bob.ok(['claim', id, '--take-over']);
  assert.match(out, /now claimed by Bob <bob@example\.invalid>/);
  const job = bob.job(id);
  assert.deepEqual(job.owner, { name: 'Bob', email: 'bob@example.invalid' });
  assert.equal(job.worktree, join(bob.fdir, 'worktrees', id));
  assert.match(job.history.at(-1).event, /^taken over by Bob <bob@example\.invalid> from Ann <ann@example\.invalid>$/);
  assert.equal(readFileSync(join(job.worktree, 'work.txt'), 'utf8'), 'half done\n');
  assert.equal(bob.git(['rev-parse', '--abbrev-ref', 'HEAD'], job.worktree), `factory/${id}`);
  assert.equal(w.remote(['log', '-1', '--format=%s|%an', BRANCH]), `factory: claim ${id}|Bob`);
  // Now Ann is the one refused, and Bob can carry on.
  p = ann.refused(['note', id, 'still mine?'], /claimed by Bob/);
  bob.ok(['note', id, 'carrying on']);
  bob.refused(['claim', id, '--take-over'], /already yours/);
}));

test('claim on a job in intake moves the claim without a worktree; claim needs a remote', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Unclaimed');
  assert.match(ann.ok(['claim', id, '--take-over']), /now claimed by Ann/);
  assert.equal(ann.job(id).worktree, null);
  ann.config({});
  ann.refused(['claim', id, '--take-over'], /claims belong to a remote factory/);
}));

test('the dashboard shows the owner and still renders jobs without one; it never serves .git', () => {
  const html = readFileSync(join(PLUGIN, 'dashboard', 'index.html'), 'utf8');
  assert.match(html, /const ownerName = j => \(j\.owner && typeof j\.owner === 'object' && j\.owner\.name\) \? String\(j\.owner\.name\) : '';/);
  assert.match(html, /ownerName\(j\)/);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-dash-')));
  try {
    spawnSync('git', ['init', '-q', join(root, 'jobs')]);
    assert.equal(mapPath(root, '/jobs/.git/config'), 404);
    assert.equal(mapPath(root, '/jobs/.GIT/config'), 404);
    assert.equal(mapPath(root, '/jobs/.git/'), 404);
    assert.equal(mapPath(root, '/jobs/'), join(root, 'jobs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 6. migration

test('remote push publishes an existing local factory with its ids and history, never worktrees', withWorld((w) => {
  const ann = new Person(w, 'Ann', null);
  ann.config({});
  const a = ann.startedJob('Local one');
  const b = ann.newJob('Local two');
  ann.ok(['note', b, 'made locally']);
  writeFileSync(join(ann.job(a).worktree, 'wt-only.txt'), 'x\n');
  const local = { a: readFileSync(join(ann.jobs, a, 'job.json'), 'utf8'), b: readFileSync(join(ann.jobs, b, 'job.json'), 'utf8') };
  assert.match(ann.ok(['remote', 'status']), /none \(local mode/);
  ann.config({ remote: { url: w.state, branch: BRANCH } });
  // Before the push, commands refuse rather than mix local and remote state; reads still answer.
  ann.refused(['note', a, 'x'], /holds local jobs .* run `factory remote push`/);
  assert.match(ann.ok(['status']), new RegExp(b));
  assert.match(ann.ok(['remote', 'status']), /not attached/);
  assert.match(ann.ok(['remote', 'push']), /pushed 2 jobs/);
  assert.deepEqual(w.jobsOnRemote(), [a, b]);
  assert.equal(w.remote(['show', `${BRANCH}:${a}/job.json`]), local.a.trimEnd());
  assert.equal(w.remote(['show', `${BRANCH}:${b}/job.json`]), local.b.trimEnd());
  assert.ok(!w.pathsInHistory().some((p) => p.includes('wt-only') || p.includes('worktrees')));
  ann.assertInSync(w);
  const st = ann.ok(['remote', 'status']);
  assert.match(st, /ahead: +0\nbehind: +0/);
  assert.match(st, /last sync: +\d{4}-/);
  // Bob joins and sees both, with their history.
  const bob = new Person(w, 'Bob');
  bob.ok(['init']);
  assert.equal(bob.job(b).history.at(-1).event, 'made locally');
  // remote status counts what Bob has not pulled yet.
  ann.ok(['note', b, 'ann again']);
  assert.match(bob.ok(['remote', 'status']), /ahead: +0\nbehind: +1/);
}));

test('remote push refuses a job number the remote already uses for another job, and changes nothing', withWorld((w) => {
  const bob = new Person(w, 'Bob');
  bob.ok(['init']);
  bob.newJob('Remote one');
  const ann = new Person(w, 'Ann');
  ann.config({});
  const a = ann.newJob('Local one');
  ann.config({ remote: { url: w.state, branch: BRANCH } });
  ann.refused(['remote', 'push'], new RegExp(`job number 1 is ${a} here but 001-remote-one on`));
  assert.equal(existsSync(join(ann.jobs, '.git')), false);
  assert.deepEqual(readdirSync(ann.jobs), [a]);
  assert.deepEqual(w.jobsOnRemote(), ['001-remote-one']);
}));

test('removing remote falls back to local mode with the last-pulled jobs; remote push publishes what changed', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Pulled');
  const tip = w.remote(['rev-parse', BRANCH]);
  ann.config({});
  assert.match(ann.ok(['status']), new RegExp(id));
  ann.ok(['note', id, 'while local']);
  const other = ann.newJob('Made locally');
  assert.equal(w.remote(['rev-parse', BRANCH]), tip, 'local mode never touches the remote');
  assert.equal(ann.job(id).activity, 'while local');
  // Back to remote mode: remote push publishes the local changes.
  ann.config({ remote: { url: w.state, branch: BRANCH } });
  ann.ok(['remote', 'push']);
  assert.equal(JSON.parse(w.remote(['show', `${BRANCH}:${id}/job.json`])).activity, 'while local');
  assert.deepEqual(w.jobsOnRemote(), [id, other]);
  ann.assertInSync(w);
}));

// ---------------------------------------------------------------- 7. locking

test('remote push refuses a job made locally whose number the remote has given another job meanwhile', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  ann.newJob('First');
  ann.config({});
  const local = ann.newJob('Made locally');
  bob.ok(['status']);
  const theirs = bob.newJob('Made remotely');
  assert.equal(Number.parseInt(local, 10), Number.parseInt(theirs, 10));
  ann.config({ remote: { url: w.state, branch: BRANCH } });
  ann.refused(['remote', 'push'], /job number 2 is 002-made-locally here but 002-made-remotely on the remote; refusing to publish two jobs with one number; nothing was pushed/);
  assert.deepEqual(w.jobsOnRemote(), ['001-first', theirs]);
}));

test('a push the server declines (a hook, a protected branch) is reported as such, not retried as a race', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Declined');
  const hook = join(w.state, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!${process.execPath}\nconsole.error('branch is protected');\nprocess.exit(1);\n`);
  chmodSync(hook, 0o755);
  const head = ann.git(['rev-parse', 'HEAD'], ann.jobs);
  const p = ann.refused(['note', id, 'x'], /push failed: .*branch is protected/);
  assert.doesNotMatch(p.stderr, /lost the race/);
  assert.equal(ann.git(['rev-parse', 'HEAD'], ann.jobs), head, 'rolled back');
  assert.equal(ann.git(['status', '--porcelain'], ann.jobs), '');
}));

test('within one machine the lock still serializes commands on the shared checkout', withWorld(async (w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const ids = [ann.newJob('One'), ann.newJob('Two')];
  const runNote = (id: string, text: string): Promise<number | null> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'note', id, text], { cwd: ann.repo, env: ann.env, stdio: 'ignore' });
      child.on('close', resolve);
    });
  const codes = await Promise.all([0, 1, 2, 3].map((i) => runNote(ids[i % 2] as string, `n${i}`)));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  assert.equal(w.remote(['rev-list', '--count', BRANCH]), '7'); // init + 2 new + 4 notes
  ann.assertInSync(w);
}));

test('Repo helper stays local: no remote key means no git in jobs/', withRepo((r: Repo) => {
  r.newJob('Plain');
  assert.equal(existsSync(join(r.fdir, 'jobs', '.git')), false);
}));

// ---------------------------------------------------------------- running from inside the state checkout

test('a command run from inside the state checkout finds the project checkout and its factory dir', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Inside');
  // No FACTORY_DIR: the factory dir is found from the cwd, as a person in a terminal would.
  const env = { ...ann.env };
  delete env.FACTORY_DIR;
  const inJob = (args: string[]): Result => {
    const p = spawnSync(process.execPath, [CLI, ...args], { cwd: join(ann.jobs, id), env, encoding: 'utf8' });
    return { status: p.status, stdout: p.stdout, stderr: p.stderr };
  };
  let p = inJob(['status']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, new RegExp(id));
  p = inJob(['note', '1', 'from inside']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(w.remote(['log', '-1', '--format=%s', BRANCH]), `factory: note ${id}`);
  p = inJob(['path', '1']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), join(ann.jobs, id));
  ann.write(id, 'task.md', TASK);
  p = inJob(['start', '1']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(ann.job(id).worktree, join(ann.fdir, 'worktrees', id));
  assert.equal(ann.git(['rev-parse', '--abbrev-ref', 'HEAD'], join(ann.fdir, 'worktrees', id)), `factory/${id}`);
  assert.equal(existsSync(join(ann.jobs, 'factory')), false, 'no stray factory dir inside the state checkout');
  // Still so after `remote` is removed (jobs/.git stays).
  ann.config({});
  p = inJob(['status']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, new RegExp(id));
  assert.equal(existsSync(join(ann.jobs, 'factory')), false);
}));

// ---------------------------------------------------------------- what someone with push access can plant

/** Someone with push access to the state branch, using plain git: a clone they commit to by hand. */
function intruder(w: World): { dir: string; git: (args: string[]) => string; edit: (path: string, fn: (job: Record<string, any>) => void) => void } {
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

test('a symbolic link pushed to the state branch is refused: nothing is written through it or published from it', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Linked');
  const victim = join(w.tmp, 'victim.txt');
  writeFileSync(victim, 'precious\n');
  const secrets = join(w.tmp, 'secrets');
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'id_rsa'), 'PRIVATE KEY\n');
  const m = intruder(w);
  symlinkSync(victim, join(m.dir, id, 'job.json.tmp'));
  symlinkSync(secrets, join(m.dir, id, 'leak'));
  m.git(['add', '-A']);
  m.git(['commit', '-q', '-m', 'plant links']);
  m.git(['push', '-q', 'origin', BRANCH]);
  const before = ann.git(['rev-parse', 'HEAD'], ann.jobs);
  for (const args of [['note', id, 'hello'], ['followup', 'add', id, '--by', 'human', 'x'], ['new', 'Other']]) {
    ann.refused(args, /holds a symbolic link or submodule \(.*job\.json\.tmp.*\)/);
  }
  // Reads show the last-pulled state and say why.
  const p = ann.factory(['status']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /symbolic link/);
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'nothing was written through the link');
  assert.equal(ann.git(['rev-parse', 'HEAD'], ann.jobs), before, 'the planted commit was never checked out');
  assert.equal(existsSync(join(ann.jobs, id, 'leak')), false);
  assert.equal(lstatSync(join(ann.jobs, id, 'job.json')).isFile(), true);
  assert.equal(ann.git(['status', '--porcelain', '--untracked-files=all'], ann.jobs), '');
  assert.equal(w.pathsInHistory().some((f) => f.startsWith(`${id}/leak/`)), false, 'no secret was published');
  // Someone attaching afresh is refused too, and keeps an empty jobs/.
  const bob = new Person(w, 'Bob');
  const q = bob.refused(['init'], /holds a symbolic link or submodule/);
  assert.equal(q.stdout, '');
  assert.deepEqual(readdirSync(bob.jobs), []);
}));

test('a symbolic link in a local job dir is never read or published', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Local link');
  const secrets = join(w.tmp, 'secrets');
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'id_rsa'), 'PRIVATE KEY\n');
  symlinkSync(secrets, join(ann.jobs, id, 'leak'));
  ann.refused(['note', id, 'x'], /leak is not a regular file \(a symbolic link\?\)/);
  assert.equal(w.pathsInHistory().some((f) => f.startsWith(`${id}/leak`)), false);
}));

test('a stale job.json.tmp link is replaced, never written through (local mode too)', withRepo((r) => {
  const id = r.newJob('Tmp link');
  const victim = join(r.repo, 'victim.txt');
  writeFileSync(victim, 'precious\n');
  symlinkSync(victim, join(r.fdir, 'jobs', id, 'job.json.tmp'));
  r.ok(['note', id, 'hello']);
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n');
  assert.equal(lstatSync(join(r.fdir, 'jobs', id, 'job.json')).isFile(), true);
  assert.match(readFileSync(join(r.fdir, 'jobs', id, 'job.json'), 'utf8'), /hello/);
}));

test('job.json fields used as paths or git arguments must be what the factory writes', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Fields');
  const m = intruder(w);
  const plant = (fn: (job: Record<string, any>) => void): void => {
    m.git(['pull', '-q', '--ff-only']);
    m.edit(`${id}/job.json`, fn);
    m.git(['commit', '-q', '-am', 'edit']);
    m.git(['push', '-q', 'origin', BRANCH]);
  };
  const outside = join(w.tmp, 'outside');
  mkdirSync(outside);
  const original = JSON.parse(w.remote(['show', `${BRANCH}:${id}/job.json`]));
  const cases: [(job: Record<string, any>) => void, RegExp][] = [
    [(j) => (j.id = '../../../outside'), /has id "\.\.\/\.\.\/\.\.\/outside", but the factory only ever writes/],
    [(j) => (j.id = '002-other'), /has id "002-other"/],
    [(j) => (j.branch = '--upload-pack=touch /tmp/x'), /has branch "--upload-pack/],
    [(j) => (j.base = '--output=/tmp/x'), /has base "--output/],
  ];
  for (const [fn, message] of cases) {
    plant((j) => {
      Object.assign(j, original);
      fn(j);
    });
    for (const args of [['note', id, 'x'], ['close', id], ['status', id]]) {
      const p = ann.factory(args);
      assert.equal(p.status, 1, `${args.join(' ')}: ${p.stdout}${p.stderr}`);
      assert.match(p.stderr, message);
    }
  }
  assert.deepEqual(readdirSync(outside), [], 'nothing written outside the factory dir');
  // A worktree path from the branch is never used: this machine's own worktrees/<id> is.
  const precious = join(w.tmp, 'precious');
  ann.git(['worktree', 'add', '-q', '-b', 'precious', precious]);
  writeFileSync(join(precious, 'unsaved.txt'), 'work in progress\n');
  plant((j) => {
    Object.assign(j, original);
    j.worktree = precious;
  });
  assert.equal(JSON.parse(ann.ok(['status', id, '--json'])).worktree, join(ann.fdir, 'worktrees', id));
  ann.ok(['close', id, 'not needed']);
  assert.equal(readFileSync(join(precious, 'unsaved.txt'), 'utf8'), 'work in progress\n', 'another worktree is untouched');
  assert.equal(ann.job(id).stage, 'done');
}));
