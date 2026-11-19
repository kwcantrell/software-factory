// Arguments, help, version and usage errors: exit 2 with stdout empty and the reason on stderr.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLI_NAME, EXIT } from '../src/run.ts';
import { PLUGIN, call, fixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-docs-run-')));
const fixtures: Fixture[] = [];
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  fixtures.forEach((f) => f.cleanup());
});

test('--help prints usage listing every command on stdout and exits 0', () => {
  const r = call(scratch, ['--help']);
  assert.equal(r.code, EXIT.ok);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const word of ['which <path>...', 'stale [--base <ref>]', 'lint', 'gate [--base <ref>]', '--json', '--repo', 'docs/docs-map.json']) assert.ok(r.stdout.includes(word), word);
  assert.equal(call(scratch, ['-h']).stdout, r.stdout);
});

test('--version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  assert.deepEqual(call(scratch, ['--version']), { code: EXIT.ok, stdout: `${pkg.version}\n`, stderr: '' });
});

for (const argv of [[], ['nope'], ['lint', 'extra'], ['stale', 'x'], ['gate', 'x'], ['which'], ['which', 'a', '--base', 'main'], ['lint', '--base', 'main'], ['lint', '--bogus'], ['stale', '--base']]) {
  test(`usage error: ${JSON.stringify(argv)} exits 2, stdout empty`, () => {
    const f = fixture();
    fixtures.push(f);
    const r = call(f.root, argv);
    assert.equal(r.code, EXIT.usage);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}
