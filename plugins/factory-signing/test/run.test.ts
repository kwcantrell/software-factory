// run(): help, version and usage errors, in-process (no git or ssh needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_NAME, EXIT, run } from '../src/run.ts';

function call(...argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

test('--help prints usage on stdout, naming every command and the passphrase limitation', () => {
  const { code, stdout } = call('--help');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const word of ['status', 'setup', 'allowed-signers', 'hook', '--confirm', '--scope repo|global', '--json', '! ssh-add']) assert.ok(stdout.includes(word), word);
});

test('--version prints the package version', () => {
  const { code, stdout } = call('--version');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

test('hook never fails: a payload it cannot read prints nothing and exits 0', () => {
  for (const payload of ['', '{', 'null', '{"tool_input":{"command":"git commit"},"cwd":"/nonexistent"}']) {
    let stdout = '';
    const code = run(['hook'], { stdout: (t) => (stdout += t), stderr: () => assert.fail('no stderr'), stdin: () => payload });
    assert.equal(code, EXIT.ok);
    assert.equal(stdout, '');
  }
  const code = run(['hook'], { stdout: () => undefined, stderr: () => undefined, stdin: () => { throw new Error('no stdin'); } });
  assert.equal(code, EXIT.ok);
});

for (const argv of [['nope'], ['nope', '--json'], [], ['status', '--bogus'], ['status', 'extra'], ['allowed-signers', '--key', 'x'], ['setup', '--scope', 'system'], ['status', '--scope', 'repo']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, () => {
    const { code, stdout, stderr } = call(...argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}
