// Shared test setup: a scratch Claude Code config dir built from the fixtures (never the real
// ~/.claude), a scratch factory-plugin-discover config dir, run() with a fake Io, and a fake `claude`.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/config.ts';
import { run } from '../src/run.ts';

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const MARKETPLACE = 'software-factory';
/** Every plugin in the fixture marketplace (a trimmed copy of the real one), sorted. */
export const ALL = ['factory', 'factory-dev', 'factory-docs', 'factory-plugin-advisor', 'factory-plugin-builder', 'factory-plugin-discover'];

export interface Options {
  /** software-factory plugins to install (default: factory, factory-dev, factory-plugin-advisor, factory-plugin-discover). */
  installed?: string[];
  /** Plugin ids whose enabledPlugins entry is false (default: factory-dev). */
  disabled?: string[];
  /**
   * software-factory plugins installed with project scope for `<dir>/some-other-project` only
   * (default: factory-plugin-builder), unless also in `installed`.
   */
  elsewhere?: string[];
  /** Record the marketplace in known_marketplaces.json (default true). */
  knownMarketplace?: boolean;
}

export interface Sandbox {
  dir: string;
  claudeDir: string;
  configDir: string;
  /** The fixture marketplace's checkout. */
  marketplace: string;
  /** A cwd outside any git checkout. */
  cwd: string;
  env: Env;
  call: (argv: string[], options?: { stdin?: string; cwd?: string }) => { code: number; stdout: string; stderr: string };
  cleanup: () => void;
}

const DEFAULT_INSTALLED = ['factory', 'factory-dev', 'factory-plugin-advisor', 'factory-plugin-discover'];

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sandbox(options: Options = {}, extraEnv: Env = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'factory-plugin-discover-test-'));
  const claudeDir = join(dir, 'claude');
  const configDir = join(dir, 'config', 'factory-plugin-discover');
  const marketplace = join(dir, 'marketplace');
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd, { recursive: true });
  cpSync(join(FIXTURES, 'marketplace'), marketplace, { recursive: true });

  const records: Record<string, unknown[]> = {};
  for (const name of options.installed ?? DEFAULT_INSTALLED) {
    const installPath = join(claudeDir, 'plugins', 'cache', MARKETPLACE, name, '0.1.0');
    cpSync(join(marketplace, 'plugins', name), installPath, { recursive: true });
    records[`${name}@${MARKETPLACE}`] = [{ scope: 'user', installPath, version: '0.1.0', installedAt: '2026-11-01T00:00:00.000Z', lastUpdated: '2026-11-01T00:00:00.000Z' }];
  }
  // A plugin from another marketplace, and a project-scoped install for a different project.
  const other = join(claudeDir, 'plugins', 'cache', 'other-market', 'other-tools', '1.2.0');
  cpSync(join(FIXTURES, 'other-tools'), other, { recursive: true });
  records['other-tools@other-market'] = [{ scope: 'user', installPath: other, version: '1.2.0' }];
  for (const name of options.elsewhere ?? ['factory-plugin-builder']) {
    if (records[`${name}@${MARKETPLACE}`] !== undefined) continue;
    const elsewhere = join(claudeDir, 'plugins', 'cache', MARKETPLACE, name, '0.1.0');
    cpSync(join(marketplace, 'plugins', name), elsewhere, { recursive: true });
    records[`${name}@${MARKETPLACE}`] = [{ scope: 'project', projectPath: join(dir, 'some-other-project'), installPath: elsewhere, version: '0.1.0' }];
  }
  writeJson(join(claudeDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: records });

  if (options.knownMarketplace !== false) {
    writeJson(join(claudeDir, 'plugins', 'known_marketplaces.json'), {
      [MARKETPLACE]: { source: { source: 'directory', path: marketplace }, installLocation: marketplace, lastUpdated: '2026-11-01T00:00:00.000Z' },
      'other-market': { source: { source: 'github', repo: 'example/other-market' }, installLocation: join(dir, 'other-market'), lastUpdated: '2026-11-01T00:00:00.000Z' },
    });
  }
  const enabled: Record<string, boolean> = {};
  for (const id of Object.keys(records)) enabled[id] = true;
  for (const id of options.disabled ?? [`factory-dev@${MARKETPLACE}`]) enabled[id] = false;
  writeJson(join(claudeDir, 'settings.json'), { enabledPlugins: enabled });
  cpSync(join(FIXTURES, 'user-skills'), join(claudeDir, 'skills'), { recursive: true });

  const env: Env = { HOME: join(dir, 'home'), PATH: process.env.PATH, CLAUDE_CONFIG_DIR: claudeDir, FACTORY_PLUGIN_DISCOVER_CONFIG_DIR: configDir, ...extraEnv };
  const call: Sandbox['call'] = (argv, o = {}) => {
    let stdout = '';
    let stderr = '';
    // pluginRoot is the source folder: its ../../.claude-plugin is the real repo's manifest, so give a
    // root whose grandparent has none, and the manifest comes from known_marketplaces.json.
    const code = run(argv, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      stdin: () => o.stdin ?? '',
      env,
      cwd: o.cwd ?? cwd,
      pluginRoot: join(dir, 'cache', 'x', 'factory-plugin-discover'),
    });
    return { code, stdout, stderr };
  };
  return { dir, claudeDir, configDir, marketplace, cwd, env, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Writes an executable fake `claude` into `<dir>/bin` that appends its argv to `<dir>/claude-calls.jsonl`,
 * then runs `script` (Node, CommonJS). It never installs anything.
 */
export function fakeClaude(dir: string, script = "console.log('Successfully installed plugin');"): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'claude');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(dir, 'claude-calls.jsonl'))}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
${script}
`,
  );
  chmodSync(path, 0o755);
  return bin;
}
