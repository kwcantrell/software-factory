// job.json compatibility with the original CLI, both ways. fixtures/factory-py/factory is a factory
// dir written by the original CLI (jobs in intake, spec-pending, build with a worktree, ship after two
// rounds with follow-ups, merged, closed, and stuck at the round limit); fixtures/*/expected holds
// that CLI's output for status, followup list and stats on exactly those files ("<ROOT>" stands for
// the factory dir). fixtures/factory-stats is a set of synthetic histories that stress the rounding
// and number formats of `stats`, with the original CLI's output.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CLI, cleanEnv, Repo, TASK } from './helpers.ts';

const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-compat-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

function copyOf(name: string): string {
  const dir = join(scratch, `${name}-${Math.random().toString(36).slice(2)}`);
  cpSync(join(FIXTURES, name, 'factory'), dir, { recursive: true });
  return dir;
}

function factory(dir: string, args: string[]): string {
  // Not inside any git repo: FACTORY_DIR alone must be enough to read jobs.
  const p = spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch,
    env: cleanEnv(scratch, { FACTORY_DIR: dir }),
    encoding: 'utf8',
  });
  assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`);
  return p.stdout.split(dir).join('<ROOT>');
}

const expected = (fixture: string, name: string): string =>
  readFileSync(join(FIXTURES, fixture, 'expected', name), 'utf8');

test('status, followup list and stats print exactly what the original CLI printed', () => {
  const dir = copyOf('factory-py');
  const cases: [string, string[]][] = [
    ['status.txt', ['status']],
    ['status.json', ['status', '--json']],
    ['status-4.json', ['status', '4', '--json']],
    ['followup-list.txt', ['followup', 'list']],
    ['followup-list-all.txt', ['followup', 'list', '--all']],
    ['followup-list-all.json', ['followup', 'list', '--all', '--json']],
    ['followup-list-4.txt', ['followup', 'list', '4', '--all']],
    ['stats.txt', ['stats']],
    ['stats.json', ['stats', '--json']],
  ];
  for (const id of readdirSync(join(dir, 'jobs'))) cases.push([`status-${id}.txt`, ['status', id]]);
  assert.equal(cases.length, 16);
  for (const [file, args] of cases) {
    assert.equal(factory(dir, args), expected('factory-py', file), `factory ${args.join(' ')}`);
  }
});

test('stats rounds and formats numbers as the original CLI did', () => {
  const dir = copyOf('factory-stats');
  assert.equal(factory(dir, ['stats']), expected('factory-stats', 'stats.txt'));
  assert.equal(factory(dir, ['stats', '--json']), expected('factory-stats', 'stats.json'));
});

test('writing to an old job keeps its format: only activity, history and updated change', () => {
  const dir = copyOf('factory-py');
  const path = join(dir, 'jobs', '003-build-with-worktree', 'job.json');
  const before = JSON.parse(readFileSync(path, 'utf8'));
  factory(dir, ['note', '3', 'still going']);
  const text = readFileSync(path, 'utf8');
  const afterJob = JSON.parse(text);
  assert.deepEqual(Object.keys(afterJob), Object.keys(before));
  assert.equal(afterJob.activity, 'still going');
  assert.equal(afterJob.history.length, before.history.length + 1);
  // The original wrote non-ASCII as \u escapes; so does the port.
  assert.match(text, /\\u00dcn\\u00efcode/);
  const strip = (j: Record<string, unknown>) => ({ ...j, activity: 0, history: 0, updated: 0 });
  assert.deepEqual(strip(afterJob), strip(before));
});

/** Every key and the JSON type of every value, recursively (arrays: the union of their items). */
function shape(v: unknown): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const items = [...new Set(v.map((x) => JSON.stringify(shape(x))))].sort();
    return { array: items };
  }
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shape(x)]));
  }
  return typeof v;
}

function fixtureJob(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, 'factory-py', 'factory', 'jobs', id, 'job.json'), 'utf8'));
}

/**
 * A job this CLI drove through `built` has the one key the original CLI never wrote: `head`, the
 * built commit, after every older key. Anything else extra still fails the shape comparison.
 */
function withoutHead(job: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(job, 'head')) return job;
  const keys = Object.keys(job);
  assert.equal(keys[keys.length - 1], 'head', 'head comes after the original keys');
  assert.match(String(job.head), /^[0-9a-f]{40}([0-9a-f]{24})?$/);
  const { head: _head, ...rest } = job;
  return rest;
}

test('jobs the port writes have the same keys, order and value types as the original', () => {
  const r = new Repo();
  try {
    // Intake, as `new` writes it.
    const intake = r.newJob('Intake only job');
    assert.deepEqual(shape(r.job(intake)), shape(fixtureJob('001-intake-only-job')));
    assert.deepEqual(Object.keys(r.job(intake)), Object.keys(fixtureJob('001-intake-only-job')));

    // Spec pending.
    const pending = r.newJob('Spec pending job');
    r.write(pending, 'task.md', TASK);
    r.ok(['spec', pending]);
    assert.deepEqual(shape(r.job(pending)), shape(fixtureJob('002-spec-pending-job')));

    // Build with a worktree, a note and a follow-up.
    const build = r.newJob('Build with worktree');
    r.write(build, 'task.md', TASK);
    r.ok(['start', build]);
    r.ok(['note', build, 'builder model: opus - test']);
    r.ok(['followup', 'add', build, '--by', 'builder', 'a follow-up']);
    assert.deepEqual(shape(r.job(build)), shape(fixtureJob('003-build-with-worktree')));

    // Ship after a failed proof and two rounds, with open, done and dropped follow-ups.
    const ship = r.newJob('Shipped after two rounds');
    r.write(ship, 'task.md', TASK);
    r.ok(['start', ship]);
    r.commitIn(ship);
    for (const n of ['build.md', 'proof.md']) r.write(ship, n, '# n\n');
    for (const n of [1, 2]) for (const v of ['security', 'standards', 'behavior']) r.write(ship, `review-${n}-${v}.md`, '# n\n');
    r.ok(['built', ship]);
    r.ok(['proof', ship, 'fail']);
    r.ok(['built', ship]);
    r.ok(['proof', ship, 'pass']);
    r.ok(['round', ship]);
    r.ok(['verdict', ship, 'security', 'approve']);
    r.ok(['verdict', ship, 'standards', 'changes']);
    r.ok(['verdict', ship, 'behavior', 'approve']);
    r.ok(['built', ship]);
    r.ok(['proof', ship, 'pass']);
    r.ok(['round', ship]);
    for (const v of ['security', 'standards', 'behavior']) r.ok(['verdict', ship, v, 'approve']);
    r.ok(['followup', 'add', ship, '--by', 'security', 'Open one']);
    r.ok(['followup', 'add', ship, '--by', 'standards', 'Done one']);
    r.ok(['followup', 'done', ship, '2', 'job', '009']);
    r.ok(['followup', 'add', ship, '--by', 'supervisor', 'Dropped one']);
    r.ok(['followup', 'drop', ship, '3']);
    // The dropped follow-up has a null resolution, the done one a string: compare item by item.
    const mine = withoutHead(r.job(ship));
    const theirs = fixtureJob('004-shipped-after-two-rounds');
    assert.deepEqual(shape({ ...mine, followups: [] }), shape({ ...theirs, followups: [] }));
    (mine.followups as unknown[]).forEach((f, i) => {
      assert.deepEqual(shape(f), shape((theirs.followups as unknown[])[i]));
    });

    // Merged.
    const merged = r.shippedJob('merged.txt');
    r.write(merged, 'ship.md', '# ship\n');
    r.ok(['merge', merged]);
    assert.deepEqual(shape(withoutHead(r.job(merged))), shape(fixtureJob('005-merged-job')));

    // The port's files are byte-compatible in layout: indent 2 and a trailing newline.
    const text = readFileSync(join(r.jobDir(merged), 'job.json'), 'utf8');
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  } finally {
    r.cleanup();
  }
});

test('the fixture covers the stages the tests above rely on', () => {
  const stages = readdirSync(join(FIXTURES, 'factory-py', 'factory', 'jobs')).map(
    (id) => (fixtureJob(id) as { stage: string }).stage,
  );
  for (const s of ['intake', 'build', 'review', 'ship', 'done']) assert.ok(stages.includes(s), s);
});
