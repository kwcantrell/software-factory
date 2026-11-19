// `stations`, `stations suggest`, `stations apply` and `stations dismiss`, through run() against fixture
// factory dirs in temp repos, with the real factory CLI (this checkout's plugins/factory) resolving
// agents and checking them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/run.ts';
import { addLesson, unifiedDiff } from '../src/station-drafts.ts';
import { blockingText, parseProof, reasonKey, themesOf } from '../src/stations.ts';
import { PLUGIN_ROOT, sandbox, type Sandbox } from './helpers.ts';
import { APPROVED, type JobSpec, REPORT_LINE, writeLine } from './stations-fixtures.ts';

const FACTORY_CLI = join(PLUGIN_ROOT, '..', 'factory', 'src', 'cli.ts');
const OLD_FIXTURE = fileURLToPath(new URL('../../factory/test/fixtures/factory-py/factory', import.meta.url));

let box: Sandbox;
afterEach(() => box?.cleanup());

/** A sandbox with an empty repository (no git needed: --repo names it) and its factory dir. */
function setup(jobs: readonly JobSpec[] = [], config?: object): { repo: string; fdir: string } {
  box = sandbox();
  const repo = join(box.dir, 'repo');
  const fdir = join(repo, 'factory');
  mkdirSync(repo, { recursive: true });
  writeLine(fdir, jobs);
  if (config !== undefined) writeFileSync(join(repo, 'factory.json'), `${JSON.stringify(config)}\n`);
  return { repo, fdir };
}

function json(r: { code: number; stdout: string; stderr: string }): any {
  assert.equal(r.code, EXIT.ok, r.stderr);
  return JSON.parse(r.stdout);
}

const stations = (repo: string, ...args: string[]): any => json(box.call(['stations', ...args, '--repo', repo, '--json']));
const suggest = (repo: string, ...args: string[]): any => stations(repo, 'suggest', ...args);

function factory(repo: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [FACTORY_CLI, ...args], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: box.env.HOME, FACTORY_DIR: join(repo, 'factory') } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A project agent that passes `factory agents check`: the template with its TODO lines filled. */
function projectAgent(repo: string, station: string): string {
  assert.equal(factory(repo, 'agents', 'new', station).status, 0);
  const path = join(repo, '.claude', 'agents', `factory-${station}.md`);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^TODO: .*$/gm, 'Node and TypeScript; run npm test.'));
  assert.equal(factory(repo, 'agents', 'check').status, 0);
  return path;
}

/** Every file under `dir`, relative, with its content: to show that a command changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

// ------------------------------------------------------------------ fixtures for the rules

const perf = (id: string, text = 'Rendering the job list is slow: quadratic in jobs.'): JobSpec => ({ id, events: APPROVED(), followups: [['builder', text]], proof: 'PASS' });
const failed = (id: string, reason: string): JobSpec => ({
  id,
  events: ['created', 'building', 'awaiting independent proof', 'proof failed (attempt 1)'],
  proof: { fail: reason },
});
/** security approved round 1 while behavior's blocking finding was a security issue. */
const missed = (id: string, finding = '1. src/log.ts:9 writes the API secret to the log.'): JobSpec => ({
  id,
  events: [
    'created', 'building', 'awaiting independent proof', 'proof passed', 'review round 1 opened',
    'round 1: security -> approve', 'round 1: standards -> approve', 'round 1: behavior -> changes', 'round 1: changes requested by behavior',
    'awaiting independent proof', 'proof passed', 'review round 2 opened', 'round 2: security -> approve', 'round 2: standards -> approve', 'round 2: behavior -> approve', 'approved in round 2',
  ],
  blocking: { '1-behavior': finding },
  proof: 'PASS',
});
/** standards asked for changes on docs in round 1, and behavior raised docs again in round 2. */
const overlapped = (id: string, again = '1. README.md still documents the old flag.'): JobSpec => ({
  id,
  events: [
    'created', 'building', 'awaiting independent proof', 'proof passed', 'review round 1 opened',
    'round 1: security -> approve', 'round 1: standards -> changes', 'round 1: behavior -> approve', 'round 1: changes requested by standards',
    'awaiting independent proof', 'proof passed', 'review round 2 opened', 'round 2: security -> approve', 'round 2: standards -> approve', 'round 2: behavior -> changes', 'round 2: changes requested by behavior',
  ],
  blocking: { '1-standards': '1. The README does not mention the new flag.', '2-behavior': again },
  proof: 'PASS',
});
/** Proof passed, then behavior asked for changes. */
const unmet = (id: string, finding = '1. Criterion 2 is not met: --json prints nothing on an empty log.'): JobSpec => ({
  id,
  events: [
    'created', 'building', 'awaiting independent proof', 'proof passed', 'review round 1 opened',
    'round 1: security -> approve', 'round 1: standards -> approve', 'round 1: behavior -> changes', 'round 1: changes requested by behavior',
  ],
  blocking: { '1-behavior': finding },
  proof: 'PASS',
});

const rules = (out: any): string[] => out.suggestions.map((s: any) => `${s.rule} ${s.station}`);

// ------------------------------------------------------------------ parsing

test('themes, blocking sections, proof reasons and their normalised key', () => {
  assert.deepEqual(themesOf('The README is stale and the loop is quadratic'), ['performance', 'docs']);
  assert.deepEqual(themesOf('nothing to see'), []);
  assert.equal(themesOf('a migration of old jobs').includes('data-migration'), true);
  assert.equal(blockingText('# R\n\n## Blocking\n\nNone. I checked the README.\n\n## Non-blocking\n\n- slow'), '');
  assert.equal(blockingText('**Blocking**\n\n1. slow path\n\n**Non-blocking**\n\n- docs'), '1. slow path');
  const p = parseProof('## Verdict\nFAIL\n\n## Failures\n1. **Criterion 3:** `npm test` has 2 failing tests. More text.\n');
  assert.deepEqual([p.verdict, p.reason], ['fail', 'npm test has 2 failing tests.']);
  assert.equal(parseProof('## Verdict\nPASS\n\n## Failures\nNone.').reason, null);
  assert.equal(reasonKey('npm test has 2 failing tests in /tmp/a.ts'), reasonKey('npm test has 5 failing tests in /tmp/b.ts'));
});

test('unified diff and the lessons section', () => {
  const before = 'a\nb\n## Rules\nc\n';
  const after = addLesson(before, '- one');
  assert.match(after, /## Lessons from this line\n\n.*\n\n- one\n\n## Rules/);
  assert.equal(addLesson(after, '- two').match(/## Lessons/g)?.length, 1);
  assert.match(addLesson(after, '- two'), /- one\n- two\n\n## Rules/);
  const d = unifiedDiff('x.md', before, after);
  assert.match(d, /^--- a\/x\.md\n\+\+\+ b\/x\.md\n@@ -1,4 \+1,10 @@\n a\n b\n\+## Lessons/);
  assert.equal(unifiedDiff('n.md', null, 'x\ny\n'), '--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+x\n+y\n');
});

// ------------------------------------------------------------------ stations: the report

test('stations reports each station with known numbers from a fixture line', () => {
  const { repo } = setup(REPORT_LINE);
  const r = stations(repo);
  assert.equal(r.jobs, 5);
  const by = Object.fromEntries(r.stations.map((s: any) => [s.station, s]));
  assert.deepEqual(Object.keys(by), ['builder', 'verifier', 'reviewer-security', 'reviewer-standards', 'reviewer-behavior']);
  for (const s of r.stations) assert.deepEqual([s.owner, s.agent], ['shipped', `factory:${s.station}`]);
  assert.deepEqual(
    [by.builder.jobs, by.builder.proof.jobs, by.builder.proof.firstPassRate, by.builder.proof.passes, by.builder.proof.failures, by.builder.escalations, by.builder.followups],
    [4, 4, 0.5, 5, 4, 2, 1],
  );
  assert.deepEqual(by.builder.proof.failureReasons, [{ job: '003-gamma', reason: 'The full checks are red: npm test has 2 failing tests in test/parser.test.ts.' }]);
  assert.deepEqual([by.verifier.jobs, by.verifier.escalations, by.verifier.followups], [4, 1, 0]);
  assert.deepEqual([by['reviewer-security'].jobs, by['reviewer-security'].reviews, by['reviewer-security'].followups], [3, { approve: 5, changes: 0, changesThenApproved: 0, changesThenApprovedRate: null }, 1]);
  assert.deepEqual([by['reviewer-standards'].reviews, by['reviewer-standards'].escalations], [{ approve: 3, changes: 2, changesThenApproved: 0, changesThenApprovedRate: 0 }, 1]);
  assert.deepEqual(by['reviewer-behavior'].reviews, { approve: 4, changes: 1, changesThenApproved: 1, changesThenApprovedRate: 1 });
  const text = box.call(['stations', '--repo', repo]);
  assert.equal(text.code, EXIT.ok, text.stderr);
  assert.match(text.stdout, /^5 jobs in /);
  assert.match(text.stdout, /builder {2}factory:builder \(shipped\)\n {2}jobs 4, first-pass proof 50%, proof passes 5, proof failures 4, escalations 2, follow-ups 1/);
});

test('stations names a project agent and its file as factory agents resolves it, and writes no log', () => {
  const { repo } = setup(REPORT_LINE, { reviewers: ['security', 'behavior'] });
  projectAgent(repo, 'builder');
  const r = stations(repo);
  const builder = r.stations.find((s: any) => s.station === 'builder');
  assert.deepEqual([builder.agent, builder.owner, builder.file], ['factory-builder', 'project', '.claude/agents/factory-builder.md']);
  // standards recorded verdicts but is no longer configured: reported, marked unconfigured.
  const standards = r.stations.find((s: any) => s.station === 'reviewer-standards');
  assert.deepEqual([standards.configured, standards.owner, standards.reviews.changes], [false, 'unconfigured', 2]);
  assert.equal(existsSync(box.config), false, 'stations is read-only: no log dir');
});

test('stations reads job.json files written by the original CLI', () => {
  const { repo, fdir } = setup();
  cpSync(OLD_FIXTURE, fdir, { recursive: true });
  const r = stations(repo);
  assert.equal(r.jobs, 7);
  assert.ok(r.stations.some((s: any) => s.station === 'reviewer-solo' && s.configured === false));
  // A job.json without rounds, followups or history still counts.
  writeLine(fdir, [{ id: '900-bare', events: ['created'], omit: ['rounds', 'followups', 'history'] }]);
  assert.equal(stations(repo).jobs, 8);
});

test('stations without a factory dir, or with a bad option, fails cleanly', () => {
  box = sandbox();
  const empty = join(box.dir, 'empty');
  mkdirSync(empty);
  const r = box.call(['stations', '--repo', empty]);
  assert.deepEqual([r.code, r.stdout], [EXIT.failure, '']);
  assert.match(r.stderr, /no factory jobs in /);
  for (const argv of [['stations', 'bogus'], ['stations', '--min', '2'], ['stations', 'suggest', '--confirm'], ['stations', 'suggest', 'x'], ['stations', 'apply'], ['stations', 'dismiss', 'a', 'b'], ['stations', 'apply', 'not-hex', '--repo', empty]]) {
    const u = box.call(argv);
    assert.equal(u.code, EXIT.usage, `${argv.join(' ')}: ${u.stderr}`);
    assert.equal(u.stdout, '');
  }
});

// ------------------------------------------------------------------ rules: each fires, and doesn't

test('rule (a) new reviewer: a theme no reviewer covers, in at least --min jobs', () => {
  const { repo } = setup([perf('001-a'), perf('002-b'), perf('003-c', 'Startup latency doubled.')]);
  const out = suggest(repo);
  assert.deepEqual(rules(out), ['new-reviewer reviewer-performance']);
  assert.deepEqual(out.suggestions[0].jobs, ['001-a', '002-b', '003-c']);
  assert.deepEqual(out.suggestions[0].files, [{ path: '.claude/agents/factory-reviewer-performance.md', action: 'create' }, { path: 'factory.json', action: 'create' }]);
});

test('rule (a) does not fire below --min, or when a configured reviewer covers the theme', () => {
  let { repo } = setup([perf('001-a'), perf('002-b')]);
  assert.deepEqual(suggest(repo).suggestions, []);
  assert.deepEqual(rules(suggest(repo, '--min', '2')), ['new-reviewer reviewer-performance']);
  box.cleanup();
  ({ repo } = setup([perf('001-a'), perf('002-b'), perf('003-c')], { reviewers: ['security', 'performance'] }));
  assert.ok(!rules(suggest(repo)).some((r) => r.startsWith('new-reviewer')));
  box.cleanup();
  // docs is covered by standards, one of the default reviewers.
  ({ repo } = setup([perf('001-a', 'README is stale'), perf('002-b', 'README is stale'), perf('003-c', 'README is stale')]));
  assert.deepEqual(suggest(repo).suggestions, []);
});

test('rule (b) modify builder: the same normalised proof failure reason at least --min times', () => {
  const { repo } = setup([
    failed('001-a', 'npm test has 2 failing tests in test/a.test.ts.'),
    failed('002-b', 'npm test has 5 failing tests in test/b.test.ts.'),
    failed('003-c', 'npm test has 1 failing tests in test/c.test.ts.'),
  ]);
  const out = suggest(repo);
  assert.deepEqual(rules(out), ['modify-builder builder']);
  assert.equal(out.suggestions[0].count, 3);
});

test('rule (b) does not fire for different reasons', () => {
  const { repo } = setup([failed('001-a', 'npm test fails.'), failed('002-b', 'The typecheck fails.'), failed('003-c', 'Criterion 2 is not covered by a test.')]);
  assert.deepEqual(suggest(repo).suggestions, []);
});

test('rule (c) modify reviewer: approvals another lens then found issues in, and findings raised again', () => {
  let { repo } = setup([missed('001-a'), missed('002-b'), missed('003-c', '1. A token is not redacted in src/x.ts:4.')]);
  assert.deepEqual(rules(suggest(repo)), ['modify-reviewer reviewer-security']);
  box.cleanup();
  ({ repo } = setup([overlapped('001-a'), overlapped('002-b'), overlapped('003-c')]));
  const out = suggest(repo);
  // standards asked for changes on docs (overlap), and approved round 2 while behavior raised docs (miss).
  assert.deepEqual(out.suggestions.map((s: any) => s.title), [
    'reviewer-standards: approved 3 jobs where later checks found issues in its lens',
    'reviewer-standards: its "changes" were raised again by another lens in 3 jobs',
  ]);
});

test('rule (c) does not fire when the later finding is outside the lens or after a reviewer that asked for changes on something else', () => {
  let { repo } = setup([missed('001-a', '1. Off-by-one in src/x.ts:2.'), missed('002-b', '1. Off-by-one in src/x.ts:2.'), missed('003-c', '1. Off-by-one in src/x.ts:2.')]);
  assert.deepEqual(suggest(repo).suggestions, []);
  box.cleanup();
  ({ repo } = setup([overlapped('001-a', '1. A crash on empty input.'), overlapped('002-b', '1. A crash on empty input.'), overlapped('003-c', '1. A crash on empty input.')]));
  assert.deepEqual(suggest(repo).suggestions, []);
});

test('rule (d) modify verifier: proof passed, then behavior found an unmet criterion, in at least --min jobs', () => {
  const { repo } = setup([unmet('001-a'), unmet('002-b'), unmet('003-c', '1. The acceptance check for --repo is missing.')]);
  const out = suggest(repo);
  assert.deepEqual(rules(out), ['modify-verifier verifier']);
  assert.deepEqual(out.suggestions[0].files, [{ path: '.claude/agents/factory-verifier.md', action: 'create' }]);
});

test('rule (d) does not fire for behavior changes that name no criterion', () => {
  const { repo } = setup([unmet('001-a', '1. Off-by-one.'), unmet('002-b', '1. Off-by-one.'), unmet('003-c', '1. Off-by-one.')]);
  assert.deepEqual(suggest(repo).suggestions, []);
});

const ALL: JobSpec[] = [
  perf('001-a'), perf('002-b'), perf('003-c'),
  failed('004-d', 'npm test has 2 failing tests.'), failed('005-e', 'npm test has 3 failing tests.'), failed('006-f', 'npm test has 4 failing tests.'),
  missed('007-g'), missed('008-h'), missed('009-i'),
  unmet('010-j'), unmet('011-k'), unmet('012-l'),
];

test('the same history gives the same suggestions and drafts, every time', () => {
  const { repo } = setup(ALL);
  const first = suggest(repo);
  assert.deepEqual(rules(first), ['new-reviewer reviewer-performance', 'modify-builder builder', 'modify-reviewer reviewer-security', 'modify-verifier verifier']);
  const drafts = first.suggestions.map((s: any) => readFileSync(s.draft, 'utf8'));
  const again = suggest(repo);
  assert.deepEqual(again, first);
  assert.deepEqual(again.suggestions.map((s: any) => readFileSync(s.draft, 'utf8')), drafts);
  // The id is the rule, station and key: the same in another repository with the same history.
  const other = join(box.dir, 'other');
  writeLine(join(other, 'factory'), ALL);
  assert.deepEqual(suggest(other).suggestions.map((s: any) => s.id), first.suggestions.map((s: any) => s.id));
});

// ------------------------------------------------------------------ drafts

test('every drafted agent passes factory agents check, for each rule and for project and fallback agents', () => {
  const { repo } = setup(ALL);
  projectAgent(repo, 'builder');
  const out = suggest(repo);
  assert.equal(out.suggestions.length, 4);
  assert.deepEqual(out.problems, []);
  for (const s of out.suggestions) {
    const rec = JSON.parse(readFileSync(s.draft.replace(/\.md$/, '.json'), 'utf8'));
    const scratch = mkdtempSync(join(tmpdir(), 'stations-check-'));
    try {
      for (const f of rec.files) {
        mkdirSync(join(scratch, f.path, '..'), { recursive: true });
        writeFileSync(join(scratch, f.path), f.after);
        assert.doesNotMatch(f.after, /^TODO: /m);
      }
      const r = factory(scratch, 'agents', 'check');
      assert.equal(r.status, 0, `${s.id} ${s.station}: ${r.stderr}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('a draft holds the rationale, evidence, the change and a /factory:run line', () => {
  const { repo } = setup(ALL);
  projectAgent(repo, 'builder');
  const out = suggest(repo);
  const by = Object.fromEntries(out.suggestions.map((s: any) => [s.station, s]));
  const reviewer = readFileSync(by['reviewer-performance'].draft, 'utf8');
  for (const part of ['## Rationale', '## Evidence', '## Change', '## Apply', '## Factory request', 'name: factory-reviewer-performance', '## Your lens: performance', '--- /dev/null', '+++ b/factory.json']) {
    assert.ok(reviewer.includes(part), part);
  }
  assert.match(reviewer, /\+ {4}"performance"/);
  assert.match(reviewer, /- 001-a, follow-up 1 by builder: Rendering the job list is slow/);
  // A modification of a project agent is a diff against it; of a fallback, a new project agent.
  const builder = readFileSync(by.builder.draft, 'utf8');
  assert.match(builder, /--- a\/\.claude\/agents\/factory-builder\.md\n\+\+\+ b\/\.claude\/agents\/factory-builder\.md\n@@ /);
  assert.match(builder, /\+- Proof failed 3 times for the same reason/);
  assert.deepEqual(by.builder.files, [{ path: '.claude/agents/factory-builder.md', action: 'overwrite' }]);
  assert.deepEqual(by.verifier.files, [{ path: '.claude/agents/factory-verifier.md', action: 'create' }]);
  for (const s of out.suggestions) {
    assert.match(s.factoryRun, new RegExp(`^/factory:run .* factory-plugin-advisor station suggestion ${s.id}\\.$`));
    assert.ok(readFileSync(s.draft, 'utf8').includes(s.factoryRun));
    assert.equal(statSync(s.draft).mode & 0o777, 0o600);
  }
});

test('drafts redact secrets and mask personal details in what they quote', () => {
  const text = 'Slow export for alice@example.com from /home/alice/repo with token=s3cr3tvalue and @someone';
  const { repo } = setup([perf('001-a', text), perf('002-b', text), perf('003-c', text)]);
  const out = suggest(repo);
  const draft = readFileSync(out.suggestions[0].draft, 'utf8');
  for (const raw of ['alice@example.com', '/home/alice', 's3cr3tvalue', '@someone']) assert.ok(!draft.includes(raw), raw);
  assert.match(draft, /\[email\] from ~\/repo with token=\[redacted\] and @\[user\]/);
});

// ------------------------------------------------------------------ apply

test('apply without --confirm is a dry run: prints the files and the diff, changes nothing', () => {
  const { repo } = setup(ALL);
  const out = suggest(repo);
  const id = out.suggestions[0].id;
  const before = snapshot(repo);
  const state = readFileSync(join(box.config, 'state.json'), 'utf8');
  const r = stations(repo, 'apply', id);
  assert.deepEqual([r.dryRun, r.applied], [true, false]);
  assert.deepEqual(r.files.map((f: any) => [f.path, f.action]), [['.claude/agents/factory-reviewer-performance.md', 'create'], ['factory.json', 'create']]);
  assert.match(r.files[1].diff, /^--- \/dev\/null\n\+\+\+ b\/factory\.json\n/);
  const text = box.call(['stations', 'apply', id, '--repo', repo]);
  assert.match(text.stdout, /^Dry run: nothing was written\./);
  assert.match(text.stdout, /Run stations apply [0-9a-f]{12} --confirm to write exactly this\./);
  assert.deepEqual(snapshot(repo), before);
  assert.equal(readFileSync(join(box.config, 'state.json'), 'utf8'), state);
});

test('apply --confirm: a new reviewer writes its agent and adds it to factory.json, which the factory loads', () => {
  const { repo } = setup(ALL, { reviewers: ['security', 'standards', 'behavior'], max_review_rounds: 2 });
  const id = suggest(repo).suggestions.find((s: any) => s.rule === 'new-reviewer').id;
  const r = stations(repo, 'apply', id, '--confirm');
  assert.deepEqual([r.applied, r.dryRun], [true, false]);
  assert.match(readFileSync(join(repo, '.claude', 'agents', 'factory-reviewer-performance.md'), 'utf8'), /^---\nname: factory-reviewer-performance\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'factory.json'), 'utf8')), { reviewers: ['security', 'standards', 'behavior', 'performance'], max_review_rounds: 2 });
  const cfg = factory(repo, 'config');
  assert.equal(cfg.status, 0, cfg.stderr);
  assert.deepEqual(JSON.parse(cfg.stdout).reviewers, ['security', 'standards', 'behavior', 'performance']);
  const agents = JSON.parse(factory(repo, 'agents', '--json').stdout);
  assert.deepEqual(agents.find((a: any) => a.station === 'reviewer-performance').owner, 'project');
  // factory.json was overwritten, so it was backed up, outside the repository's factory/.
  const backup = r.files.find((f: any) => f.path === 'factory.json').backup;
  assert.ok(backup.startsWith(box.config) && !backup.startsWith(join(repo, 'factory')));
  assert.equal(JSON.parse(readFileSync(backup, 'utf8')).max_review_rounds, 2);
  assert.equal(existsSync(join(repo, '.git')), false, 'nothing committed (no repo made)');
});

test('apply --confirm creates factory.json when there is none, with the default reviewers plus the new one', () => {
  const { repo } = setup(ALL);
  const id = suggest(repo).suggestions.find((s: any) => s.rule === 'new-reviewer').id;
  stations(repo, 'apply', id, '--confirm');
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'factory.json'), 'utf8')), { reviewers: ['security', 'standards', 'behavior', 'performance'] });
  assert.equal(factory(repo, 'agents', 'check').status, 0);
});

test('apply --confirm: a modification overwrites the project agent and backs it up; a fallback station gets a new project agent', () => {
  const { repo } = setup(ALL);
  const path = projectAgent(repo, 'builder');
  const original = readFileSync(path, 'utf8');
  const out = suggest(repo);
  const builder = out.suggestions.find((s: any) => s.station === 'builder');
  const r = stations(repo, 'apply', builder.id, '--confirm');
  assert.match(readFileSync(path, 'utf8'), /## Lessons from this line\n[\s\S]*- Proof failed 3 times/);
  assert.equal(readFileSync(r.files[0].backup, 'utf8'), original);
  for (const station of ['verifier', 'reviewer-security']) {
    const s = out.suggestions.find((x: any) => x.station === station);
    assert.equal(stations(repo, 'apply', s.id, '--confirm').applied, true);
    assert.ok(existsSync(join(repo, '.claude', 'agents', `factory-${station}.md`)));
  }
  assert.equal(existsSync(join(repo, 'factory.json')), false);
  const agents = JSON.parse(factory(repo, 'agents', '--json').stdout);
  for (const station of ['builder', 'verifier', 'reviewer-security']) assert.equal(agents.find((a: any) => a.station === station).owner, 'project');
});

test('apply rolls everything back when factory agents check fails afterwards', () => {
  const { repo } = setup(ALL, { reviewers: ['security'] });
  const id = suggest(repo).suggestions.find((s: any) => s.rule === 'new-reviewer').id;
  // Another project agent that fails the check: the check after applying fails.
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'agents', 'factory-reviewer-broken.md'), 'not an agent\n');
  const before = snapshot(repo);
  const r = box.call(['stations', 'apply', id, '--confirm', '--repo', repo]);
  assert.deepEqual([r.code, r.stdout], [EXIT.failure, '']);
  assert.match(r.stderr, /factory agents check failed after applying [0-9a-f]{12}, so every file was put back as it was/);
  assert.deepEqual(snapshot(repo), before);
  // Not marked applied: once the broken agent is gone it applies.
  rmSync(join(repo, '.claude', 'agents', 'factory-reviewer-broken.md'));
  assert.equal(stations(repo, 'apply', id, '--confirm').applied, true);
});

test('apply refuses a target that changed since the draft was made, and a draft already applied or dismissed', () => {
  const { repo } = setup(ALL);
  const path = projectAgent(repo, 'builder');
  const out = suggest(repo);
  const id = (station: string): string => out.suggestions.find((s: any) => s.station === station).id;
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nEdited by hand.\n`);
  let r = box.call(['stations', 'apply', id('builder'), '--confirm', '--repo', repo]);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /\.claude\/agents\/factory-builder\.md changed since the draft was made; run stations suggest again/);
  // A file the draft would create, created since.
  writeFileSync(join(repo, 'factory.json'), '{"reviewers": ["security"]}\n');
  r = box.call(['stations', 'apply', id('reviewer-performance'), '--repo', repo]);
  assert.match(r.stderr, /factory\.json was created since the draft was made/);
  // Applied twice.
  assert.equal(stations(repo, 'apply', id('verifier'), '--confirm').applied, true);
  r = box.call(['stations', 'apply', id('verifier'), '--confirm', '--repo', repo]);
  assert.deepEqual([r.code, r.stdout], [EXIT.failure, '']);
  assert.match(r.stderr, /was already applied/);
  // Dismissed: not applied, and not suggested again.
  assert.equal(stations(repo, 'dismiss', id('reviewer-security')).dismissed, true);
  r = box.call(['stations', 'apply', id('reviewer-security'), '--repo', repo]);
  assert.match(r.stderr, /is dismissed; not applying it/);
  const later = suggest(repo).suggestions.map((s: any) => s.station);
  assert.ok(!later.includes('reviewer-security') && !later.includes('verifier'), later.join(' '));
});

test('apply refuses any path outside .claude/agents/ and factory.json, and symbolic links', () => {
  const { repo } = setup(ALL);
  const s = suggest(repo).suggestions.find((x: any) => x.station === 'verifier');
  const recPath = s.draft.replace(/\.md$/, '.json');
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  for (const path of ['../evil.md', '.claude/agents/../../evil.md', 'factory/jobs/x.md', '.claude/settings.json']) {
    writeFileSync(recPath, JSON.stringify({ ...rec, files: [{ ...rec.files[0], path }] }));
    const r = box.call(['stations', 'apply', s.id, '--confirm', '--repo', repo]);
    assert.equal(r.code, EXIT.failure, path);
    assert.match(r.stderr, /a station suggestion writes only \.claude\/agents\/factory-\*\.md and factory\.json/);
  }
  writeFileSync(recPath, JSON.stringify(rec));
  const elsewhere = join(box.dir, 'elsewhere');
  mkdirSync(elsewhere);
  mkdirSync(join(repo, '.claude'));
  symlinkSync(elsewhere, join(repo, '.claude', 'agents'));
  const r = box.call(['stations', 'apply', s.id, '--confirm', '--repo', repo]);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /is a symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), []);
});
