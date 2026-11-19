// The remote factory (factory.json `remote`): job state shared through a git branch. Every test
// drives the real CLI as a subprocess. The remote is a bare repo in a temp dir; two clones of a
// shared code repo act as two people (Ann and Bob), each with their own factory dir.
// Split from the former single remote.test.ts so each file stays well inside the per-test timeout.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI, TASK, withRepo } from './helpers.ts';
import type { Result } from './helpers.ts';
import { BRANCH, git, Person, withWorld } from './remote-helpers.ts';

// ---------------------------------------------------------------- 1. configuration

test('remote config: valid values load, bad shapes and unknown sub-keys are refused', withRepo((r) => {
  const cfg = join(r.repo, 'factory.json');
  writeFileSync(cfg, JSON.stringify({ remote: { url: 'git@github.com:org/project-factory.git', branch: 'factory/state' } }));
  // A read command still runs when the remote cannot be reached; it says so on stderr.
  const p = r.factory(['config']);
  assert.equal(p.status, 0, p.stderr);
  // The optional keys are filled in with their defaults: signing required, no allowed-signers file yet.
  assert.deepEqual(JSON.parse(p.stdout).remote, { url: 'git@github.com:org/project-factory.git', branch: 'factory/state', allowed_signers: null, unsigned_ok: false });
  assert.match(p.stderr, /showing the last-pulled state/);
  for (const [remote, signers, unsignedOk] of [
    [{ url: 'x', branch: 'b', allowed_signers: '.factory/allowed_signers' }, '.factory/allowed_signers', false],
    [{ url: 'x', branch: 'b', allowed_signers: 'allowed_signers', unsigned_ok: false }, 'allowed_signers', false],
    [{ url: 'x', branch: 'b', allowed_signers: null, unsigned_ok: true }, null, true],
  ] as const) {
    writeFileSync(cfg, JSON.stringify({ remote }));
    const q = r.factory(['config', '--offline']);
    assert.equal(q.status, 0, q.stderr);
    assert.deepEqual(JSON.parse(q.stdout).remote, { url: 'x', branch: 'b', allowed_signers: signers, unsigned_ok: unsignedOk });
  }
  writeFileSync(cfg, '{"remote": null}');
  assert.equal(JSON.parse(r.ok(['config'])).remote, null);
  const bad: [unknown, RegExp][] = [
    ['https://x/y.git', /'remote' must be null or an object/],
    [[], /'remote' must be null or an object/],
    [{ url: 'x', branch: 'b', token: 'secret' }, /'remote' has unknown key 'token' \(known: url, branch, allowed_signers, unsigned_ok\)/],
    [{ url: 'x', branch: 'b', allowed_signers: '/etc/allowed_signers' }, /'remote\.allowed_signers' must be null or a path inside the repository/],
    [{ url: 'x', branch: 'b', allowed_signers: '../allowed_signers' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: '.factory/../../x' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: '' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: 'a//b' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: '.git/config' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: 'a\\..\\b' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: '-x' }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', allowed_signers: 7 }, /'remote\.allowed_signers'/],
    [{ url: 'x', branch: 'b', unsigned_ok: 'yes' }, /'remote\.unsigned_ok' must be true or false/],
    [{ url: 'x', branch: 'b', unsigned_ok: true, allowed_signers: 'a' }, /'remote\.unsigned_ok' is true, which turns signature checks off, but 'remote\.allowed_signers' is set/],
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
  r.sign();
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
  r.sign();
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

