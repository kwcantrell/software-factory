// Argument parsing, usage text and exit codes, through run() with a fake Io.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLI_NAME, EXIT, USAGE, run } from '../src/run.ts';
import { findCheckout } from '../src/repo.ts';
import { cleanEnv, fixture } from './fixture.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-dev-run-')));
const f = fixture();
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  f.cleanup();
});

async function call(cwd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env: cleanEnv() });
  return { code, stdout, stderr };
}

test('--help prints usage, naming every command and option, on stdout', async () => {
  const { code, stdout, stderr } = await call(scratch, ['--help']);
  assert.equal(code, EXIT.ok);
  assert.equal(stderr, '');
  assert.equal(stdout, USAGE);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const word of ['check [--require-claude]', 'release [<tag>] [--notes-out <file>]', '--repo <path>', '--json', '--version']) assert.ok(stdout.includes(word), word);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await call(scratch, ['--version']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [[], ['nope'], ['check', 'extra'], ['check', '--notes-out', 'x'], ['release', 'v1', 'v2'], ['release', '--require-claude'], ['check', '--bogus'], ['release', '--notes-out']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const { code, stdout, stderr } = await call(f.root, argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}

test('outside a software-factory checkout: exit 2 with a clear message, for both commands', async () => {
  for (const argv of [['check'], ['release'], ['release', 'v1.2.0']]) {
    const { code, stdout, stderr } = await call(scratch, argv);
    assert.equal(code, EXIT.usage, argv.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^factory-dev: not inside a software-factory checkout: .*pass --repo <path>\n$/);
  }
  const missing = await call(scratch, ['release', '--repo', join(scratch, 'nope')]);
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.stderr, /--repo .*nope: no such directory/);
});

test('a marketplace.json with another name is not a checkout', () => {
  const dir = join(scratch, 'other-market');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'someone-else', plugins: [] }));
  assert.throws(() => findCheckout(dir), /not inside a software-factory checkout/);
});

test('release refusal: exit 1, stdout empty, the reason on stderr', async () => {
  const { code, stdout, stderr } = await call(f.root, ['release', 'v9.9.9', '--json']);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.equal(stderr, "factory-dev: release check failed: tag 'v9.9.9' does not match plugin.json version 1.2.0 (expected 'v1.2.0')\n");
});
