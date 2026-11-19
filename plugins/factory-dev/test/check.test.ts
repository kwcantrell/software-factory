// check: every step passes in a clean fixture checkout, and each one is made to fail in turn; the exit
// code and the named failed step are checked each time.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validateTargets } from '../src/check.ts';
import { EXIT, run } from '../src/run.ts';
import { cleanEnv, fixture, withFakeClaude, withoutClaude, writePlugin } from './fixture.ts';
import type { Fixture, FixtureOptions } from './fixture.ts';

const fixtures: Fixture[] = [];
after(() => fixtures.forEach((f) => f.cleanup()));

function checkout(options: FixtureOptions = {}): Fixture {
  const f = fixture(options);
  fixtures.push(f);
  return f;
}

async function check(f: Fixture, argv: string[] = [], env: NodeJS.ProcessEnv = withFakeClaude(cleanEnv(), f), cwd = f.root): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(['check', ...argv], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env });
  return { code, stdout, stderr };
}

const ALL_STEPS = ['json', 'validate .', 'validate plugins/demo', 'typecheck', 'test', 'release', 'plugin-convention'];

/** Asserts exit 1, an empty stdout, and exactly `failed` named in the closing line. */
function assertFailed(r: { code: number; stdout: string; stderr: string }, failed: string[]): void {
  assert.equal(r.code, EXIT.failure, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.endsWith(`\nfactory-dev: check failed: ${failed.join(', ')}\n`), r.stderr.slice(-400));
  for (const name of failed) assert.match(r.stderr, new RegExp(`^FAIL  ${name.replace('.', '\\.')} `, 'm'));
}

test('a clean checkout passes every step, in order, and exits 0', async () => {
  const f = checkout();
  const r = await check(f, ['--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((s: { name: string }) => s.name), ALL_STEPS);
  assert.deepEqual(result.steps.map((s: { status: string }) => s.status), ALL_STEPS.map(() => 'pass'));
  assert.deepEqual(readFileSync(f.claudeLog, 'utf8').trim().split('\n'), ['plugin validate .', 'plugin validate plugins/demo']);
  // the steps' own output and a result line per step go to stderr
  assert.match(r.stderr, /^ok   \.claude-plugin\/marketplace\.json$/m);
  assert.match(r.stderr, /stub factory-plugin-builder check --all --repo \./);
  assert.match(r.stderr, /^PASS  release /m);
});

test('without --json it prints one line per step and "all checks passed"', async () => {
  const r = await check(checkout());
  assert.equal(r.code, EXIT.ok, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, ALL_STEPS.length + 1);
  ALL_STEPS.forEach((name, i) => assert.ok(lines[i]?.startsWith(`PASS  ${name} `), String(lines[i])));
  assert.equal(lines.at(-1), 'all checks passed');
});

test('runs from anywhere inside the checkout, or with --repo', async () => {
  const f = checkout();
  const deep = join(f.root, 'plugins', 'demo', '.claude-plugin');
  assert.equal((await check(f, [], undefined, deep)).code, EXIT.ok);
  const elsewhere = checkout();
  // cwd in one checkout, --repo the other: the --repo one is checked
  writeFileSync(join(elsewhere.root, 'broken.json'), '{');
  assertFailed(await check(f, ['--repo', elsewhere.root]), ['json']);
});

test('json: a broken untracked JSON file fails the json step; an ignored one does not', async () => {
  const f = checkout();
  mkdirSync(join(f.root, 'ignored'));
  writeFileSync(join(f.root, 'ignored', 'junk.json'), '{');
  assert.equal((await check(f)).code, EXIT.ok);
  writeFileSync(join(f.root, 'plugins', 'demo', 'broken.json'), '{"a":');
  const r = await check(f);
  assertFailed(r, ['json']);
  assert.match(r.stderr, /^BAD  plugins\/demo\/broken\.json - /m);
  assert.match(r.stderr, /FAIL  json .*invalid JSON: plugins\/demo\/broken\.json\)/);
});

test('json: not a git checkout fails the json step', async () => {
  const f = checkout();
  rmSync(join(f.root, '.git'), { recursive: true, force: true });
  const env = { ...withFakeClaude(cleanEnv(), f), GIT_CEILING_DIRECTORIES: join(f.root, '..') };
  assertFailed(await check(f, [], env), ['json']);
});

test('validate: a plugin claude rejects fails its own validate step', async () => {
  const f = checkout();
  assertFailed(await check(f, [], { ...withFakeClaude(cleanEnv(), f), FAKE_CLAUDE_FAIL: 'plugins/demo' }), ['validate plugins/demo']);
  assertFailed(await check(f, [], { ...withFakeClaude(cleanEnv(), f), FAKE_CLAUDE_FAIL: '.' }), ['validate .']);
});

test('validate: the template is validated when the checkout has one', async () => {
  const f = checkout();
  mkdirSync(join(f.root, 'templates', 'plugin'), { recursive: true });
  assert.deepEqual(validateTargets(f.root), ['.', 'plugins/demo', 'templates/plugin']);
  assertFailed(await check(f, [], { ...withFakeClaude(cleanEnv(), f), FAKE_CLAUDE_FAIL: 'templates/plugin' }), ['validate templates/plugin']);
});

test('validate: without claude the steps are skipped, not passed; --require-claude fails them', async () => {
  const f = checkout();
  const env = withoutClaude(cleanEnv(), f);
  const skipped = await check(f, [], env);
  assert.equal(skipped.code, EXIT.ok, skipped.stderr);
  assert.match(skipped.stdout, /^SKIP  validate \. .*\(claude is not on PATH\)$/m);
  assert.match(skipped.stdout, /^SKIP  validate plugins\/demo /m);
  assert.doesNotMatch(skipped.stdout, /^PASS  validate/m);
  assert.match(skipped.stdout, /all checks passed, but these were skipped \(not passed\): validate \., validate plugins\/demo\n$/);
  const json = JSON.parse((await check(f, ['--json'], env)).stdout);
  assert.deepEqual(json.steps.filter((s: { status: string }) => s.status === 'skipped').map((s: { name: string }) => s.name), ['validate .', 'validate plugins/demo']);

  const required = await check(f, ['--require-claude'], env);
  assertFailed(required, ['validate .', 'validate plugins/demo']);
  assert.match(required.stderr, /--require-claude was given/);
  // with claude present, --require-claude changes nothing
  assert.equal((await check(f, ['--require-claude'])).code, EXIT.ok);
});

test('typecheck: npm run typecheck failing fails the typecheck step', async () => {
  assertFailed(await check(checkout({ typecheckExit: 1 })), ['typecheck']);
});

test('test: npm test failing fails the test step', async () => {
  assertFailed(await check(checkout({ testExit: 3 })), ['test']);
});

test('release: a version mismatch fails the release step, with the reason', async () => {
  const f = checkout();
  writePlugin(f.root, 'demo', '1.2.0', '1.1.0');
  const r = await check(f);
  assertFailed(r, ['release']);
  assert.match(r.stderr, /FAIL  release .*plugins\/demo\/package\.json/);
  writePlugin(f.root, 'demo', '7.0.0');
  assertFailed(await check(f), ['release']);
});

test('plugin-convention: factory-plugin-builder check --all failing, or missing, fails the step', async () => {
  assertFailed(await check(checkout({ conventionExit: 1 })), ['plugin-convention']);
  const f = checkout();
  rmSync(join(f.root, 'plugins', 'factory-plugin-builder'), { recursive: true });
  const r = await check(f);
  assertFailed(r, ['plugin-convention']);
  assert.match(r.stderr, /plugins\/factory-plugin-builder\/src\/cli\.ts is missing/);
});

test('every step runs after a failure, and every failed step is listed', async () => {
  const f = checkout({ typecheckExit: 1, testExit: 1, conventionExit: 1 });
  writeFileSync(join(f.root, 'bad.json'), '[');
  writePlugin(f.root, 'demo', '5.0.0');
  assertFailed(await check(f, [], { ...withFakeClaude(cleanEnv(), f), FAKE_CLAUDE_FAIL: 'plugins/demo' }), [
    'json',
    'validate plugins/demo',
    'typecheck',
    'test',
    'release',
    'plugin-convention',
  ]);
});
