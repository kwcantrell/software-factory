// Opt-in sharing (factory.json "advisor": {"share": true} with a remote factory): two simulated users,
// each with their own config dir, OS identity and project checkout, against one bare remote. The
// remote's state branch is created by the real factory CLI, so the factory keeps working on it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/run.ts';
import { AUTHOR, displayUrl, mergeState, privateHost, publicWarning, remoteHost, type ShareConfig, sharedOccurrence } from '../src/shared.ts';
import { FIXTURES, PLUGIN_ROOT, sandbox, type Sandbox } from './helpers.ts';
import type { Env } from '../src/plugins.ts';

const BRANCH = 'factory-state';
const FACTORY_CLI = fileURLToPath(new URL('../../factory/src/cli.ts', import.meta.url));
const ADVISOR_CLI = join(PLUGIN_ROOT, 'src', 'cli.ts');

const boxes: Sandbox[] = [];
afterEach(() => {
  while (boxes.length > 0) boxes.pop()?.cleanup();
});

function git(args: string[], cwd: string, env: Env = {}): string {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', ...env } as NodeJS.ProcessEnv });
  assert.equal(p.status, 0, `git ${args.join(' ')}: ${p.stderr}`);
  return p.stdout;
}

/** A bare remote in its own sandbox dir. */
function world(): { box: Sandbox; remote: string } {
  const box = sandbox();
  boxes.push(box);
  const remote = join(box.dir, 'state.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], box.dir);
  return { box, remote };
}

interface User {
  box: Sandbox;
  project: string;
  name: string;
  factory: (args: string[]) => string;
}

/** One person: their own config dir, home, username and project checkout (with factory.json). */
function user(name: string, factoryJson: unknown, extra: Env = {}): User {
  const login = `${name.toLowerCase()}smith`;
  const home = `/home/${login}`;
  // FACTORY_DIR points at the project's factory dir; factory.json is read from its parent.
  const box = sandbox({ USER: login, HOME: home, ...extra }, PLUGIN_ROOT, { homedir: home, username: login });
  boxes.push(box);
  const project = join(box.dir, 'project');
  mkdirSync(project);
  git(['init', '-q', '-b', 'main', project], project);
  box.env.FACTORY_DIR = join(project, 'factory');
  writeFileSync(join(project, 'factory.json'), `${JSON.stringify(factoryJson)}\n`);
  // The remote factory signs its state commits: a throwaway SSH key, set in the project's own git config.
  const key = join(box.dir, 'signing_ed25519');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0, 'ssh-keygen');
  git(['config', 'gpg.format', 'ssh'], project);
  git(['config', 'user.signingkey', key], project);
  const factory = (args: string[]): string => {
    const env = { PATH: process.env.PATH, HOME: box.dir, GIT_CONFIG_NOSYSTEM: '1', FACTORY_DIR: box.env.FACTORY_DIR, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${login}@example.com`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${login}@example.com` };
    const p = spawnSync(process.execPath, [FACTORY_CLI, ...args], { cwd: project, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(p.status, 0, `factory ${args.join(' ')}: ${p.stdout}${p.stderr}`);
    return p.stdout;
  };
  return { box, project, name, factory };
}

const shared = (remote: string): unknown => ({ remote: { url: remote, branch: BRANCH }, advisor: { share: true } });

function sharedLog(remote: string): any[] {
  const p = spawnSync('git', ['--git-dir', remote, 'show', `${BRANCH}:advisor/occurrences.jsonl`], { encoding: 'utf8' });
  if (p.status !== 0) return [];
  return p.stdout.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

function sharedRaw(remote: string, file: string): string {
  const p = spawnSync('git', ['--git-dir', remote, 'show', `${BRANCH}:advisor/${file}`], { encoding: 'utf8' });
  return p.status === 0 ? p.stdout : '';
}

const ok = (r: { code: number; stdout: string; stderr: string }): string => {
  assert.equal(r.code, EXIT.ok, r.stderr);
  return r.stdout;
};

const record = (u: User, summary: string, detail?: string): { code: number; stdout: string; stderr: string } =>
  u.box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', summary, ...(detail === undefined ? [] : ['--detail', detail])]);

const list = (u: User): any[] => JSON.parse(ok(u.box.call(['list', '--json']))).issues;

// ------------------------------------------------------------------ 1. opt-in

test('off (no advisor.share, share false, or no remote) is exactly the local log: no id, no shared dir, no remote writes', () => {
  const { remote } = world();
  for (const cfg of [{}, { remote: { url: remote, branch: BRANCH } }, { remote: { url: remote, branch: BRANCH }, advisor: { share: false } }, { remote: null, advisor: { share: true } }]) {
    const u = user('Ann', cfg);
    const r = record(u, 'docs gate fails on a fresh clone');
    assert.deepEqual(r, { code: EXIT.ok, stdout: `Recorded ${JSON.parse(ok(u.box.call(['list', '--json']))).issues[0].signature} (factory-docs, workaround): seen 1 time.\n`, stderr: '' }, JSON.stringify(cfg));
    const line = JSON.parse(readFileSync(join(u.box.config, 'occurrences.jsonl'), 'utf8'));
    assert.deepEqual(Object.keys(line).sort(), ['at', 'kind', 'plugin', 'signature', 'source', 'summary'], 'no id or by field');
    assert.equal(existsSync(join(u.box.config, 'shared')), false, JSON.stringify(cfg));
  }
  assert.equal(spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', BRANCH]).status, 1, 'nothing was pushed');
});

test('sharing on still refuses a local log inside a git checkout, and then shares nothing', () => {
  const { remote } = world();
  const u = user('Ann', shared(remote));
  u.box.env.FACTORY_PLUGIN_ADVISOR_CONFIG_DIR = join(u.project, 'advisor-log');
  const r = record(u, 'docs gate fails on a fresh clone');
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /refusing to keep the log in .*inside the git checkout/);
  assert.deepEqual(sharedLog(remote), []);
});

// ------------------------------------------------------------------ 2. what is shared

test('only the redacted, masked occurrence reaches the shared file; no identity unless opted in, commits by a fixed author', () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  ann.factory(['init']);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
  const summary = `docs gate failed in /home/annsmith/work/app for annsmith: token=${secret} ann.smith@example.com cc @annsmith-gh`;
  ok(record(ann, summary, `trace /Users/annsmith/x\nAuthorization: Bearer ${secret}\nmail ann.smith@example.com @octo-person`));
  const text = sharedRaw(remote, 'occurrences.jsonl');
  assert.notEqual(text, '');
  for (const raw of [secret, 'annsmith', 'ann.smith@example.com', '@annsmith-gh', '@octo-person', '/home/', '/Users/']) {
    assert.equal(text.includes(raw), false, `${raw} reached the shared file: ${text}`);
  }
  const [o, ...more] = sharedLog(remote);
  assert.equal(more.length, 0);
  assert.match(o.summary, /\[redacted\]/);
  assert.match(o.summary, /\[email\]/);
  assert.match(o.summary, /@\[user\]/);
  assert.match(o.id, /^[0-9a-f]{16}$/);
  assert.equal(o.by, undefined, 'no identity without FACTORY_PLUGIN_ADVISOR_SHARE_AS');
  assert.deepEqual(Object.keys(o).sort(), ['at', 'detail', 'id', 'kind', 'plugin', 'signature', 'source', 'summary']);
  // The local log holds the same occurrence (same id).
  const local = JSON.parse(readFileSync(join(ann.box.config, 'occurrences.jsonl'), 'utf8'));
  assert.deepEqual(local, o);
  // The commit that carried it names neither the user nor their git identity.
  const log = git(['--git-dir', remote, 'log', '--format=%an <%ae>|%cn <%ce>|%s', BRANCH], ann.box.dir).trim().split('\n');
  assert.equal(log[0], `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|factory-plugin-advisor: record 1 occurrence`);
  // The opt-in: the chosen name, and nothing else.
  const bob = user('Bob', shared(remote), { FACTORY_PLUGIN_ADVISOR_SHARE_AS: 'Bob B' });
  ok(record(bob, 'docs gate fails on a fresh clone'));
  assert.equal(sharedLog(remote)[1].by, 'Bob B');
  // A name that could be an email or a mention is ignored, and the CLI says so.
  const eve = user('Eve', shared(remote), { FACTORY_PLUGIN_ADVISOR_SHARE_AS: 'eve@example.com' });
  const r = record(eve, 'docs gate fails on a fresh clone');
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, /FACTORY_PLUGIN_ADVISOR_SHARE_AS is ignored/);
  assert.equal(sharedLog(remote)[2].by, undefined);
});

// ------------------------------------------------------------------ 3. reading

test('two users: list, show and suggest read both logs, group one issue across people, and never double-count', () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  const bob = user('Bob', shared(remote));
  ann.factory(['init']);
  ok(record(ann, 'factory-docs stale fails in /home/annsmith/app/README.md with exit 1'));
  ok(record(bob, 'factory-docs stale fails in /home/bobsmith/code/README.md with exit 2'));
  const r = record(ann, 'factory-docs stale fails in /home/annsmith/other/README.md with exit 3');
  assert.match(r.stdout, /seen 3 times/, 'record counts the team');
  for (const u of [ann, bob]) {
    const issues = list(u);
    assert.equal(issues.length, 1, `${u.name}: one issue across people`);
    assert.equal(issues[0].count, 3, `${u.name}: own occurrences in both logs count once`);
    const shown = JSON.parse(ok(u.box.call(['show', issues[0].signature, '--json'])));
    assert.equal(shown.occurrences.length, 3);
  }
  // Bob's local log holds only his own occurrence.
  assert.equal(readFileSync(join(bob.box.config, 'occurrences.jsonl'), 'utf8').trim().split('\n').length, 1);
  // suggest: state.json moves to the shared location; one person's dismiss applies to the team.
  const sig = list(ann)[0].signature;
  const s = JSON.parse(ok(ann.box.call(['suggest', '--threshold', '3', '--json'])));
  assert.equal(s.suggestions.length, 1);
  assert.equal(JSON.parse(sharedRaw(remote, 'state.json')).issues[sig].suggestedCount, 3);
  assert.equal(list(bob)[0].status, 'suggested', "Bob sees Ann's suggestion");
  ok(bob.box.call(['dismiss', sig]));
  assert.ok(JSON.parse(sharedRaw(remote, 'state.json')).issues[sig].dismissedAt);
  assert.equal(list(ann)[0].status, 'dismissed', "Ann sees Bob's dismiss");
  for (let i = 0; i < 3; i++) ok(record(ann, `factory-docs stale fails in /home/annsmith/x${i}/README.md with exit ${i}`));
  assert.deepEqual(JSON.parse(ok(ann.box.call(['suggest', '--threshold', '3', '--json']))).suggestions, [], 'dismissed stays dismissed');
  const state = JSON.parse(sharedRaw(remote, 'state.json')).issues[sig];
  assert.equal(state.suggestedCount, 3);
  assert.ok(state.dismissedAt);
  // The factory still works on the branch, and its checkout brings the advisor's files along.
  const id = ann.factory(['new', 'After sharing']).split('\n')[0] as string;
  assert.match(id, /^001-/);
  assert.equal(existsSync(join(ann.project, 'factory', 'jobs', 'advisor', 'occurrences.jsonl')), true);
  ok(record(bob, 'factory-docs stale fails in /home/bobsmith/later/README.md with exit 9'));
  ann.factory(['note', id, 'still works after an advisor push']);
});

test('concurrent records from two users race for the branch; every occurrence lands once', async () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  const bob = user('Bob', shared(remote));
  ann.factory(['init']);
  const runs: Promise<number>[] = [];
  for (const u of [ann, bob, ann, bob]) {
    runs.push(
      new Promise((done) => {
        const p = spawn(process.execPath, [ADVISOR_CLI, 'record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', `parallel ${u.name} ${runs.length}`], { env: { ...u.box.env, PATH: process.env.PATH } as NodeJS.ProcessEnv, cwd: u.project, stdio: 'ignore' });
        p.on('close', (code) => done(code ?? 1));
      }),
    );
  }
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  // A record that lost every race leaves its occurrence queued; the next command pushes it.
  list(ann);
  list(bob);
  const ids = sharedLog(remote).map((o) => o.id);
  assert.equal(ids.length, 4, JSON.stringify(sharedLog(remote)));
  assert.equal(new Set(ids).size, 4);
  assert.equal(list(ann).reduce((n, i) => n + i.count, 0), 4);
});

/** The real git, for the wrapper below to run. */
function realGit(): string {
  for (const d of (process.env.PATH ?? '').split(':')) {
    if (d !== '' && existsSync(join(d, 'git'))) return join(d, 'git');
  }
  throw new Error('git not on PATH');
}

/**
 * A `git` first on PATH that holds every `git init` at a barrier until `n` of them have started (or
 * `waitMs` passed), so `n` processes of one user that all find no bare clone yet set it up at once,
 * every time. Everything else goes straight to the real git.
 */
function barrierGit(dir: string, n: number, waitMs: number): string {
  const bin = join(dir, 'barrier-bin');
  const marks = join(dir, 'barrier-marks');
  mkdirSync(bin, { recursive: true });
  mkdirSync(marks, { recursive: true });
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'init') {
  fs.writeFileSync(${JSON.stringify(marks)} + '/' + process.pid, '');
  const until = Date.now() + ${waitMs};
  while (fs.readdirSync(${JSON.stringify(marks)}).length < ${n} && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const p = spawnSync(${JSON.stringify(realGit())}, args, { stdio: 'inherit' });
process.exit(p.status ?? 1);
`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}

/** Every push to the remote takes `ms` longer, so pushes from different processes overlap. */
function slowPushes(remote: string, ms: number): void {
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').readFileSync(0);\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`);
  chmodSync(hook, 0o755);
}

/** The ids of a user's own occurrences: their local log. */
const localIds = (u: User): string[] => readFileSync(join(u.box.config, 'occurrences.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);

/** The ids waiting in a user's queue. */
function queuedIds(u: User): string[] {
  const shared = join(u.box.config, 'shared');
  if (!existsSync(shared)) return [];
  return readdirSync(shared).flatMap((key) => {
    const q = join(shared, key, 'queue');
    return existsSync(q) ? readdirSync(q).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)) : [];
  });
}

function spawnAdvisor(u: User, env: NodeJS.ProcessEnv, args: string[], stdin?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [ADVISOR_CLI, ...args], { env, cwd: u.project, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.stdin.end(stdin ?? '');
    p.on('close', (code) => done({ code: code ?? 1, stderr }));
  });
}

test('concurrent records and hooks of one user and of two race for one bare clone, one queue and the branch; no occurrence is ever lost', async () => {
  const hook = readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8');
  const PER_USER = 4; // three records and one hook
  for (let round = 1; round <= 3; round++) {
    const { remote } = world();
    slowPushes(remote, 150);
    const ann = user('Ann', shared(remote));
    const bob = user('Bob', shared(remote));
    ann.factory(['init']);
    const runs: Array<Promise<{ code: number; stderr: string }>> = [];
    for (const u of [ann, bob]) {
      // Every process of this user reaches `git init` of its (missing) bare clone together.
      const env = { ...u.box.env, PATH: `${barrierGit(u.box.dir, PER_USER, 1500)}:${process.env.PATH}` } as NodeJS.ProcessEnv;
      for (let i = 0; i < PER_USER - 1; i++) runs.push(spawnAdvisor(u, env, ['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', `round ${round} ${u.name} ${i}`]));
      runs.push(spawnAdvisor(u, env, ['hook'], hook));
    }
    const results = await Promise.all(runs);
    assert.deepEqual(results.map((r) => r.code), Array(2 * PER_USER).fill(0), results.map((r) => r.stderr).join(''));
    const expected = [...localIds(ann), ...localIds(bob)];
    assert.equal(expected.length, 2 * PER_USER);
    // Right after the race: each occurrence is on the branch exactly once, or still in its owner's queue.
    const landed = sharedLog(remote).map((o) => o.id);
    assert.equal(new Set(landed).size, landed.length, `round ${round}: an occurrence landed twice`);
    const waiting = [...queuedIds(ann), ...queuedIds(bob)];
    for (const id of expected) assert.ok(landed.includes(id) || waiting.includes(id), `round ${round}: ${id} is neither on the branch nor queued`);
    for (const r of results) assert.doesNotMatch(r.stderr, /cannot queue/);
    // One more command each: every occurrence is on the branch exactly once, and the queues are empty.
    list(ann);
    list(bob);
    const after = sharedLog(remote).map((o) => o.id);
    assert.deepEqual([...after].sort(), [...expected].sort(), `round ${round}`);
    assert.deepEqual([...queuedIds(ann), ...queuedIds(bob)], []);
  }
});

test('a record or hook that cannot take the shared lock in time leaves its occurrence queued and exits 0 silently; a stale lock is taken over', async () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  ok(record(ann, 'first one creates the bare clone'));
  const [key] = readdirSync(join(ann.box.config, 'shared'));
  const lock = join(ann.box.config, 'shared', key as string, 'lock');
  // A live process holds the lock (this test's own pid): the commands wait a bounded time, then give up.
  writeFileSync(lock, `${process.pid}\n`);
  const env = { ...ann.box.env, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const started = Date.now();
  const [r, h] = await Promise.all([
    spawnAdvisor(ann, env, ['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', 'while locked']),
    spawnAdvisor(ann, env, ['hook'], readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8')),
  ]);
  assert.ok(Date.now() - started < 15_000, 'bounded wait');
  assert.deepEqual([r.code, r.stderr, h.code, h.stderr], [0, '', 0, '']);
  const ids = localIds(ann);
  assert.equal(ids.length, 3);
  assert.deepEqual(queuedIds(ann).sort(), ids.slice(1).sort(), 'both wait in the queue');
  assert.equal(sharedLog(remote).length, 1);
  // The holder died without releasing it: the next command takes the lock over and pushes the queue.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(lock, `${dead}\n`);
  list(ann);
  assert.deepEqual(sharedLog(remote).map((o) => o.id).sort(), [...ids].sort());
  assert.deepEqual(queuedIds(ann), []);
  assert.equal(existsSync(lock), false, 'released');
});

test('the hook stays silent and queues locally when the remote is unreachable; the next command pushes the queue', () => {
  const { box: w, remote } = world();
  const missing = join(w.dir, 'not-yet.git');
  const ann = user('Ann', { remote: { url: missing, branch: BRANCH }, advisor: { share: true } });
  const hook = readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8');
  assert.deepEqual(ann.box.call(['hook'], { stdin: hook }), { code: EXIT.ok, stdout: '', stderr: '' });
  const local = JSON.parse(readFileSync(join(ann.box.config, 'occurrences.jsonl'), 'utf8'));
  assert.equal(local.source, 'hook');
  const queueDir = join(ann.box.config, 'shared');
  const [key] = readdirSync(queueDir);
  assert.deepEqual(readdirSync(join(queueDir, key as string, 'queue')), [`${local.id}.json`]);
  // A CLI command says it could not reach the remote, and still works on the local log.
  const r = ann.box.call(['list']);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, /cannot reach the remote factory .*not-yet\.git .*occurrences wait in/);
  assert.match(r.stdout, /1x {2}factory/);
  // Back online (the remote now exists at that path): the next command pushes the queue, once.
  renameSync(remote, missing);
  const again = ann.box.call(['list', '--json']);
  assert.equal(again.stderr, '');
  assert.equal(JSON.parse(again.stdout).issues[0].count, 1);
  const pushed = spawnSync('git', ['--git-dir', missing, 'show', `${BRANCH}:advisor/occurrences.jsonl`], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(pushed, [local]);
  assert.deepEqual(readdirSync(join(queueDir, key as string, 'queue')), []);
  // The exact hook command (hooks/hooks.json) also prints nothing and exits 0 while unreachable.
  const offline = { ...ann.box.env, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  writeFileSync(join(ann.project, 'factory.json'), `${JSON.stringify({ remote: { url: join(w.dir, 'gone.git'), branch: BRANCH }, advisor: { share: true } })}\n`);
  const p = spawnSync(process.execPath, [ADVISOR_CLI, 'hook'], { input: hook, env: offline, encoding: 'utf8' });
  assert.deepEqual([p.status, p.stdout, p.stderr], [0, '', '']);
});

test('a dismiss made while offline is kept locally and pushed by the next command that reaches the remote', () => {
  const { box: w, remote } = world();
  const ann = user('Ann', shared(remote));
  const bob = user('Bob', shared(remote));
  ok(record(ann, 'docs gate fails on a fresh clone'));
  const sig = list(ann)[0].signature;
  const away = join(w.dir, 'away.git');
  renameSync(remote, away);
  const r = ann.box.call(['dismiss', sig]);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, /the state change is saved locally/);
  assert.equal(list(ann)[0].status, 'dismissed');
  renameSync(away, remote);
  assert.equal(list(bob)[0].status, 'open', 'not pushed yet');
  list(ann);
  assert.equal(list(bob)[0].status, 'dismissed');
});

// ------------------------------------------------------------------ 4. the public-remote warning

test('record and suggest warn once per session about a remote that is or may be public; never offline-fatal', () => {
  const { box: w } = world();
  // No network in tests: git may not use https at all, so the remote is unreachable (as offline).
  const ann = user('Ann', { remote: { url: 'https://ann:tok3n@github.com/org/project-factory.git', branch: BRANCH }, advisor: { share: true } }, { GIT_ALLOW_PROTOCOL: 'file', CLAUDE_CODE_SESSION_ID: 'session-1' });
  const first = record(ann, 'docs gate fails on a fresh clone');
  assert.equal(first.code, EXIT.ok);
  const warnings = (s: string): string[] => s.split('\n').filter((l) => l.includes('warning: sharing'));
  assert.deepEqual(warnings(first.stderr), ['factory-plugin-advisor: warning: sharing the redacted friction log on github.com, which hosts public repositories (factory.json advisor.share); if that repository is public, anyone can read the shared occurrences']);
  assert.equal(first.stderr.includes('tok3n'), false, 'credentials are never printed');
  assert.deepEqual(warnings(record(ann, 'docs gate fails again').stderr), [], 'once per session');
  assert.deepEqual(warnings(ann.box.call(['suggest']).stderr), []);
  assert.deepEqual(warnings(ann.box.call(['list']).stderr), [], 'list never warns');
  ann.box.env.CLAUDE_CODE_SESSION_ID = 'session-2';
  assert.equal(warnings(ann.box.call(['suggest']).stderr).length, 1, 'a new session warns again');
  // Outside a Claude Code session every run is its own session.
  delete ann.box.env.CLAUDE_CODE_SESSION_ID;
  assert.equal(warnings(record(ann, 'x happened').stderr).length, 1);
  assert.equal(warnings(record(ann, 'x happened').stderr).length, 1);
  // A local path remote: no warning.
  const bob = user('Bob', shared(join(w.dir, 'state.git')));
  assert.deepEqual(warnings(record(bob, 'docs gate fails on a fresh clone').stderr), []);
});

test('how the warning decides: no network, local paths and private hosts are quiet, public or unknown hosts warn', () => {
  const cfg = (url: string): ShareConfig => ({ url, branch: BRANCH, configPath: '/x/factory.json' });
  for (const url of ['/srv/git/state.git', './state.git', '../s.git', 'file:///srv/state.git', 'C:\\repos\\s.git', 'git@gitserver:team/state.git', 'ssh://git@git.corp/x.git', 'https://10.0.0.5/x.git', 'https://192.168.1.2/x.git', 'https://git.internal/x.git', 'http://localhost:3000/x.git']) {
    assert.equal(publicWarning(cfg(url)), null, url);
  }
  for (const url of ['git@github.com:org/x.git', 'https://github.com/org/x.git', 'ssh://git@gitlab.com/org/x.git', 'https://user:pw@bitbucket.org/o/x.git', 'git@codeberg.org:o/x.git']) {
    assert.match(publicWarning(cfg(url)) ?? '', /which hosts public repositories/, url);
  }
  for (const url of ['https://git.example.com/x.git', 'git@git.example.org:o/x.git']) {
    assert.match(publicWarning(cfg(url)) ?? '', /which the advisor cannot tell is private/, url);
  }
  assert.equal(remoteHost('git@github.com:org/x.git'), 'github.com');
  assert.equal(remoteHost('/abs/path'), null);
  assert.equal(privateHost('172.20.1.1'), true);
  assert.equal(privateHost('172.32.1.1'), false);
  assert.equal(displayUrl('https://u:secret@github.com/o/x.git'), 'https://github.com/o/x.git');
});

// ------------------------------------------------------------------ untrusted shared content

test('shared lines and state are validated: unknown fields, control characters and bad shapes are dropped', () => {
  const good = { signature: '0123456789ab', plugin: 'factory', kind: 'workaround', summary: 'ok', at: '2026-11-01T10:00:00.000Z', source: 'record', id: '0123456789abcdef' };
  assert.deepEqual(sharedOccurrence(good), good);
  for (const bad of [{ ...good, id: undefined }, { ...good, summary: 'a\u001b[31mred' }, { ...good, extra: 1 }, { ...good, by: 'x@y.com' }, { ...good, kind: 'other' }, { ...good, signature: '../../etc' }]) {
    assert.equal(sharedOccurrence(JSON.parse(JSON.stringify(bad))), null, JSON.stringify(bad));
  }
  const merged = mergeState(
    { version: 1, issues: { '0123456789ab': { suggestedCount: 3, suggestedAt: '2026-11-01T10:00:00.000Z' } } },
    { version: 1, issues: { '0123456789ab': { suggestedCount: 2, dismissedAt: '2026-11-02T10:00:00.000Z' } } },
  );
  assert.deepEqual(merged.issues['0123456789ab'], { suggestedCount: 3, suggestedAt: '2026-11-01T10:00:00.000Z', dismissedAt: '2026-11-02T10:00:00.000Z' });
});
