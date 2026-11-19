// The PostToolUseFailure hook: recorded hook-input JSON (the documented Claude Code format) on stdin,
// matching and non-matching, through run() and through the exact command hooks/hooks.json runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { cliCalls, failureOf, quickReject } from '../src/hook.ts';
import { marketplacePlugins } from '../src/plugins.ts';
import { EXIT } from '../src/run.ts';
import { FIXTURES, PLUGIN_ROOT, sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
afterEach(() => box?.cleanup());

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const { bins, plugins } = marketplacePlugins(PLUGIN_ROOT, {});

function log(b: Sandbox): any[] {
  const path = join(b.config, 'occurrences.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('an npx run of a marketplace CLI that exits non-zero is recorded as a cli-failure', () => {
  box = sandbox();
  const r = box.call(['hook'], { stdin: fixture('hook-npx-failure.json') });
  assert.deepEqual(r, { code: EXIT.ok, stdout: '', stderr: '' });
  const [o, ...more] = log(box);
  assert.equal(more.length, 0);
  assert.equal(o.plugin, 'factory-docs');
  assert.equal(o.kind, 'cli-failure');
  assert.equal(o.subcommand, 'which');
  assert.equal(o.exitCode, 1);
  assert.equal(o.source, 'hook');
  assert.equal(o.summary, 'factory-docs which exited 1: factory-docs: cannot read https://[redacted]@git.example/x (token [redacted] rejected)');
  assert.equal(o.detail, undefined);
  // Only the plugin, subcommand, exit code and the redacted error line are kept.
  const stored = readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8');
  for (const leak of ['STDOUT-SHOULD-NOT-BE-STORED', 'secret-project', 'hunter2', 'ghp_', '--package', 'toolu_', 'transcript', 'npx']) {
    assert.ok(!stored.includes(leak), `stored ${leak}`);
  }
});

test('a node run of plugins/<plugin>/src/cli.ts that exits non-zero is recorded', () => {
  box = sandbox();
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-node-failure.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
  const [o] = log(box);
  assert.equal(o.plugin, 'factory-plugin-builder');
  assert.equal(o.subcommand, 'verify');
  assert.equal(o.summary, 'factory-plugin-builder verify exited 1: factory-plugin-builder: verify failed: 2 gates failed (typecheck, tests)');
  assert.ok(!readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8').includes('my-plugin'));
});

test('a node run of the plugin cache copy (<plugin>/<version>/src/cli.ts) that exits non-zero is recorded', () => {
  box = sandbox();
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-cache-failure.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
  const [o, ...more] = log(box);
  assert.equal(more.length, 0);
  assert.equal(o.plugin, 'factory-dev');
  assert.equal(o.subcommand, 'check');
  assert.equal(o.exitCode, 1);
  assert.equal(o.summary, 'factory-dev check exited 1: factory-dev: check failed: 1 step failed (typecheck)');
});

test('factory exit 1 (a gate refused) is recorded, with its refused: line', () => {
  box = sandbox();
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-factory-refused.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
  const [o, ...more] = log(box);
  assert.equal(more.length, 0);
  assert.equal(o.plugin, 'factory');
  assert.equal(o.subcommand, 'proof');
  assert.equal(o.exitCode, 1);
  assert.equal(o.summary, 'factory proof exited 1: refused: 005-port-the-factory-cli-to-typescript is at stage build, not proof');
  assert.ok(!readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8').includes('STDOUT-SHOULD-NOT-BE-STORED'));
});

test('factory refusals for different jobs are one issue: the job id is masked in the signature', () => {
  box = sandbox();
  const other = fixture('hook-factory-refused.json').replaceAll('005-port-the-factory-cli-to-typescript', '012-add-docs-plugin');
  box.call(['hook'], { stdin: fixture('hook-factory-refused.json') });
  box.call(['hook'], { stdin: other });
  const [a, b] = log(box);
  assert.notEqual(a.summary, b.summary);
  assert.equal(a.signature, b.signature);
});

// factory exit 2 means "escalated to a human": the line working as designed, not friction.
for (const name of ['hook-factory-escalated.json', 'hook-other-failure.json', 'hook-other-npx-failure.json', 'hook-success.json', 'hook-interrupt.json']) {
  test(`${name}: nothing recorded, no output, exit 0`, () => {
    box = sandbox();
    assert.deepEqual(box.call(['hook'], { stdin: fixture(name) }), { code: EXIT.ok, stdout: '', stderr: '' });
    assert.equal(existsSync(box.config), false, 'not even the config dir is created');
  });
}

test('malformed or empty input never fails the hook', () => {
  box = sandbox();
  for (const stdin of ['', 'not json', '{"hook_event_name":"PostToolUseFailure","tool_input":"npx"}', '[]', 'PostToolUseFailure npx {']) {
    assert.deepEqual(box.call(['hook'], { stdin }), { code: EXIT.ok, stdout: '', stderr: '' });
  }
  assert.equal(log(box).length, 0);
});

test('a failure to write the log is swallowed', () => {
  box = sandbox({ FACTORY_PLUGIN_ADVISOR_CONFIG_DIR: '/proc/factory-plugin-advisor-cannot-write-here' });
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-npx-failure.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
});

test('a regular file where the config dir should be is left alone and the failure swallowed', () => {
  box = sandbox();
  const file = join(box.dir, 'not-a-dir');
  writeFileSync(file, 'keep me', { mode: 0o644 });
  box.env.FACTORY_PLUGIN_ADVISOR_CONFIG_DIR = file;
  assert.deepEqual(box.call(['hook'], { stdin: fixture('hook-npx-failure.json') }), { code: EXIT.ok, stdout: '', stderr: '' });
  assert.equal(statSync(file).mode & 0o777, 0o644, 'not chmodded');
  assert.equal(readFileSync(file, 'utf8'), 'keep me');
});

test('quickReject rejects anything that is not a failure mentioning npx or cli.ts, before parsing', () => {
  assert.equal(quickReject(fixture('hook-other-failure.json')), true);
  assert.equal(quickReject(fixture('hook-success.json')), true);
  assert.equal(quickReject(fixture('hook-npx-failure.json')), false);
  assert.equal(quickReject(fixture('hook-node-failure.json')), false);
  assert.equal(quickReject(fixture('hook-cache-failure.json')), false);
});

test('cliCalls finds marketplace CLI calls in compound commands', () => {
  const prefix = 'npx --yes --offline --loglevel=error --package="/p/x y/factory-dev/0.2.0" --';
  assert.deepEqual(cliCalls(`cd /x && ${prefix} factory-dev check --json | jq .`, bins, plugins), [{ bin: 'factory-dev', plugin: 'factory-dev', subcommand: 'check' }]);
  assert.deepEqual(cliCalls(`${prefix} factory-dev --help`, bins, plugins), [{ bin: 'factory-dev', plugin: 'factory-dev' }]);
  assert.deepEqual(cliCalls(`${prefix} factory status`, bins, plugins), [{ bin: 'factory', plugin: 'factory', subcommand: 'status' }]);
  assert.deepEqual(cliCalls('node /home/u/.claude/plugins/cache/software-factory/factory/0.2.0/src/cli.ts status', bins, plugins), [
    { bin: 'factory', plugin: 'factory', subcommand: 'status' },
  ]);
  assert.deepEqual(cliCalls('node "/home/u/my checkout/plugins/factory-docs/src/cli.ts" gate', bins, plugins), [
    { bin: 'factory-docs', plugin: 'factory-docs', subcommand: 'gate' },
  ]);
  assert.deepEqual(cliCalls('npx -- eslint . ; node scripts/src/cli.ts x ; npx tsc ; node plugins/other/src/cli.ts y', bins, plugins), []);
  assert.equal(cliCalls(`${prefix} factory-docs stale; ${prefix} factory-docs gate`, bins, plugins).length, 2);
});

test('failureOf reads the exit code from the error string and ignores exit 0 and other tools', () => {
  const base = JSON.parse(fixture('hook-npx-failure.json'));
  assert.equal(failureOf({ ...base, error: 'Exit code 0\n' }, bins, plugins), null);
  assert.equal(failureOf({ ...base, error: 'spawn /bin/bash ENOENT' }, bins, plugins), null);
  assert.equal(failureOf({ ...base, tool_name: 'Read' }, bins, plugins), null);
  assert.deepEqual(failureOf({ ...base, error: 'Exit code 2\nsome stdout line\n' }, bins, plugins), { bin: 'factory-docs', plugin: 'factory-docs', subcommand: 'which', exitCode: 2 });
  assert.equal(failureOf({ ...base, error: 'Exit code 1\nnpm error code ENOTCACHED' }, bins, plugins)?.message, 'npm error code ENOTCACHED');
});

test('exit 2 is skipped only for the factory bin, whichever way it is run', () => {
  const refused = JSON.parse(fixture('hook-factory-refused.json'));
  assert.equal(failureOf({ ...refused, error: 'Exit code 2\nescalated to a human: x' }, bins, plugins), null);
  const viaNode = { ...refused, tool_input: { command: 'node /home/u/.claude/plugins/cache/software-factory/factory/0.2.0/src/cli.ts review 005-a changes --by reviewer-standards' } };
  assert.equal(failureOf({ ...viaNode, error: 'Exit code 2\nescalated to a human: x' }, bins, plugins), null);
  assert.equal(failureOf({ ...viaNode, error: 'Exit code 1\nrefused: x' }, bins, plugins)?.message, 'refused: x');
  // Another plugin's exit 2 (a usage error) is still friction.
  assert.equal(failureOf({ ...JSON.parse(fixture('hook-npx-failure.json')), error: 'Exit code 2\nfactory-docs: unknown command' }, bins, plugins)?.exitCode, 2);
});

test('hooks/hooks.json registers an async PostToolUseFailure hook on Bash, in exec form', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['PostToolUseFailure']);
  assert.deepEqual(hooks.hooks.PostToolUseFailure, [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/cli.ts', 'hook'], async: true, timeout: 10 }] },
  ]);
});

test('the hook command from hooks/hooks.json runs and records, with no output', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const groups = hooks.hooks.PostToolUseFailure;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, 'Bash');
  const [handler] = groups[0].hooks;
  assert.equal(handler.type, 'command');
  assert.equal(handler.command, 'node');
  assert.equal(handler.async, true, 'runs in the background, so Claude never waits for it');
  box = sandbox();
  const args = handler.args.map((a: string) => a.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT.replace(/\/$/, '')));
  for (const [name, expected] of [
    ['hook-other-failure.json', 0],
    ['hook-npx-failure.json', 1],
    ['hook-factory-escalated.json', 1],
    ['hook-factory-refused.json', 2],
    ['hook-interrupt.json', 2],
    ['hook-success.json', 2],
  ] as const) {
    const r = spawnSync(handler.command, args, { input: fixture(name), encoding: 'utf8', env: { ...process.env, ...box.env } as NodeJS.ProcessEnv });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(log(box).length, expected, name);
  }
});

test('the hook masks home-dir usernames, emails and mentions in the error line before storing it', () => {
  box = sandbox({ HOME: '/srv/people/jdoe-test', USER: 'jdoe-test' });
  const input = JSON.parse(fixture('hook-npx-failure.json'));
  input.error =
    'Exit code 1\nfactory-docs: cannot read /home/jdoe-test/a.json, /srv/people/jdoe-test/b.json and C:\\Users\\jdoe-test\\c.json for jdoe-test (jdoe-test@example.com, cc @octocat)\nSTDOUT';
  assert.deepEqual(box.call(['hook'], { stdin: JSON.stringify(input) }), { code: EXIT.ok, stdout: '', stderr: '' });
  const [o] = log(box);
  assert.equal(o.summary, 'factory-docs which exited 1: factory-docs: cannot read ~/a.json, ~/b.json and ~\\c.json for [user] ([email], cc @[user])');
  const stored = readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8');
  for (const leak of ['jdoe-test', 'example.com', 'octocat', '/home/', '/srv/people']) assert.ok(!stored.includes(leak), `stored ${leak}`);
});
