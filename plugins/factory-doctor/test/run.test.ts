// The CLI's own surface: help, version, usage errors (exit 2, message on stderr only).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { CLI_NAME, EXIT } from '../src/run.ts';
import { sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

test('--help prints usage on stdout, naming every command and the never-a-value rule', async () => {
  const { code, stdout, stderr } = await s.call(['--help']);
  assert.equal(code, EXIT.ok);
  assert.equal(stderr, '');
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const c of ['check', 'scan', 'profiles', 'add', 'remove', 'init', '--from-scan', '--confirm', '--file']) assert.ok(stdout.includes(c), c);
  assert.match(stdout, /never stores, prints or sends the value/);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await s.call(['--version']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [['nope'], [], ['check', '--bogus'], ['scan', 'x'], ['profiles', 'x'], ['init', 'x'], ['check', 'a', 'b'], ['add', 'tool'], ['remove', 'tool'], ['scan', '--profile', 'dev'], ['add', '--from-scan', 'x']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const { code, stdout, stderr } = await s.call(argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}
