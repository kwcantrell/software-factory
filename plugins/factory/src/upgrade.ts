// `factory migrate-repo`: the plumbing behind `factory-doctor migrate`, which plans a move between
// software-factory versions and runs this command for the part that rewrites the factory runtime dir
// (plugins/factory/src is the only writer of job.json). It prints one JSON report; only --apply
// writes. `factory upgrade` itself moved to `factory-doctor migrate` and only says so.
//
// Moving up (--to at or after --from), as `factory upgrade` did:
//   - settings: Claude Code settings that enable the old plugin (factory@kwcantrell-plugins, or
//     factory@<any marketplace but software-factory>) are switched to factory@software-factory;
//   - runtime dir: factory/ written by the Python CLI gets the job fields, dashboard and .gitignore
//     the current CLI writes, after the originals are copied to factory/upgrade-backup-<time>/;
//     settings files are backed up outside factory/ (which the dashboard serves), in a private
//     factory-upgrade-backup-<time>/ under the repo's git dir, since they can hold secrets;
//   - manual steps: what it must not do itself (factory.json keys the CLI refuses, tracked files that
//     still name the old CLI, `claude plugin` commands), listed with what to do.
// Moving down (--to before --from), while this newer CLI that reads both formats is installed:
//   - refused, changing nothing, when going back would lose meaning: a target before 0.3.0 (the
//     retired Python CLI), a remote factory (its state branch and signed history), or an unfinished
//     job whose recorded commit (`head`) protects its merge;
//   - otherwise the factory.json keys and job.json fields the target does not know are removed
//     (factory.json backed up in the private git-dir backup, job.json under factory/upgrade-backup-).
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

/** The job.json fields every CLI from 0.2.0 to 0.4.0 writes, in its order. */
const BASE_JOB_FIELDS = [
  'id', 'title', 'stage', 'status', 'needs_human', 'activity', 'spec', 'spec_sha', 'branch', 'base', 'base_branch',
  'worktree', 'proof_attempts', 'rounds', 'followups', 'created', 'history', 'updated',
];
const BASE_CONFIG_KEYS = ['reviewers', 'max_review_rounds', 'max_proof_attempts', 'spec_gate'];

/**
 * The versions this plumbing moves a repo between, oldest first: the factory.json keys each one
 * accepts and the job.json fields it knows. `factory-doctor migrate` holds the full registry (what
 * each version changes and how to move across it); its tests check this table against it through
 * `factory migrate-repo --versions`. `unreleased` is the [Unreleased] changes of CHANGELOG.md; a
 * release renames it to the new version, here and in factory-doctor's registry.
 */
export const VERSIONS: readonly { id: string; config_keys: string[]; job_fields: string[] }[] = [
  { id: 'kwcantrell', config_keys: BASE_CONFIG_KEYS, job_fields: BASE_JOB_FIELDS.filter((f) => f !== 'followups') },
  { id: '0.2.0', config_keys: [...BASE_CONFIG_KEYS, 'specs_dir'], job_fields: BASE_JOB_FIELDS },
  { id: '0.3.0', config_keys: [...BASE_CONFIG_KEYS, 'specs_dir'], job_fields: BASE_JOB_FIELDS },
  { id: '0.3.1', config_keys: [...BASE_CONFIG_KEYS, 'specs_dir'], job_fields: BASE_JOB_FIELDS },
  { id: '0.4.0', config_keys: [...BASE_CONFIG_KEYS, 'specs_dir'], job_fields: BASE_JOB_FIELDS },
  {
    id: 'unreleased',
    config_keys: [...BASE_CONFIG_KEYS, 'specs_dir', 'remote', 'advisor'],
    // `owner`: a remote factory's claim (021). `head`: the commit proof and review passed (028).
    job_fields: [...BASE_JOB_FIELDS.slice(0, 15), 'owner', 'created', 'history', 'updated', 'head'],
  },
];
/** The oldest version migrate-repo moves a repo to: the first TypeScript CLI. */
const OLDEST_TARGET = '0.3.0';

const versionIndex = (id: string): number => VERSIONS.findIndex((v) => v.id === id);

/** The `--repo`/cwd is not a git checkout, or a path argument is wrong: exit 2. */
export class UsageProblem extends Error {}

export interface UpgradeOptions {
  repo: string | null;
  apply: boolean;
  /** The settings scopes to change; null means the default, project and local. */
  scopes: Scope[] | null;
  /** The version the repo is at and the one to move it to (ids of VERSIONS). */
  from: string;
  to: string;
}

export interface Report {
  repo: string;
  factory_dir: string;
  from: string;
  to: string;
  direction: 'upgrade' | 'downgrade';
  mode: 'dry-run' | 'apply';
  found: string[];
  settings: { scope: Scope; file: string; selected: boolean; changes: string[] }[];
  /** factory.json changes (a downgrade removes keys the target refuses). */
  config: { file: string; changes: string[] };
  /** Each change with the file it touches, relative to the runtime dir. */
  runtime: { dir: string; changes: { file: string; change: string }[] };
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
  changes: { file: string; change: string }[];
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

/** Refused while a live factory command holds the current CLI's lock. */
function checkPidLock(root: string): void {
  const pidLock = join(root, LOCK_FILE);
  if (!existsSync(pidLock)) return;
  const owner = Number.parseInt(readFileSync(pidLock, 'utf8'), 10);
  if (Number.isInteger(owner) && owner > 0 && alive(owner)) {
    throw new Refused(`the factory lock (${pidLock}) is held by process ${owner}; wait for it to finish, then run the migration again`);
  }
}

function planRuntime(root: string, found: string[]): RuntimePlan {
  const plan: RuntimePlan = { dir: root, changes: [], originals: [], apply: [] };
  if (!existsSync(root)) return plan;

  checkPidLock(root);
  const oldLock = join(root, '.lock');
  if (existsSync(oldLock)) {
    if (fileLockHeld(oldLock)) {
      throw new Refused(`${oldLock} is locked by a running factory command (the old CLI); wait for it to finish, then run the migration again`);
    }
    found.push(`runtime dir: .lock, the lock file of the Python CLI`);
    plan.changes.push({ file: '.lock', change: 'remove .lock (the Python CLI\'s lock file; the current CLI locks with .lock.pid)' });
    plan.originals.push('.lock');
    plan.apply.push(() => unlinkSync(oldLock));
  }

  const current = readFileSync(join(PLUGIN_ROOT, 'dashboard', 'index.html'));
  const dashboard = join(root, 'index.html');
  if (!existsSync(dashboard)) {
    plan.changes.push({ file: 'index.html', change: 'install the dashboard (index.html)' });
    plan.apply.push(() => writeFileSync(dashboard, current));
  } else {
    const have = readFileSync(dashboard);
    if (!have.equals(current)) {
      const sha = createHash('sha256').update(have).digest('hex');
      found.push(`runtime dir: dashboard (index.html) from ${OLD_DASHBOARDS[sha] ?? 'another version'}`);
      plan.changes.push({ file: 'index.html', change: 'replace index.html with the current dashboard' });
      plan.originals.push('index.html');
      plan.apply.push(() => writeFileSync(dashboard, current));
    }
  }

  const ignore = join(root, '.gitignore');
  if (!existsSync(ignore)) {
    plan.changes.push({ file: '.gitignore', change: 'create .gitignore (factory/ is runtime state, not source)' });
    plan.apply.push(() => writeFileSync(ignore, '# Factory runtime state: job records, worktrees, dashboard copy.\n*\n'));
  }

  const jobsDir = join(root, 'jobs');
  if (!existsSync(jobsDir)) {
    plan.changes.push({ file: 'jobs', change: 'create jobs/' });
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
      throw new Refused(`${path} is not valid JSON (${(error as Error).message}); fix it by hand, then run the migration again`);
    }
    if (!isObj(job)) throw new Refused(`${path} is not a JSON object; fix it by hand, then run the migration again`);
    const lacking = REQUIRED_FIELDS.filter((k) => !Object.hasOwn(job, k));
    if (lacking.length > 0) {
      throw new Refused(`${path} has no ${lacking.join(', ')}; the migration cannot invent them - fix it by hand`);
    }
    const missing = JOB_FIELDS.filter((k) => !Object.hasOwn(job, k));
    if (missing.length === 0) continue;
    old.push(id);
    for (const k of missing) missingAll.add(k);
    const next = withFields(job, missing);
    const shown = missing.map((k) => `${k} (${JSON.stringify(next[k])})`).join(', ');
    plan.changes.push({ file: `jobs/${id}/job.json`, change: `jobs/${id}/job.json: add ${shown}` });
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
      `${plan.scope} settings (${plan.path}) still enable the old plugin; to switch them run \`factory-doctor migrate --apply --scope ${plan.scope}${repoFlag}\`, which will: ${plan.changes.join('; ')}`,
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
    // After this migration (or the rerun it asks for), does this scope enable the plugin?
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

/** The repo's factory.json path: next to the factory dir. */
const configFile = (root: string): string => join(dirname(root), 'factory.json');

function readConfigFile(path: string): Obj | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Refused(`${path} is not valid JSON (${(error as Error).message}); fix it by hand, then run the migration again`);
  }
  if (!isObj(data)) throw new Refused(`${path} is not a JSON object; fix it by hand, then run the migration again`);
  return data;
}

interface DowngradePlan {
  config: { file: string; changes: string[]; text: string | null };
  runtime: RuntimePlan;
}

/**
 * Moving to an older version: refuse what cannot go back without losing meaning (every reason at
 * once), else plan removing the factory.json keys and job.json fields the target does not know.
 */
function planDowngrade(root: string, to: string, found: string[]): DowngradePlan {
  const target = VERSIONS[versionIndex(to)] as (typeof VERSIONS)[number];
  const known = new Set(VERSIONS.flatMap((v) => v.job_fields));
  const knownKeys = new Set(VERSIONS.flatMap((v) => v.config_keys));
  const refusals: string[] = [];
  const path = configFile(root);
  const config = readConfigFile(path);
  const plan: DowngradePlan = { config: { file: path, changes: [], text: null }, runtime: { dir: root, changes: [], originals: [], apply: [] } };

  // `"remote": null` is the documented local default (no remote factory): it is dropped like any
  // other key the target does not know, not refused.
  const remote = config !== null && isObj(config.remote) && !target.config_keys.includes('remote');
  const stateCheckout = existsSync(join(root, 'jobs', '.git'));
  if (remote || stateCheckout) {
    refusals.push(
      `${remote ? `${path} sets 'remote'` : `${join(root, 'jobs')} is a checkout of a remote factory's state branch`}: ${to} has no remote factory. ` +
        'The job state lives on the state branch, whose signed history (remote.allowed_signers) is what merge checks, and the claims on it would be lost. ' +
        `Stay on this version, or stop using the remote factory first (remove 'remote' from factory.json yourself, knowing merges are then no longer checked against signed state)`,
    );
  }
  if (config !== null) {
    const drop = Object.keys(config).filter((k) => !(k === 'remote' && remote) && knownKeys.has(k) && !target.config_keys.includes(k));
    if (drop.length > 0) {
      found.push(`factory.json: ${drop.join(', ')} (unknown to ${to})`);
      const out: Obj = {};
      for (const [k, v] of Object.entries(config)) if (!drop.includes(k)) out[k] = v;
      for (const k of drop) plan.config.changes.push(`factory.json: remove "${k}": ${JSON.stringify(config[k])} (${to} refuses the key)`);
      plan.config.text = `${JSON.stringify(out, null, indentOf(readFileSync(path, 'utf8')))}\n`;
    }
  }

  const jobsDir = join(root, 'jobs');
  if (existsSync(root)) checkPidLock(root);
  if (existsSync(jobsDir) && !stateCheckout) {
    for (const id of readdirSync(jobsDir).sort()) {
      const jobPath = join(jobsDir, id, 'job.json');
      if (!existsSync(jobPath)) continue;
      let job: unknown;
      try {
        job = JSON.parse(readFileSync(jobPath, 'utf8'));
      } catch (error) {
        throw new Refused(`${jobPath} is not valid JSON (${(error as Error).message}); fix it by hand, then run the migration again`);
      }
      if (!isObj(job)) throw new Refused(`${jobPath} is not a JSON object; fix it by hand, then run the migration again`);
      const finished = job.stage === 'done' || job.status === 'merged' || job.status === 'closed';
      if (Object.hasOwn(job, 'head') && !target.job_fields.includes('head') && !finished) {
        refusals.push(
          `jobs/${id}/job.json records the commit proof and review passed ('head'), which merge checks; ${to} would merge whatever the branch holds. ` +
            'Finish the job first (merge it, or close it), or stay on this version',
        );
        continue;
      }
      const drop = Object.keys(job).filter((k) => known.has(k) && !target.job_fields.includes(k));
      if (drop.length === 0) continue;
      const next: Obj = {};
      for (const [k, v] of Object.entries(job)) if (!drop.includes(k)) next[k] = v;
      const rel = join('jobs', id, 'job.json');
      plan.runtime.changes.push({ file: rel, change: `${rel}: remove ${drop.join(', ')} (${to} does not know ${drop.length === 1 ? 'it' : 'them'})` });
      plan.runtime.originals.push(rel);
      plan.runtime.apply.push(() => writeAtomic(jobPath, `${dumps(next)}\n`));
    }
  }
  if (refusals.length > 0) throw new Refused(`cannot move this repo back to ${to}:\n  - ${refusals.join('\n  - ')}`);
  return plan;
}

export function migrateRepo(opts: UpgradeOptions): Report {
  const fromAt = versionIndex(opts.from);
  const toAt = versionIndex(opts.to);
  const ids = VERSIONS.map((v) => v.id).join(', ');
  if (fromAt < 0) throw new UsageProblem(`--from: unknown version '${opts.from}' (known: ${ids})`);
  if (toAt < 0) throw new UsageProblem(`--to: unknown version '${opts.to}' (known: ${ids})`);
  const repo = checkout(resolvePath(opts.repo ?? process.cwd()));
  if (toAt < versionIndex(OLDEST_TARGET)) {
    throw new Refused(`cannot move this repo to ${opts.to}: it ran the Python CLI, which is retired; ${OLDEST_TARGET} is the oldest version migrate moves a repo to`);
  }
  const root = factoryDir(repo);
  const direction = toAt < fromAt ? 'downgrade' : 'upgrade';
  const selected: Scope[] = opts.scopes ?? ['project', 'local'];
  const found: string[] = [];

  let settings: SettingsPlan[] = [];
  let runtime: RuntimePlan;
  let manual: string[] = [];
  let config: DowngradePlan['config'] = { file: configFile(root), changes: [], text: null };
  if (direction === 'upgrade') {
    settings = SCOPES.map((s) => planSettings(s, repo, selected.includes(s), found));
    runtime = planRuntime(root, found);
    manual = manualSteps(repo, root, settings, opts, found);
  } else {
    const down = planDowngrade(root, opts.to, found);
    runtime = down.runtime;
    config = down.config;
  }
  const toWrite = settings.filter((p) => p.selected && p.text !== null);
  const changes = toWrite.reduce((n, p) => n + p.changes.length, 0) + runtime.changes.length + config.changes.length;

  let backup: string | null = null;
  let settingsBackup: string | null = null;
  if (opts.apply && changes > 0) {
    // Originals first: nothing is changed until every one of them is copied.
    const settingsToBackUp = toWrite.filter((p) => existsSync(p.path));
    if (settingsToBackUp.length > 0 || config.text !== null) {
      // Not under factory/, which `factory dashboard` serves: settings can hold secrets (env,
      // apiKeyHelper). The dir is 0700 and each copy keeps its original's mode.
      const dir = backupDir(gitDir(repo), 'factory-upgrade-backup');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const copies: [string, string][] = settingsToBackUp.map((p) => [p.path, join(p.scope, basename(p.path))]);
      if (config.text !== null) copies.push([config.file, join('config', 'factory.json')]);
      for (const [from, rel] of copies) {
        const copy = join(dir, rel);
        mkdirSync(dirname(copy), { mode: 0o700 });
        copyFileSync(from, copy);
        chmodSync(copy, statSync(from).mode & 0o7777);
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
    if (config.text !== null) writeAtomic(config.file, config.text);
    for (const p of toWrite) writeAtomic(p.path, p.text as string);
  }

  return {
    repo,
    factory_dir: root,
    from: opts.from,
    to: opts.to,
    direction,
    mode: opts.apply ? 'apply' : 'dry-run',
    found,
    settings: settings.map((p) => ({ scope: p.scope, file: p.path, selected: p.selected, changes: p.changes })),
    config: { file: config.file, changes: config.changes },
    runtime: { dir: root, changes: runtime.changes },
    manual,
    backup,
    settings_backup: settingsBackup,
    changes,
    nothing_to_do: changes === 0,
  };
}

/** `factory migrate-repo`: one JSON value, the report (or, with --versions, the version table). */
export function cmdMigrateRepo(args: Record<string, unknown>, io: Io): void {
  if (args.versions === true) {
    io.stdout(`${dumps(VERSIONS)}\n`);
    return;
  }
  if (typeof args.from !== 'string' || typeof args.to !== 'string') throw new UsageProblem('the following arguments are required: --from, --to');
  const report = migrateRepo({
    repo: (args.repo as string | null) ?? null,
    apply: args.apply === true,
    scopes: (args.scope as Scope[] | null) ?? null,
    from: args.from,
    to: args.to,
  });
  io.stdout(`${dumps(report)}\n`);
}

/** What `factory upgrade` (and /factory:upgrade) says now: the command moved to factory-doctor. */
export const UPGRADE_MOVED =
  'factory upgrade moved to factory-doctor migrate, which moves a repo between software-factory versions (up or down) and can update the plugins too.\n' +
  'Run its dry run from the repository: npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor migrate\n' +
  '(with CLAUDE_PLUGIN_ROOT the factory-doctor plugin\'s folder; in Claude Code, ask to migrate the repo and the factory-doctor skill runs it).\n' +
  'Without factory-doctor installed: claude plugin install factory-doctor@software-factory\n';
