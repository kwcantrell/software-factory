import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hello } from '../src/hello.ts';
import { CLI_NAME, EXIT, run } from '../src/run.ts';

function call(...argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

test('hello() builds the greeting', () => {
  assert.deepEqual(hello('Ada'), { greeting: 'Hello, Ada!' });
});

test('hello prints text by default', () => {
  assert.deepEqual(call('hello', 'Ada'), { code: EXIT.ok, stdout: 'Hello, Ada!\n', stderr: '' });
});

test('hello --json prints one JSON object', () => {
  const { code, stdout, stderr } = call('hello', '--json');
  assert.equal(code, EXIT.ok);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { greeting: 'Hello, world!' });
});

test('--help prints usage on stdout', () => {
  const { code, stdout } = call('--help');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  assert.match(stdout, /--json/);
});

test('--version prints the package version', () => {
  const { code, stdout } = call('--version');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [['nope'], ['nope', '--json'], [], ['hello', '--bogus'], ['hello', 'a', 'b']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, () => {
    const { code, stdout, stderr } = call(...argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}
