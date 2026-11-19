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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumps, Float, formatG, formatPercent, roundHalfEven, str } from './pyfmt.ts';

export const STAGES = ['intake', 'build', 'proof', 'review', 'ship', 'done'] as const;

export interface Config {
  reviewers: string[];
  max_review_rounds: number;
  max_proof_attempts: number;
  spec_gate: boolean;
  /** Repo-relative directory of living behavior specs, if the project keeps them. Intake reads the
   * specs a change touches and gives each one an acceptance criterion. */
  specs_dir: string | null;
}

/** Defaults; a project overrides them in factory.json at the repository root. */
export const DEFAULTS: Readonly<Config> = {
  reviewers: ['security', 'standards', 'behavior'],
  max_review_rounds: 3,
  max_proof_attempts: 3,
  spec_gate: false,
  specs_dir: null,
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
  created: string;
  history: HistoryEntry[];
  updated?: string;
}

/** A gate was not met. */
export class Refused extends Error {}
/** The job was handed to a human. */
export class Escalated extends Error {}

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

/** The repo's primary working tree, even when called from a job worktree. */
export function mainCheckout(): string {
  const p = run('git', ['worktree', 'list', '--porcelain']);
  if (p.status !== 0 || !p.stdout.startsWith('worktree ')) {
    throw new Refused('not inside a git repository (the factory isolates builds in git worktrees)');
  }
  return (p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length);
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

export function factoryDir(): string {
  const env = process.env.FACTORY_DIR;
  return env ? resolveReal(env) : join(mainCheckout(), 'factory');
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

export function loadConfig(root: string): Config {
  const cfg: Config = { ...DEFAULTS, reviewers: [...DEFAULTS.reviewers] };
  const path = configPath(root);
  if (!existsSync(path)) return cfg;
  let user: unknown;
  try {
    user = parseJson(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Refused(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof user !== 'object' || user === null || Array.isArray(user) || user instanceof JsonFloat) {
    throw new Refused(`${path} must be a JSON object`);
  }
  const known = Object.keys(DEFAULTS);
  for (const [key, value] of Object.entries(user as Record<string, unknown>)) {
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
    } else if (!(typeof value === 'number' && Number.isInteger(value) && value >= 1)) {
      throw new Refused(`${path}: '${key}' must be a whole number of at least 1`);
    }
    (cfg as unknown as Record<string, unknown>)[key] = value;
  }
  return cfg;
}

// ---------------------------------------------------------------- job storage

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Run fn while holding the factory lock: a file holding the owner's pid, created atomically.
 * A lock whose owner is gone (a crashed run) is taken over. */
export function locked<T>(root: string, fn: () => T): T {
  const lock = join(root, '.lock.pid');
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

export function load(root: string, jobId: string): Job {
  return JSON.parse(readFileSync(join(root, 'jobs', jobId, 'job.json'), 'utf8')) as Job;
}

export function save(root: string, job: Job): void {
  job.updated = now();
  const path = join(root, 'jobs', job.id, 'job.json');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${dumps(job)}\n`);
  renameSync(tmp, path); // atomic: the dashboard never reads a half-written file
}

/** Load a job under the lock; save it when fn returns, and also when it escalates. */
export function editing<T>(root: string, ref: string, fn: (job: Job) => T): T {
  return locked(root, () => {
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

export const cmdInit: Command = (root, _a, io) => {
  io.stdout(`factory ready at ${root}\ndashboard: factory dashboard\n`);
};

export const cmdNew: Command = (root, a, io) => {
  const title = list(a, 'title').join(' ').trim();
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'job';
  const jobId = locked(root, () => {
    const nums = readdirSync(join(root, 'jobs'))
      .map((name) => name.split('-')[0] ?? '')
      .filter((head) => /^\d+$/.test(head))
      .map((head) => Number.parseInt(head, 10));
    const id = `${String(Math.max(0, ...nums) + 1).padStart(3, '0')}-${slug}`;
    mkdirSync(join(root, 'jobs', id));
    const job: Job = {
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
      created: now(),
      history: [],
    };
    log(job, 'created');
    save(root, job);
    return id;
  });
  io.stdout(
    `${jobId}\njob dir: ${join(root, 'jobs', jobId)}\nnext: write task.md there, then \`factory start ${jobId}\`\n`,
  );
};

export const cmdStart: Command = (root, a, io) => {
  const out = editing(root, s(a, 'job'), (job) => {
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
    git(['worktree', 'add', '-b', branch, wt, base], main);
    job.worktree = wt;
    move(job, 'build', 'building');
    return `worktree: ${wt}\nbranch: ${branch}\nbase: ${base}\n`;
  });
  io.stdout(out);
};

export const cmdSpec: Command = (root, a, io) => {
  const id = editing(root, s(a, 'job'), (job) => {
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
  const id = editing(root, s(a, 'job'), (job) => {
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

export const cmdBuilt: Command = (root, a, io) => {
  const id = editing(root, s(a, 'job'), (job) => {
    requireStage(job, 'build');
    requireFile(root, job, 'build.md');
    const wt = job.worktree;
    if (git(['status', '--porcelain'], wt)) {
      throw new Refused(`uncommitted changes in ${str(wt)} - commit them; reviewers read commits`);
    }
    if (git(['rev-list', '--count', `${str(job.base)}..HEAD`], wt) === '0') {
      throw new Refused(`no commits on ${str(job.branch)} since ${str(job.base).slice(0, 8)}`);
    }
    move(job, 'proof', 'awaiting independent proof');
    return job.id;
  });
  io.stdout(`${id} -> proof\n`);
};

export const cmdProof: Command = (root, a, io) => {
  const out = editing(root, s(a, 'job'), (job) => {
    requireStage(job, 'proof');
    requireFile(root, job, 'proof.md');
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
  const out = editing(root, s(a, 'job'), (job) => {
    requireStage(job, 'review');
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
  const out = editing(root, s(a, 'job'), (job) => {
    requireStage(job, 'review');
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
  editing(root, s(a, 'job'), (job) => {
    needHuman(job, list(a, 'reason').join(' '));
    throw new Escalated(`${job.id} flagged for a human: ${str(job.needs_human)}`);
  });
};

export const cmdResume: Command = (root, a, io) => {
  const reset = flag(a, 'reset');
  const out = editing(root, s(a, 'job'), (job) => {
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

/** The human gate. hooks/hooks.json (src/human-gate.ts) makes Claude Code ask before this runs. */
export const cmdMerge: Command = (root, a, io) => {
  const out = editing(root, s(a, 'job'), (job) => {
    requireStage(job, 'ship');
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
    const p = run('git', ['merge', '--no-ff', '-m', `Merge ${branch}: ${job.title}`, branch], main);
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
  const out = editing(root, s(a, 'job'), (job) => {
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
  const out = editing(root, s(a, 'job'), (job) => {
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

export const cmdConfig: Command = (root, a, io) => {
  const path = configPath(root);
  const source = existsSync(path) ? path : `defaults (create ${path} to override)`;
  io.stdout(`${dumps(a.cfg)}\n`);
  io.stderr(`# from ${source}\n`);
};

export const cmdNote: Command = (root, a) => {
  editing(root, s(a, 'job'), (job) => log(job, list(a, 'text').join(' ')));
};

export const cmdFollowupAdd: Command = (root, a, io) => {
  const text = list(a, 'text').join(' ').trim();
  const by = s(a, 'by');
  if (!text) throw new Refused('say what the follow-up is: factory followup add <job> --by <who> <text>');
  if (!NAME.test(by)) {
    throw new Refused('--by must be a lowercase name like builder, verifier, security or human');
  }
  const out = editing(root, s(a, 'job'), (job) => {
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
  const out = editing(root, s(a, 'job'), (job) => {
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
  const ids = ref ? [resolve(root, ref)] : jobIds(root);
  const rows = ids.flatMap((i) =>
    (load(root, i).followups ?? []).filter((f) => all || f.status === 'open').map((f) => ({ ...f, job: i })),
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
  const ids = ref ? [resolve(root, ref)] : jobIds(root);
  const jobs = ids.map((i) => load(root, i));
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
          `  activity: ${str(j.activity)}\n  follow-ups: ${openFu} open (factory followup list ${j.id})\n`,
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
  const st = stats(jobIds(root).map((i) => load(root, i)));
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

