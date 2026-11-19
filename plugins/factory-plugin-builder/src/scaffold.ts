// new: copies templates/plugin to plugins/<name>/, renames the template's identifiers (plugin name,
// skill folder and name, CLI bin name: all the token "plugin-template") and appends the plugin to
// marketplace.json. The new plugin's plugin.json and package.json get the version the marketplace's
// plugins share (one changelog, one repo version), so it passes factory-dev check as made. The root
// `npm run new-plugin` runs this same code through the CLI.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CommandError, MARKETPLACE_PATH, TEMPLATE_PATH, UsageError, marketplaceEntries, readMarketplace, validateName } from './repo.ts';

export const TEMPLATE_TOKEN = 'plugin-template';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a: string, b: string): number {
  const x = (VERSION_RE.exec(a) ?? []).slice(1).map(Number);
  const y = (VERSION_RE.exec(b) ?? []).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * The repo version: the X.Y.Z `version` in the plugin.json of the plugins marketplace.json lists from
 * "./" sources. They normally all share it; if they differ (factory-dev check refuses that), the
 * highest. Null when no listed plugin has one.
 */
export function repoVersion(root: string): string | null {
  const versions: string[] = [];
  for (const entry of marketplaceEntries(root)) {
    const source = entry.source;
    if (typeof source !== 'string' || !source.startsWith('./') || source.split('/').includes('..')) continue;
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(root, source, '.claude-plugin', 'plugin.json'), 'utf8'));
      const version = typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : undefined;
      if (typeof version === 'string' && VERSION_RE.test(version)) versions.push(version);
    } catch {
      // no readable manifest: it has no version to share
    }
  }
  return versions.sort(compareVersions).at(-1) ?? null;
}

/** Sets "version" in a JSON object file, keeping its other keys in order. */
function setVersion(path: string, version: string): void {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  value.version = version;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface Created {
  name: string;
  path: string;
  marketplace: string;
  description: string;
}

/**
 * Creates plugins/<name> in the checkout at `root`. Throws UsageError for a bad name (exit 2) and
 * CommandError when the folder or marketplace entry already exists (exit 1); either way nothing is
 * written.
 */
export function scaffold(root: string, name: string, description?: string): Created {
  validateName(name);
  if (name === TEMPLATE_TOKEN) throw new UsageError(`'${name}' is the template's own name`);
  if (description !== undefined && description.trim() === '') throw new UsageError('--description must not be empty');
  const template = join(root, TEMPLATE_PATH);
  if (!existsSync(template) || !statSync(template).isDirectory()) throw new CommandError(`${TEMPLATE_PATH} not found in ${root}`);
  const marketplace = readMarketplace(root);
  if (marketplace === null || !Array.isArray(marketplace.plugins)) throw new CommandError(`${MARKETPLACE_PATH} has no "plugins" array`);
  const plugins: unknown[] = marketplace.plugins;
  const target = join(root, 'plugins', name);
  if (existsSync(target)) throw new CommandError(`plugins/${name} already exists`);
  if (plugins.some((p) => typeof p === 'object' && p !== null && (p as { name?: unknown }).name === name)) {
    throw new CommandError(`${MARKETPLACE_PATH} already lists a plugin named '${name}'`);
  }

  const summary = description?.trim() ?? `${name}: TODO describe what this plugin does.`;
  const repo = repoVersion(root);
  try {
    cpSync(template, target, { recursive: true, filter: (path) => basename(path) !== 'node_modules' });
    renameTree(target, name);
    const manifestPath = join(target, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.description = summary;
    if (repo !== null) manifest.version = repo;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (repo !== null) setVersion(join(target, 'package.json'), repo);
    plugins.push({ name, source: `./plugins/${name}`, description: summary });
    writeFileSync(join(root, MARKETPLACE_PATH), `${JSON.stringify(marketplace, null, 2)}\n`);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw new CommandError(`could not create plugins/${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { name, path: `plugins/${name}`, marketplace: MARKETPLACE_PATH, description: summary };
}

/** Replaces the template token in every file's contents and in every file and directory name. */
function renameTree(dir: string, name: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    let path = join(dir, entry.name);
    if (entry.name.includes(TEMPLATE_TOKEN)) {
      const renamed = join(dir, entry.name.replaceAll(TEMPLATE_TOKEN, name));
      renameSync(path, renamed);
      path = renamed;
    }
    if (entry.isDirectory()) {
      renameTree(path, name);
    } else if (entry.isFile()) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(TEMPLATE_TOKEN)) writeFileSync(path, text.replaceAll(TEMPLATE_TOKEN, name));
    }
  }
}
