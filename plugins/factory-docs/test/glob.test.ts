import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matches } from '../src/glob.ts';

const cases: [string, string, boolean][] = [
  ['README.md', 'README.md', true],
  ['README.md', 'docs/README.md', false],
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/x/a.ts', false],
  ['src/**', 'src/a.ts', true],
  ['src/**', 'src/x/y/a.ts', true],
  ['src/**', 'srcx/a.ts', false],
  ['**/*.md', 'a.md', true],
  ['**/*.md', 'a/b/c.md', true],
  ['plugins/*/src/**', 'plugins/demo/src/run.ts', true],
  ['plugins/*/src/**', 'plugins/demo/test/run.ts', false],
  ['plugins/*/src/**', 'plugins/a/b/src/run.ts', false],
  ['src/?.ts', 'src/a.ts', true],
  ['src/?.ts', 'src/ab.ts', false],
  ['a.b', 'axb', false],
  ['a+(b)', 'a+(b)', true],
  ['.github/workflows/**', '.github/workflows/ci.yml', true],
];

for (const [glob, path, expected] of cases) {
  test(`${glob} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
    assert.equal(matches(path, [glob]), expected);
  });
}

test('matches is true when any pattern matches, false for none', () => {
  assert.equal(matches('lib/c.ts', ['src/**', 'lib/**']), true);
  assert.equal(matches('lib/c.ts', []), false);
});
