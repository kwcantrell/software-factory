// Claude Code's plugin and skill records, read from its own files under $CLAUDE_CONFIG_DIR (else
// ~/.claude): plugins/installed_plugins.json, the enabledPlugins of each settings file, each
// install's skills/*/SKILL.md, and the user's skills/*/SKILL.md; plus the project's own
// .claude/skills. Copied (trimmed) from factory-plugin-discover's src/catalog.ts, not imported:
// plugins never import each other. Never runs `claude`.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export type Env = Record<string, string | undefined>;

export interface InstalledPlugin {
  /** `<plugin>@<marketplace>`. */
  id: string;
  name: string;
  enabled: boolean;
  skills: string[];
}

export interface ElsewherePlugin {
  id: string;
  projectPath: string;
}

export interface ClaudeRecords {
  claudeDir: string;
  installed: InstalledPlugin[];
  elsewhere: ElsewherePlugin[];
  /** The user's own skills (`<claudeDir>/skills`) and the project's (`<root>/.claude/skills`). */
  skills: string[];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeDir(env: Env): string {
  const override = env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override !== '' ? resolve(override) : join(env.HOME ?? homedir(), '.claude');
}

/** The `name` in a SKILL.md's frontmatter (plain or quoted), else undefined. */
function skillName(text: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const m = fm === undefined ? null : /^name:\s*(.*)$/m.exec(fm);
  const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
  return v === undefined || v === '' ? undefined : v;
}

/** The skill names in `<dir>/*\/SKILL.md`; a skill's name defaults to its folder. */
export function readSkillDir(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const folder of entries.sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, folder, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    out.push(skillName(text) ?? folder);
  }
  return out.sort();
}

function within(dir: string, ancestor: string): boolean {
  const a = resolve(ancestor);
  const d = resolve(dir);
  return d === a || d.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** The enabledPlugins map Claude Code applies in `cwd`: the user's settings, then each project level. */
function enabledPlugins(dir: string, cwd: string): Map<string, boolean> {
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

export function readClaudeRecords(env: Env, cwd: string): ClaudeRecords {
  const dir = claudeDir(env);
  const records = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  const plugins = isObject(records) && isObject(records.plugins) ? records.plugins : {};
  const enabled = enabledPlugins(dir, cwd);
  const installed: InstalledPlugin[] = [];
  const elsewhere: ElsewherePlugin[] = [];
  for (const [id, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const valid = installs.filter((i): i is Record<string, unknown> => isObject(i) && str(i.installPath) !== undefined);
    const scoped = (i: Record<string, unknown>): boolean => i.scope === 'project' || i.scope === 'local';
    const install = valid.find((i) => {
      const projectPath = str(i.projectPath);
      return !scoped(i) || (projectPath !== undefined && within(cwd, projectPath));
    });
    if (install === undefined) {
      const other = valid.find((i) => scoped(i) && str(i.projectPath) !== undefined);
      if (other !== undefined) elsewhere.push({ id, projectPath: str(other.projectPath) ?? '' });
      continue;
    }
    installed.push({ id, name, enabled: enabled.get(id) !== false, skills: readSkillDir(join(str(install.installPath) ?? '', 'skills')) });
  }
  const skills = [...new Set([...readSkillDir(join(dir, 'skills')), ...readSkillDir(join(cwd, '.claude', 'skills'))])].sort();
  return { claudeDir: dir, installed, elsewhere, skills };
}
