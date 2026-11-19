// The remote factory: what someone with push access can plant on the state branch.
// Split from the former single remote.test.ts so each file stays well inside the per-test timeout.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withRepo } from './helpers.ts';
import { BRANCH, intruder, Person, withWorld } from './remote-helpers.ts';


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
    [(j) => (j.id = '../../../outside'), /its id is "\.\.\/\.\.\/\.\.\/outside", not its directory's name "001-fields"/],
    [(j) => (j.id = '002-other'), /its id is "002-other"/],
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

// ---------------------------------------------------------------- 7. signed state commits
