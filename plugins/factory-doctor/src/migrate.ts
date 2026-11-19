// `migrate`: move a repo between software-factory versions, up or down. It detects where the repo
// and the installed plugins are, plans the move from the registry (src/registry.ts) in order, prints
// it as a dry run, applies the repo steps with --apply, and updates the plugins with
// --update-plugins --confirmed.
//
// Everything that rewrites the factory runtime dir, factory.json or Claude Code settings runs in the
// factory CLI (`factory migrate-repo`, plumbing): plugins/factory/src is the only writer of job.json,
// and plugins never import each other. migrate finds the installed factory plugin in Claude Code's
// install records and runs it through npx with that plugin's root. Upgrades update the plugins first,
// then migrate the repo; downgrades migrate the repo first, while the newer tools that read both
// formats are still installed, then switch the plugins.
//
// It never installs or removes a plugin, runs `claude` only with --update-plugins --confirmed, and
// never edits job.json itself.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { claudeDir, type Env } from './claude.ts';
import { DEFAULT_FILE } from './requirements.ts';
import { addedIn, type Change, entry, type Handling, indexOf, LATEST, REGISTRY, type VersionEntry } from './registry.ts';

export const MARKETPLACE = 'software-factory';
const OLD_PLUGIN = 'factory@kwcantrell-plugins';
const REPO_URL = 'https://github.com/kwcantrell/software-factory';
export const SCOPES = ['project', 'local', 'user'] as const;
export type Scope = (typeof SCOPES)[number];
const INVOCATION = 'factory-doctor migrate';

/** A path or argument problem: exit 2. */
export class MigrateUsage extends Error {}
/** The move is refused, or a step failed: exit 1. */
export class MigrateRefused extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- where things are

export interface Install {
  id: string;
  name: string;
  marketplace: string;
  scope: string;
  version: string | null;
  sha: string | null;
  installPath: string | null;
  /** The registry version this install is at, or null when its version is not in the registry. */
  at: string | null;
}

function within(dir: string, ancestor: string): boolean {
  const a = resolve(ancestor);
  const d = resolve(dir);
  return d === a || d.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** The registry version of an install: by its commit when it is a release's, else by its version. */
export function installedAt(version: string | null, sha: string | null, marketplace: string): string | null {
  if (marketplace !== MARKETPLACE) return marketplace === 'kwcantrell-plugins' ? 'kwcantrell' : null;
  const byCommit = REGISTRY.find((v) => v.commit !== undefined && sha !== null && v.commit === sha);
  if (byCommit) return byCommit.id;
  const same = REGISTRY.filter((v) => v.plugin_version !== null && v.plugin_version === version);
  if (same.length === 0) return null;
  // A commit that is no release's: installed from the marketplace's branch after that release.
  return (sha === null ? same[0] : same[same.length - 1])?.id ?? null;
}

/** Claude Code's install records that apply in `repo`: user scope, or project/local scope for it. */
export function readInstalls(env: Env, repo: string): Install[] {
  const records = readJson(join(claudeDir(env), 'plugins', 'installed_plugins.json'));
  const plugins = isObj(records) && isObj(records.plugins) ? records.plugins : {};
  const out: Install[] = [];
  for (const [id, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : '';
    for (const i of installs) {
      if (!isObj(i)) continue;
      const scope = typeof i.scope === 'string' ? i.scope : '';
      const projectPath = typeof i.projectPath === 'string' ? i.projectPath : undefined;
      if ((scope === 'project' || scope === 'local') && (projectPath === undefined || !within(repo, projectPath))) continue;
      const version = typeof i.version === 'string' ? i.version : null;
      const sha = typeof i.gitCommitSha === 'string' ? i.gitCommitSha : null;
      out.push({
        id,
        name,
        marketplace,
        scope,
        version,
        sha,
        installPath: typeof i.installPath === 'string' ? i.installPath : null,
        at: installedAt(version, sha, marketplace),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
}

function git(args: string[], cwd: string, env: Env): { status: number; stdout: string } {
  const p = spawnSync('git', args, { cwd, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { status: p.error ? 127 : (p.status ?? 1), stdout: p.stdout ?? '' };
}

/** The main checkout holding `start` (as the factory CLI finds it). */
export function mainCheckout(start: string, env: Env): string {
  if (!existsSync(start) || !statSync(start).isDirectory()) throw new MigrateUsage(`${start} is not a directory`);
  const p = git(['worktree', 'list', '--porcelain'], start, env);
  if (p.status !== 0 || !p.stdout.startsWith('worktree ')) throw new MigrateUsage(`${start} is not inside a git checkout`);
  return (p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length);
}

// ---------------------------------------------------------------- what the repo has

interface Job {
  id: string;
  data: Obj;
}

interface RepoState {
  repo: string;
  factoryDir: string;
  config: Obj | null;
  jobs: Job[];
  stateCheckout: boolean;
  /** Project agents: file (relative to repo), station kind, text. */
  agents: { file: string; kind: 'builder' | 'verifier' | 'reviewer'; text: string }[];
  doctorFormat: number | null;
  settings: { scope: Scope; file: string; enabled: Obj }[];
}

function settingsFile(scope: Scope, repo: string, env: Env): string {
  if (scope === 'project') return join(repo, '.claude', 'settings.json');
  if (scope === 'local') return join(repo, '.claude', 'settings.local.json');
  return join(claudeDir(env), 'settings.json');
}

function readRepo(repo: string, env: Env): RepoState {
  const factoryDir = env.FACTORY_DIR ? resolve(env.FACTORY_DIR) : join(repo, 'factory');
  const cfg = readJson(join(repo, 'factory.json'));
  const jobs: Job[] = [];
  const jobsDir = join(factoryDir, 'jobs');
  if (existsSync(jobsDir)) {
    for (const id of readdirSync(jobsDir).sort()) {
      const data = readJson(join(jobsDir, id, 'job.json'));
      if (isObj(data)) jobs.push({ id, data });
    }
  }
  const agents: RepoState['agents'] = [];
  const agentsDir = join(repo, '.claude', 'agents');
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).sort()) {
      const m = /^factory-(builder|verifier|reviewer-[a-z0-9][a-z0-9-]*)\.md$/.exec(name);
      if (m?.[1] === undefined) continue;
      const kind = m[1].startsWith('reviewer-') ? 'reviewer' : (m[1] as 'builder' | 'verifier');
      agents.push({ file: join('.claude', 'agents', name), kind, text: readFileSync(join(agentsDir, name), 'utf8') });
    }
  }
  const doctor = readJson(join(repo, DEFAULT_FILE));
  const settings: RepoState['settings'] = [];
  for (const scope of SCOPES) {
    const file = settingsFile(scope, repo, env);
    const data = readJson(file);
    if (isObj(data) && isObj(data.enabledPlugins)) settings.push({ scope, file, enabled: data.enabledPlugins });
  }
  return {
    repo,
    factoryDir,
    config: isObj(cfg) ? cfg : null,
    jobs,
    stateCheckout: existsSync(join(jobsDir, '.git')),
    agents,
    doctorFormat: isObj(doctor) && typeof doctor.version === 'number' ? doctor.version : null,
    settings,
  };
}

// ---------------------------------------------------------------- detection

interface Signal {
  /** `atleast`: the repo uses something this version added; `atmost`: something it no longer has. */
  bound: 'atleast' | 'atmost';
  version: string;
  text: string;
}

function sha256(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function repoSignals(s: RepoState): Signal[] {
  const out: Signal[] = [];
  const atleast = (version: string | null, text: string): void => {
    if (version !== null) out.push({ bound: 'atleast', version, text });
  };
  for (const st of s.settings) {
    if (Object.hasOwn(st.enabled, OLD_PLUGIN)) out.push({ bound: 'atmost', version: 'kwcantrell', text: `${st.scope} settings enable ${OLD_PLUGIN}` });
  }
  if (existsSync(join(s.factoryDir, '.lock'))) out.push({ bound: 'atmost', version: '0.2.0', text: "factory/.lock: the Python CLI's lock file" });
  const dash = sha256(join(s.factoryDir, 'index.html'));
  const byDash = REGISTRY.find((v) => v.dashboard_sha256 === dash);
  if (byDash) atleast(byDash.id, `factory/index.html: the dashboard ${byDash.label} installs`);
  const lacking = s.jobs.filter((j) => !Object.hasOwn(j.data, 'followups')).length;
  if (lacking > 0) out.push({ bound: 'atmost', version: 'kwcantrell', text: `${lacking} job(s) without followups (the CLI before follow-ups)` });
  // Keys and fields the first version already had say nothing about the version.
  const first = (REGISTRY[0] as VersionEntry).id;
  const newer = (area: 'factory.json' | 'job.json', name: string): string | null => {
    const v = addedIn(area, name);
    return v === first ? null : v;
  };
  for (const key of Object.keys(s.config ?? {})) atleast(newer('factory.json', key), `factory.json key '${key}'`);
  const fields = new Set(s.jobs.flatMap((j) => Object.keys(j.data)));
  for (const f of fields) atleast(newer('job.json', f), `job.json field '${f}'`);
  if (s.stateCheckout) atleast(addedIn('factory.json', 'remote'), "factory/jobs is a remote factory's state checkout");
  for (const a of s.agents) {
    atleast(addedIn('agents', `${a.kind}:handoff`), `${a.file}: a project station agent`);
    for (const m of a.text.matchAll(/<!-- fixed:([a-z-]+) -->/g)) atleast(addedIn('agents', `${a.kind}:${m[1]}`), `${a.file}: fixed section '${m[1]}'`);
  }
  if (s.doctorFormat !== null) atleast(addedIn('doctor-file', String(s.doctorFormat)), `${DEFAULT_FILE} format ${s.doctorFormat}`);
  return out;
}

/**
 * The repo's version. With something only an older version has (a bound from above), the newest
 * thing it uses (else that bound). With nothing old, it is at least the newest thing it uses, and
 * as new as the installed plugins that have been writing it. Null when there is no sign at all.
 */
function repoVersion(signals: Signal[], plugins: string | null): string | null {
  const least = signals.filter((s) => s.bound === 'atleast').map((s) => indexOf(s.version));
  const most = signals.filter((s) => s.bound === 'atmost').map((s) => indexOf(s.version));
  const lo = least.length > 0 ? Math.max(...least) : null;
  if (most.length > 0) return REGISTRY[lo ?? Math.min(...most)]?.id ?? null;
  const at = Math.max(lo ?? -1, plugins === null ? -1 : indexOf(plugins));
  return at < 0 ? null : (REGISTRY[at]?.id ?? null);
}

// ---------------------------------------------------------------- the plan

export interface Step {
  kind: 'plugin' | 'automatic' | 'manual';
  title: string;
  files: string[];
  why: string;
  /** plugin steps: the `claude` argv lists it runs with --update-plugins --confirmed. */
  commands?: string[][];
}

export interface PlumbingReport {
  from: string;
  to: string;
  direction: string;
  found: string[];
  settings: { scope: string; file: string; selected: boolean; changes: string[] }[];
  config: { file: string; changes: string[] };
  runtime: { dir: string; changes: { file: string; change: string }[] };
  manual: string[];
  backup: string | null;
  settings_backup: string | null;
  changes: number;
}

export interface Plan {
  repo: string;
  factory_dir: string;
  target: string;
  latest: string;
  from: { repo: string | null; plugins: string | null; used: string };
  direction: 'upgrade' | 'downgrade' | 'none';
  found: string[];
  refused: string[];
  steps: Step[];
  /** The factory CLI's migrate-repo report, or null (and why) when it could not run. */
  plumbing: PlumbingReport | null;
  plumbing_note: string | null;
}

export interface MigrateOptions {
  cwd: string;
  env: Env;
  repo?: string | undefined;
  to?: string | undefined;
  scopes: Scope[] | null;
}

const label = (id: string): string => `${id} (${entry(id).label})`;

function rangeChanges(from: string, to: string): { version: string; change: Change; handling: Handling }[] {
  const a = indexOf(from);
  const b = indexOf(to);
  if (b > a) return REGISTRY.slice(a + 1, b + 1).flatMap((v) => v.changes.map((c) => ({ version: v.id, change: c, handling: c.up })));
  return REGISTRY.slice(b + 1, a + 1)
    .reverse()
    .flatMap((v) => v.changes.map((c) => ({ version: v.id, change: c, handling: c.down })));
}

function gitConfig(repo: string, env: Env, key: string): string {
  return git(['config', '--get', key], repo, env).stdout.trim();
}

const finished = (j: Job): boolean => j.data.stage === 'done' || j.data.status === 'merged' || j.data.status === 'closed';

function nodeAtLeast(major: number, minor: number): boolean {
  const [a = 0, b = 0] = process.versions.node.split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

/** The files a manual or refused change applies to in this repo ([] = the whole repo), or null when it does not apply. */
function applies(c: Change, h: Handling, s: RepoState, installs: Install[], env: Env): string[] | null {
  const remote = isObj(s.config?.remote) || s.stateCheckout;
  const unsigned = isObj(s.config?.remote) && (s.config.remote as Obj).unsigned_ok === true;
  const cfgFile = join(s.repo, 'factory.json');
  switch (`${c.area}:${c.name}`) {
    case 'factory.json:remote':
      return remote ? [s.stateCheckout ? join(s.factoryDir, 'jobs') : cfgFile] : null;
    case 'job.json:head': {
      const open = s.jobs.filter((j) => Object.hasOwn(j.data, 'head') && !finished(j));
      return open.length > 0 ? open.map((j) => join(s.factoryDir, 'jobs', j.id, 'job.json')) : null;
    }
    case 'requirement:node':
      return nodeAtLeast(22, 18) ? null : [];
    case 'requirement:remote-signing': {
      if (h.kind === 'refused' || !remote || unsigned) return null; // the remote refusal covers going down
      const r = s.config?.remote as Obj | undefined;
      const ready = gitConfig(s.repo, env, 'gpg.format') === 'ssh' && gitConfig(s.repo, env, 'user.signingkey') !== '' && typeof r?.allowed_signers === 'string';
      return ready ? null : [cfgFile];
    }
    case 'requirement:recorded-commit': {
      if (h.kind === 'refused' || !remote || unsigned) return null; // job.json head covers going down
      const ship = s.jobs.filter((j) => j.data.stage === 'ship' && !Object.hasOwn(j.data, 'head'));
      return ship.length > 0 ? ship.map((j) => join(s.factoryDir, 'jobs', j.id, 'job.json')) : null;
    }
    default:
      break;
  }
  if (c.area === 'plugins') {
    const installed = installs.some((i) => i.marketplace === MARKETPLACE && i.name === c.name);
    // Going up, a plugin the version added is a step when it is not installed; going down, when it is.
    return (h === c.up) !== installed ? [] : null;
  }
  if (c.area === 'agents') {
    const [kind, id] = c.name.split(':');
    const mine = s.agents.filter((a) => a.kind === kind);
    if (h.kind === 'manual' && c.op === 'added' && h === c.up) {
      const lacking = mine.filter((a) => !a.text.includes(`<!-- fixed:${id} -->`));
      return lacking.length > 0 ? lacking.map((a) => a.file) : null;
    }
    return mine.length > 0 ? mine.map((a) => a.file) : null;
  }
  // Anything else manual or refused applies to every repo (a move before 0.3.0, say).
  return [];
}

/** The steps the registry asks of the person (manual), and the refusals, for this repo. */
function registrySteps(from: string, to: string, s: RepoState, installs: Install[], env: Env): { manual: Step[]; refused: string[] } {
  const manual: Step[] = [];
  const refused: string[] = [];
  const plugins = new Map<string, { names: string[]; text: string; version: string }>();
  const agents = new Map<string, { ids: string[]; text: string; version: string; why: string }>();
  for (const { version, change, handling } of rangeChanges(from, to)) {
    if (handling.kind === 'automatic') continue;
    const files = applies(change, handling, s, installs, env);
    if (files === null) continue;
    if (handling.kind === 'refused') {
      const reason = `${change.what}: ${handling.text}${files.length > 0 ? ` (${files.map((f) => relative(s.repo, f) || f).join(', ')})` : ''}`;
      if (!refused.includes(reason) && !refused.some((r) => r.endsWith(`: ${handling.text}`))) refused.push(reason);
      continue;
    }
    if (change.area === 'plugins') {
      if (change.pending !== undefined) continue; // not in the marketplace yet
      const g = plugins.get(handling.text.replace(change.name, '<name>')) ?? { names: [], text: handling.text, version };
      g.names.push(change.name);
      plugins.set(handling.text.replace(change.name, '<name>'), g);
      continue;
    }
    if (change.area === 'agents') {
      for (const f of files) {
        const key = `${f}\0${handling.text}`;
        const g = agents.get(key) ?? { ids: [], text: handling.text, version, why: change.what };
        g.ids.push(change.name.split(':')[1] ?? change.name);
        agents.set(key, g);
      }
      continue;
    }
    manual.push({ kind: 'manual', title: handling.text, files, why: `${change.what} (${version})` });
  }
  for (const [key, g] of agents) {
    const file = key.split('\0')[0] ?? '';
    const station = /factory-(.*)\.md$/.exec(file)?.[1] ?? '<station>';
    manual.push({
      kind: 'manual',
      title: `${file}: ${g.text.replace('<station>', station)}`,
      files: [join(s.repo, file)],
      why: `fixed section${g.ids.length === 1 ? '' : 's'} ${g.ids.map((i) => `'${i}'`).join(', ')}: ${g.why} (${g.version})`,
    });
  }
  for (const g of plugins.values()) {
    const title = `${g.names.join(', ')}: ${g.names.length === 1 ? g.text : g.text.replace(g.names[0] as string, '<name>')}`;
    manual.push({ kind: 'manual', title, files: [], why: `marketplace plugins ${indexOf(to) > indexOf(from) ? `added after ${from}` : `not in ${to}`}` });
  }
  return { manual, refused };
}

/** The `claude` commands that move every installed software-factory plugin to the latest version. */
export function updateCommands(installs: Install[]): string[][] {
  const ids = [...new Set(installs.filter((i) => i.marketplace === MARKETPLACE).map((i) => i.id))].sort();
  if (ids.length === 0) return [];
  return [['plugin', 'marketplace', 'update', MARKETPLACE], ...ids.map((id) => ['plugin', 'update', id])];
}

/** The steps a person takes to run a version that is not the marketplace's latest. */
export function pinSteps(target: string, installs: Install[]): string[] {
  const v = entry(target);
  const ref = v.tag ?? v.commit ?? 'main';
  const ids = [...new Set(installs.filter((i) => i.marketplace === MARKETPLACE).map((i) => i.id))].sort();
  return [
    `Claude Code cannot install a plugin version that is not its marketplace's latest: \`claude plugin update\` installs the latest and \`claude plugin install\` takes no version. To run ${target}'s plugins, by hand:`,
    `git clone ${REPO_URL} <dir> && git -C <dir> checkout ${ref}`,
    ...ids.map((id) => `claude plugin disable ${id}`),
    'claude --plugin-dir <dir>/plugins   (loads each of its plugins for that session; repeat it for every session)',
    `to go back to the installed plugins: ${ids.map((id) => `claude plugin enable ${id}`).join('; ') || 'claude plugin enable <name>@software-factory'}`,
  ];
}

function pluginSteps(target: string, installs: Install[]): { step: Step | null; supported: boolean } {
  const sf = installs.filter((i) => i.marketplace === MARKETPLACE);
  if (sf.length === 0) return { step: null, supported: true };
  const t = indexOf(target);
  const ahead = sf.filter((i) => i.at !== null && indexOf(i.at) > t);
  const behind = sf.filter((i) => i.at === null || indexOf(i.at) < t);
  const files = [...new Set(sf.map((i) => i.installPath).filter((p): p is string => p !== null))];
  const list = (xs: Install[]): string => xs.map((i) => `${i.id} ${i.version ?? '?'}${i.at ? ` (${i.at})` : ''}`).join(', ');
  if (ahead.length > 0 || (behind.length > 0 && target !== LATEST)) {
    return {
      supported: false,
      step: {
        kind: 'plugin',
        title: `switch the plugins to ${target} by hand: ${pinSteps(target, installs).join('\n')}`,
        files,
        why: `installed: ${list(ahead.length > 0 ? ahead : behind)}; ${target} is not the marketplace's latest (${LATEST})`,
      },
    };
  }
  if (behind.length === 0) return { step: null, supported: true };
  return {
    supported: true,
    step: {
      kind: 'plugin',
      title: `update every installed software-factory plugin to ${target}, together (${INVOCATION} --update-plugins --confirmed runs these; then restart Claude Code)`,
      files,
      why: `installed: ${list(behind)}`,
      commands: updateCommands(installs),
    },
  };
}

/** The installed factory plugin's root, which runs the migrate-repo plumbing. */
export function factoryRoot(installs: Install[]): string | null {
  const f = installs.find((i) => i.id === `factory@${MARKETPLACE}` && i.installPath !== null && existsSync(i.installPath));
  return f?.installPath ?? null;
}

export interface Plumbed {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the factory CLI's plumbing through npx with the plugin's root, as skills run it. */
export function runPlumbing(root: string, args: string[], cwd: string, env: Env): Plumbed {
  const p = spawnSync('npx', ['--yes', '--offline', '--loglevel=error', `--package=${root}`, '--', 'factory', 'migrate-repo', ...args], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (p.error) return { status: 127, stdout: '', stderr: p.error.message };
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

function plumbingArgs(repo: string, from: string, to: string, scopes: Scope[] | null, apply: boolean): string[] {
  return ['--from', from, '--to', to, '--repo', repo, ...(scopes ?? []).flatMap((s) => ['--scope', s]), ...(apply ? ['--apply'] : [])];
}

function whyRuntime(change: string, direction: string): string {
  if (/job\.json: add /.test(change)) return 'job.json fields the current CLI writes (followups: 0.2.0)';
  if (/job\.json: remove /.test(change)) return 'job.json fields the target does not know';
  if (direction === 'downgrade') return 'the target version';
  return 'the TypeScript CLI\'s runtime dir (0.3.0)';
}

function plumbingSteps(r: PlumbingReport): { automatic: Step[]; manual: Step[] } {
  const automatic: Step[] = [];
  for (const s of r.settings) {
    if (!s.selected || s.changes.length === 0) continue;
    automatic.push({ kind: 'automatic', title: `${s.scope} settings: ${s.changes.join('; ')}`, files: [s.file], why: 'the plugin moved from factory@kwcantrell-plugins to factory@software-factory (0.2.0)' });
  }
  for (const c of r.config.changes) automatic.push({ kind: 'automatic', title: c, files: [r.config.file], why: 'factory.json keys the target refuses' });
  for (const c of r.runtime.changes) automatic.push({ kind: 'automatic', title: c.change, files: [join(r.runtime.dir, c.file)], why: whyRuntime(c.change, r.direction) });
  const manual = r.manual.map((m): Step => ({ kind: 'manual', title: m, files: [], why: 'reported by factory migrate-repo' }));
  return { automatic, manual };
}

export function plan(opts: MigrateOptions): Plan {
  const repo = mainCheckout(resolve(opts.cwd, opts.repo ?? '.'), opts.env);
  const to = opts.to === undefined || opts.to === 'latest' ? LATEST : opts.to;
  if (indexOf(to) < 0) throw new MigrateUsage(`--to: unknown version '${to}' (known: ${REGISTRY.map((v) => v.id).join(', ')}, latest)`);
  const s = readRepo(repo, opts.env);
  const installs = readInstalls(opts.env, repo);
  const signals = repoSignals(s);
  const sf = installs.filter((i) => i.marketplace === MARKETPLACE || i.marketplace === 'kwcantrell-plugins');
  const factory = sf.find((i) => i.name === 'factory' && i.at !== null);
  const fromPlugins = factory?.at ?? (sf.length > 0 ? (sf.map((i) => i.at).filter((a): a is string => a !== null).sort((a, b) => indexOf(a) - indexOf(b))[0] ?? null) : null);
  const fromRepo = repoVersion(signals, fromPlugins);
  const from = fromRepo ?? fromPlugins ?? to;

  const found: string[] = [
    ...signals.map((x) => `${x.text}: ${x.bound === 'atleast' ? 'at least' : 'at most'} ${x.version}`),
    ...sf.map((i) => `installed: ${i.id} ${i.version ?? '(no version)'} (${i.scope} scope)${i.at ? ` = ${i.at}` : ' - not a version the registry knows'}`),
  ];
  const repoDir = indexOf(to) - indexOf(from);
  const pluginsAhead = sf.some((i) => i.at !== null && indexOf(i.at) > indexOf(to));
  const direction: Plan['direction'] = repoDir < 0 || pluginsAhead ? 'downgrade' : repoDir > 0 || sf.some((i) => i.at === null || indexOf(i.at) < indexOf(to)) ? 'upgrade' : 'none';

  const reg = registrySteps(from, to, s, installs, opts.env);
  const refused = [...reg.refused];
  let plumbing: PlumbingReport | null = null;
  let note: string | null = null;
  const root = factoryRoot(installs);
  if (refused.length === 0) {
    if (root === null) {
      note = `the factory plugin (factory@${MARKETPLACE}) is not installed for this repo, so the repo steps (factory/ dir, factory.json, settings) cannot be planned or applied: install it yourself (claude plugin install factory@${MARKETPLACE} --scope project), restart Claude Code, then run ${INVOCATION} again`;
    } else {
      const p = runPlumbing(root, plumbingArgs(repo, from, to, opts.scopes, false), repo, opts.env);
      if (p.status === 0) plumbing = JSON.parse(p.stdout) as PlumbingReport;
      else if (p.status === 1) refused.push(p.stderr.trim().replace(/^refused: /, ''));
      else {
        note = `the installed factory plugin (${root}) cannot plan the repo steps for ${from} -> ${to} (${p.stderr.trim().split('\n').pop() ?? `exit ${p.status}`}): it is older than this factory-doctor; update the plugins first (${INVOCATION} --update-plugins), restart Claude Code, then run ${INVOCATION} again`;
      }
    }
  }
  if (plumbing) for (const f of plumbing.found) if (!found.includes(f) && !f.startsWith('installed: ')) found.push(f);

  const ps = pluginSteps(to, installs);
  const fromPlumbing = plumbing ? plumbingSteps(plumbing) : { automatic: [], manual: [] };
  const repoSteps = [...fromPlumbing.automatic, ...reg.manual, ...fromPlumbing.manual];
  const plugin = ps.step ? [ps.step] : [];
  const steps = direction === 'downgrade' ? [...repoSteps, ...plugin] : [...plugin, ...repoSteps];
  return {
    repo,
    factory_dir: s.factoryDir,
    target: to,
    latest: LATEST,
    from: { repo: fromRepo, plugins: fromPlugins, used: from },
    direction,
    found,
    refused,
    steps,
    plumbing,
    plumbing_note: note,
  };
}

// ---------------------------------------------------------------- output

const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

function flags(opts: MigrateOptions, p: Plan): string {
  return `${opts.to !== undefined ? ` --to ${quote(p.target)}` : ''}${opts.repo !== undefined ? ` --repo ${quote(p.repo)}` : ''}`;
}

export function stepsText(steps: Step[], indent = '  '): string[] {
  const lines: string[] = [];
  steps.forEach((s, n) => {
    const [first, ...rest] = s.title.split('\n');
    lines.push(`${indent}${n + 1}. [${s.kind}] ${first}`);
    for (const r of rest) lines.push(`${indent}     ${r}`);
    if (s.files.length > 0) lines.push(`${indent}     files: ${s.files.join(', ')}`);
    lines.push(`${indent}     why: ${s.why}`);
    for (const c of s.commands ?? []) lines.push(`${indent}     runs: claude ${c.join(' ')}`);
  });
  if (steps.length === 0) lines.push(`${indent}(nothing)`);
  return lines;
}

export function planText(p: Plan, opts: MigrateOptions, mode: 'dry-run' | 'apply'): string {
  const lines: string[] = [];
  lines.push(`factory-doctor migrate: ${p.repo}${mode === 'dry-run' ? ' (dry run: nothing was written)' : ''}`);
  lines.push(`  repo:    ${p.from.repo ? label(p.from.repo) : '(no sign of a version)'}`);
  lines.push(`  plugins: ${p.from.plugins ? label(p.from.plugins) : '(no software-factory plugin installed)'}`);
  lines.push(`  target:  ${label(p.target)}${p.target === p.latest ? ' - the latest this factory-doctor knows' : ''}`);
  lines.push(
    `  move:    ${p.direction === 'downgrade' ? 'downgrade: the repo first, while the newer tools are installed, then the plugins' : p.direction === 'upgrade' ? 'upgrade: the plugins first, then the repo' : 'none: already there'}`,
  );
  if (p.refused.length > 0) {
    lines.push('', `refused: migrate does not make this move (nothing was changed):`);
    for (const r of p.refused) lines.push(`  - ${r}`);
  }
  lines.push('', 'found:');
  for (const f of p.found) lines.push(`  - ${f}`);
  if (p.found.length === 0) lines.push('  (no older factory plugin, settings or runtime dir)');
  if (p.plumbing_note) lines.push('', `note: ${p.plumbing_note}`);
  lines.push('', 'plan, in order:', ...stepsText(p.steps));
  lines.push('');
  const f = flags(opts, p);
  if (p.refused.length > 0) {
    lines.push('refused: see the reasons above');
  } else if (mode === 'dry-run') {
    const plugin = p.steps.some((s) => s.kind === 'plugin' && s.commands);
    const auto = p.steps.some((s) => s.kind === 'automatic');
    if (plugin) lines.push(`next: ${INVOCATION} --update-plugins${f} shows the plugin commands; --update-plugins --confirmed runs them (then restart Claude Code)`);
    if (auto) lines.push(`next: ${INVOCATION} --apply${f} makes the automatic repo steps (backups first)`);
    if (!plugin && !auto) lines.push(p.steps.length === 0 ? `nothing to do: the repo and plugins are at ${p.target}` : 'nothing to apply: only the steps above, which are yours');
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- apply and update

export interface ApplyResult {
  plan: Plan;
  applied: PlumbingReport;
  left: Plan;
}

/** Apply the repo steps through the factory CLI's plumbing, then plan again. */
export function apply(opts: MigrateOptions, before: Plan): ApplyResult {
  if (before.refused.length > 0) throw new MigrateRefused(`refused:\n  - ${before.refused.join('\n  - ')}`);
  const installs = readInstalls(opts.env, before.repo);
  const root = factoryRoot(installs);
  if (root === null) throw new MigrateRefused(before.plumbing_note ?? `the factory plugin (factory@${MARKETPLACE}) is not installed for this repo`);
  const p = runPlumbing(root, plumbingArgs(before.repo, before.from.used, before.target, opts.scopes, true), before.repo, opts.env);
  if (p.status === 1) throw new MigrateRefused(p.stderr.trim());
  if (p.status !== 0) throw new MigrateRefused(before.plumbing_note ?? `the factory plugin's migrate-repo failed (exit ${p.status}): ${p.stderr.trim()}`);
  const applied = JSON.parse(p.stdout) as PlumbingReport;
  return { plan: before, applied, left: plan(opts) };
}

export function applyText(r: ApplyResult): { text: string; ok: boolean } {
  const lines: string[] = [`factory-doctor migrate --apply: ${r.plan.repo}`, '', 'applying (the automatic repo steps):'];
  lines.push(...stepsText(r.plan.steps.filter((s) => s.kind === 'automatic')));
  lines.push('', `done: ${r.applied.changes} change(s) made`);
  if (r.applied.backup) lines.push(`backup of the originals: ${r.applied.backup}`);
  if (r.applied.settings_backup) lines.push(`backup of the settings files (and factory.json): ${r.applied.settings_backup}`);
  const auto = r.left.steps.filter((s) => s.kind === 'automatic');
  lines.push('', 'left (plan again):', ...stepsText(r.left.steps));
  const ok = auto.length === 0 && r.left.refused.length === 0;
  lines.push('', ok ? (r.left.steps.length === 0 ? 'nothing left' : 'only manual or plugin steps are left: they are yours') : 'automatic steps are still left: see above');
  return { text: `${lines.join('\n')}\n`, ok };
}

export interface UpdateResult {
  commands: string[][];
  results: { command: string[]; status: number; output: string }[] | null;
}

/** --update-plugins: the commands (run only when confirmed); refused for a downgrade or a version not the latest. */
export function updatePlugins(opts: MigrateOptions, p: Plan, confirmed: boolean): UpdateResult {
  const installs = readInstalls(opts.env, p.repo);
  const ps = pluginSteps(p.target, installs);
  if (!ps.supported) {
    throw new MigrateRefused(`refused: --update-plugins cannot move the plugins to ${p.target}.\n  ${pinSteps(p.target, installs).join('\n  ')}`);
  }
  const commands = updateCommands(installs);
  if (!confirmed || commands.length === 0) return { commands, results: null };
  const results: UpdateResult['results'] = [];
  for (const command of commands) {
    const r = spawnSync('claude', command, { cwd: p.repo, env: opts.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 300_000 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`.trim();
    const status = r.error ? 127 : (r.status ?? 1);
    results.push({ command, status, output });
    if (status !== 0) break; // a failed step stops the rest: the plugins move together or not at all
  }
  return { commands, results };
}

export function updateText(u: UpdateResult, p: Plan): { text: string; ok: boolean } {
  const lines: string[] = [];
  if (u.commands.length === 0) {
    return { text: `no software-factory plugin is installed for this repo: nothing to update (migrate never installs one)\n`, ok: true };
  }
  if (u.results === null) {
    lines.push(`would run, in order (nothing was run; add --confirmed to run them):`);
    for (const c of u.commands) lines.push(`  claude ${c.join(' ')}`);
    lines.push('', `then restart Claude Code, and run ${INVOCATION} again for the repo steps`);
    return { text: `${lines.join('\n')}\n`, ok: true };
  }
  for (const r of u.results) {
    lines.push(`${r.status === 0 ? 'ok' : `failed (exit ${r.status})`}: claude ${r.command.join(' ')}`);
    for (const l of r.output.split('\n').slice(-5)) if (l.trim() !== '') lines.push(`    ${l}`);
  }
  const ok = u.results.length === u.commands.length && u.results.every((r) => r.status === 0);
  for (const c of u.commands.slice(u.results.length)) lines.push(`not run: claude ${c.join(' ')}`);
  lines.push(
    '',
    ok
      ? `Restart Claude Code so the updated plugins load (a plugin update needs a restart), then run ${INVOCATION} again for the repo steps (target ${p.target}).`
      : 'Not every command succeeded: the plugins may now be at different versions. Fix the failure above and run it again, then restart Claude Code.',
  );
  return { text: `${lines.join('\n')}\n`, ok };
}

