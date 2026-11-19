// The marketplace's plugins and bins are read at run time, not hard-coded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FACTORY_COMMANDS, FACTORY_FOLLOWUP_COMMANDS, FALLBACK_PLUGINS, findManifest, marketplacePlugins, MARKETPLACE_NAME } from '../src/plugins.ts';
import { PLUGIN_ROOT } from './helpers.ts';

const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'factory-plugin-advisor-plugins-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('in a checkout, the plugins and bins come from marketplace.json and each package.json', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const found = marketplacePlugins(PLUGIN_ROOT, {});
  assert.equal(found.manifest, join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
  assert.deepEqual(found.plugins, manifest.plugins.map((p: { name: string }) => p.name).sort());
  for (const p of manifest.plugins as Array<{ name: string; source: string }>) {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, p.source, 'package.json'), 'utf8'));
    for (const bin of Object.keys(pkg.bin)) assert.equal(found.bins.get(bin), p.name);
  }
  assert.ok(found.plugins.includes('factory-plugin-advisor'));
});

test('from the plugin cache, the manifest is found through known_marketplaces.json', () => {
  const market = join(scratch, 'market');
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  mkdirSync(join(market, 'plugins', 'new-thing'), { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'new-thing', source: './plugins/new-thing' }] }));
  writeFileSync(join(market, 'plugins', 'new-thing', 'package.json'), JSON.stringify({ bin: { 'new-thing-cli': 'src/cli.ts' } }));
  const claude = join(scratch, 'claude-config');
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ [MARKETPLACE_NAME]: { installLocation: market } }));
  const cached = join(scratch, 'cache', MARKETPLACE_NAME, 'factory-plugin-advisor', '0.1.0');
  mkdirSync(cached, { recursive: true });
  cpSync(join(PLUGIN_ROOT, 'package.json'), join(cached, 'package.json'));
  assert.equal(findManifest(cached, { CLAUDE_CONFIG_DIR: claude }), join(market, '.claude-plugin', 'marketplace.json'));
  const found = marketplacePlugins(cached, { CLAUDE_CONFIG_DIR: claude });
  assert.deepEqual(found.plugins, ['new-thing']);
  assert.equal(found.bins.get('new-thing-cli'), 'new-thing');
});

test('with no manifest anywhere, the fallback list is used', () => {
  const lone = join(scratch, 'lone', 'factory-plugin-advisor');
  mkdirSync(lone, { recursive: true });
  const found = marketplacePlugins(lone, { HOME: join(scratch, 'empty-home') });
  assert.equal(found.manifest, null);
  assert.deepEqual(found.plugins, [...FALLBACK_PLUGINS]);
  for (const p of FALLBACK_PLUGINS) assert.equal(found.bins.get(p), p);
});

test('FALLBACK_PLUGINS equals the sorted plugin names in the repo marketplace.json', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const names = (manifest.plugins as Array<{ name: string }>).map((p) => p.name).sort();
  assert.deepEqual([...FALLBACK_PLUGINS], names, 'update FALLBACK_PLUGINS in src/plugins.ts when a plugin is added to or removed from the marketplace');
  assert.deepEqual([...FALLBACK_PLUGINS], [...FALLBACK_PLUGINS].sort(), 'FALLBACK_PLUGINS is sorted');
});

test('FACTORY_COMMANDS equals the subcommands `factory --help` lists', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins', 'factory', 'src', 'cli.ts'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const listed = /\{([a-z,-]+)\}/.exec(r.stdout)?.[1]?.split(',');
  assert.ok(listed !== undefined && listed.length > 0, r.stdout);
  assert.deepEqual([...FACTORY_COMMANDS], listed, 'update FACTORY_COMMANDS in src/plugins.ts when a factory subcommand is added or removed');
});

test('FACTORY_FOLLOWUP_COMMANDS equals the subcommands `factory followup --help` lists', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'plugins', 'factory', 'src', 'cli.ts'), 'followup', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const listed = /\{([a-z,-]+)\}/.exec(r.stdout)?.[1]?.split(',');
  assert.ok(listed !== undefined && listed.length > 0, r.stdout);
  assert.deepEqual([...FACTORY_FOLLOWUP_COMMANDS], listed, 'update FACTORY_FOLLOWUP_COMMANDS in src/plugins.ts when a factory followup subcommand is added or removed');
});
