// The software factory's state machine.
//
// Every job lives in <repo>/factory/jobs/<id>/ as a job.json plus the markdown files the agents hand
// each other. This module is the only writer of job.json and the only way a job changes stage, so
// the gates below hold no matter what a prompt says.
//
//     intake -> build -> proof -> review -> ship -> done
//
// Exit codes: 0 ok, 1 refused (a gate was not met), 2 escalated to a human.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Escalated, now, Refused } from './errors.ts';
import { dumps, Float, formatG, formatPercent, roundHalfEven, str } from './pyfmt.ts';
import {
  attach,
  attached,
  identity,
  isStateCheckout,
  JOB_DIR,
  personText,
  publish,
  pull,
  pullForRead,
  RaceLost,
  remoteProblem,
  REMOTE_DEFAULTS,
  remotePush,
  remoteStatus,
  resolveRemote,
  samePerson,
  snapshot,
  stateDir,
  PUSH_ATTEMPTS,
} from './remote.ts';
import type { Person, RemoteConfig } from './remote.ts';
import { gitSigning, noSignersProblem, UNSIGNED, useSigning, verifyJobHistory } from './signing.ts';

export { Escalated, now, Refused } from './errors.ts';
export type { Person, RemoteConfig } from './remote.ts';

export const STAGES = ['intake', 'build', 'proof', 'review', 'ship', 'done'] as const;

export interface Config {
  reviewers: string[];
  max_review_rounds: number;
  max_proof_attempts: number;
  spec_gate: boolean;
  /** Repo-relative directory of living behavior specs, if the project keeps them. Intake reads the
   * specs a change touches and gives each one an acceptance criterion. */
  specs_dir: string | null;
  /**
   * Where the job state is shared (a git URL or path and a branch), or null for a local factory. Its
   * optional keys (`allowed_signers`, `unsigned_ok`) default to REMOTE_DEFAULTS when it is set.
   */
  remote: RemoteConfig | null;
  /**
   * factory-plugin-advisor settings. `share`: with a `remote`, the advisor also keeps its redacted
   * friction log and its state in the state branch's `advisor/` directory (the factory itself only
   * validates this key and lets `advisor/` exist on the branch).
   */
  advisor: AdvisorConfig;
}

export interface AdvisorConfig {
  share: boolean;
}

export const ADVISOR_KEYS = ['share'] as const;

/** Defaults; a project overrides them in factory.json at the repository root. */
export const DEFAULTS: Readonly<Config> = {
  reviewers: ['security', 'standards', 'behavior'],
  max_review_rounds: 3,
  max_proof_attempts: 3,
  spec_gate: false,
  specs_dir: null,
  remote: null,
  advisor: { share: false },
};

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Slot {
  verdict: string | null;
  at: string | null;
}
export interface Round {
  n: number;
  reviewers: Record<string, Slot>;
}
export interface FollowUp {
  n: number;
  text: string;
  by: string;
  stage: string;
  at: string;
  status: string;
  resolution: string | null;
  resolved_at: string | null;
}
export interface HistoryEntry {
  at: string;
  stage: string;
  event: string;
}
export interface Job {
  id: string;
  title: string;
  stage: string;
  status: string;
  needs_human: string | null;
  activity: string;
  spec?: string | null;
  spec_sha?: string | null;
  branch: string | null;
  base: string | null;
  base_branch: string | null;
  worktree: string | null;
  proof_attempts: number;
  rounds: Round[];
  followups?: FollowUp[];
  /** Remote factory only: who claimed the job (set by `start`, moved by `claim --take-over`). */
  owner?: Person | null;
  created: string;
  history: HistoryEntry[];
  updated?: string;
  /**
   * The commit `built` handed to proof: the job branch's head at that moment. Absent in jobs never
   * built by a CLI that records it (older job.json files); added after the older keys, never by
   * `blankJob`.
   */
  head?: string;
}

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// ---------------------------------------------------------------- git / paths

interface Proc {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd?: string): Proc {
  const p = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (p.error) return { status: 127, stdout: '', stderr: p.error.message };
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

export function git(args: string[], cwd?: string | null, check = true): string {
  const p = run('git', args, cwd ?? undefined);
  if (check && p.status !== 0) {
    throw new Refused(`git ${args.join(' ')} failed: ${p.stderr.trim() || p.stdout.trim()}`);
  }
  return p.stdout.trim();
}

/**
 * The repo's primary working tree, even when called from a job worktree, or from inside a remote
 * factory's state checkout (`<factory dir>/jobs`, a repository of its own), where it is the checkout
 * that holds that factory dir.
 */
export function mainCheckout(): string {
  const first = (cwd?: string): string | null => {
    const p = run('git', ['worktree', 'list', '--porcelain'], cwd);
    if (p.status !== 0 || !p.stdout.startsWith('worktree ')) return null;
    return (p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length);
  };
  const main = first();
  if (main === null) throw new Refused('not inside a git repository (the factory isolates builds in git worktrees)');
  if (!isStateCheckout(main)) return main;
  const outer = first(dirname(dirname(main)));
  if (outer === null || isStateCheckout(outer)) {
    throw new Refused(
      `${process.cwd()} is inside a remote factory's state checkout (${main}), not a project checkout; run factory from the project's checkout`,
    );
  }
  return outer;
}

/** An absolute path with symlinks resolved as far as the path exists (like Path.resolve()). */
function resolveReal(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(resolveReal(parent), basename(abs));
  }
}

/** FACTORY_DIR if set, else <main checkout>/factory (of the checkout holding the cwd, or `main`). */
export function factoryDir(main?: string): string {
  const env = process.env.FACTORY_DIR;
  return env ? resolveReal(env) : join(main ?? mainCheckout(), 'factory');
}

/** Create the factory directory. Idempotent; refreshes the dashboard. */
export function ensure(root: string): string {
  mkdirSync(join(root, 'jobs'), { recursive: true });
  const ignore = join(root, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, '# Factory runtime state: job records, worktrees, dashboard copy.\n*\n');
  }
  const src = join(PLUGIN_ROOT, 'dashboard', 'index.html');
  const dst = join(root, 'index.html');
  if (existsSync(src) && (!existsSync(dst) || !readFileSync(src).equals(readFileSync(dst)))) {
    copyFileSync(src, dst);
  }
  return root;
}

export function configPath(root: string): string {
  return join(dirname(root), 'factory.json');
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A JSON number written with a fraction or exponent ("2.0", "1e3"): a float, never a whole number.
 * Input side only (factory.json validation); pyfmt.ts `Float` is the output side, for writing floats.
 */
class JsonFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

function parseJson(text: string): unknown {
  // Keep "2.0" distinguishable from "2": a count must be written as a whole number.
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source !== undefined && /[.eE]/.test(context.source)) {
      return new JsonFloat(value);
    }
    return value;
  } as (key: string, value: unknown) => unknown);
}

/** Check one factory.json key and its value; throws Refused saying what is wrong and how to fix it. */
function checkConfigKey(path: string, key: string, value: unknown): void {
  const known = Object.keys(DEFAULTS);
  if (!known.includes(key)) {
    throw new Refused(`${path}: unknown key '${key}' (known: ${known.join(', ')})`);
  }
  if (key === 'reviewers') {
    const ok =
      Array.isArray(value) &&
      value.length > 0 &&
      new Set(value).size === value.length &&
      value.every((r) => typeof r === 'string' && NAME.test(r));
    if (!ok) {
      throw new Refused(
        `${path}: 'reviewers' must be a non-empty list of unique lowercase names like "security"`,
      );
    }
  } else if (key === 'spec_gate') {
    if (typeof value !== 'boolean') throw new Refused(`${path}: 'spec_gate' must be true or false`);
  } else if (key === 'specs_dir') {
    const ok =
      value === null ||
      (typeof value === 'string' &&
        value.trim() !== '' &&
        !value.startsWith('/') &&
        !value.split('/').includes('..'));
    if (!ok) {
      throw new Refused(`${path}: 'specs_dir' must be null or a repo-relative directory like "docs/specs"`);
    }
  } else if (key === 'remote') {
    const problem = remoteProblem(value);
    if (problem) throw new Refused(`${path}: ${problem}`);
  } else if (key === 'advisor') {
    const shape = `${path}: 'advisor' must be an object like {"share": true}`;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof JsonFloat) throw new Refused(shape);
    for (const sub of Object.keys(value)) {
      if (!(ADVISOR_KEYS as readonly string[]).includes(sub)) {
        throw new Refused(`${path}: 'advisor' has unknown key '${sub}' (known: ${ADVISOR_KEYS.join(', ')})`);
      }
    }
    if (typeof (value as Record<string, unknown>).share !== 'boolean') throw new Refused(`${path}: 'advisor.share' must be true or false`);
  } else if (!(typeof value === 'number' && Number.isInteger(value) && value >= 1)) {
    throw new Refused(`${path}: '${key}' must be a whole number of at least 1`);
  }
}

/** factory.json parsed (null when there is none); throws Refused when it is not a JSON object. */
function readConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let user: unknown;
  try {
    user = parseJson(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Refused(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof user !== 'object' || user === null || Array.isArray(user) || user instanceof JsonFloat) {
    throw new Refused(`${path} must be a JSON object`);
  }
  return user as Record<string, unknown>;
}

export function loadConfig(root: string): Config {
  const cfg: Config = { ...DEFAULTS, reviewers: [...DEFAULTS.reviewers], advisor: { ...DEFAULTS.advisor } };
  const path = configPath(root);
  const user = readConfig(path);
  if (user === null) return cfg;
  for (const [key, value] of Object.entries(user)) {
    checkConfigKey(path, key, value);
    (cfg as unknown as Record<string, unknown>)[key] = value;
  }
  if (cfg.remote) {
    const r = cfg.remote;
    cfg.remote = {
      url: r.url,
      branch: r.branch,
      allowed_signers: r.allowed_signers ?? REMOTE_DEFAULTS.allowed_signers,
      unsigned_ok: r.unsigned_ok ?? REMOTE_DEFAULTS.unsigned_ok,
    };
  }
  return cfg;
}

/** Every reason loadConfig would refuse factory.json, one per key (empty when it would load). */
export function configProblems(root: string): string[] {
  const path = configPath(root);
  let user: Record<string, unknown> | null;
  try {
    user = readConfig(path);
  } catch (error) {
    return [(error as Error).message];
  }
  const problems: string[] = [];
  for (const [key, value] of Object.entries(user ?? {})) {
    try {
      checkConfigKey(path, key, value);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- job storage

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file: it holds the pid of the run that has the lock. */
export const LOCK_FILE = '.lock.pid';

/** Run fn while holding the factory lock: a file holding the owner's pid, created atomically.
 * A lock whose owner is gone (a crashed run) is taken over. */
export function locked<T>(root: string, fn: () => T): T {
  const lock = join(root, LOCK_FILE);
  const mine = join(root, `.lock.${process.pid}.tmp`);
  writeFileSync(mine, `${process.pid}\n`);
  try {
    for (;;) {
      try {
        linkSync(mine, lock); // atomic: fails if the lock exists, and never shows a half-written pid
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      let owner = NaN;
      try {
        owner = Number.parseInt(readFileSync(lock, 'utf8'), 10);
      } catch {
        continue; // released between our attempt and the read
      }
      if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) {
        // Stale. Move it aside under a unique name first, so two runs never both remove a live lock.
        const aside = join(root, `.lock.stale.${process.pid}`);
        try {
          renameSync(lock, aside);
          const again = Number.parseInt(readFileSync(aside, 'utf8'), 10);
          if (again === owner || Number.isNaN(again)) unlinkSync(aside);
          else renameSync(aside, lock); // someone took it in between: put it back
        } catch {
          // Lost a race with another run doing the same; just try again.
        }
        continue;
      }
      sleep(20);
    }
  } finally {
    try {
      unlinkSync(mine);
    } catch {
      // already gone
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

function jobIds(root: string): string[] {
  return readdirSync(join(root, 'jobs'))
    .filter((name) => existsSync(join(root, 'jobs', name, 'job.json')))
    .sort();
}

/** Accept a full id, its number ('7', '007') or any unique prefix. */
export function resolve(root: string, ref: string): string {
  const ids = jobIds(root);
  if (ids.includes(ref)) return ref;
  let hits = ids.filter((i) => i.startsWith(ref));
  if (/^\d+$/.test(ref)) {
    const want = Number.parseInt(ref, 10);
    hits = ids.filter((i) => {
      const head = i.split('-')[0] ?? '';
      return /^\d+$/.test(head) && Number.parseInt(head, 10) === want;
    });
  }
  if (hits.length === 1) return hits[0] as string;
  throw new Refused(hits.length === 0 ? `no job matches '${ref}'` : `'${ref}' is ambiguous: ${hits.join(', ')}`);
}

/**
 * A job's record. Refused (naming the file and why) when it is not valid JSON or not the shape the
 * CLI writes, so a command acting on the job stops cleanly; listings skip it (loadListed).
 */
export function load(root: string, jobId: string): Job {
  const where = join(root, 'jobs', jobId, 'job.json');
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(where, 'utf8'));
  } catch (error) {
    throw new Refused(`${where} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it`);
  }
  const job = checkJob(where, jobId, data);
  if (attached(root)) trustRemoteJob(root, jobId, job);
  return job;
}

/**
 * The fields commands and listings read, checked to be the types the CLI writes. The dashboard's
 * `jobProblem` (dashboard/index.html) is a copy of these rules: change both together.
 */
/** A full commit hash, SHA-1 or SHA-256. */
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function checkJob(where: string, jobId: string, data: unknown): Job {
  const bad = (what: string): Refused => new Refused(`${where} is not a job record the factory wrote: ${what}; fix or remove it`);
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(data)) throw bad('it is not a JSON object');
  if (data.id !== jobId) throw bad(`its id is ${JSON.stringify(data.id)}, not its directory's name "${jobId}"`);
  for (const key of ['title', 'stage', 'status', 'created']) {
    if (typeof data[key] !== 'string') throw bad(`'${key}' is not a string`);
  }
  if (!(STAGES as readonly unknown[]).includes(data.stage)) throw bad(`'stage' is ${JSON.stringify(data.stage)}, not one of ${STAGES.join(', ')}`);
  if (!Array.isArray(data.history) || !data.history.every((h) => isObj(h) && typeof h.event === 'string' && typeof h.at === 'string')) {
    throw bad("'history' is not a list of {at, stage, event} entries");
  }
  if (!Array.isArray(data.rounds) || !data.rounds.every((r) => isObj(r) && isObj(r.reviewers) && Object.values(r.reviewers).every(isObj))) {
    throw bad("'rounds' is not a list of {n, reviewers} entries");
  }
  if (data.followups !== undefined && !(Array.isArray(data.followups) && data.followups.every(isObj))) {
    throw bad("'followups' is not a list");
  }
  // A git argument (merge merges it): only ever a full commit hash, or absent.
  if (data.head !== undefined && !(typeof data.head === 'string' && SHA.test(data.head))) {
    throw bad("'head' is not a commit hash");
  }
  return data as unknown as Job;
}

/** `text` with its control characters (terminal escapes, newlines) shown as `\\uXXXX`. */
const printable = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Every job in `ids` that loads; one stderr warning per job that does not (its directory and why),
 * so one bad job.json on a shared state branch cannot take a listing down for every other job.
 */
function loadListed(root: string, ids: string[], io: Io): Job[] {
  const jobs: Job[] = [];
  for (const id of ids) {
    try {
      jobs.push(load(root, id));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      // The reason can quote the file, which whoever pushes to the state branch wrote: no raw control characters.
      io.stderr(`factory: skipping ${printable(`${join(root, 'jobs', id)}: ${error.message}`)}\n`);
    }
  }
  return jobs;
}

/**
 * A job from a state checkout was written by whoever can push to the state branch, so the fields
 * this CLI uses as paths or git arguments must be the values it writes itself: the id is the job's
 * directory name, the branch is `factory/<id>`, the base a commit hash. The worktree is always this
 * machine's own `<factory dir>/worktrees/<id>` (another person's path means nothing here).
 */
function trustRemoteJob(root: string, jobId: string, job: Job): void {
  const where = join(root, 'jobs', jobId, 'job.json');
  const bad = (field: string, value: unknown, want: string): Refused =>
    new Refused(`${where} has ${field} ${JSON.stringify(value)}, but the factory only ever writes ${want}; refusing to use it - fix it on the state branch`);
  if (job.id !== jobId || !JOB_DIR.test(jobId)) throw bad('id', job.id, JSON.stringify(jobId));
  if (job.branch !== null && job.branch !== `factory/${jobId}`) throw bad('branch', job.branch, `null or "factory/${jobId}"`);
  if (job.base !== null && !(typeof job.base === 'string' && SHA.test(job.base))) {
    throw bad('base', job.base, 'null or a commit hash');
  }
  if (job.worktree !== null) job.worktree = join(root, 'worktrees', jobId);
}

export function save(root: string, job: Job): void {
  job.updated = now();
  const path = join(root, 'jobs', job.id, 'job.json');
  const tmp = `${path}.tmp`;
  // Never write through whatever already sits at the temp path (a link, say): replace it.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${dumps(job)}\n`, { flag: 'wx' });
  renameSync(tmp, path); // atomic: the dashboard never reads a half-written file
}

/** factory.json's remote with a relative url made absolute, or null for a local factory. */
export function remoteOf(root: string, cfg: Config): RemoteConfig | null {
  return cfg.remote ? resolveRemote(cfg.remote, dirname(configPath(root))) : null;
}

/**
 * Set how this command signs the state commits it makes (src/signing.ts): signed with the person's
 * SSH key in remote mode, unless `unsigned_ok`. With `required`, refuse before anything changes when
 * signing is required but not set up; a read command (not required) only fails if it has to commit.
 */
function signFor(remote: RemoteConfig | null, required: boolean): void {
  if (remote === null || remote.unsigned_ok === true) {
    useSigning(UNSIGNED);
    return;
  }
  const signing = gitSigning(mainCheckout(), remote.allowed_signers ?? null);
  useSigning(signing);
  if (required && signing.problem !== null) throw new Refused(signing.problem);
}

/** Commands any person may run on a job someone else has claimed: the human gates, and `claim`. */
export const ANYONE: ReadonlySet<string> = new Set(['approve', 'merge', 'rework', 'close', 'claim']);

/** Steps that undo a command's side effects outside the state checkout, if publishing it fails. */
let undoSteps: (() => void)[] = [];

function onRollback(step: () => void): void {
  undoSteps.push(step);
}

/**
 * Load a job under the lock; save it when fn returns, and also when it escalates. With a remote,
 * pull first, refuse a job someone else claimed (unless `command` is in ANYONE), and publish the
 * job's directory as one commit after saving it.
 */
export function editing<T>(root: string, a: Args, command: string, fn: (job: Job) => T): T {
  const ref = a.job as string;
  const remote = remoteOf(root, a.cfg);
  return locked(root, () => {
    undoSteps = [];
    if (remote === null) {
      const job = load(root, resolve(root, ref));
      let result: T;
      try {
        result = fn(job);
      } catch (error) {
        if (error instanceof Escalated) save(root, job);
        throw error;
      }
      save(root, job);
      return result;
    }
    const me = identity();
    signFor(remote, true);
    pull(root, remote, () => me);
    const id = resolve(root, ref);
    const snap = snapshot(join(root, 'jobs', id));
    const job = load(root, id);
    if (job.owner && !samePerson(job.owner, me) && !ANYONE.has(command)) {
      throw new Refused(
        `${id} is claimed by ${personText(job.owner)}; only they can run \`factory ${command}\` on it. ` +
          `A human can take it over with \`factory claim ${id} --take-over\``,
      );
    }
    let result!: T;
    let escalated: Escalated | null = null;
    try {
      result = fn(job);
    } catch (error) {
      if (!(error instanceof Escalated)) {
        for (const step of undoSteps.reverse()) {
          try {
            step();
          } catch {
            // best effort: the refusal below is what the caller needs to see
          }
        }
        throw error;
      }
      escalated = error;
    }
    save(root, job);
    publish(root, remote, id, command, me, { snap, undo: undoSteps });
    if (escalated) throw escalated;
    return result;
  });
}

function log(job: Job, event: string): void {
  job.activity = event;
  job.history.push({ at: now(), stage: job.stage, event });
}

function move(job: Job, stage: string, event: string): void {
  job.stage = stage;
  log(job, event);
}

function needHuman(job: Job, reason: string): void {
  job.status = 'needs-human';
  job.needs_human = reason;
  log(job, `needs human: ${reason}`);
}

function requireStage(job: Job, ...stages: string[]): void {
  if (!stages.includes(job.stage)) {
    throw new Refused(`${job.id} is in '${job.stage}', expected ${stages.join(' or ')}`);
  }
  if (job.status === 'needs-human' && job.stage !== 'ship') {
    throw new Refused(
      `${job.id} is waiting on a human (${str(job.needs_human)}); a human runs \`factory resume ${job.id}\` to continue`,
    );
  }
}

function requireFile(root: string, job: Job, name: string): string {
  const path = join(root, 'jobs', job.id, name);
  if (!existsSync(path) || readFileSync(path, 'utf8').trim() === '') {
    throw new Refused(`missing ${path} - write it first`);
  }
  return path;
}

/**
 * Refuse while an untracked copy of a station's handoff file sits at the root of the main checkout or
 * of the job's worktree. Handoff files belong only in the job dir; a stray copy is swept into a
 * commit by `git add -A`. A tracked file of the same name is the project's own and is left alone.
 */
function requireNoStray(root: string, job: Job, name: string): void {
  const wt = job.worktree && existsSync(job.worktree) ? job.worktree : null;
  let main: string | null = null;
  const p = run('git', ['worktree', 'list', '--porcelain'], wt ?? undefined);
  if (p.status === 0 && p.stdout.startsWith('worktree ')) {
    main = (p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length);
  }
  const roots = [...new Set([main, wt].filter((d): d is string => d !== null))];
  for (const dir of roots) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const tracked = run('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', name], dir);
    if (tracked.status === 0) continue;
    const own = join(root, 'jobs', job.id, name);
    let same = false;
    try {
      same = readFileSync(path).equals(readFileSync(own));
    } catch {
      // A directory or unreadable file is never a copy of the job's handoff file.
    }
    throw new Refused(
      `stray ${path} is an untracked copy of a handoff file that belongs only in ${join(root, 'jobs', job.id)} ` +
        `(it ${same ? 'is byte-identical to' : 'differs from'} ${own}) - move or delete it, then retry`,
    );
  }
}

function requireContract(root: string, job: Job): string {
  const path = requireFile(root, job, 'task.md');
  if (!/^#+\s*acceptance criteria/im.test(readFileSync(path, 'utf8'))) {
    throw new Refused(
      "task.md needs an '## Acceptance criteria' section - it is the contract the verifier and reviewers judge against",
    );
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ------------------------------------------------------------------- commands

/** Parsed arguments for one command, plus the effective config. */
export interface Args {
  cfg: Config;
  [name: string]: unknown;
}

const s = (a: Args, name: string): string => a[name] as string;
const list = (a: Args, name: string): string[] => (a[name] as string[] | undefined) ?? [];
const flag = (a: Args, name: string): boolean => a[name] === true;

export type Command = (root: string, a: Args, io: Io) => void;

export const cmdInit: Command = (root, a, io) => {
  const remote = remoteOf(root, a.cfg);
  let state = '';
  if (remote) {
    signFor(remote, true);
    const how = locked(root, () => {
      const result = attach(root, remote, identity);
      pull(root, remote, identity);
      return result;
    });
    const verb = { attached: 'tracks', cloned: 'cloned from', created: 'created as a new branch on' }[how];
    state = `job state: ${stateDir(root)} ${verb} ${remote.url} (branch ${remote.branch})\n`;
  }
  io.stdout(`factory ready at ${root}\n${state}dashboard: factory dashboard\n`);
};

/** A new job record: every field the CLI writes, in the order it writes them (save() adds `updated`). */
export function blankJob(id: string, title: string, created: string): Job {
  return {
    id,
    title,
    stage: 'intake',
    status: 'active',
    needs_human: null,
    activity: '',
    spec: null,
    spec_sha: null,
    branch: null,
    base: null,
    base_branch: null,
    worktree: null,
    proof_attempts: 0,
    rounds: [],
    followups: [],
    created,
    history: [],
  };
}

export const cmdNew: Command = (root, a, io) => {
  const title = list(a, 'title').join(' ').trim();
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'job';
  const create = (): string => {
    const nums = readdirSync(join(root, 'jobs'))
      .map((name) => name.split('-')[0] ?? '')
      .filter((head) => /^\d+$/.test(head))
      .map((head) => Number.parseInt(head, 10));
    const id = `${String(Math.max(0, ...nums) + 1).padStart(3, '0')}-${slug}`;
    mkdirSync(join(root, 'jobs', id));
    const job = blankJob(id, title, now());
    log(job, 'created');
    save(root, job);
    return id;
  };
  const remote = remoteOf(root, a.cfg);
  const jobId = locked(root, () => {
    if (remote === null) return create();
    // Two people creating jobs at once: whoever pushes second rolls back, pulls the other's job
    // and allocates the next number, so ids never collide and neither job is lost.
    const me = identity();
    signFor(remote, true);
    pull(root, remote, () => me);
    // Never replay a `new` onto the remote's commits: its number may be taken there by now.
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      const id = create();
      try {
        publish(root, remote, id, 'new', me, { snap: null, undo: [], redo: true });
        return id;
      } catch (error) {
        if (!(error instanceof RaceLost)) throw error;
      }
    }
    throw new Refused(
      `lost the race to push ${remote.branch} ${PUSH_ATTEMPTS} times while numbering the job; nothing was created - retry the command`,
    );
  });
  io.stdout(
    `${jobId}\njob dir: ${join(root, 'jobs', jobId)}\nnext: write task.md there, then \`factory start ${jobId}\`\n`,
  );
};

export const cmdStart: Command = (root, a, io) => {
  const out = editing(root, a, 'start', (job) => {
    if (job.stage === 'intake' && job.spec === 'pending') {
      throw new Refused(`${job.id} is waiting for a human to approve its spec (task.md)`);
    }
    requireStage(job, 'intake');
    const sha = requireContract(root, job);
    if (a.cfg.spec_gate && job.spec !== 'approved') {
      throw new Refused(`spec_gate is on: run \`factory spec ${job.id}\` and wait for a human to approve task.md`);
    }
    if (job.spec === 'approved' && sha !== job.spec_sha) {
      throw new Refused(
        `task.md changed after the human approved it; run \`factory spec ${job.id}\` to ask for approval of the new version`,
      );
    }
    const main = mainCheckout();
    if (git(['rev-parse', '--verify', '-q', 'HEAD'], main, false) === '') {
      throw new Refused('the repository has no commits yet; make an initial commit first');
    }
    const base = git(['rev-parse', 'HEAD'], main);
    job.base = base;
    job.base_branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], main, false) || null;
    const branch = `factory/${job.id}`;
    job.branch = branch;
    const wt = join(root, 'worktrees', job.id);
    if (a.cfg.remote) job.owner = identity();
    git(['worktree', 'add', '-b', branch, wt, base], main);
    onRollback(() => {
      git(['worktree', 'remove', '--force', wt], main, false);
      git(['branch', '-D', branch], main, false);
    });
    job.worktree = wt;
    move(job, 'build', 'building');
    return `worktree: ${wt}\nbranch: ${branch}\nbase: ${base}\n`;
  });
  io.stdout(out);
};

export const cmdSpec: Command = (root, a, io) => {
  const id = editing(root, a, 'spec', (job) => {
    if (job.stage !== 'intake') {
      throw new Refused(`${job.id} is in '${job.stage}'; a spec is approved before building`);
    }
    requireContract(root, job);
    job.spec = 'pending';
    job.spec_sha = null;
    needHuman(job, 'review task.md and approve the spec');
    return job.id;
  });
  io.stdout(`${id} is waiting for spec approval; the user runs /factory:approve ${id}\n`);
};

/** A human gate. hooks/hooks.json (src/human-gate.ts) makes Claude Code ask before this runs. */
export const cmdApprove: Command = (root, a, io) => {
  const id = editing(root, a, 'approve', (job) => {
    if (job.stage !== 'intake' || job.spec !== 'pending') {
      throw new Refused(`${job.id} has no spec waiting for approval`);
    }
    job.spec = 'approved';
    job.spec_sha = requireContract(root, job);
    job.status = 'active';
    job.needs_human = null;
    log(job, 'spec approved by human');
    return job.id;
  });
  io.stdout(`${id} spec approved; next: factory start ${id}\n`);
};

/** The commit the job's branch points at in this checkout, or null when the branch is not here. */
function branchTip(job: Job): string | null {
  if (!job.branch) return null;
  return git(['rev-parse', '--verify', '-q', `refs/heads/${job.branch}^{commit}`], mainCheckout(), false) || null;
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * Refuse unless the job's branch still points at the commit `built` recorded (job.head): proof,
 * review and merge all judge that one commit, never whatever lands on the branch later. A job
 * without a recorded commit (built by an older CLI) is not checked here; `merge` decides about it.
 * Branches are local, so the check runs in this machine's checkout; `retry` says how to go on.
 */
function requireRecordedHead(job: Job, retry: string): void {
  if (job.head === undefined) return;
  const tip = branchTip(job);
  if (tip === null) {
    throw new Refused(
      `${job.id}: branch ${str(job.branch)} is not in ${mainCheckout()}, so it cannot be checked against the commit \`factory built\` recorded (${job.head}); ` +
        `fetch that branch into this checkout, then retry`,
    );
  }
  if (tip !== job.head) {
    throw new Refused(
      `${job.id}: branch ${str(job.branch)} is at ${tip}, but \`factory built\` handed ${job.head} to proof and review; ${retry}`,
    );
  }
}

const builtAgain = (job: Job): string =>
  `run \`factory built ${job.id}\` again, which sends the new code back through proof`;

export const cmdBuilt: Command = (root, a, io) => {
  const id = editing(root, a, 'built', (job) => {
    // Code that changed after `built` goes back through proof from proof or review too; otherwise
    // `built` is the end of the build stage.
    const moved = job.head !== undefined && (job.stage === 'proof' || job.stage === 'review') && branchTip(job) !== job.head;
    requireStage(job, ...(moved ? [job.stage] : ['build']));
    requireFile(root, job, 'build.md');
    requireNoStray(root, job, 'build.md');
    const wt = job.worktree;
    if (git(['status', '--porcelain'], wt)) {
      throw new Refused(`uncommitted changes in ${str(wt)} - commit them; reviewers read commits`);
    }
    const tip = branchTip(job);
    if (tip === null) throw new Refused(`branch ${str(job.branch)} is not in ${mainCheckout()}`);
    const at = git(['rev-parse', 'HEAD'], wt);
    if (at !== tip) {
      throw new Refused(`${str(wt)} is at ${short(at)}, not at the tip of ${str(job.branch)} (${short(tip)}); check out ${str(job.branch)} there`);
    }
    if (git(['rev-list', '--count', `${str(job.base)}..${tip}`], wt) === '0') {
      throw new Refused(`no commits on ${str(job.branch)} since ${str(job.base).slice(0, 8)}`);
    }
    let event = 'awaiting independent proof';
    if (moved) {
      event = `code changed after built (${short(str(job.head))} -> ${short(tip)}); awaiting independent proof`;
      const last = job.rounds[job.rounds.length - 1];
      if (job.stage === 'review' && last && Object.values(last.reviewers).some((v) => v.verdict === null)) {
        // That round reviewed the old commit; its open slots must not judge the new one.
        job.rounds.pop();
        event += ` (unfinished review round ${last.n} discarded)`;
      }
    }
    job.head = tip;
    move(job, 'proof', event);
    return job.id;
  });
  io.stdout(`${id} -> proof\n`);
};

export const cmdProof: Command = (root, a, io) => {
  const out = editing(root, a, 'proof', (job) => {
    requireStage(job, 'proof');
    requireRecordedHead(job, builtAgain(job));
    requireFile(root, job, 'proof.md');
    requireNoStray(root, job, 'proof.md');
    if (a.result === 'pass') {
      move(job, 'review', 'proof passed');
    } else {
      job.proof_attempts += 1;
      move(job, 'build', `proof failed (attempt ${job.proof_attempts})`);
      if (job.proof_attempts >= a.cfg.max_proof_attempts) {
        needHuman(job, `proof failed ${job.proof_attempts} times - see proof.md`);
        throw new Escalated(str(job.needs_human));
      }
    }
    return `${job.id} -> ${job.stage}\n`;
  });
  io.stdout(out);
};

export const cmdRound: Command = (root, a, io) => {
  const out = editing(root, a, 'round', (job) => {
    requireStage(job, 'review');
    requireRecordedHead(job, builtAgain(job));
    const rounds = job.rounds;
    const last = rounds[rounds.length - 1];
    if (last && Object.values(last.reviewers).some((v) => v.verdict === null)) {
      throw new Refused(`round ${last.n} is still waiting on verdicts`);
    }
    const n = rounds.length + 1;
    if (n > a.cfg.max_review_rounds) {
      needHuman(job, `no approval after ${a.cfg.max_review_rounds} review round(s)`);
      throw new Escalated(str(job.needs_human));
    }
    const given = list(a, 'reviewers');
    const names = given.length > 0 ? given : a.cfg.reviewers;
    const reviewers: Record<string, Slot> = {};
    for (const r of names) reviewers[r] = { verdict: null, at: null };
    rounds.push({ n, reviewers });
    log(job, `review round ${n} opened`);
    return `round ${n}: ${names.join(' ')}\n`;
  });
  io.stdout(out);
};

export const cmdVerdict: Command = (root, a, io) => {
  const reviewer = s(a, 'reviewer');
  const verdict = s(a, 'verdict');
  const out = editing(root, a, 'verdict', (job) => {
    requireStage(job, 'review');
    requireRecordedHead(job, builtAgain(job));
    const rnd = job.rounds[job.rounds.length - 1];
    if (!rnd) throw new Refused('no review round is open - run `factory round` first');
    const slot = Object.hasOwn(rnd.reviewers, reviewer) ? rnd.reviewers[reviewer] : undefined;
    if (slot === undefined || slot === null) {
      throw new Refused(
        `'${reviewer}' is not a reviewer in round ${rnd.n} (${Object.keys(rnd.reviewers).join(', ')})`,
      );
    }
    if (slot.verdict !== null) {
      throw new Refused(`${reviewer} already recorded '${slot.verdict}' for round ${rnd.n}`);
    }
    requireFile(root, job, `review-${rnd.n}-${reviewer}.md`);
    requireNoStray(root, job, `review-${rnd.n}-${reviewer}.md`);
    slot.verdict = verdict;
    slot.at = now();
    log(job, `round ${rnd.n}: ${reviewer} -> ${verdict}`);
    const slots = Object.entries(rnd.reviewers);
    if (slots.every(([, v]) => v.verdict !== null)) {
      const blockers = slots.filter(([, v]) => v.verdict === 'changes').map(([r]) => r);
      if (blockers.length === 0) {
        move(job, 'ship', `approved in round ${rnd.n}`);
        needHuman(job, 'approved by every reviewer - awaiting your merge');
      } else if (rnd.n >= a.cfg.max_review_rounds) {
        needHuman(
          job,
          `changes still requested after ${rnd.n} round${rnd.n !== 1 ? 's' : ''} (${blockers.join(', ')})`,
        );
        throw new Escalated(str(job.needs_human));
      } else {
        move(job, 'build', `round ${rnd.n}: changes requested by ${blockers.join(', ')}`);
      }
    }
    return `${job.id}: ${reviewer} -> ${verdict} (stage: ${job.stage})\n`;
  });
  io.stdout(out);
};

export const cmdHuman: Command = (root, a) => {
  // Exit 2 like every other escalation, so the caller stops work on the job.
  editing(root, a, 'human', (job) => {
    needHuman(job, list(a, 'reason').join(' '));
    throw new Escalated(`${job.id} flagged for a human: ${str(job.needs_human)}`);
  });
};

export const cmdResume: Command = (root, a, io) => {
  const reset = flag(a, 'reset');
  const out = editing(root, a, 'resume', (job) => {
    if (job.stage === 'ship' || job.stage === 'done') {
      throw new Refused(`${job.id} is in '${job.stage}'; use \`factory merge\` or \`factory close\``);
    }
    job.status = 'active';
    job.needs_human = null;
    if (reset) {
      job.proof_attempts = 0;
      job.rounds = [];
    }
    log(job, `resumed by human${reset ? ' (attempt and round counters reset)' : ''}`);
    return `${job.id} resumed in ${job.stage}\n`;
  });
  io.stdout(out);
};

function dropWorktree(job: Job, keepBranch: boolean): void {
  const main = mainCheckout();
  if (job.worktree && existsSync(job.worktree)) {
    git(['worktree', 'remove', '--force', job.worktree], main, false);
  }
  if (job.branch && !keepBranch) git(['branch', '-d', job.branch], main, false);
  job.worktree = null;
}

/**
 * Remote mode: refuse unless every state commit that touched the job's directory is signed by a key
 * in the allowed-signers file, as committed at HEAD of the project checkout (never the state branch,
 * whose pushers it judges, nor an uncommitted edit). The job.json this merge reads must be the one
 * committed. Off with `unsigned_ok`; a remote with neither key is refused with how to set it up.
 */
function requireSignedHistory(root: string, cfg: Config, job: Job): void {
  const remote = cfg.remote;
  if (!remote || remote.unsigned_ok === true) return;
  if (!remote.allowed_signers) throw new Refused(noSignersProblem(configPath(root)));
  const main = mainCheckout();
  const path = remote.allowed_signers;
  const add = `commit it, listing each person's SSH public key ("<email> ssh-ed25519 AAAA..."), by pull request; see the README's "Remote factory" section`;
  const entry = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(git(['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', path], main, false));
  if (!entry) throw new Refused(`the allowed-signers file ${path} (factory.json remote.allowed_signers) is not committed in ${main} (HEAD): ${add}`);
  if (entry[2] !== 'blob' || (entry[1] !== '100644' && entry[1] !== '100755')) {
    throw new Refused(`the allowed-signers file ${path} in ${main} (HEAD) is not a regular file; ${add}`);
  }
  const signers = git(['cat-file', 'blob', entry[3] as string], main);
  const dir = stateDir(root);
  if (git(['status', '--porcelain', '--untracked-files=all', '--', `${job.id}/job.json`], dir) !== '') {
    throw new Refused(
      `${join(dir, job.id, 'job.json')} is not the version committed on the state branch; refusing to merge from an unverified record - ` +
        `restore it (git -C ${dir} checkout -- ${job.id}/job.json), then retry`,
    );
  }
  verifyJobHistory(dir, job.id, signers, `${path} at HEAD of ${main}`);
}

/**
 * What `merge` merges: the commit `built` recorded, refused when the branch has moved past it. A job
 * without one (built by an older CLI) merges its branch as before, except where state commits must be
 * signed: there a rollback of the state branch to a record from before this check could otherwise
 * merge code no one proved, so it is refused until `built` records the commit.
 */
function requireProvenCommit(cfg: Config, job: Job): string {
  if (job.head === undefined) {
    if (cfg.remote && cfg.remote.unsigned_ok !== true) {
      throw new Refused(
        `${job.id} has no commit recorded by \`factory built\` (it was built by an older factory), so what proof and review judged cannot be checked; ` +
          `a human runs \`factory rework ${job.id}\` and the builder runs \`factory built ${job.id}\` again to record the commit and send it through proof and review; nothing was merged`,
      );
    }
    return str(job.branch);
  }
  requireRecordedHead(
    job,
    `a human runs \`factory rework ${job.id}\`, then ${builtAgain(job)}; nothing was merged`,
  );
  return job.head;
}

/** The human gate. hooks/hooks.json (src/human-gate.ts) makes Claude Code ask before this runs. */
export const cmdMerge: Command = (root, a, io) => {
  const out = editing(root, a, 'merge', (job) => {
    requireSignedHistory(root, a.cfg, job);
    requireStage(job, 'ship');
    const merged = requireProvenCommit(a.cfg, job);
    const main = mainCheckout();
    if (git(['status', '--porcelain', '--untracked-files=no'], main)) {
      throw new Refused(`${main} has uncommitted changes; commit or stash them before merging`);
    }
    const current = git(['symbolic-ref', '--short', '-q', 'HEAD'], main, false) || '(detached)';
    if (job.base_branch && current !== job.base_branch && !flag(a, 'into_current')) {
      throw new Refused(
        `main checkout is on '${current}' but the job was cut from '${job.base_branch}'; check that out, or pass --into-current`,
      );
    }
    const branch = str(job.branch);
    // The recorded commit itself, never the branch name resolved now: what proof and review judged.
    const p = run('git', ['merge', '--no-ff', '-m', `Merge ${branch}: ${job.title}`, merged], main);
    if (p.status !== 0) {
      // Only unmerged paths mean a conflict; anything else (no git identity, a hook, a lock) is
      // reported in git's own words so the human is not sent looking for a conflict.
      const conflicted = git(['diff', '--name-only', '--diff-filter=U'], main, false);
      git(['merge', '--abort'], main, false);
      if (conflicted) {
        needHuman(job, `merge into ${current} conflicts - the branch needs a rebase`);
      } else {
        const error = (p.stderr.trim() || p.stdout.trim()).split(/\s+/).filter(Boolean).join(' ');
        needHuman(job, `merge into ${current} failed: ${error || `git exited ${p.status}`}`);
      }
      throw new Escalated(`${str(job.needs_human)}\n${(p.stdout + p.stderr).trim()}`);
    }
    dropWorktree(job, false);
    job.status = 'merged';
    job.needs_human = null;
    move(job, 'done', `merged into ${current}`);
    return `${job.id} merged into ${current}\n`;
  });
  io.stdout(out);
};

export const cmdRework: Command = (root, a, io) => {
  const out = editing(root, a, 'rework', (job) => {
    requireStage(job, 'ship');
    const reason = list(a, 'reason').join(' ').trim();
    if (!reason) throw new Refused('say what to change: factory rework <job> <what to change>');
    const n = job.rounds.length;
    const name = `rework-${n}.md`;
    writeFileSync(
      join(root, 'jobs', job.id, name),
      `# Rework requested after round ${n}\n\nRequested by a human at ${now()}.\n\n${reason}\n`,
    );
    job.status = 'active';
    job.needs_human = null;
    move(job, 'build', `rework requested by a human after round ${n}: ${reason}`);
    return `${job.id} -> build (rework; request in ${name})\n`;
  });
  io.stdout(out);
};

export const cmdClose: Command = (root, a, io) => {
  const out = editing(root, a, 'close', (job) => {
    if (job.stage === 'done') throw new Refused(`${job.id} is already done`);
    dropWorktree(job, true);
    job.status = 'closed';
    job.needs_human = null;
    const reason = list(a, 'reason').join(' ') || 'closed';
    move(job, 'done', `closed without merging: ${reason}`);
    const kept = job.branch ? ` (branch ${job.branch} kept)` : '';
    return `${job.id} closed${kept}\n`;
  });
  io.stdout(out);
};

/** Stages in which a job has a worktree (and a branch) that `claim --take-over` brings along. */
const WORKTREE_STAGES = ['build', 'proof', 'review', 'ship'];

/**
 * A human command (src/gate.ts): move a job's claim to whoever runs this. A job in build or later
 * gets its worktree recreated here from its branch on the code remote (`origin` of the main
 * checkout); a branch the previous owner never pushed is refused.
 */
export const cmdClaim: Command = (root, a, io) => {
  if (!a.cfg.remote) {
    throw new Refused('claims belong to a remote factory: set "remote" in factory.json (see the README\'s Remote factory section)');
  }
  const out = editing(root, a, 'claim', (job) => {
    const me = identity();
    if (samePerson(job.owner, me)) throw new Refused(`${job.id} is already yours`);
    const was = job.owner ? personText(job.owner) : 'nobody';
    if (!flag(a, 'take_over')) {
      throw new Refused(`${job.id} is claimed by ${was}; a human takes it over with \`factory claim ${job.id} --take-over\``);
    }
    let where = '';
    if (WORKTREE_STAGES.includes(job.stage) && job.branch) {
      const main = mainCheckout();
      const branch = job.branch;
      const fetched = run('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], main);
      if (fetched.status !== 0) {
        throw new Refused(
          `${branch} is not on the code remote (origin of ${main}): ${was} must push it first ` +
            `(git push origin ${branch}), then retry`,
        );
      }
      const wt = join(root, 'worktrees', job.id);
      if (!existsSync(wt)) {
        const local = git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], main, false) !== '';
        git(['worktree', 'add', ...(local ? [wt, branch] : ['-b', branch, wt, `origin/${branch}`])], main);
        onRollback(() => {
          git(['worktree', 'remove', '--force', wt], main, false);
          if (!local) git(['branch', '-D', branch], main, false);
        });
      }
      job.worktree = wt;
      where = `worktree: ${wt}\n`;
    }
    job.owner = me;
    log(job, `taken over by ${personText(me)} from ${was}`);
    return `${job.id} is now claimed by ${personText(me)}\n${where}`;
  });
  io.stdout(out);
};

function needRemote(root: string, a: Args): RemoteConfig {
  const remote = remoteOf(root, a.cfg);
  if (!remote) throw new Refused(`no "remote" in ${configPath(root)}: this factory is local (see the README's Remote factory section)`);
  return remote;
}

export const cmdRemoteStatus: Command = (root, a, io) => {
  const remote = remoteOf(root, a.cfg);
  if (!remote) {
    io.stdout(`remote:     none (local mode: no "remote" in ${configPath(root)})\n`);
    return;
  }
  const st = locked(root, () => remoteStatus(root, remote, flag(a, 'offline')));
  if (st.warning) io.stderr(`factory: ${st.warning}\n`);
  io.stdout(st.text);
};

export const cmdRemotePush: Command = (root, a, io) => {
  const remote = needRemote(root, a);
  const me = identity();
  signFor(remote, true);
  io.stdout(locked(root, () => remotePush(root, remote, me)));
};

/** Read commands pull first (unless --offline); without the remote they show the last-pulled state. */
export function syncForRead(root: string, a: Args, io: Io): void {
  const remote = remoteOf(root, a.cfg);
  if (!remote) return;
  signFor(remote, false);
  const note = locked(root, () => pullForRead(root, remote, flag(a, 'offline'), identity));
  if (note) io.stderr(note.split('\n').map((line) => `factory: ${line}\n`).join(''));
}

export const cmdConfig: Command = (root, a, io) => {
  const path = configPath(root);
  const source = existsSync(path) ? path : `defaults (create ${path} to override)`;
  io.stdout(`${dumps(a.cfg)}\n`);
  io.stderr(`# from ${source}\n`);
};

export const cmdNote: Command = (root, a) => {
  editing(root, a, 'note', (job) => log(job, list(a, 'text').join(' ')));
};

export const cmdFollowupAdd: Command = (root, a, io) => {
  const text = list(a, 'text').join(' ').trim();
  const by = s(a, 'by');
  if (!text) throw new Refused('say what the follow-up is: factory followup add <job> --by <who> <text>');
  if (!NAME.test(by)) {
    throw new Refused('--by must be a lowercase name like builder, verifier, security or human');
  }
  const out = editing(root, a, 'followup add', (job) => {
    job.followups ??= [];
    const items = job.followups;
    const n = Math.max(0, ...items.map((f) => f.n)) + 1;
    items.push({
      n,
      text,
      by,
      stage: job.stage,
      at: now(),
      status: 'open',
      resolution: null,
      resolved_at: null,
    });
    job.history.push({ at: now(), stage: job.stage, event: `follow-up ${n} added by ${by}` });
    return `${job.id}: follow-up ${n} recorded\n`;
  });
  io.stdout(out);
};

export const cmdFollowupResolve: Command = (root, a, io) => {
  const n = a.n as number;
  const out = editing(root, a, `followup ${String(a.action)}`, (job) => {
    const item = (job.followups ?? []).find((f) => f.n === n);
    if (!item) throw new Refused(`${job.id} has no follow-up ${n}`);
    if (item.status !== 'open') throw new Refused(`follow-up ${n} is already ${item.status}`);
    const status = a.action === 'done' ? 'done' : 'dropped';
    item.status = status;
    item.resolution = list(a, 'note').join(' ').trim() || null;
    item.resolved_at = now();
    job.history.push({ at: now(), stage: job.stage, event: `follow-up ${n} ${status}` });
    return `${job.id}: follow-up ${n} ${status}\n`;
  });
  io.stdout(out);
};

export const cmdFollowupList: Command = (root, a, io) => {
  const ref = a.job as string | null;
  const all = flag(a, 'all');
  const jobs = ref ? [load(root, resolve(root, ref))] : loadListed(root, jobIds(root), io);
  const rows = jobs.flatMap((j) =>
    (j.followups ?? []).filter((f) => all || f.status === 'open').map((f) => ({ ...f, job: j.id })),
  );
  if (flag(a, 'json')) {
    io.stdout(`${dumps(rows)}\n`);
    return;
  }
  if (rows.length === 0) io.stdout(all ? 'no follow-ups\n' : 'no open follow-ups\n');
  for (const f of rows) {
    const mark =
      f.status === 'open' ? '' : `  [${f.status}` + (f.resolution ? `: ${f.resolution}]` : ']');
    io.stdout(`${f.job} #${f.n} (${f.by}, ${f.stage})${mark}\n  ${f.text}\n`);
  }
};

export const cmdPath: Command = (root, a, io) => {
  const job = load(root, resolve(root, s(a, 'job')));
  io.stdout(`${flag(a, 'worktree') ? (job.worktree ?? '') : join(root, 'jobs', job.id)}\n`);
};

const MARK: Record<string, string> = { approve: '+', changes: 'x' };

export const cmdStatus: Command = (root, a, io) => {
  const ref = a.job as string | null;
  const jobs = ref ? [load(root, resolve(root, ref))] : loadListed(root, jobIds(root), io);
  if (flag(a, 'json')) {
    io.stdout(`${dumps(ref ? jobs[0] : jobs)}\n`);
    return;
  }
  if (jobs.length === 0) io.stdout('no jobs yet\n');
  for (const j of jobs) {
    const flagText = j.status === 'needs-human' ? `  !! ${str(j.needs_human)}` : '';
    const rounds = j.rounds
      .map(
        (r) =>
          `r${r.n}[${Object.values(r.reviewers)
            .map((v) => (v.verdict === null ? '.' : (MARK[v.verdict] ?? '?')))
            .join('')}]`,
      )
      .join(' ');
    io.stdout(`${j.id.padEnd(46)} ${j.stage.padEnd(7)} ${j.status.padEnd(11)} ${rounds}${flagText}\n`);
    if (ref) {
      const openFu = (j.followups ?? []).filter((f) => f.status === 'open').length;
      io.stdout(
        `  title:    ${str(j.title)}\n  job dir:  ${join(root, 'jobs', j.id)}\n` +
          `  worktree: ${str(j.worktree)}\n  branch:   ${str(j.branch)}  base: ${str(j.base)}\n` +
          (j.head ? `  built:    ${short(j.head)} (the commit proof, review and merge judge)\n` : '') +
          `  activity: ${str(j.activity)}\n  follow-ups: ${openFu} open (factory followup list ${j.id})\n` +
          (j.owner ? `  owner:    ${personText(j.owner)}\n` : ''),
      );
    }
  }
};

export interface Stats {
  jobs: number;
  approved: number;
  first_pass_proof_rate: Float | null;
  avg_review_rounds: Float | null;
  first_round_approval_rate: Float | null;
  median_hours_to_approval: Float | null;
  escalation_rate: Float | null;
}

/** Line metrics, derived from each job's history. The dashboard computes the same. */
export function stats(jobs: Job[]): Stats {
  const parse = (iso: string): number => Date.parse(iso);
  const firstProofs: boolean[] = [];
  const rounds: number[] = [];
  const hours: number[] = [];
  let escalated = 0;
  for (const j of jobs) {
    const events = j.history;
    const proofs = events
      .map((h) => h.event)
      .filter((e) => e.startsWith('proof passed') || e.startsWith('proof failed'));
    if (proofs.length > 0) firstProofs.push((proofs[0] as string).startsWith('proof passed'));
    const approved = events.find((h) => h.event.startsWith('approved in round '));
    if (approved) {
      rounds.push(Number.parseInt(approved.event.slice(approved.event.lastIndexOf(' ') + 1), 10));
      hours.push((parse(approved.at) - parse(j.created)) / 1000 / 3600);
    }
    if (events.some((h) => h.event.startsWith('needs human:') && !h.event.startsWith('needs human: approved'))) {
      escalated += 1;
    }
  }
  hours.sort((x, y) => x - y);
  const r2 = (v: number): Float => new Float(roundHalfEven(v, 2));
  const sum = (xs: number[]): number => xs.reduce((t, x) => t + x, 0);
  return {
    jobs: jobs.length,
    approved: rounds.length,
    first_pass_proof_rate: firstProofs.length
      ? r2(firstProofs.filter(Boolean).length / firstProofs.length)
      : null,
    avg_review_rounds: rounds.length ? r2(sum(rounds) / rounds.length) : null,
    first_round_approval_rate: rounds.length ? r2(rounds.filter((r) => r === 1).length / rounds.length) : null,
    median_hours_to_approval: hours.length ? r2(hours[Math.floor(hours.length / 2)] as number) : null,
    escalation_rate: jobs.length ? r2(escalated / jobs.length) : null,
  };
}

export const cmdStats: Command = (root, a, io) => {
  const st = stats(loadListed(root, jobIds(root), io));
  if (flag(a, 'json')) {
    io.stdout(`${dumps(st)}\n`);
    return;
  }
  const pct = (v: Float | null): string => (v === null ? '-' : formatPercent(v.value));
  const num = (v: Float | null, unit = ''): string => (v === null ? '-' : `${formatG(v.value)}${unit}`);
  io.stdout(
    `jobs                        ${st.jobs} (${st.approved} approved)\n` +
      `first-pass proof            ${pct(st.first_pass_proof_rate)}\n` +
      `approved in first round     ${pct(st.first_round_approval_rate)}\n` +
      `review rounds to approval   ${num(st.avg_review_rounds)} avg\n` +
      `time to approval            ${num(st.median_hours_to_approval, 'h')} median\n` +
      `escalated to a human        ${pct(st.escalation_rate)}\n`,
  );
};

