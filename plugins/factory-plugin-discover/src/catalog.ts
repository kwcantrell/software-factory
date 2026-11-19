// The catalog: every installed plugin with its skills, the user's own skills, and the
// software-factory marketplace plugins that are not installed. Read from Claude Code's own records on disk
// (installed_plugins.json, known_marketplaces.json, settings.json, each install's skills/*/SKILL.md),
// never by running `claude plugin list`: `claude` may not be on PATH (tests, CI, a hook), and spawning
// it costs far more than reading a few small files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Env = Record<string, string | undefined>;

export const MARKETPLACE_NAME = 'software-factory';
export const SELF = 'factory-plugin-discover';

export interface Skill {
  name: string;
  description: string;
  /**
   * The CLI commands the skill runs: `<command>` of every `--package=<root> -- <bin> <command>` line
   * in its SKILL.md (frontmatter and body), sorted. `factory-dev release` is how that plugin is used,
   * so match counts these words like the plugin's name.
   */
  commands: string[];
}

export interface InstalledPlugin {
  /** `<plugin>@<marketplace>`, the key in installed_plugins.json. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  scope?: string;
  installPath: string;
  description: string;
  /** False when a settings file has `enabledPlugins["<id>"]: false`. */
  enabled: boolean;
  skills: Skill[];
}

export interface AvailablePlugin {
  name: string;
  marketplace: typeof MARKETPLACE_NAME;
  description: string;
  skills: Skill[];
  installCommand: string;
}

/** A plugin installed with project or local scope for another project: not usable here, not missing. */
export interface ElsewherePlugin {
  id: string;
  name: string;
  marketplace: string;
  /** `project` or `local`. */
  scope: string;
  /** The project it is installed for. */
  projectPath: string;
  installPath: string;
  description: string;
  skills: Skill[];
}

export interface UserSkill extends Skill {
  path: string;
}

export interface Catalog {
  claudeDir: string;
  /** The software-factory marketplace manifest used for `available`, or null when none was found. */
  manifest: string | null;
  installed: InstalledPlugin[];
  /** Plugins installed only for other projects (project or local scope); never in `available`. */
  installedElsewhere: ElsewherePlugin[];
  userSkills: UserSkill[];
  available: AvailablePlugin[];
}

export function installCommand(name: string): string {
  return `claude plugin install ${name}@${MARKETPLACE_NAME}`;
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeDir(env: Env): string {
  const override = env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== '' ? resolve(override) : join(env.HOME ?? homedir(), '.claude');
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.startsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

/** Folds the lines of a `>` block: adjacent lines join with a space, each blank line is a newline. */
function fold(lines: readonly string[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i === 0) out = line;
    else if (line === '') out += '\n';
    else out += (lines[i - 1] ?? '') === '' ? line : ` ${line}`;
  }
  return out;
}

/**
 * The `name` and `description` of a SKILL.md's frontmatter. Handles plain, quoted and block (`>`,
 * `|`) scalars, which is all skill frontmatter uses; anything else is ignored. A block runs over
 * every following indented or blank line, so blank lines inside it are kept (as a newline when
 * folded); trailing blank lines are dropped.
 */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m === null) return {};
  const out: Record<string, string> = {};
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (kv === null) continue;
    const key = kv[1] ?? '';
    let value = kv[2] ?? '';
    if (/^[>|][+-]?$/.test(value.trim())) {
      const raw: string[] = [];
      while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1] ?? '')) raw.push(lines[++i] ?? '');
      while (raw.length > 0 && (raw[raw.length - 1] ?? '').trim() === '') raw.pop();
      while (raw.length > 0 && (raw[0] ?? '').trim() === '') raw.shift();
      const indent = /^\s*/.exec(raw[0] ?? '')?.[0].length ?? 0;
      const block = raw.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(indent, /^\s*/.exec(l)?.[0].length ?? 0)).trimEnd()));
      value = value.trim().startsWith('>') ? fold(block) : block.join('\n');
    } else {
      value = unquote(value);
    }
    out[key] = value;
  }
  return out;
}

/** The skills in `<root>/skills/*\/SKILL.md`, sorted by name; a skill's name defaults to its folder. */
export function readSkills(root: string): Skill[] {
  return readSkillDir(join(root, 'skills')).map(({ name, description, commands }) => ({ name, description, commands }));
}

const COMMAND_LINE = /--package=(?:"[^"\n]*"|'[^'\n]*'|\S+)\s+--\s+[a-z][a-z0-9-]*\s+([a-z][a-z0-9-]*)/g;

/** The CLI commands a SKILL.md runs through npx (see Skill.commands). */
export function skillCommands(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(COMMAND_LINE)) if (m[1] !== undefined) out.add(m[1]);
  return [...out].sort();
}

function readSkillDir(dir: string): UserSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: UserSkill[] = [];
  for (const folder of entries.sort()) {
    const path = join(dir, folder, 'SKILL.md');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    out.push({ name: fm.name !== undefined && fm.name !== '' ? fm.name : folder, description: fm.description ?? '', commands: skillCommands(text), path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Is `dir` the same as `ancestor` or inside it? */
function within(dir: string, ancestor: string): boolean {
  const a = resolve(ancestor);
  const d = resolve(dir);
  return d === a || d.startsWith(a.endsWith(sep) ? a : a + sep);
}

/**
 * The `enabledPlugins` map Claude Code would apply in `cwd`: the user's settings.json, then each
 * `.claude/settings.json` and `.claude/settings.local.json` from the filesystem root down to `cwd`
 * (a nearer file wins).
 */
export function enabledPlugins(dir: string, cwd: string): Map<string, boolean> {
  const files = [join(dir, 'settings.json')];
  const chain: string[] = [];
  for (let current = resolve(cwd); ; current = dirname(current)) {
    chain.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const d of chain) {
    if (resolve(d, '.claude') === resolve(dir)) continue;
    files.push(join(d, '.claude', 'settings.json'), join(d, '.claude', 'settings.local.json'));
  }
  const out = new Map<string, boolean>();
  for (const file of files) {
    const settings = readJson(file);
    const enabled = isObject(settings) ? settings.enabledPlugins : undefined;
    if (!isObject(enabled)) continue;
    for (const [id, value] of Object.entries(enabled)) if (typeof value === 'boolean') out.set(id, value);
  }
  return out;
}

/**
 * The installed plugins in `<claudeDir>/plugins/installed_plugins.json` (version 2:
 * `{"plugins": {"<name>@<marketplace>": [{scope, installPath, version, projectPath?}]}}`), split into
 * those that apply in `cwd` and those installed only for another project. A project- or local-scoped
 * install counts only inside its project; elsewhere it is reported as installed elsewhere.
 */
export function readInstalled(dir: string, cwd: string): { installed: InstalledPlugin[]; elsewhere: ElsewherePlugin[] } {
  const records = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  const plugins = isObject(records) && isObject(records.plugins) ? records.plugins : {};
  const enabled = enabledPlugins(dir, cwd);
  const out: InstalledPlugin[] = [];
  const elsewhere: ElsewherePlugin[] = [];
  for (const [id, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : '';
    const valid = installs.filter((i): i is Record<string, unknown> => isObject(i) && str(i.installPath) !== undefined);
    const scoped = (i: Record<string, unknown>): boolean => i.scope === 'project' || i.scope === 'local';
    const install = valid.find((i) => {
      const projectPath = str(i.projectPath);
      return !scoped(i) || (projectPath !== undefined && within(cwd, projectPath));
    });
    const description = (installPath: string): string => {
      const manifest = readJson(join(installPath, '.claude-plugin', 'plugin.json'));
      return (isObject(manifest) ? str(manifest.description) : undefined) ?? '';
    };
    if (install === undefined) {
      const other = valid.find((i) => scoped(i) && str(i.projectPath) !== undefined);
      if (other === undefined) continue;
      const installPath = str(other.installPath) ?? '';
      elsewhere.push({
        id,
        name,
        marketplace,
        scope: str(other.scope) ?? '',
        projectPath: str(other.projectPath) ?? '',
        installPath,
        description: description(installPath),
        skills: readSkills(installPath),
      });
      continue;
    }
    const installPath = str(install.installPath) ?? '';
    const version = str(install.version);
    const scope = str(install.scope);
    out.push({
      id,
      name,
      marketplace,
      ...(version === undefined ? {} : { version }),
      ...(scope === undefined ? {} : { scope }),
      installPath,
      description: description(installPath),
      enabled: enabled.get(id) !== false,
      skills: readSkills(installPath),
    });
  }
  return { installed: out.sort((a, b) => a.id.localeCompare(b.id)), elsewhere: elsewhere.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** The user's own skills, `<claudeDir>/skills/*\/SKILL.md`. */
export function readUserSkills(dir: string): UserSkill[] {
  return readSkillDir(join(dir, 'skills'));
}

/**
 * Where the software-factory marketplace manifest is, the way factory-plugin-advisor finds it: next to
 * this plugin when it runs from a checkout (`<repo>/plugins/factory-plugin-discover`), else the install location Claude
 * Code recorded for the marketplace in `known_marketplaces.json` (the plugin cache holds plugins, not
 * the manifest).
 */
export function findManifest(pluginRoot: string, dir: string): string | null {
  const local = join(resolve(pluginRoot), '..', '..', '.claude-plugin', 'marketplace.json');
  const parsed = readJson(local);
  if (isObject(parsed) && parsed.name === MARKETPLACE_NAME) return local;
  const known = readJson(join(dir, 'plugins', 'known_marketplaces.json'));
  const entry = isObject(known) ? known[MARKETPLACE_NAME] : undefined;
  const location = isObject(entry) ? str(entry.installLocation) : undefined;
  if (location === undefined) return null;
  const manifest = join(location, '.claude-plugin', 'marketplace.json');
  return existsSync(manifest) ? manifest : null;
}

export interface MarketplaceEntry {
  name: string;
  description: string;
  /** The plugin's folder when its source is a relative path in the marketplace, else null. */
  root: string | null;
}

/** The plugins listed in a marketplace manifest; null when it cannot be read. */
export function readMarketplace(manifest: string): MarketplaceEntry[] | null {
  const parsed = readJson(manifest);
  if (!isObject(parsed) || !Array.isArray(parsed.plugins)) return null;
  const base = dirname(dirname(manifest));
  const out: MarketplaceEntry[] = [];
  for (const entry of parsed.plugins) {
    if (!isObject(entry) || typeof entry.name !== 'string') continue;
    const source = str(entry.source);
    out.push({ name: entry.name, description: str(entry.description) ?? '', root: source === undefined ? null : join(base, source) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readCatalog(env: Env, options: { pluginRoot: string; cwd: string }): Catalog {
  const dir = claudeDir(env);
  const { installed, elsewhere } = readInstalled(dir, options.cwd);
  const manifest = findManifest(options.pluginRoot, dir);
  const entries = manifest === null ? [] : (readMarketplace(manifest) ?? []);
  // Installed here, or for another project: either way not missing, so not offered for install.
  const have = new Set([...installed, ...elsewhere].filter((p) => p.marketplace === MARKETPLACE_NAME).map((p) => p.name));
  const available: AvailablePlugin[] = entries
    .filter((e) => !have.has(e.name))
    .map((e) => {
      const pluginJson = e.root === null ? undefined : readJson(join(e.root, '.claude-plugin', 'plugin.json'));
      const description = e.description !== '' ? e.description : ((isObject(pluginJson) ? str(pluginJson.description) : undefined) ?? '');
      return { name: e.name, marketplace: MARKETPLACE_NAME, description, skills: e.root === null ? [] : readSkills(e.root), installCommand: installCommand(e.name) };
    });
  return { claudeDir: dir, manifest, installed, installedElsewhere: elsewhere, userSkills: readUserSkills(dir), available };
}

/** This plugin's own folder (src/..). */
export function ownRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}
