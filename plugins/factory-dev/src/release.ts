// release: the tag/version consistency check and the release notes from CHANGELOG.md.
//
// One changelog and one repo version: every plugin the marketplace lists carries the same `version` in
// its .claude-plugin/plugin.json and its package.json, and a release tag is "v" + that version.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKETPLACE_PATH, entryDir, marketplaceEntries } from './repo.ts';

/** Exit 1: the checkout is not releasable (at that tag). */
export class ReleaseError extends Error {}

export interface ReleaseResult {
  version: string;
  tag: string | null;
  /** The plugins checked, by name. */
  plugins: string[];
  /** The CHANGELOG.md section body for the version, trimmed, ending in one newline. */
  notes: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;

function readJson(root: string, rel: string): Record<string, unknown> {
  const path = join(root, rel);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ReleaseError(`${rel} is missing`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ReleaseError(`${rel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ReleaseError(`${rel} is not a JSON object`);
  return value as Record<string, unknown>;
}

function relPath(dir: string, file: string): string {
  return dir === '.' ? file : `${dir}/${file}`;
}

interface PluginVersion {
  name: string;
  manifest: string;
  version: string;
}

/** Every marketplace plugin's plugin.json version, after checking its package.json and marketplace entry agree. */
export function pluginVersions(root: string): PluginVersion[] {
  readJson(root, MARKETPLACE_PATH);
  const entries = marketplaceEntries(root);
  if (entries.length === 0) throw new ReleaseError(`${MARKETPLACE_PATH} lists no plugins`);
  return entries.map((entry) => {
    const name = String(entry.name);
    const dir = entryDir(entry);
    if (dir === null) throw new ReleaseError(`${MARKETPLACE_PATH} entry '${name}' has source ${JSON.stringify(entry.source)}; expected a "./<path>" inside the checkout`);
    const manifest = relPath(dir, '.claude-plugin/plugin.json');
    const version = readJson(root, manifest).version;
    if (typeof version !== 'string' || !VERSION.test(version)) {
      throw new ReleaseError(`${manifest} 'version' must be X.Y.Z, got ${JSON.stringify(version)}`);
    }
    const pkg = relPath(dir, 'package.json');
    if (existsSync(join(root, pkg))) {
      const pkgVersion = readJson(root, pkg).version;
      if (pkgVersion !== version) {
        throw new ReleaseError(`${pkg} has version ${JSON.stringify(pkgVersion)} but ${manifest} has ${version}; set both to the same version`);
      }
    }
    if (entry.version !== undefined && entry.version !== version) {
      throw new ReleaseError(`marketplace.json lists ${name} ${String(entry.version)} but ${manifest} says ${version}`);
    }
    return { name, manifest, version };
  });
}

/** The body of CHANGELOG.md's `## [version]` section, up to the next `## ` heading or the link definitions. */
export function changelogSection(root: string, version: string): string {
  let text: string;
  try {
    text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    throw new ReleaseError('CHANGELOG.md is missing');
  }
  const heading = `## [${version}]`;
  const body: string[] = [];
  let inside = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.startsWith('## ') || /^\[[^\]]+\]: /.test(line)) {
      if (inside) break;
      inside = line.startsWith(heading);
      continue;
    }
    if (inside) body.push(line);
  }
  const notes = body.join('\n').trim();
  if (notes === '') throw new ReleaseError(`CHANGELOG.md has no '${heading}' section with release notes`);
  return `${notes}\n`;
}

/**
 * Checks that every marketplace plugin has the same version (plugin.json, package.json and any version in
 * its marketplace entry), that `tag`, when given, is "v" + that version, and that CHANGELOG.md has a
 * non-empty section for it. Returns that section as the release notes; throws ReleaseError otherwise.
 */
export function releaseCheck(root: string, tag: string | null = null): ReleaseResult {
  const plugins = pluginVersions(root);
  const first = plugins[0];
  if (first === undefined) throw new ReleaseError(`${MARKETPLACE_PATH} lists no plugins`);
  const differing = plugins.filter((p) => p.version !== first.version);
  if (differing.length > 0) {
    const list = plugins.map((p) => `${p.manifest} ${p.version}`).join(', ');
    throw new ReleaseError(`plugin versions differ (${list}); every plugin's plugin.json version moves together`);
  }
  const version = first.version;
  if (tag !== null && tag !== `v${version}`) {
    throw new ReleaseError(`tag '${tag}' does not match plugin.json version ${version} (expected 'v${version}')`);
  }
  return { version, tag, plugins: plugins.map((p) => p.name), notes: changelogSection(root, version) };
}
