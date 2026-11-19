// Drives the real CLI (node src/cli.ts) as a subprocess against throwaway git repos with FACTORY_DIR
// set. The first block is the port of the original CLI's test suite, one test per original test.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Repo, TASK, withRepo } from './helpers.ts';

/** A failed merge exits 2, leaves the job in ship with its worktree and branch, and the main
 * checkout clean with no merge in progress. */
function assertMergeEscalatedAndKept(r: Repo, id: string, p: { status: number | null; stderr: string; stdout: string }) {
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.match(p.stderr, /escalated to a human/);
  const job = r.job(id);
  assert.deepEqual([job.stage, job.status], ['ship', 'needs-human']);
  assert.ok(statSync(job.worktree).isDirectory());
  assert.match(r.git(['branch', '--list', job.branch]), new RegExp(job.branch));
  assert.equal(r.git(['status', '--porcelain', '--untracked-files=no']), '');
  assert.equal(existsSync(join(r.repo, '.git', 'MERGE_HEAD')), false);
  return job;
}

// ------------------------------------------------- ported from the original test suite

test('init creates a runtime dir that ignores itself', withRepo((r) => {
  const out = r.ok(['init']);
  assert.match(out, /factory ready at/);
  assert.ok(statSync(join(r.fdir, 'jobs')).isDirectory());
  assert.equal(readFileSync(join(r.fdir, '.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  assert.ok(statSync(join(r.fdir, 'index.html')).isFile());
  assert.equal(r.git(['status', '--porcelain']), '', 'factory/ must not show up in git status');
}));

test('new opens a job in intake', withRepo((r) => {
  const id = r.newJob('Add cursor pagination');
  assert.equal(id, '001-add-cursor-pagination');
  const job = r.job(id);
  assert.deepEqual([job.stage, job.status], ['intake', 'active']);
  assert.equal(r.newJob('Second'), '002-second');
}));

test('start creates the worktree and branch', withRepo((r) => {
  const id = r.startedJob();
  const job = r.job(id);
  assert.equal(job.stage, 'build');
  assert.equal(job.branch, `factory/${id}`);
  assert.equal(job.base_branch, 'main');
  assert.equal(job.base, r.git(['rev-parse', 'HEAD']));
  assert.equal(job.worktree, join(r.fdir, 'worktrees', id));
  assert.ok(statSync(join(job.worktree, 'README.md')).isFile());
  assert.equal(r.git(['rev-parse', '--abbrev-ref', 'HEAD'], job.worktree), job.branch);
  assert.match(r.git(['branch', '--list', job.branch]), new RegExp(job.branch));
}));

test('start without task.md is refused', withRepo((r) => {
  const id = r.newJob();
  const p = r.factory(['start', id]);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /refused/);
  assert.match(p.stderr, /task\.md/);
  assert.equal(r.job(id).stage, 'intake');
  assert.equal(existsSync(join(r.fdir, 'worktrees', id)), false);
}));

test('start without acceptance criteria is refused', withRepo((r) => {
  const id = r.newJob();
  r.write(id, 'task.md', '# A job\n\nDo it.\n');
  const p = r.factory(['start', id]);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /Acceptance criteria/);
}));

test('built with no commits is refused', withRepo((r) => {
  const id = r.startedJob();
  r.write(id, 'build.md', '# Build\n');
  const p = r.factory(['built', id]);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /no commits/);
  assert.equal(r.job(id).stage, 'build');
}));

test('built with a commit moves to proof', withRepo((r) => {
  const id = r.startedJob();
  const wt = r.commitIn(id);
  r.write(id, 'build.md', '# Build\n');
  r.ok(['built', id], { cwd: wt }); // from inside the worktree, as the builder does
  assert.equal(r.job(id).stage, 'proof');
}));

test('human escalates with exit 2', withRepo((r) => {
  const id = r.newJob();
  const p = r.factory(['human', id, 'which database?']);
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.match(p.stderr, /escalated to a human/);
  const job = r.job(id);
  assert.deepEqual([job.status, job.needs_human], ['needs-human', 'which database?']);
  // A job waiting on a human is refused until a human resumes it.
  r.write(id, 'task.md', TASK);
  assert.equal(r.factory(['start', id]).status, 1);
  r.ok(['resume', id]);
  r.ok(['start', id]);
}));

test('repeated proof failures escalate with exit 2', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), '{"max_proof_attempts": 1}\n');
  const id = r.startedJob();
  r.commitIn(id, 'x.txt', 'x\n');
  for (const name of ['build.md', 'proof.md']) r.write(id, name, '# notes\n');
  r.ok(['built', id]);
  const p = r.factory(['proof', id, 'fail']);
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.equal(r.job(id).status, 'needs-human');
}));

test('merge conflict escalates as a conflict', withRepo((r) => {
  const id = r.shippedJob('README.md', "the branch's readme\n");
  writeFileSync(join(r.repo, 'README.md'), "main's readme\n");
  r.git(['commit', '-q', '-am', 'Change README on main']);
  const p = r.factory(['merge', id]);
  const job = assertMergeEscalatedAndKept(r, id, p);
  assert.match(job.needs_human, /conflicts - the branch needs a rebase/);
  assert.match(p.stderr, /CONFLICT/, "git's own output is still printed");
}));

test("merge failing for another reason reports git's error", withRepo((r) => {
  const id = r.shippedJob();
  // No identity anywhere: drop the GIT_AUTHOR_*/GIT_COMMITTER_* env, and stop git guessing one from
  // the host name so the failure does not depend on the machine's DNS.
  const env = Object.fromEntries(
    Object.entries(r.env).filter(([k]) => !k.startsWith('GIT_AUTHOR_') && !k.startsWith('GIT_COMMITTER_')),
  );
  r.git(['config', 'user.useConfigOnly', 'true']);
  const p = r.factory(['merge', id], { env });
  const job = assertMergeEscalatedAndKept(r, id, p);
  assert.match(job.needs_human, /Please tell me who you are/);
  assert.doesNotMatch(job.needs_human.toLowerCase(), /conflict/);
  assert.doesNotMatch(job.needs_human.toLowerCase(), /rebase/);
  assert.match(p.stderr, /Please tell me who you are/, "git's own output is still printed");
}));

test('config prints the defaults', withRepo((r) => {
  const cfg = JSON.parse(r.ok(['config']));
  assert.deepEqual(cfg.reviewers, ['security', 'standards', 'behavior']);
  assert.equal(cfg.spec_gate, false);
}));

test('config rejects an unknown key', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), '{"max_review_round": 2}\n');
  const p = r.factory(['config']);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /unknown key 'max_review_round'/);
}));

test('config rejects a bad value', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), '{"spec_gate": "yes"}\n');
  const p = r.factory(['config']);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /spec_gate/);
}));

// ------------------------------------------------- added with the port

test('a merge that succeeds lands on the base branch and cleans up', withRepo((r) => {
  const id = r.shippedJob();
  const out = r.ok(['merge', id]);
  assert.equal(out, `${id} merged into main\n`);
  const job = r.job(id);
  assert.deepEqual([job.stage, job.status, job.worktree, job.needs_human], ['done', 'merged', null, null]);
  assert.ok(existsSync(join(r.repo, 'thing.txt')));
  assert.equal(r.git(['branch', '--list', `factory/${id}`]), '');
}));

test('merge refuses a dirty checkout and a different branch', withRepo((r) => {
  const id = r.shippedJob();
  writeFileSync(join(r.repo, 'README.md'), 'dirty\n');
  let p = r.factory(['merge', id]);
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stderr, /has uncommitted changes/);
  r.git(['checkout', '-q', '--', 'README.md']);
  r.git(['checkout', '-q', '-b', 'other']);
  p = r.factory(['merge', id]);
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stderr, /main checkout is on 'other' but the job was cut from 'main'/);
  r.ok(['merge', id, '--into-current']);
  assert.equal(r.job(id).stage, 'done');
}));

test('config accepts valid values and rejects floats, bools and bad names', withRepo((r) => {
  const cfg = join(r.repo, 'factory.json');
  writeFileSync(cfg, '{"reviewers": ["a", "b-2"], "max_review_rounds": 5, "spec_gate": true, "specs_dir": "docs/specs"}');
  const ok = JSON.parse(r.ok(['config']));
  assert.deepEqual(ok, { reviewers: ['a', 'b-2'], max_review_rounds: 5, max_proof_attempts: 3, spec_gate: true, specs_dir: 'docs/specs' });
  const bad: [string, RegExp][] = [
    ['{"max_review_rounds": 2.0}', /'max_review_rounds' must be a whole number of at least 1/],
    ['{"max_review_rounds": true}', /must be a whole number/],
    ['{"max_proof_attempts": 0}', /must be a whole number/],
    ['{"reviewers": []}', /'reviewers' must be a non-empty list/],
    ['{"reviewers": ["a", "a"]}', /'reviewers' must be/],
    ['{"reviewers": ["Upper"]}', /'reviewers' must be/],
    ['{"specs_dir": "/abs"}', /'specs_dir' must be null or a repo-relative/],
    ['{"specs_dir": "a/../b"}', /'specs_dir' must be/],
    ['{"specs_dir": "  "}', /'specs_dir' must be/],
    ['[1]', /must be a JSON object/],
    ['{nope', /is not valid JSON/],
  ];
  for (const [text, message] of bad) {
    writeFileSync(cfg, text);
    const p = r.factory(['config']);
    assert.equal(p.status, 1, `${text}: ${p.stdout}${p.stderr}`);
    assert.match(p.stderr, message, text);
  }
}));

test('the spec gate: spec, approve, then start; an edited task.md needs approving again', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), '{"spec_gate": true}\n');
  const id = r.newJob();
  r.write(id, 'task.md', TASK);
  let p = r.factory(['start', id]);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /spec_gate is on/);
  r.ok(['spec', id]);
  assert.equal(r.job(id).spec, 'pending');
  p = r.factory(['start', id]);
  assert.match(p.stderr, /waiting for a human to approve its spec/);
  assert.equal(r.ok(['approve', id]), `${id} spec approved; next: factory start ${id}\n`);
  assert.equal(r.job(id).spec_sha.length, 64);
  r.write(id, 'task.md', `${TASK}\n2. More.\n`);
  p = r.factory(['start', id]);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /task\.md changed after the human approved it/);
  assert.equal(r.factory(['approve', id]).status, 1, 'no spec pending any more');
}));

test('review rounds: changes go back to build, the round limit escalates, unknown reviewers are refused', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), '{"max_review_rounds": 2}\n');
  const id = r.startedJob();
  r.commitIn(id);
  for (const name of ['build.md', 'proof.md', 'review-1-a.md', 'review-1-b.md', 'review-2-a.md', 'review-2-b.md']) {
    r.write(id, name, '# notes\n');
  }
  r.ok(['built', id]);
  r.ok(['proof', id, 'pass']);
  assert.equal(r.factory(['verdict', id, 'a', 'approve']).status, 1, 'no round open');
  assert.equal(r.ok(['round', id, 'a', 'b']), 'round 1: a b\n');
  assert.match(r.factory(['round', id]).stderr, /round 1 is still waiting on verdicts/);
  assert.match(r.factory(['verdict', id, 'c', 'approve']).stderr, /'c' is not a reviewer in round 1 \(a, b\)/);
  r.ok(['verdict', id, 'a', 'approve']);
  assert.match(r.factory(['verdict', id, 'a', 'changes']).stderr, /a already recorded 'approve' for round 1/);
  assert.equal(r.ok(['verdict', id, 'b', 'changes']), `${id}: b -> changes (stage: build)\n`);
  r.ok(['built', id]);
  r.ok(['proof', id, 'pass']);
  r.ok(['round', id, 'a', 'b']);
  r.ok(['verdict', id, 'a', 'approve']);
  const p = r.factory(['verdict', id, 'b', 'changes']);
  assert.equal(p.status, 2, p.stderr);
  assert.match(p.stderr, /escalated to a human: changes still requested after 2 rounds \(b\)/);
  const job = r.job(id);
  assert.deepEqual([job.stage, job.status], ['review', 'needs-human']);
  r.ok(['resume', id, '--reset']);
  assert.deepEqual(r.job(id).rounds, []);
  assert.equal(r.job(id).proof_attempts, 0);
}));

test('rework sends an approved job back to build with the request saved', withRepo((r) => {
  const id = r.shippedJob();
  assert.equal(r.factory(['rework', id, '  ']).status, 1);
  assert.equal(r.ok(['rework', id, 'rename', 'the', 'thing']), `${id} -> build (rework; request in rework-1.md)\n`);
  const note = readFileSync(join(r.jobDir(id), 'rework-1.md'), 'utf8');
  assert.match(note, /^# Rework requested after round 1\n\nRequested by a human at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\.\n\nrename the thing\n$/);
  const job = r.job(id);
  assert.deepEqual([job.stage, job.status, job.needs_human], ['build', 'active', null]);
}));

test('close keeps the branch and drops the worktree; resume refuses ship and done', withRepo((r) => {
  const id = r.startedJob();
  const wt = r.job(id).worktree;
  assert.equal(r.ok(['close', id, 'not', 'needed']), `${id} closed (branch factory/${id} kept)\n`);
  const job = r.job(id);
  assert.deepEqual([job.stage, job.status, job.worktree], ['done', 'closed', null]);
  assert.equal(existsSync(wt), false);
  assert.match(r.git(['branch', '--list', `factory/${id}`]), /factory/);
  assert.match(r.factory(['close', id]).stderr, /is already done/);
  assert.match(r.factory(['resume', id]).stderr, /use `factory merge` or `factory close`/);
}));

test('follow-ups: add, list, done, drop and --json', withRepo((r) => {
  const id = r.newJob();
  assert.equal(r.factory(['followup', 'add', id, '--by', 'Bad Name', 'x']).status, 1);
  assert.equal(r.factory(['followup', 'add', id, 'x']).status, 2, '--by is required');
  r.ok(['followup', 'add', id, '--by', 'builder', 'first', 'one']);
  r.ok(['followup', 'add', id, 'second', '--by=verifier']);
  r.ok(['followup', 'done', id, '1', 'job', '009']);
  assert.match(r.factory(['followup', 'drop', id, '1']).stderr, /follow-up 1 is already done/);
  assert.match(r.factory(['followup', 'drop', id, '7']).stderr, /has no follow-up 7/);
  assert.equal(r.factory(['followup', 'drop', id, 'x']).status, 2, 'n must be a number');
  assert.equal(r.ok(['followup', 'list']), `${id} #2 (verifier, intake)\n  second\n`);
  assert.equal(
    r.ok(['followup', 'list', '--all', '1']),
    `${id} #1 (builder, intake)  [done: job 009]\n  first one\n${id} #2 (verifier, intake)\n  second\n`,
  );
  const rows = JSON.parse(r.ok(['followup', 'list', '--json', '--all']));
  assert.deepEqual(Object.keys(rows[0]), ['n', 'text', 'by', 'stage', 'at', 'status', 'resolution', 'resolved_at', 'job']);
  r.ok(['followup', 'drop', id, '2']);
  assert.equal(r.ok(['followup', 'list']), 'no open follow-ups\n');
}));

test('job refs: number, prefix, ambiguity; path and --worktree; note sets the activity', withRepo((r) => {
  const a = r.newJob('alpha one');
  const b = r.newJob('alpha two');
  assert.equal(r.ok(['path', '2']), `${r.jobDir(b)}\n`);
  assert.equal(r.ok(['path', '002-alpha-t']), `${r.jobDir(b)}\n`);
  assert.equal(r.ok(['path', '1', '--worktree']), '\n');
  assert.match(r.factory(['path', '00']).stderr, /no job matches '00'/, 'a number matches by value');
  mkdirSync(join(r.fdir, 'jobs', '001-alpha-copy'));
  copyFileSync(join(r.jobDir(a), 'job.json'), join(r.fdir, 'jobs', '001-alpha-copy', 'job.json'));
  assert.match(r.factory(['path', '1']).stderr, /'1' is ambiguous: 001-alpha-copy, 001-alpha-one/);
  assert.match(r.factory(['path', '001-alpha-']).stderr, /'001-alpha-' is ambiguous/);
  assert.match(r.factory(['path', '9']).stderr, /no job matches '9'/);
  r.ok(['note', a, 'working', 'on', 'it']);
  assert.equal(r.job(a).activity, 'working on it');
}));

test('usage errors exit 2 with argparse-style messages; --help exits 0', withRepo((r) => {
  let p = r.factory(['proof', '1', 'maybe']);
  assert.equal(p.status, 2);
  assert.equal(p.stderr, "usage: factory proof [-h] job {pass,fail}\nfactory proof: error: argument result: invalid choice: 'maybe' (choose from 'pass', 'fail')\n");
  p = r.factory([]);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /the following arguments are required: cmd/);
  p = r.factory(['nope']);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /invalid choice: 'nope'/);
  p = r.factory(['start']);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /the following arguments are required: job/);
  p = r.factory(['resume', '1', '--bogus']);
  assert.equal(p.status, 2);
  assert.match(p.stderr, /unrecognized arguments: --bogus/);
  assert.equal(r.factory(['start', '--help']).status, 0);
  assert.equal(existsSync(r.fdir), false, 'usage errors and --help never create factory/');
}));

test('long options may be abbreviated, as before', withRepo((r) => {
  const id = r.newJob();
  assert.equal(r.factory(['human', id, 'why']).status, 2);
  assert.equal(r.ok(['resume', id, '--res']), `${id} resumed in intake\n`);
  assert.equal(JSON.parse(r.ok(['status', '--js'])).length, 1);
}));

test('without FACTORY_DIR the factory lives in the main checkout, also from a worktree', withRepo((r) => {
  const env = { ...r.env };
  delete env.FACTORY_DIR;
  const p1 = r.factory(['new', 'x'], { env });
  assert.equal(p1.status, 0, p1.stderr);
  assert.ok(existsSync(join(r.repo, 'factory', 'jobs', '001-x', 'job.json')));
  writeFileSync(join(r.repo, 'factory', 'jobs', '001-x', 'task.md'), TASK);
  assert.equal(r.factory(['start', '1'], { env }).status, 0);
  const wt = r.job('001-x').worktree;
  const p2 = r.factory(['path', '1'], { env, cwd: wt });
  assert.equal(p2.stdout, `${join(r.repo, 'factory', 'jobs', '001-x')}\n`);
  const outside = r.factory(['status'], { env, cwd: r.tmp });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /refused: not inside a git repository/);
}));

test('concurrent runs never lose an update (the job lock)', withRepo(async (r) => {
  const id = r.newJob();
  const { spawn } = await import('node:child_process');
  const { CLI } = await import('./helpers.ts');
  const runs = Array.from({ length: 8 }, (_, i) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'followup', 'add', id, '--by', 'builder', `item ${i}`], {
        cwd: r.repo,
        env: r.env,
        stdio: 'ignore',
      });
      child.on('close', resolve);
    }),
  );
  assert.deepEqual(await Promise.all(runs), Array(8).fill(0));
  assert.deepEqual(r.job(id).followups.map((f: { n: number }) => f.n).sort((a: number, b: number) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  // A lock left by a run that died is taken over.
  writeFileSync(join(r.fdir, '.lock.pid'), '999999999\n');
  r.ok(['note', id, 'after a crash']);
  assert.equal(existsSync(join(r.fdir, '.lock.pid')), false);
}));

// ------------------------------------------------- stray handoff files outside the job dir

/** A job waiting on `cmd`, with its handoff file written to the job dir: the args and file name. */
function waitingOn(r: Repo, cmd: 'built' | 'proof' | 'verdict'): { id: string; args: string[]; name: string } {
  const id = r.startedJob();
  r.commitIn(id);
  for (const name of ['build.md', 'proof.md', 'review-1-solo.md']) r.write(id, name, '# notes\n');
  if (cmd === 'built') return { id, args: ['built', id], name: 'build.md' };
  r.ok(['built', id]);
  if (cmd === 'proof') return { id, args: ['proof', id, 'pass'], name: 'proof.md' };
  r.ok(['proof', id, 'pass']);
  r.ok(['round', id, 'solo']);
  return { id, args: ['verdict', id, 'solo', 'approve'], name: 'review-1-solo.md' };
}

for (const cmd of ['built', 'proof', 'verdict'] as const) {
  for (const where of ['main checkout', 'worktree'] as const) {
    test(`${cmd} refuses while an untracked copy of its handoff file sits in the ${where}`, withRepo((r) => {
      const { id, args, name } = waitingOn(r, cmd);
      const dir = where === 'worktree' ? (r.job(id).worktree as string) : r.repo;
      const stray = join(dir, name);
      writeFileSync(stray, '# notes\n');
      const jobJson = join(r.jobDir(id), 'job.json');
      const before = readFileSync(jobJson, 'utf8');
      const p = r.factory(args);
      assert.equal(p.status, 1, p.stdout + p.stderr);
      assert.equal(p.stdout, '');
      assert.match(p.stderr, /refused/);
      assert.ok(p.stderr.includes(stray), `names the stray file's full path: ${p.stderr}`);
      assert.match(p.stderr, /move or delete it/);
      assert.equal(readFileSync(jobJson, 'utf8'), before, 'job.json is unchanged on refusal');
      // Deleting the stray copy is all it takes.
      unlinkSync(stray);
      r.ok(args);
    }));
  }

  test(`${cmd} ignores a tracked file of the same name in the main checkout and the worktree`, withRepo((r) => {
    const name = { built: 'build.md', proof: 'proof.md', verdict: 'review-1-solo.md' }[cmd];
    writeFileSync(join(r.repo, name), "the project's own file\n");
    r.git(['add', name]);
    r.git(['commit', '-q', '-m', `Add ${name}`]);
    const { id, args } = waitingOn(r, cmd);
    assert.ok(existsSync(join(r.job(id).worktree as string, name)));
    const stage = r.job(id).stage;
    r.ok(args);
    assert.notEqual(r.job(id).stage, stage);
  }));
}
