// `factory upgrade`: move a repository from an older Software Factory to this one.
//
// Three parts, each planned first and shown as a dry run; only --apply writes:
//   - settings: Claude Code settings that enable the old plugin (factory@kwcantrell-plugins, or
//     factory@<any marketplace but software-factory>) are switched to factory@software-factory;
//   - runtime dir: factory/ written by the Python CLI gets the job fields, dashboard and .gitignore
//     the current CLI writes, after the originals are copied to factory/upgrade-backup-<time>/;
//     settings files are backed up outside factory/ (which the dashboard serves), in a private
//     factory-upgrade-backup-<time>/ under the repo's git dir, since they can hold secrets;
//   - manual steps: what it must not do itself (factory.json keys the CLI refuses, tracked files that
//     still name the old CLI, `claude plugin` commands), listed with what to do.
// It never runs `claude`, and changes user-scope settings only with an explicit --scope user.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import {
  alive,
  blankJob,
  configProblems,
  factoryDir,
  LOCK_FILE,
  locked,
  now,
  PLUGIN_ROOT,
  Refused,
} from './factory.ts';
import type { Io } from './factory.ts';
import { dumps } from './pyfmt.ts';

export const SCOPES = ['project', 'local', 'user'] as const;
export type Scope = (typeof SCOPES)[number];

export const NEW_PLUGIN = 'factory@software-factory';
const NEW_MARKETPLACE = 'software-factory';
const NEW_REPO = 'kwcantrell/software-factory';
const OLD_MARKETPLACE = 'kwcantrell-plugins';
const OLD_REPO = 'kwcantrell/kwcantrell-plugins';
// Spelled in pieces so this file is not itself a tracked file that "still names the old CLI".
const OLD_CLI = 'bin/' + 'factory';

/** sha256 of each dashboard an older CLI installed, and which CLI that was. */
const OLD_DASHBOARDS: Record<string, string> = {
  ec4cd71e0a5bdc17a79372e454118af50940fa8c9ef72577866641d3f2f241aa:
    'the original Python CLI (kwcantrell-plugins, before follow-ups)',
  '3ebeb2bcaa41743bb12d846c738fee3d28419ab1a472f0829cedd049fcea530c':
    'the Python CLI with follow-ups (kwcantrell-plugins, or software-factory 0.2.0)',
};

/** The `--repo`/cwd is not a git checkout, or a path argument is wrong: exit 2. */
export class UsageProblem extends Error {}

export interface UpgradeOptions {
  repo: string | null;
  apply: boolean;
  /** The settings scopes to change; null means the default, project and local. */
  scopes: Scope[] | null;
}

export interface Report {
  repo: string;
  factory_dir: string;
  mode: 'dry-run' | 'apply';
  found: string[];
  settings: { scope: Scope; file: string; selected: boolean; changes: string[] }[];
  runtime: { dir: string; changes: string[] };
  manual: string[];
  /** Where the runtime dir's originals were copied, under factory/. */
  backup: string | null;
  /** Where the changed settings files' originals were copied: a private dir in the git dir. */
  settings_backup: string | null;
  changes: number;
  nothing_to_do: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- locating things

function checkout(start: string): string {
  if (!existsSync(start) || !statSync(start).isDirectory()) throw new UsageProblem(`${start} is not a directory`);
  const p = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: start, encoding: 'utf8' });
  if (p.error || p.status !== 0 || !p.stdout.startsWith('worktree ')) {
    throw new UsageProblem(`${start} is not inside a git checkout`);
  }
  return (p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length);
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function settingsPath(scope: Scope, repo: string): string {
  if (scope === 'project') return join(repo, '.claude', 'settings.json');
  if (scope === 'local') return join(repo, '.claude', 'settings.local.json');
  return join(claudeConfigDir(), 'settings.json');
}

// ---------------------------------------------------------------- settings

interface SettingsPlan {
  scope: Scope;
  path: string;
  selected: boolean;
  data: Obj | null;
  changes: string[];
  text: string | null; // the new file content, when there are changes
}

function readSettings(path: string): Obj | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Refused(`${path} is not valid JSON (${(error as Error).message}); fix it by hand - it was not changed`);
  }
  if (!isObj(data)) throw new Refused(`${path} is not a JSON object; fix it by hand - it was not changed`);
  return data;
}

const marketplaceOf = (key: string): string => key.slice(key.indexOf('@') + 1);
const isOldPlugin = (key: string): boolean => key.startsWith('factory@') && key !== NEW_PLUGIN;

function pointsAtOldRepo(entry: unknown): boolean {
  if (!isObj(entry) || !isObj(entry.source)) return false;
  const { repo, url } = entry.source;
  return (
    (typeof repo === 'string' && repo.toLowerCase() === OLD_REPO) ||
    (typeof url === 'string' && url.toLowerCase().includes(OLD_REPO))
  );
}

function describeOld(key: string): string {
  return marketplaceOf(key) === OLD_MARKETPLACE
    ? `the original plugin, from ${OLD_REPO}`
    : `marketplace '${marketplaceOf(key)}', not ${NEW_MARKETPLACE}`;
}

/** The indent a settings file uses (default 2 spaces), so a rewrite keeps it. */
function indentOf(text: string): string {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
}

function planSettings(scope: Scope, repo: string, selected: boolean, found: string[]): SettingsPlan {
  const path = settingsPath(scope, repo);
  const data = readSettings(path);
  const plan: SettingsPlan = { scope, path, selected, data, changes: [], text: null };
  if (data === null) return plan;
  const enabled = isObj(data.enabledPlugins) ? data.enabledPlugins : {};
  const markets = isObj(data.extraKnownMarketplaces) ? data.extraKnownMarketplaces : null;
  const oldKeys = Object.keys(enabled).filter(isOldPlugin);
  const where = `${scope} settings (${path})`;
  for (const key of oldKeys) {
    found.push(`${where}: ${key} ${enabled[key] === false ? 'disabled' : 'enabled'} - ${describeOld(key)}`);
  }
  if (Object.hasOwn(enabled, NEW_PLUGIN)) {
    found.push(`${where}: ${NEW_PLUGIN} ${enabled[NEW_PLUGIN] === false ? 'disabled' : 'enabled'} (current)`);
  }
  const oldMarkets = Object.entries(markets ?? {})
    .filter(([name, entry]) => name === OLD_MARKETPLACE || pointsAtOldRepo(entry) || oldKeys.some((k) => marketplaceOf(k) === name))
    .map(([name]) => name);
  for (const name of oldMarkets) found.push(`${where}: marketplace '${name}' declared (kept: other plugins may come from it)`);
  if (oldKeys.length === 0) return plan;

  // Rebuild enabledPlugins in its own key order: the first old key becomes the new one in place.
  const next: Obj = {};
  for (const [key, value] of Object.entries(enabled)) {
    if (!isOldPlugin(key)) {
      next[key] = value;
    } else if (Object.hasOwn(enabled, NEW_PLUGIN) || Object.hasOwn(next, NEW_PLUGIN)) {
      plan.changes.push(`enabledPlugins: remove "${key}" (${NEW_PLUGIN} is already set to ${JSON.stringify(enabled[NEW_PLUGIN] ?? next[NEW_PLUGIN])})`);
    } else {
      next[NEW_PLUGIN] = value;
      plan.changes.push(`enabledPlugins: "${key}": ${JSON.stringify(value)} -> "${NEW_PLUGIN}": ${JSON.stringify(value)}`);
    }
  }
  const out: Obj = { ...data, enabledPlugins: next };
  if (markets && oldMarkets.length > 0 && !Object.hasOwn(markets, NEW_MARKETPLACE)) {
    out.extraKnownMarketplaces = { ...markets, [NEW_MARKETPLACE]: { source: { source: 'github', repo: NEW_REPO } } };
    plan.changes.push(`extraKnownMarketplaces: add "${NEW_MARKETPLACE}" (github ${NEW_REPO})`);
  }
  plan.text = `${JSON.stringify(out, null, indentOf(readFileSync(path, 'utf8')))}\n`;
  return plan;
}

// ---------------------------------------------------------------- runtime dir

/** Every field the current CLI writes in job.json, in its order. */
const JOB_FIELDS = [...Object.keys(blankJob('', '', '')), 'updated'];
const REQUIRED_FIELDS = ['id', 'title', 'stage', 'status', 'created'];

/** The value the current CLI gives a field it finds missing in an old job. */
function jobDefault(job: Obj, key: string): unknown {
  if (key === 'updated') {
    // save() stamps the time of the last write; the last recorded event is the closest to that.
    const history = Array.isArray(job.history) ? job.history : [];
    const last = history[history.length - 1];
    return isObj(last) && typeof last.at === 'string' ? last.at : job.created;
  }
  return (blankJob('', '', '') as unknown as Obj)[key];
}

/** The job with each missing field inserted where the current CLI would write it: right after the
 * nearest field before it that the job has (or first, when it has none). Other keys keep their order. */
function withFields(job: Obj, missing: string[]): Obj {
  const after = new Map<string | null, string[]>();
  for (const key of missing) {
    const before = JOB_FIELDS.slice(0, JOB_FIELDS.indexOf(key)).reverse();
    const anchor = before.find((b) => Object.hasOwn(job, b)) ?? null;
    after.set(anchor, [...(after.get(anchor) ?? []), key]);
  }
  const out: Obj = {};
  for (const key of after.get(null) ?? []) out[key] = jobDefault(job, key);
  for (const [key, value] of Object.entries(job)) {
    out[key] = value;
    for (const k of after.get(key) ?? []) out[k] = jobDefault(job, k);
  }
  return out;
}

/** Whether some process holds a flock/POSIX lock on path (Linux: /proc/locks). */
function fileLockHeld(path: string): boolean {
  let st;
  let locks: string;
  try {
    st = statSync(path, { bigint: true });
    locks = readFileSync('/proc/locks', 'utf8');
  } catch {
    return false;
  }
  const dev = st.dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  const id = `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${st.ino}`;
  return locks.split('\n').some((line) => !line.includes('->') && line.split(/\s+/).includes(id));
}

interface RuntimePlan {
  dir: string;
  changes: string[];
  /** Files (relative to dir) whose originals the backup keeps. */
  originals: string[];
  apply: (() => void)[];
}

/**
 * Replace a file's content atomically. A symlink is followed, so the link stays and its target is
 * rewritten; the file keeps its permission bits (a 0600 settings file stays 0600). The temp file
 * gets a random name and is created exclusively, so nothing already at that name is followed.
 */
function writeAtomic(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : 0o666;
  const tmp = join(dirname(target), `.${basename(target)}.upgrade-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw error;
  }
}

function planRuntime(root: string, found: string[]): RuntimePlan {
  const plan: RuntimePlan = { dir: root, changes: [], originals: [], apply: [] };
  if (!existsSync(root)) return plan;

  const pidLock = join(root, LOCK_FILE);
  if (existsSync(pidLock)) {
    const owner = Number.parseInt(readFileSync(pidLock, 'utf8'), 10);
    if (Number.isInteger(owner) && owner > 0 && alive(owner)) {
      throw new Refused(`the factory lock (${pidLock}) is held by process ${owner}; wait for it to finish, then run the upgrade again`);
    }
  }
  const oldLock = join(root, '.lock');
  if (existsSync(oldLock)) {
    if (fileLockHeld(oldLock)) {
      throw new Refused(`${oldLock} is locked by a running factory command (the old CLI); wait for it to finish, then run the upgrade again`);
    }
    found.push(`runtime dir: .lock, the lock file of the Python CLI`);
    plan.changes.push('remove .lock (the Python CLI\'s lock file; the current CLI locks with .lock.pid)');
    plan.originals.push('.lock');
    plan.apply.push(() => unlinkSync(oldLock));
  }

  const current = readFileSync(join(PLUGIN_ROOT, 'dashboard', 'index.html'));
  const dashboard = join(root, 'index.html');
  if (!existsSync(dashboard)) {
    plan.changes.push('install the dashboard (index.html)');
    plan.apply.push(() => writeFileSync(dashboard, current));
  } else {
    const have = readFileSync(dashboard);
    if (!have.equals(current)) {
      const sha = createHash('sha256').update(have).digest('hex');
      found.push(`runtime dir: dashboard (index.html) from ${OLD_DASHBOARDS[sha] ?? 'another version'}`);
      plan.changes.push('replace index.html with the current dashboard');
      plan.originals.push('index.html');
      plan.apply.push(() => writeFileSync(dashboard, current));
    }
  }

  const ignore = join(root, '.gitignore');
  if (!existsSync(ignore)) {
    plan.changes.push('create .gitignore (factory/ is runtime state, not source)');
    plan.apply.push(() => writeFileSync(ignore, '# Factory runtime state: job records, worktrees, dashboard copy.\n*\n'));
  }

  const jobsDir = join(root, 'jobs');
  if (!existsSync(jobsDir)) {
    plan.changes.push('create jobs/');
    plan.apply.push(() => mkdirSync(jobsDir, { recursive: true }));
    return plan;
  }
  const old: string[] = [];
  const missingAll = new Set<string>();
  for (const id of readdirSync(jobsDir).sort()) {
    const path = join(jobsDir, id, 'job.json');
    if (!existsSync(path)) continue;
    let job: unknown;
    try {
      job = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Refused(`${path} is not valid JSON (${(error as Error).message}); fix it by hand, then run the upgrade again`);
    }
    if (!isObj(job)) throw new Refused(`${path} is not a JSON object; fix it by hand, then run the upgrade again`);
    const lacking = REQUIRED_FIELDS.filter((k) => !Object.hasOwn(job, k));
    if (lacking.length > 0) {
      throw new Refused(`${path} has no ${lacking.join(', ')}; the upgrade cannot invent them - fix it by hand`);
    }
    const missing = JOB_FIELDS.filter((k) => !Object.hasOwn(job, k));
    if (missing.length === 0) continue;
    old.push(id);
    for (const k of missing) missingAll.add(k);
    const next = withFields(job, missing);
    const shown = missing.map((k) => `${k} (${JSON.stringify(next[k])})`).join(', ');
    plan.changes.push(`jobs/${id}/job.json: add ${shown}`);
    plan.originals.push(join('jobs', id, 'job.json'));
    plan.apply.push(() => writeAtomic(path, `${dumps(next)}\n`));
  }
  if (old.length > 0) {
    found.push(`runtime dir: ${old.length} job(s) written by an older CLI (missing ${[...missingAll].join(', ')})`);
  }
  return plan;
}

// ---------------------------------------------------------------- manual steps

interface Installed {
  key: string;
  scope: string;
  projectPath?: string;
  version?: string;
}

function installedPlugins(): Installed[] {
  const path = join(claudeConfigDir(), 'plugins', 'installed_plugins.json');
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObj(data) || !isObj(data.plugins)) return [];
    return Object.entries(data.plugins).flatMap(([key, entries]) =>
      (Array.isArray(entries) ? entries : []).filter(isObj).map((e) => ({
        key,
        scope: String(e.scope ?? ''),
        projectPath: typeof e.projectPath === 'string' ? e.projectPath : undefined,
        version: typeof e.version === 'string' ? e.version : undefined,
      })),
    );
  } catch {
    return [];
  }
}

function knownMarketplaces(): string[] {
  try {
    const data = JSON.parse(readFileSync(join(claudeConfigDir(), 'plugins', 'known_marketplaces.json'), 'utf8')) as unknown;
    return isObj(data) ? Object.keys(data) : [];
  } catch {
    return [];
  }
}

/** Tracked files with a line that still names the old plugin or CLI. */
function oldMentions(repo: string, limit = 50): string[] {
  const p = spawnSync('git', ['grep', '-n', '-z', '-I', '-E', '-e', `${OLD_MARKETPLACE}|${OLD_CLI}`], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (p.status !== 0) return [];
  const hits: string[] = [];
  for (const record of p.stdout.split('\n')) {
    const [file, line, ...rest] = record.split('\0');
    const text = rest.join('\0');
    // Settings files are the settings section's job, not a manual edit.
    if (!file || !line || /^\.claude\/settings(\.local)?\.json$/.test(file)) continue;
    if (!text.includes(OLD_CLI) && !(text.includes(OLD_MARKETPLACE) && /factory/.test(text.replaceAll(OLD_MARKETPLACE, '')))) continue;
    const trimmed = text.trim();
    hits.push(`${file}:${line}: ${trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed}`);
  }
  if (hits.length > limit) return [...hits.slice(0, limit), `... and ${hits.length - limit} more (git grep -n -E '${OLD_MARKETPLACE}|${OLD_CLI}')`];
  return hits;
}

function manualSteps(
  repo: string,
  root: string,
  settings: SettingsPlan[],
  opts: UpgradeOptions,
  found: string[],
): string[] {
  const steps: string[] = [];
  for (const problem of configProblems(root)) {
    steps.push(`${problem} - the current CLI refuses this factory.json, so every factory command fails until you fix it`);
  }
  for (const hit of oldMentions(repo)) {
    steps.push(`${hit}\n    names the old plugin or CLI: point it at ${NEW_PLUGIN} and the npx CLI, or leave it if it only records history`);
  }

  const repoFlag = opts.repo ? ` --repo ${shellQuote(repo)}` : '';
  for (const plan of settings) {
    if (plan.selected || plan.changes.length === 0) continue;
    steps.push(
      `${plan.scope} settings (${plan.path}) still enable the old plugin; to switch them run \`factory upgrade --apply --scope ${plan.scope}${repoFlag}\`, which will: ${plan.changes.join('; ')}`,
    );
  }

  const installed = installedPlugins();
  const inScope = (i: Installed, scope: Scope): boolean =>
    i.scope === scope && (scope === 'user' || i.projectPath === undefined || resolvePath(i.projectPath) === repo);
  for (const i of installed) {
    if (i.key === NEW_PLUGIN || isOldPlugin(i.key)) {
      if (SCOPES.some((s) => inScope(i, s))) found.push(`installed: ${i.key}${i.version ? ` ${i.version}` : ''} (${i.scope} scope)`);
    }
  }
  const claude: string[] = [];
  for (const plan of settings) {
    const s = plan.scope;
    // After this upgrade (or the rerun it asks for), does this scope enable the plugin?
    const enabled = isObj(plan.data?.enabledPlugins) ? (plan.data.enabledPlugins as Obj) : {};
    const usesFactory = Object.keys(enabled).some((k) => k === NEW_PLUGIN || isOldPlugin(k));
    const oldInstalled = installed.filter((i) => isOldPlugin(i.key) && inScope(i, s));
    const newInstalled = installed.some((i) => i.key === NEW_PLUGIN && (inScope(i, s) || inScope(i, 'user')));
    if ((usesFactory || oldInstalled.length > 0) && !newInstalled) {
      claude.push(`claude plugin install ${NEW_PLUGIN} --scope ${s}`);
    }
    for (const i of oldInstalled) claude.push(`claude plugin uninstall ${i.key} --scope ${s}`);
  }
  if (claude.some((c) => c.includes(' install '))) {
    const declared = settings.some((p) => {
      const m = p.data?.extraKnownMarketplaces;
      return (isObj(m) && Object.hasOwn(m, NEW_MARKETPLACE)) || p.changes.some((c) => c.startsWith('extraKnownMarketplaces'));
    });
    if (!declared && !knownMarketplaces().includes(NEW_MARKETPLACE)) {
      claude.unshift(`claude plugin marketplace add ${NEW_REPO}`);
    }
  }
  for (const c of claude) steps.push(`run in a terminal: ${c}`);
  if (claude.length > 0 || settings.some((p) => p.selected && p.changes.length > 0)) {
    steps.push('then run /reload-plugins in Claude Code (or restart it) so the new plugin is loaded');
  }
  return steps;
}

// ---------------------------------------------------------------- the command

/** A path quoted for a POSIX shell: single quotes, so nothing in it is expanded. */
function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

function backupDir(parent: string, name: string): string {
  const stamp = now().replace(/[-:]/g, '');
  let dir = join(parent, `${name}-${stamp}`);
  for (let n = 2; existsSync(dir); n++) dir = join(parent, `${name}-${stamp}-${n}`);
  return dir;
}

/** The repo's git dir (shared by its worktrees): private to the checkout and never committed. */
function gitDir(repo: string): string {
  const p = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' });
  if (p.error || p.status !== 0) throw new Refused(`cannot find the git dir of ${repo}: ${(p.stderr || '').trim()}`);
  return resolvePath(repo, p.stdout.trim());
}

export function upgrade(opts: UpgradeOptions): Report {
  const repo = checkout(resolvePath(opts.repo ?? process.cwd()));
  const root = factoryDir(repo);
  const selected: Scope[] = opts.scopes ?? ['project', 'local'];
  const found: string[] = [];

  const settings = SCOPES.map((s) => planSettings(s, repo, selected.includes(s), found));
  const runtime = planRuntime(root, found);
  const manual = manualSteps(repo, root, settings, opts, found);
  const toWrite = settings.filter((p) => p.selected && p.text !== null);
  const changes = toWrite.reduce((n, p) => n + p.changes.length, 0) + runtime.changes.length;

  let backup: string | null = null;
  let settingsBackup: string | null = null;
  if (opts.apply && changes > 0) {
    // Originals first: nothing is changed until every one of them is copied.
    const settingsToBackUp = toWrite.filter((p) => existsSync(p.path));
    if (settingsToBackUp.length > 0) {
      // Not under factory/, which `factory dashboard` serves: settings can hold secrets (env,
      // apiKeyHelper). The dir is 0700 and each copy keeps its original's mode.
      const dir = backupDir(gitDir(repo), 'factory-upgrade-backup');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      for (const p of settingsToBackUp) {
        const copy = join(dir, p.scope, basename(p.path));
        mkdirSync(dirname(copy), { mode: 0o700 });
        copyFileSync(p.path, copy);
        chmodSync(copy, statSync(p.path).mode & 0o7777);
      }
      settingsBackup = dir;
    }
    if (existsSync(root)) {
      if (runtime.originals.length > 0) {
        const dir = backupDir(root, 'upgrade-backup');
        for (const rel of runtime.originals) {
          mkdirSync(dirname(join(dir, rel)), { recursive: true });
          copyFileSync(join(root, rel), join(dir, rel));
        }
        backup = dir;
      }
      if (runtime.apply.length > 0) {
        locked(root, () => {
          for (const step of runtime.apply) step();
        });
      }
    }
    for (const p of toWrite) writeAtomic(p.path, p.text as string);
  }

  return {
    repo,
    factory_dir: root,
    mode: opts.apply ? 'apply' : 'dry-run',
    found,
    settings: settings.map((p) => ({ scope: p.scope, file: p.path, selected: p.selected, changes: p.changes })),
    runtime: { dir: root, changes: runtime.changes },
    manual,
    backup,
    settings_backup: settingsBackup,
    changes,
    nothing_to_do: changes === 0,
  };
}

export function formatReport(r: Report): string {
  const lines: string[] = [];
  const dry = r.mode === 'dry-run';
  lines.push(dry ? `factory upgrade: dry run for ${r.repo} - nothing was written` : `factory upgrade: ${r.repo}`);
  lines.push('', 'found:');
  for (const f of r.found) lines.push(`  - ${f}`);
  if (r.found.length === 0) lines.push('  (no older factory plugin or runtime dir)');

  lines.push('', dry ? 'settings (would change):' : 'settings:');
  let any = false;
  for (const s of r.settings) {
    if (!s.selected || s.changes.length === 0) continue;
    any = true;
    lines.push(`  ${s.scope} (${s.file}):`);
    for (const c of s.changes) lines.push(`    - ${c}`);
  }
  if (!any) lines.push('  (no changes)');

  lines.push('', `${dry ? 'runtime dir (would change)' : 'runtime dir'} (${r.runtime.dir}):`);
  for (const c of r.runtime.changes) lines.push(`  - ${c}`);
  if (r.runtime.changes.length === 0) lines.push(existsSync(r.runtime.dir) ? '  (no changes)' : '  (none: no factory dir)');

  lines.push('', 'manual steps (this command does not do these):');
  for (const m of r.manual) lines.push(`  - ${m}`);
  if (r.manual.length === 0) lines.push('  (none)');
  lines.push('');

  if (r.backup) lines.push(`backup of the originals: ${r.backup}`);
  if (r.settings_backup) lines.push(`backup of the settings files: ${r.settings_backup}`);
  if (r.nothing_to_do) {
    lines.push(`nothing to do: the settings and runtime dir are current${r.manual.length > 0 ? ` (${r.manual.length} manual step(s) listed above)` : ''}`);
  } else if (dry) {
    lines.push(`${r.changes} change(s) to make; run again with --apply to make them`);
  } else {
    lines.push(`${r.changes} change(s) made`);
  }
  return `${lines.join('\n')}\n`;
}

export function cmdUpgrade(args: Record<string, unknown>, io: Io): void {
  const report = upgrade({
    repo: (args.repo as string | null) ?? null,
    apply: args.apply === true,
    scopes: (args.scope as Scope[] | null) ?? null,
  });
  io.stdout(args.json === true ? `${dumps(report)}\n` : formatReport(report));
}
