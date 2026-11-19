// release: the tag/version check and changelog extraction the release workflow runs. The first ten tests
// are the counterparts of the Python suite this command replaced (tests/test_release.py), one each, in
// its order; they drive the CLI as a subprocess (node src/cli.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { REPO, PLUGIN, cleanEnv, fixture, writeJson, writeMarketplace, writePlugin } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const CLI = join(PLUGIN, 'src', 'cli.ts');
const fixtures: Fixture[] = [];
after(() => fixtures.forEach((f) => f.cleanup()));

let root = '';
beforeEach(() => {
  const f = fixture();
  fixtures.push(f);
  root = f.root;
});

function release(args: string[], repo = root): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, 'release', '--repo', repo, ...args], { cwd: repo, env: cleanEnv(), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a matching tag passes and prints that version\'s notes', () => {
  const p = release(['v1.2.0']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, '### Added\n\n- The 1.2 feature.\n');
});

test('--notes-out writes the notes to the file, and nothing to stdout', () => {
  const out = join(root, 'notes.md');
  const p = release(['v1.2.0', '--notes-out', out]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, '');
  assert.ok(readFileSync(out, 'utf8').includes('The 1.2 feature.'));
  assert.ok(!readFileSync(out, 'utf8').includes('Older'));
});

test('the last section stops at the link definitions', () => {
  writePlugin(root, 'demo', '1.1.0');
  const p = release(['v1.1.0']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, '- Older.\n');
});

test('a mismatched tag fails', () => {
  for (const tag of ['v1.1.0', '1.2.0', 'v1.2.0-rc1', 'v1.2']) {
    const p = release([tag]);
    assert.equal(p.status, 1, tag);
    assert.equal(p.stdout, '');
    assert.ok(p.stderr.includes('does not match plugin.json version 1.2.0'), `${tag}: ${p.stderr}`);
  }
});

test('the marketplace entry version must match when present', () => {
  writeMarketplace(root, [{ name: 'demo', source: './plugins/demo', version: '1.2.0' }]);
  assert.equal(release(['v1.2.0']).status, 0);
  writeMarketplace(root, [{ name: 'demo', source: './plugins/demo', version: '1.1.0' }]);
  const p = release(['v1.2.0']);
  assert.equal(p.status, 1);
  assert.ok(p.stderr.includes('marketplace.json lists demo 1.1.0'), p.stderr);
});

test('a missing changelog section fails', () => {
  writePlugin(root, 'demo', '1.3.0');
  const p = release(['v1.3.0']);
  assert.equal(p.status, 1);
  assert.ok(p.stderr.includes("no '## [1.3.0]' section"), p.stderr);
});

test('an empty changelog section fails', () => {
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [1.2.0] - 2026-01-02\n\n## [1.1.0]\n\n- x\n');
  assert.equal(release(['v1.2.0']).status, 1);
});

test('without a tag it checks the plugin version has a section', () => {
  assert.equal(release([]).status, 0);
  writePlugin(root, 'demo', '9.9.9');
  const p = release([]);
  assert.equal(p.status, 1);
  assert.ok(p.stderr.includes("no '## [9.9.9]' section"), p.stderr);
});

test('plugin.json is found through the marketplace source', () => {
  writeJson(root, 'elsewhere/thing/.claude-plugin/plugin.json', { name: 'demo', version: '1.1.0' });
  writeMarketplace(root, [{ name: 'demo', source: './elsewhere/thing' }]);
  assert.equal(release(['v1.1.0']).stdout, '- Older.\n');
  assert.equal(release(['v1.2.0']).status, 1);
});

test('this repository is releasable at its current version', () => {
  const version = JSON.parse(readFileSync(join(REPO, 'plugins', 'factory', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const p = release([`v${version}`], REPO);
  assert.equal(p.status, 0, p.stderr);
  assert.ok(p.stdout.trim() !== '');
  assert.equal(release([], REPO).status, 0);
  assert.equal(release(['v0.0.0'], REPO).status, 1);
});

// Beyond the original script: every marketplace plugin, and package.json too.

test('every marketplace plugin must have the tag\'s version', () => {
  writePlugin(root, 'other', '1.2.0');
  writeMarketplace(root, [{ name: 'demo', source: './plugins/demo' }, { name: 'other', source: './plugins/other' }]);
  assert.equal(release(['v1.2.0']).status, 0);
  writePlugin(root, 'other', '1.1.0');
  for (const args of [['v1.2.0'], ['v1.1.0'], []]) {
    const p = release(args);
    assert.equal(p.status, 1, args.join(' '));
    assert.equal(p.stdout, '');
    assert.match(p.stderr, /^factory-dev: release check failed: plugin versions differ \(plugins\/demo\/\.claude-plugin\/plugin\.json 1\.2\.0, plugins\/other\/\.claude-plugin\/plugin\.json 1\.1\.0\)/);
  }
});

test('a package.json version that differs from plugin.json is refused, naming both files, with or without a tag', () => {
  writePlugin(root, 'demo', '1.2.0', '1.1.0');
  for (const args of [['v1.2.0'], []]) {
    const p = release(args);
    assert.equal(p.status, 1, args.join(' '));
    assert.equal(p.stdout, '');
    assert.ok(p.stderr.includes('plugins/demo/package.json'), p.stderr);
    assert.ok(p.stderr.includes('plugins/demo/.claude-plugin/plugin.json'), p.stderr);
  }
  // a package.json without a version is a mismatch too
  writeJson(root, 'plugins/demo/package.json', { name: 'demo', private: true });
  assert.equal(release([]).status, 1);
});

test('a missing or broken plugin.json, a bad version or an outside source is refused', () => {
  rmSync(join(root, 'plugins/demo/.claude-plugin/plugin.json'));
  assert.match(release([]).stderr, /plugins\/demo\/\.claude-plugin\/plugin\.json is missing/);
  writeFileSync(join(root, 'plugins/demo/.claude-plugin/plugin.json'), '{nope');
  assert.match(release([]).stderr, /is not valid JSON/);
  writePlugin(root, 'demo', '1.2');
  assert.match(release([]).stderr, /'version' must be X\.Y\.Z, got "1\.2"/);
  writeMarketplace(root, [{ name: 'demo', source: './../demo' }]);
  assert.match(release([]).stderr, /source "\.\/\.\.\/demo"/);
  writeMarketplace(root, []);
  assert.match(release([]).stderr, /lists no plugins/);
});

test('--json prints the version, tag, plugins and notes; --notes-out is relative to the cwd', () => {
  const p = release(['v1.2.0', '--json']);
  assert.equal(p.status, 0, p.stderr);
  assert.deepEqual(JSON.parse(p.stdout), { version: '1.2.0', tag: 'v1.2.0', plugins: ['demo'], notes: '### Added\n\n- The 1.2 feature.\n' });
  mkdirSync(join(root, 'sub'));
  const r = spawnSync(process.execPath, [CLI, 'release', '--notes-out', 'notes.md'], { cwd: join(root, 'sub'), env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(root, 'sub', 'notes.md'), 'utf8'), '### Added\n\n- The 1.2 feature.\n');
});

test('CRLF changelogs are read the same way', () => {
  writeFileSync(join(root, 'CHANGELOG.md'), readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replaceAll('\n', '\r\n'));
  assert.equal(release(['v1.2.0']).stdout, '### Added\n\n- The 1.2 feature.\n');
});
