// The marketplace's plugins and their CLI bins, read at run time from .claude-plugin/marketplace.json
// and each listed plugin's package.json "bin", so a plugin added to the marketplace is recognised
// without changing this one. The fallback list is used only when no marketplace manifest can be found.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Env = Record<string, string | undefined>;

export const MARKETPLACE_NAME = 'software-factory';

/**
 * The marketplace's plugins, sorted; each one's bin is its own name. test/plugins.test.ts fails when
 * this differs from .claude-plugin/marketplace.json, so add a new plugin here too.
 */
export const FALLBACK_PLUGINS = [
  'factory',
  'factory-dev',
  'factory-docs',
  'factory-plugin-advisor',
  'factory-plugin-builder',
  'factory-plugin-discover',
] as const;

export interface MarketplacePlugins {
  /** Plugin names, sorted. */
  plugins: string[];
  /** CLI bin name -> plugin name. */
  bins: Map<string, string>;
  /** The manifest the list came from, or null for the fallback list. */
  manifest: string | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Where the marketplace manifest is: next to this plugin when it runs from a checkout
 * (`<repo>/plugins/factory-plugin-advisor`), else the install location Claude Code recorded for the
 * marketplace in `known_marketplaces.json` (the plugin cache holds plugins, not the manifest).
 */
export function findManifest(pluginRoot: string, env: Env): string | null {
  const local = join(resolve(pluginRoot), '..', '..', '.claude-plugin', 'marketplace.json');
  if (existsSync(local)) return local;
  const claudeDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(env.HOME ?? homedir(), '.claude');
  const known = readJson(join(claudeDir, 'plugins', 'known_marketplaces.json'));
  const entry = isObject(known) ? known[MARKETPLACE_NAME] : undefined;
  const location = isObject(entry) && typeof entry.installLocation === 'string' ? entry.installLocation : undefined;
  if (location === undefined) return null;
  const manifest = join(location, '.claude-plugin', 'marketplace.json');
  return existsSync(manifest) ? manifest : null;
}

/** Reads the plugins and bins from a marketplace manifest; null when it is unreadable. */
export function readMarketplace(manifest: string): MarketplacePlugins | null {
  const parsed = readJson(manifest);
  if (!isObject(parsed) || !Array.isArray(parsed.plugins)) return null;
  const root = dirname(dirname(manifest));
  const plugins: string[] = [];
  const bins = new Map<string, string>();
  for (const entry of parsed.plugins) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue;
    plugins.push(entry.name);
    const pkg = typeof entry.source === 'string' ? readJson(join(root, entry.source, 'package.json')) : undefined;
    const bin = isObject(pkg) ? pkg.bin : undefined;
    if (isObject(bin)) for (const name of Object.keys(bin)) bins.set(name, entry.name);
    else bins.set(entry.name, entry.name);
  }
  return { plugins: plugins.sort(), bins, manifest };
}

export function marketplacePlugins(pluginRoot: string, env: Env): MarketplacePlugins {
  const manifest = findManifest(pluginRoot, env);
  const read = manifest === null ? null : readMarketplace(manifest);
  if (read !== null && read.plugins.length > 0) return read;
  return { plugins: [...FALLBACK_PLUGINS], bins: new Map(FALLBACK_PLUGINS.map((p) => [p, p])), manifest: null };
}

/** This plugin's own folder (src/..). */
export function ownRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}
