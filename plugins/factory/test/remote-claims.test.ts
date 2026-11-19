// The remote factory: claims and owners, remote push, the dashboard and the state checkout.
// Split from the former single remote.test.ts so each file stays well inside the per-test timeout.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mapPath } from '../src/dashboard.ts';
import { CLI, PLUGIN, Repo, TASK, withRepo } from './helpers.ts';
import type { Result } from './helpers.ts';
import { BRANCH, Person, withWorld } from './remote-helpers.ts';

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

