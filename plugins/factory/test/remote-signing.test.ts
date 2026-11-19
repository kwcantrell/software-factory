// The remote factory: signed state commits, allowed signers and merge.
// Split from the former single remote.test.ts so each file stays well inside the per-test timeout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sshKey, TASK } from './helpers.ts';
import { BRANCH, intruder, Person, withWorld, World } from './remote-helpers.ts';


const SIGNERS = '.factory/allowed_signers';

/** Commit an allowed-signers file listing `people` in `p`'s project checkout, and point factory.json at it. */
function trust(p: Person, w: World, people: Person[]): void {
  mkdirSync(join(p.repo, '.factory'), { recursive: true });
  writeFileSync(join(p.repo, SIGNERS), `${people.map((x) => x.signer).join('\n')}\n`);
  p.git(['add', SIGNERS]);
  p.git(['commit', '-q', '-m', 'Allowed signers']);
  p.config({ remote: { url: w.state, branch: BRANCH, allowed_signers: SIGNERS } });
}

/** Drive `id` (started by `p`) through build, proof and one approving round to ship. */
function toShip(p: Person, id: string): void {
  const wt = p.job(id).worktree as string;
  writeFileSync(join(wt, 'feature.txt'), 'feature\n');
  p.git(['add', 'feature.txt'], wt);
  p.git(['commit', '-q', '-m', 'feature'], wt);
  for (const name of ['build.md', 'proof.md', 'review-1-solo.md']) p.write(id, name, '# notes\n');
  p.ok(['built', id]);
  p.ok(['proof', id, 'pass']);
  p.ok(['round', id, 'solo']);
  p.ok(['verdict', id, 'solo', 'approve']);
  assert.equal(p.job(id).stage, 'ship');
}

/** `%G?` of every commit on the state branch, checked against `people`'s keys. */
function signatures(w: World, people: Person[]): string[] {
  const file = join(w.tmp, 'check_signers');
  writeFileSync(file, `${people.map((x) => x.signer).join('\n')}\n`);
  return w.remote(['-c', `gpg.ssh.allowedSignersFile=${file}`, 'log', '--format=%G?', BRANCH]).split('\n');
}

/** A commit in the intruder's clone of the state branch, signed with `key` (or unsigned), pushed. */
function forge(m: ReturnType<typeof intruder>, id: string, fn: (job: Record<string, any>) => void, key: string | null): string {
  m.git(['pull', '-q', '--ff-only']);
  m.edit(`${id}/job.json`, fn);
  m.git(['add', '-A']);
  m.git([...(key ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`] : []), 'commit', ...(key ? ['-S'] : []), '-q', '-m', 'hand edit']);
  m.git(['push', '-q', 'origin', BRANCH]);
  return m.git(['rev-parse', 'HEAD']);
}

/** A job in review with every verdict forged to approve: what a hand edit would push to skip review. */
const forgedApproval = (job: Record<string, any>): void => {
  job.stage = 'ship';
  job.status = 'needs-human';
  job.needs_human = 'approved by every reviewer - awaiting your merge';
  job.rounds = [{ n: 1, reviewers: { solo: { verdict: 'approve', at: job.created } } }];
  job.history.push({ at: job.created, stage: 'ship', event: 'approved in round 1' });
};

test('every state commit the CLI makes in remote mode is signed with the person\'s own key', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  const id = ann.newJob('Signed');
  bob.ok(['note', id, 'from Bob']);
  ann.write(id, 'task.md', TASK);
  ann.ok(['start', id]);
  const sigs = signatures(w, [ann, bob]);
  assert.equal(sigs.length, 4);
  assert.deepEqual(new Set(sigs), new Set(['G']), 'init, new, note, start: all signed by an allowed key');
  assert.equal(w.remote(['log', '-1', '--skip=1', '--format=%an', BRANCH]), 'Bob');
  // Bob's commit is his key's, not Ann's: checked against Ann's key alone it is not a good signature.
  assert.equal(signatures(w, [ann])[1], 'U');
}));

test('without a signing setup a state-changing command refuses before changing anything, naming the git settings', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.newJob('Before');
  const tip = w.remote(['rev-parse', BRANCH]);
  const nobody = new Person(w, 'Nobody');
  nobody.git(['config', '--unset', 'user.signingkey']);
  const run = (p: Person, args: string[], message: RegExp): void => {
    const q = p.refused(args, message);
    assert.match(q.stderr, /git config gpg\.format ssh/);
    assert.match(q.stderr, /git config user\.signingkey <path to your SSH key/);
    assert.match(q.stderr, /unsigned_ok/);
  };
  for (const args of [['init'], ['new', 'x'], ['note', id, 'x'], ['close', id], ['remote', 'push']]) {
    run(nobody, args, /user\.signingkey is not set/);
  }
  assert.equal(existsSync(join(nobody.jobs, '.git')), false, 'nothing was attached');
  nobody.git(['config', 'gpg.format', 'openpgp']);
  run(nobody, ['new', 'x'], /gpg\.format is 'openpgp'/);
  nobody.git(['config', '--unset', 'gpg.format']);
  run(nobody, ['new', 'x'], /gpg\.format is not set/);
  nobody.git(['config', 'gpg.format', 'ssh']);
  nobody.git(['config', 'user.signingkey', join(w.tmp, 'no-such-key')]);
  run(nobody, ['new', 'x'], /user\.signingkey .*no-such-key does not exist/);
  // Ann's own checkout loses its key: her next command changes nothing, locally or on the remote.
  ann.git(['config', '--unset', 'user.signingkey']);
  const before = readFileSync(join(ann.jobs, id, 'job.json'), 'utf8');
  run(ann, ['note', id, 'x'], /user\.signingkey is not set/);
  assert.equal(readFileSync(join(ann.jobs, id, 'job.json'), 'utf8'), before);
  assert.equal(w.remote(['rev-parse', BRANCH]), tip);
  // Reading still works.
  ann.ok(['status']);
  // unsigned_ok: true is the documented way out; its commits are unsigned.
  ann.config({ remote: { url: w.state, branch: BRANCH, unsigned_ok: true } });
  ann.ok(['note', id, 'unsigned on purpose']);
  assert.equal(signatures(w, [ann])[0], 'N');
}));

test('merge refuses a remote factory without allowed_signers, saying how to set it up', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const id = ann.startedJob('No signers');
  toShip(ann, id);
  const p = ann.refused(['merge', id], /needs an allowed-signers file/);
  assert.match(p.stderr, /"allowed_signers": "\.factory\/allowed_signers"/);
  assert.match(p.stderr, /by pull request/);
  assert.equal(ann.job(id).stage, 'ship');
  // Set, but not committed in the project checkout: refused too.
  ann.config({ remote: { url: w.state, branch: BRANCH, allowed_signers: SIGNERS } });
  mkdirSync(join(ann.repo, '.factory'));
  writeFileSync(join(ann.repo, SIGNERS), `${ann.signer}\n`);
  ann.refused(['merge', id], /allowed-signers file \.factory\/allowed_signers .* is not committed in .* \(HEAD\)/);
  assert.equal(ann.job(id).stage, 'ship');
}));

test('two people with allowed keys complete a job and merge it', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  trust(ann, w, [ann, bob]);
  const id = ann.newJob('Together');
  ann.write(id, 'task.md', TASK);
  ann.ok(['spec', id]);
  bob.ok(['approve', id]);
  ann.ok(['start', id]);
  toShip(ann, id);
  assert.equal(w.remote(['log', '--format=%an', BRANCH, '--', id]).split('\n').filter((n) => n === 'Bob').length, 1, 'Bob approved the spec');
  assert.match(ann.ok(['merge', id]), new RegExp(`${id} merged into main`));
  assert.equal(ann.job(id).stage, 'done');
  assert.ok(existsSync(join(ann.repo, 'feature.txt')), 'the branch was merged');
  assert.deepEqual(new Set(signatures(w, [ann, bob])), new Set(['G']));
}));

test('merge refuses an unsigned commit and a commit signed by a key not in the allowed-signers file, naming the commit', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const eve = new Person(w, 'Eve');
  ann.ok(['init']);
  trust(ann, w, [ann]);
  // An unsigned state commit made by the CLI itself (Eve turned signing off), before Ann claims the job.
  const id = ann.newJob('Checked');
  eve.config({ remote: { url: w.state, branch: BRANCH, unsigned_ok: true } });
  eve.ok(['init']);
  eve.ok(['note', id, 'unsigned']);
  const unsigned = w.remote(['rev-parse', BRANCH]);
  ann.write(id, 'task.md', TASK);
  ann.ok(['start', id]);
  toShip(ann, id);
  const tip = w.remote(['rev-parse', BRANCH]);
  let p = ann.refused(['merge', id], new RegExp(`state commit ${unsigned.slice(0, 12)} \\("factory: note ${id}"\\) is not signed`));
  assert.equal(ann.job(id).stage, 'ship');
  assert.equal(w.remote(['rev-parse', BRANCH]), tip, 'a refused merge publishes nothing');
  // A commit signed by Eve's key, which the allowed-signers file does not list.
  const other = ann.newJob('Checked again');
  eve.config({ remote: { url: w.state, branch: BRANCH } });
  eve.ok(['note', other, 'signed by Eve']);
  const evil = w.remote(['rev-parse', BRANCH]);
  ann.write(other, 'task.md', TASK);
  ann.ok(['start', other]);
  toShip(ann, other);
  p = ann.refused(['merge', other], new RegExp(`state commit ${evil.slice(0, 12)} .* is signed by a key that is not in the allowed-signers file \\(SHA256:`));
  assert.match(p.stderr, /allowed signers: \.factory\/allowed_signers at HEAD of /);
  // Adding Eve to the file without committing it changes nothing: merge reads the committed file.
  writeFileSync(join(ann.repo, SIGNERS), `${ann.signer}\n${eve.signer}\n`);
  ann.refused(['merge', other], /is signed by a key that is not in the allowed-signers file/);
  ann.git(['checkout', '--', SIGNERS]);
  assert.equal(ann.job(other).stage, 'ship');
}));

test('a forged approval pushed unsigned by a second clone is refused at merge', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  trust(ann, w, [ann]);
  const id = ann.startedJob('Under review');
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'unreviewed.txt'), 'never reviewed\n');
  ann.git(['add', 'unreviewed.txt'], wt);
  ann.git(['commit', '-q', '-m', 'unreviewed'], wt);
  ann.write(id, 'build.md', '# notes\n');
  ann.ok(['built', id]);
  const m = intruder(w);
  const forged = forge(m, id, forgedApproval, null);
  ann.ok(['status']);
  assert.equal(ann.job(id).stage, 'ship', 'the forged job.json looks approved');
  ann.refused(['merge', id], new RegExp(`refusing to merge ${id}: state commit ${forged.slice(0, 12)} \\("hand edit"\\) is not signed`));
  assert.equal(existsSync(join(ann.repo, 'unreviewed.txt')), false, 'nothing was merged');
  assert.equal(ann.job(id).stage, 'ship');
  // Signed with a key outside the file: refused as well.
  const other = ann.startedJob('Under review too');
  const mallory = sshKey(join(w.tmp, 'keys'), 'mallory', 'mallory@example.invalid');
  forge(m, other, forgedApproval, mallory.key);
  ann.ok(['status']);
  ann.refused(['merge', other], /\("hand edit"\) is signed by a key that is not in the allowed-signers file/);
}));

test('a hand-edited job.json committed outside the CLI with an allowed key passes: the trust boundary is the key', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  trust(ann, w, [ann, bob]);
  const id = ann.startedJob('Edited by hand');
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'by-hand.txt'), 'x\n');
  ann.git(['add', 'by-hand.txt'], wt);
  ann.git(['commit', '-q', '-m', 'x'], wt);
  // The edit must name the commit, as `built` records it: a ship record without one is refused
  // under signing (a rollback to a record from before `head` existed would skip the check).
  const m = intruder(w);
  forge(m, id, forgedApproval, bob.key);
  ann.ok(['status']);
  ann.refused(['merge', id], new RegExp(`${id} has no commit recorded by \`factory built\`.*\`factory rework ${id}\`.*\`factory built ${id}\` again`));
  assert.equal(existsSync(join(ann.repo, 'by-hand.txt')), false);
  forge(m, id, (job) => (job.head = ann.git(['rev-parse', 'HEAD'], wt)), bob.key);
  ann.ok(['status']);
  assert.match(ann.ok(['merge', id]), /merged into main/);
  assert.ok(existsSync(join(ann.repo, 'by-hand.txt')));
}));

test('a rollback of the state branch to a signed ship record cannot merge code built after it', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  trust(ann, w, [ann, bob]);
  trust(bob, w, [ann, bob]);
  const id = ann.startedJob('Rolled back');
  toShip(ann, id);
  const reviewed = ann.git(['rev-parse', 'HEAD'], ann.job(id).worktree as string);
  bob.ok(['status']);
  assert.equal(bob.job(id).stage, 'ship');
  const shipTip = w.remote(['rev-parse', BRANCH]);
  // A human sends it back; the builder commits new code and hands it to proof again.
  ann.ok(['rework', id, 'one more change']);
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'unreviewed.txt'), 'never proven or reviewed\n');
  ann.git(['add', 'unreviewed.txt'], wt);
  ann.git(['commit', '-q', '-m', 'unreviewed'], wt);
  ann.ok(['built', id]);
  const unreviewed = ann.git(['rev-parse', 'HEAD'], wt);
  ann.git(['push', '-q', 'origin', `factory/${id}`]);
  // Someone with push access rolls the state branch back to the signed ship tip.
  const m = intruder(w);
  m.git(['push', '-q', '--force', 'origin', `${shipTip}:refs/heads/${BRANCH}`]);
  assert.equal(w.remote(['rev-parse', BRANCH]), shipTip);
  // The merger pulls it (every commit in it is signed by an allowed key) and has the branch.
  bob.git(['fetch', '-q', 'origin', `factory/${id}:factory/${id}`]);
  bob.ok(['status']);
  assert.equal(bob.job(id).stage, 'ship');
  const main = bob.git(['rev-parse', 'HEAD']);
  const p = bob.refused(['merge', id], new RegExp(`branch factory/${id} is at ${unreviewed}, but \`factory built\` handed ${reviewed} to proof and review`));
  assert.match(p.stderr, new RegExp(`\`factory built ${id}\` again`));
  assert.equal(bob.git(['rev-parse', 'HEAD']), main, 'nothing was merged');
  assert.equal(existsSync(join(bob.repo, 'unreviewed.txt')), false);
  assert.equal(bob.job(id).stage, 'ship');
  assert.equal(w.remote(['rev-parse', BRANCH]), shipTip, 'a refused merge publishes nothing');
  assert.equal(bob.job(id).head, reviewed);
  assert.equal(ann.job(id).head, unreviewed);
}));

test('a merger without the job branch is refused with how to get it', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  trust(ann, w, [ann, bob]);
  trust(bob, w, [ann, bob]);
  const id = ann.startedJob('Elsewhere');
  toShip(ann, id);
  bob.refused(['merge', id], new RegExp(`branch factory/${id} is not in .*fetch that branch into this checkout`));
  assert.equal(existsSync(join(bob.repo, 'feature.txt')), false);
}));

test('a push that loses a race replays the state commit signed: every commit stays good and the job that lost merges', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  const bob = new Person(w, 'Bob');
  ann.ok(['init']);
  bob.ok(['init']);
  trust(ann, w, [ann, bob]);
  trust(bob, w, [ann, bob]);
  const a = ann.newJob('Anns job');
  const b = bob.startedJob('Bobs job');
  bob.raceWith(ann, ['note', a, 'ann was first']);
  bob.ok(['note', b, 'bob second']);
  assert.match(bob.raced(), /^0\n/);
  assert.deepEqual(w.remote(['log', '-2', '--format=%s', BRANCH]).split('\n'), [`factory: note ${b}`, `factory: note ${a}`], 'Bob\'s commit was replayed');
  assert.deepEqual(new Set(signatures(w, [ann, bob])), new Set(['G']), 'the replayed commit is signed too');
  bob.assertInSync(w);
  toShip(bob, b);
  assert.match(bob.ok(['merge', b]), new RegExp(`${b} merged into main`));
}));

test('merge refuses a state commit with an OpenPGP signature, even one git calls good', { skip: spawnSync('gpg', ['--version']).status !== 0 && 'gpg is not installed' }, withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  trust(ann, w, [ann]);
  const id = ann.startedJob('Signed with GPG');
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'gpg.txt'), 'x\n');
  ann.git(['add', 'gpg.txt'], wt);
  ann.git(['commit', '-q', '-m', 'x'], wt);
  // A throwaway GnuPG key in the home every process here shares (HOME is the temp dir): the merger's
  // own keyring trusts it ultimately, so git reports its signature as good ('G').
  const gnupg = join(w.tmp, '.gnupg');
  mkdirSync(gnupg, { mode: 0o700 });
  const gpg = (args: string[]): void => {
    const p = spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { env: w.env, encoding: 'utf8' });
    assert.equal(p.status, 0, `gpg ${args.join(' ')}: ${p.stderr}`);
  };
  try {
    gpg(['--quick-gen-key', 'Mallory <mallory@example.invalid>', 'ed25519', 'sign', 'never']);
    const m = intruder(w);
    m.git(['pull', '-q', '--ff-only']);
    m.edit(`${id}/job.json`, forgedApproval);
    m.git(['add', '-A']);
    m.git(['-c', 'gpg.format=openpgp', '-c', 'user.signingkey=mallory@example.invalid', 'commit', '-S', '-q', '-m', 'hand edit']);
    m.git(['push', '-q', 'origin', BRANCH]);
    const forged = m.git(['rev-parse', 'HEAD']);
    const empty = join(w.tmp, 'no_signers');
    writeFileSync(empty, '');
    assert.equal(w.remote(['-c', `gpg.ssh.allowedSignersFile=${empty}`, 'log', '-1', '--format=%G?', BRANCH]), 'G', 'git alone calls it good');
    ann.ok(['status']);
    assert.equal(ann.job(id).stage, 'ship');
    ann.refused(['merge', id], new RegExp(`state commit ${forged.slice(0, 12)} \\("hand edit"\\) has an OpenPGP signature, which git checks without the allowed-signers file, so it is not accepted`));
    assert.equal(existsSync(join(ann.repo, 'gpg.txt')), false, 'nothing was merged');
    assert.equal(ann.job(id).stage, 'ship');
  } finally {
    spawnSync('gpgconf', ['--kill', 'all'], { env: w.env });
  }
}));

test('merge refuses a job.json changed in the state checkout but not committed', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  trust(ann, w, [ann]);
  const id = ann.startedJob('Edited locally');
  ann.write(id, 'build.md', '# notes\n');
  const wt = ann.job(id).worktree as string;
  writeFileSync(join(wt, 'y.txt'), 'y\n');
  ann.git(['add', 'y.txt'], wt);
  ann.git(['commit', '-q', '-m', 'y'], wt);
  ann.ok(['built', id]);
  const path = join(ann.jobs, id, 'job.json');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  forgedApproval(job);
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`);
  ann.refused(['merge', id], /job\.json is not the version committed on the state branch/);
  assert.equal(existsSync(join(ann.repo, 'y.txt')), false);
}));

test('unsigned_ok: true merges without signatures, as before', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.config({ remote: { url: w.state, branch: BRANCH, unsigned_ok: true } });
  ann.git(['config', '--unset', 'user.signingkey']);
  ann.ok(['init']);
  const id = ann.startedJob('Unsigned team');
  toShip(ann, id);
  assert.match(ann.ok(['merge', id]), /merged into main/);
  assert.deepEqual(new Set(signatures(w, [ann])), new Set(['N']));
}));

// ---------------------------------------------------------------- 8. a bad job on the state branch

test('one invalid job.json on the state branch: listings skip it with a warning, commands on it refuse', withWorld((w) => {
  const ann = new Person(w, 'Ann');
  ann.ok(['init']);
  const good = ann.newJob('Fine');
  ann.ok(['followup', 'add', good, '--by', 'human', 'listed anyway']);
  const bad = ann.newJob('Broken on the branch');
  const m = intruder(w);
  m.git(['pull', '-q', '--ff-only']);
  writeFileSync(join(m.dir, bad, 'job.json'), '["not", "a", "job"]\n');
  m.git(['commit', '-q', '-am', 'break it']);
  m.git(['push', '-q', 'origin', BRANCH]);
  for (const args of [['status'], ['status', '--json'], ['stats'], ['followup', 'list']]) {
    const p = ann.factory(args);
    assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`);
    const warnings = p.stderr.split('\n').filter((l) => l.startsWith('factory: skipping'));
    assert.equal(warnings.length, 1, p.stderr);
    assert.match(warnings[0] as string, new RegExp(`skipping ${join(ann.jobs, bad).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*is not a job record the factory wrote: it is not a JSON object`));
  }
  assert.match(ann.ok(['status']), new RegExp(good));
  assert.match(ann.ok(['followup', 'list']), /listed anyway/);
  for (const args of [['status', bad], ['note', bad, 'x'], ['close', bad]]) ann.refused(args, /it is not a JSON object/);
  ann.assertInSync(w);
}));
