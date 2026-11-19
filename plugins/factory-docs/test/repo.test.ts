// This repository's own doc map passes lint (read only), and covers the docs the plugin promises.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../src/run.ts';
import { MAP_PATH, parseMap } from '../src/repo.ts';
import { REPO, call } from './fixture.ts';

test('factory-docs lint exits 0 on this repository', () => {
  const r = call(REPO, ['lint', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(Object.keys(result.clis).sort(), ['factory', 'factory-dev', 'factory-docs', 'factory-doctor', 'factory-plugin-advisor', 'factory-plugin-builder', 'factory-plugin-discover', 'factory-signing']);
});

test('the map covers the root docs, every plugin README, skill and agent, and treats CHANGELOG.md as the changelog', () => {
  const map = parseMap(readFileSync(join(REPO, MAP_PATH), 'utf8'));
  const docs = [...map.docs.keys()];
  for (const doc of ['README.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) assert.ok(docs.includes(doc), doc);
  const r = call(REPO, ['which', '--json', 'plugins/factory-dev/src/run.ts', 'plugins/factory/src/run.ts']);
  const covered = JSON.parse(r.stdout);
  assert.ok(covered['plugins/factory-dev/src/run.ts'].includes('plugins/factory-dev/README.md'));
  assert.ok(covered['plugins/factory/src/run.ts'].includes('plugins/factory/agents/builder.md'));
  assert.equal(map.changelog, 'CHANGELOG.md');
  for (const glob of ['plugins/*/src/**', 'plugins/*/skills/**', 'plugins/*/agents/**', 'plugins/*/hooks/**', 'plugins/*/.claude-plugin/plugin.json']) {
    assert.ok(map.docs.get('CHANGELOG.md')?.includes(glob), glob);
  }
});

test('CI runs the gate on pull requests against the base branch, with full history and SHA-pinned actions', () => {
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /^ {6}- uses: actions\/checkout@[0-9a-f]{40} # v\S+\n {8}with:\n(?: {10}#.*\n)* {10}fetch-depth: 0\n/m);
  const step = /- name: Docs in sync with code \(factory-docs gate\)\n((?: {8}.*\n?)+)/.exec(ci)?.[1] ?? '';
  assert.match(step, /^ {8}if: github\.event_name == 'pull_request'$/m);
  assert.match(step, /^ {10}BASE_REF: \$\{\{ github\.base_ref \}\}$/m);
  assert.match(step, /^ {8}run: npx --yes --offline --loglevel=error --package=\.\/plugins\/factory-docs -- factory-docs gate --base "origin\/\$BASE_REF"$/m);
  for (const uses of ci.matchAll(/uses: ([^\s#]+)/g)) assert.match(uses[1] ?? '', /^(?:\.\/|[\w.-]+\/[\w.-]+@[0-9a-f]{40}$)/, uses[1] ?? '');
});
