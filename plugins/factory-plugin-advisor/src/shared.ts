// Opt-in sharing: with factory.json `"advisor": {"share": true}` and a remote factory (`remote`), every
// occurrence is also appended to `advisor/occurrences.jsonl` on the remote factory's state branch, and
// the issue state (suggested, dismissed, filed) lives in `advisor/state.json` there, so a team pools
// what the advisor learns. Off, or without a remote, nothing here runs.
//
// Only what the local log already holds is shared: summaries and details redacted and masked before
// anything is written (advisor.ts record), plus a random id (to count an occurrence once when it is
// both in the local log and the shared one) and, only when the user sets
// FACTORY_PLUGIN_ADVISOR_SHARE_AS, the name they chose. The commits carry a fixed author, never the
// user's git identity.
//
// The git side follows the factory's remote sync (pull, change, commit, push, retry on a lost race),
// without a working tree: a bare clone in the advisor's own config dir, and each change built with
// plumbing on top of the branch's newest tip, so it touches only `advisor/` and never conflicts with
// a job. Occurrences wait in a local queue until a push lands; nothing here ever throws into the hook.
//
// Several processes of one user (records, hooks, any command) share that bare clone and queue. An
// occurrence is written to the queue before any git runs, so it is never lost to a git failure, and
// every git step on the clone (creating it, fetch, commit, push) runs under one lock file per clone.
// A process that cannot take the lock within LOCK_WAIT_MS leaves the queue to the next command.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Env } from './plugins.ts';
import type { IssueState, Occurrence, State, StationState } from './store.ts';

export const SHARE_AS_ENV = 'FACTORY_PLUGIN_ADVISOR_SHARE_AS';
/** The state branch's directory the advisor writes, and nothing else. */
export const SHARED_DIR = 'advisor';
export const SHARED_LOG = 'occurrences.jsonl';
export const SHARED_STATE = 'state.json';
/** How many times a push that lost a race is retried, as the factory does. */
export const PUSH_ATTEMPTS = 5;
/** The shared log is trimmed to its newest SHARED_MAX_LINES occurrences once it grows past this. */
export const SHARED_MAX_BYTES = 4 * 1024 * 1024;
export const SHARED_MAX_LINES = 10_000;
/** Queued occurrences kept while the remote cannot be reached; the oldest go first. */
export const QUEUE_MAX = 500;
/** The author of every commit the advisor pushes: never the user's identity. */
export const AUTHOR = { name: 'factory-plugin-advisor', email: 'factory-plugin-advisor@users.noreply.invalid' } as const;
/** How long a process waits for another one of the same user to finish with the bare clone. */
export const LOCK_WAIT_MS = 5_000;
/** The lock file, in the clone's dir: it holds the pid of the process using the clone. */
export const LOCK_FILE = 'lock';
/** How many times one sync pushes again for occurrences queued while it ran. */
const SYNC_ROUNDS = 3;
const NETWORK_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 10_000;

export interface ShareConfig {
  /** The remote factory's git URL or path (a ./ or ../ path made absolute against factory.json). */
  url: string;
  branch: string;
  /** The factory.json that turned sharing on. */
  configPath: string;
  /** FACTORY_PLUGIN_ADVISOR_SHARE_AS, when the user opted in to sharing a name. */
  by?: string;
  /** Why FACTORY_PLUGIN_ADVISOR_SHARE_AS was ignored, if it was. */
  byProblem?: string;
}

// ------------------------------------------------------------------ configuration

const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** The factory's own rules for remote.branch (plugins/factory/src/remote.ts branchOk). */
export function branchOk(b: string): boolean {
  return (
    b.length <= 200 &&
    BRANCH.test(b) &&
    b !== 'HEAD' &&
    !b.includes('..') &&
    !b.endsWith('/') &&
    !b.endsWith('.') &&
    !b.endsWith('.lock') &&
    !b.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))
  );
}

/** The factory's own rules for remote.url: no control characters, no leading `-`, no `<helper>::`. */
export function urlOk(u: string): boolean {
  return u.trim() !== '' && u.length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(u) && !u.startsWith('-') && !/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u);
}

export const SHARE_AS = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** factory.json: FACTORY_DIR's parent, else the main checkout of the repository holding `cwd`. */
export function factoryJsonPath(env: Env, cwd: string): string | null {
  const fdir = env.FACTORY_DIR;
  if (fdir !== undefined && fdir !== '') return join(dirname(resolve(cwd, fdir)), 'factory.json');
  const p = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', env: gitEnv(env), timeout: LOCAL_TIMEOUT_MS });
  if (p.status !== 0 || !(p.stdout ?? '').startsWith('worktree ')) return null;
  const main = (p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length);
  return main === '' ? null : join(main, 'factory.json');
}

/**
 * The sharing settings in the factory.json at `path`, or why there are none: no such file,
 * `advisor.share` not true, or no valid `remote` (the factory refuses such a factory.json itself;
 * here it simply means local only).
 */
export function readShareConfig(env: Env, path: string): ShareConfig | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? `no factory.json at ${path}` : `${path} is not valid JSON`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `${path} is not a JSON object`;
  const cfg = parsed as Record<string, unknown>;
  const advisor = cfg.advisor;
  if (typeof advisor !== 'object' || advisor === null || (advisor as Record<string, unknown>).share !== true) return `${path} does not set "advisor": {"share": true}`;
  const remote = cfg.remote;
  if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) return `${path} has no remote factory ("remote": {"url", "branch"})`;
  const { url, branch } = remote as Record<string, unknown>;
  if (typeof url !== 'string' || !urlOk(url) || typeof branch !== 'string' || !branchOk(branch)) return `${path} has no valid remote.url and remote.branch`;
  const abs = url.startsWith('./') || url.startsWith('../') ? resolve(dirname(path), url) : url;
  const out: ShareConfig = { url: abs, branch, configPath: path };
  const as = env[SHARE_AS_ENV];
  if (as !== undefined && as !== '') {
    if (SHARE_AS.test(as)) out.by = as;
    else out.byProblem = `${SHARE_AS_ENV} is ignored: it must be 1 to 64 letters, digits, spaces, '.', '_' or '-' (no email or @mention), starting with a letter or digit`;
  }
  return out;
}

/**
 * What factory.json asks for: the sharing settings, or null when sharing is off. This is the
 * repository's request only; whether anything is shared also needs the user's own acknowledgement
 * of that remote (`allowed`).
 */
export function shareConfig(env: Env, cwd: string): ShareConfig | null {
  const path = factoryJsonPath(env, cwd);
  if (path === null) return null;
  const out = readShareConfig(env, path);
  return typeof out === 'string' ? null : out;
}

/** The remote as it may be printed: credentials in an https URL (`user:token@`) are dropped. */
export function displayUrl(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, '$1');
}

// ------------------------------------------------------------------ the user's acknowledgement

// factory.json belongs to the repository, so a cloned or untrusted repository can ask for sharing
// and choose where it goes. Nothing is shared with, and nothing is read from, a remote the user has
// not acknowledged themselves (`share allow`), in a file in the advisor's own config dir that no
// repository can write. The acknowledgement is for one normalised URL and one branch: a factory.json
// that names another needs another.

/** The acknowledged remotes, in the advisor's config dir. */
export const ALLOW_FILE = 'share-allowed.json';
/** The sessions already told that sharing is configured but not acknowledged. */
export const NOTICE_FILE = 'share-noticed.json';

export interface Allowed {
  /** The remote's URL, normalised (normaliseUrl): no credentials, lower-case scheme and host, no trailing `/`. */
  url: string;
  branch: string;
  /** When the user acknowledged it (ISO). */
  at: string;
}

/**
 * The form a remote is acknowledged and compared in: a `scheme://` URL loses its user info (never a
 * token on disk) and gets a lower-case scheme and host; an scp-like `[user@]host:path` a lower-case
 * host; an absolute path is resolved (`..`, `.` and `//` folded). Trailing slashes go.
 */
export function normaliseUrl(url: string): string {
  const u = url.trim();
  const strip = (path: string): string => path.replace(/\/+$/, '');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/]*)(.*)$/.exec(u);
  if (scheme !== null) return `${(scheme[1] ?? '').toLowerCase()}://${(scheme[2] ?? '').toLowerCase()}${strip(scheme[3] ?? '')}`;
  if (isAbsolute(u)) return resolve(u);
  if (/^[A-Za-z]:[\\/]/.test(u)) return u;
  const scp = /^((?:[^@/]*@)?)([^/:]+):(.*)$/.exec(u);
  if (scp !== null) return `${scp[1] ?? ''}${(scp[2] ?? '').toLowerCase()}:${strip(scp[3] ?? '')}`;
  return strip(u);
}

/** The acknowledged remotes; an empty list when the file is missing or unreadable, and only well-formed entries. */
export function readAllowed(configDir: string): Allowed[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(configDir, ALLOW_FILE), 'utf8'));
  } catch {
    return [];
  }
  const remotes = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).remotes : undefined;
  if (!Array.isArray(remotes)) return [];
  const out: Allowed[] = [];
  for (const r of remotes as unknown[]) {
    if (typeof r !== 'object' || r === null) continue;
    const { url, branch, at } = r as Record<string, unknown>;
    if (typeof url === 'string' && urlOk(url) && typeof branch === 'string' && branchOk(branch) && typeof at === 'string' && ISO.test(at)) out.push({ url, branch, at });
  }
  return out;
}

/** Whether the user acknowledged exactly this remote URL and branch. */
export function allowed(configDir: string, share: ShareConfig): boolean {
  const url = normaliseUrl(share.url);
  return readAllowed(configDir).some((a) => a.url === url && a.branch === share.branch);
}

function writeAllowed(configDir: string, list: Allowed[], files: Files): void {
  files.ensureDir(configDir);
  files.writeFile(join(configDir, ALLOW_FILE), `${JSON.stringify({ version: 1, remotes: list }, null, 2)}\n`);
}

/** Acknowledges the remote factory.json names; `added` is false when it already was. */
export function allowRemote(configDir: string, share: ShareConfig, files: Files, now: Date): { entry: Allowed; added: boolean } {
  const list = readAllowed(configDir);
  const url = normaliseUrl(share.url);
  const have = list.find((a) => a.url === url && a.branch === share.branch);
  if (have !== undefined) return { entry: have, added: false };
  const entry: Allowed = { url, branch: share.branch, at: now.toISOString() };
  writeAllowed(configDir, [...list, entry], files);
  return { entry, added: true };
}

/**
 * Removes the acknowledgement of `url` (normalised; a ./ or ../ path is taken against `cwd`) on
 * `branch`, or on every branch when none is given. Returns what was removed.
 */
export function revokeRemote(configDir: string, url: string, branch: string | undefined, files: Files, cwd: string): Allowed[] {
  const list = readAllowed(configDir);
  const target = normaliseUrl(url.startsWith('./') || url.startsWith('../') ? resolve(cwd, url) : url);
  const gone = list.filter((a) => a.url === target && (branch === undefined || a.branch === branch));
  if (gone.length > 0) writeAllowed(configDir, list.filter((a) => !gone.includes(a)), files);
  return gone;
}

/**
 * True the first time `key` is seen in this Claude Code session (CLAUDE_CODE_SESSION_ID), recorded in
 * the JSON list at `path`; outside a session, every run is its own session and this is always true.
 */
function firstInSession(path: string, key: string, env: Env, files: Files): boolean {
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (session === undefined || session === '') return true;
  let seen: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(parsed)) seen = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    // never said yet
  }
  const id = createHash('sha256').update(`${session}\n${key}`).digest('hex').slice(0, 16);
  if (seen.includes(id)) return false;
  try {
    files.ensureDir(dirname(path));
    files.writeFile(path, `${JSON.stringify([...seen, id].slice(-20))}\n`);
  } catch {
    // said anyway; it may be said again
  }
  return true;
}

/** The `share allow` command line for the repository whose factory.json is `configPath`. */
export function allowCommand(share: ShareConfig): string {
  const repo = dirname(share.configPath);
  return `factory-plugin-advisor share allow --repo ${/^[A-Za-z0-9_./-]+$/.test(repo) ? repo : `'${repo.replaceAll("'", `'\\''`)}'`}`;
}

/**
 * The one-line notice that factory.json asks for sharing the user has not acknowledged, once per
 * Claude Code session and remote; null when it was said already in this session.
 */
export function unacknowledgedNotice(configDir: string, share: ShareConfig, env: Env, files: Files): string | null {
  if (!firstInSession(join(configDir, NOTICE_FILE), `${normaliseUrl(share.url)}\n${share.branch}`, env, files)) return null;
  return `${share.configPath} turns on sharing with ${displayUrl(share.url)} (branch ${share.branch}), but you have not acknowledged that remote, so nothing is shared or read from it; to share, run: ${allowCommand(share)}`;
}

// ------------------------------------------------------------------ the public-remote warning

/** Hosts that serve public repositories (among private ones): a repo there may be public. */
export const PUBLIC_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht', 'gitee.com', 'sourceforge.net', 'launchpad.net', 'huggingface.co'];

/** The host of a git URL (`scheme://[user@]host[:port]/...` or scp-like `[user@]host:path`), or null for a local path. */
export function remoteHost(url: string): string | null {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)/.exec(url);
  if (scheme !== null) return (scheme[1] ?? '').toLowerCase() === 'file' ? null : (scheme[2] ?? '').toLowerCase();
  if (isAbsolute(url) || url.startsWith('.') || /^[A-Za-z]:[\\/]/.test(url)) return null;
  // scp-like syntax: a colon before the first slash.
  const scp = /^(?:[^@/]*@)?([^/:]+):/.exec(url);
  return scp === null ? null : (scp[1] ?? '').toLowerCase();
}

/** A host that is plainly on a private network: localhost, a private or loopback IP, a single label, or a private-use domain. */
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /^(fc|fd)[0-9a-f]{0,2}:/i.test(h)) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (ip !== null) {
    const a = Number(ip[1]);
    const b = Number(ip[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (!h.includes('.')) return true;
  return /\.(local|localhost|internal|intranet|corp|lan|home\.arpa)$/.test(h);
}

/**
 * The one-line warning for a shared log on a remote that is, or may be, public; null when it plainly
 * is not (a local path or a private-network host). It needs no network: a repo on a host that serves
 * public repositories cannot be told public or private offline, so it is warned about, and so is any
 * host the advisor cannot place.
 */
export function publicWarning(share: ShareConfig): string | null {
  const host = remoteHost(share.url);
  if (host === null || privateHost(host)) return null;
  const known = PUBLIC_HOSTS.find((p) => host === p || host.endsWith(`.${p}`));
  const where = known !== undefined ? `${host}, which hosts public repositories` : `${host}, which the advisor cannot tell is private`;
  return `factory-plugin-advisor: warning: sharing the redacted friction log on ${where} (factory.json advisor.share); if that repository is public, anyone can read the shared occurrences`;
}

// ------------------------------------------------------------------ validating what comes from the remote

const ID = /^[0-9a-f]{16}$/;
const SIG = /^[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const PLUGIN = /^(?:none|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const KIND = /^(?:cli-failure|workaround|manual-step|missing-guidance|user-correction)$/;
const LINE = /^[^\u0000-\u001f\u007f]*$/;
const MULTILINE = /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/;

export function newId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * An occurrence read from the shared log (anyone who can push to the branch wrote it): exactly the
 * fields the advisor writes, with the shapes it writes them in, or null.
 */
export function sharedOccurrence(value: unknown): Occurrence | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const str = (k: string, max: number, re: RegExp = LINE): boolean => typeof o[k] === 'string' && (o[k] as string).length <= max && re.test(o[k] as string);
  if (!str('signature', 12, SIG) || !str('plugin', 64, PLUGIN) || !str('kind', 32, KIND) || !str('summary', 400) || !str('at', 40, ISO)) return null;
  if (o.source !== 'record' && o.source !== 'hook') return null;
  if (!str('id', 16, ID)) return null;
  if (o.detail !== undefined && !str('detail', 4000, MULTILINE)) return null;
  if (o.subcommand !== undefined && !str('subcommand', 40, /^[a-z][a-z0-9-]{0,39}$/)) return null;
  if (o.exitCode !== undefined && !(typeof o.exitCode === 'number' && Number.isInteger(o.exitCode) && o.exitCode >= 0 && o.exitCode < 1000)) return null;
  if (o.by !== undefined && !str('by', 64, SHARE_AS)) return null;
  const known = new Set(['signature', 'plugin', 'kind', 'summary', 'detail', 'at', 'source', 'subcommand', 'exitCode', 'id', 'by']);
  if (Object.keys(o).some((k) => !known.has(k))) return null;
  return o as unknown as Occurrence;
}

export function parseLog(text: string, check: (value: unknown) => Occurrence | null): Occurrence[] {
  const out: Occurrence[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o = check(JSON.parse(line));
      if (o !== null) out.push(o);
    } catch {
      // a torn or hand-edited line
    }
  }
  return out;
}

const EMPTY: State = { version: 1, issues: {} };

function cleanIssue(value: unknown): IssueState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: IssueState = {};
  if (typeof v.suggestedCount === 'number' && Number.isInteger(v.suggestedCount) && v.suggestedCount >= 0) out.suggestedCount = v.suggestedCount;
  if (typeof v.suggestedAt === 'string' && ISO.test(v.suggestedAt)) out.suggestedAt = v.suggestedAt;
  if (typeof v.dismissedAt === 'string' && ISO.test(v.dismissedAt)) out.dismissedAt = v.dismissedAt;
  const f = v.filed as Record<string, unknown> | undefined;
  if (
    typeof f === 'object' && f !== null &&
    typeof f.url === 'string' && /^https:\/\/[^\s\u0000-\u001f\u007f]{1,300}$/.test(f.url) &&
    typeof f.repo === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(f.repo) &&
    typeof f.at === 'string' && ISO.test(f.at)
  ) {
    out.filed = { url: f.url, repo: f.repo, at: f.at };
  }
  return out;
}

function cleanStation(value: unknown): StationState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if ((v.status !== 'drafted' && v.status !== 'applied' && v.status !== 'dismissed') || typeof v.at !== 'string' || !ISO.test(v.at)) return null;
  return { status: v.status, at: v.at };
}

/** The shared state.json, keeping only well-formed entries; an empty state when it is missing or unreadable. */
export function parseState(text: string | null): State {
  if (text === null) return { ...EMPTY, issues: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...EMPTY, issues: {} };
  }
  const out: State = { version: 1, issues: {} };
  if (typeof parsed !== 'object' || parsed === null) return out;
  const p = parsed as Record<string, unknown>;
  for (const [sig, value] of Object.entries(typeof p.issues === 'object' && p.issues !== null ? p.issues : {})) {
    const issue = cleanIssue(value);
    if (SIG.test(sig) && issue !== null) out.issues[sig] = issue;
  }
  for (const [key, value] of Object.entries(typeof p.stations === 'object' && p.stations !== null ? p.stations : {})) {
    const s = cleanStation(value);
    if (/^[0-9a-f]{12}\/[a-z0-9-]{1,80}$/.test(key) && s !== null) (out.stations ??= {})[key] = s;
  }
  return out;
}

const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : a >= b ? a : b);
const earlier = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : a <= b ? a : b);

/**
 * Two states as one. State only grows (nothing un-dismisses or un-files an issue), so the merge is a
 * union: dismissed or filed on either side stays so, the highest suggested count wins, and a station
 * suggestion keeps its newest status. One person's dismiss therefore survives another's suggest.
 */
export function mergeState(a: State, b: State): State {
  const out: State = { version: 1, issues: {} };
  for (const sig of new Set([...Object.keys(a.issues), ...Object.keys(b.issues)])) {
    const x = a.issues[sig] ?? {};
    const y = b.issues[sig] ?? {};
    const m: IssueState = {};
    const count = Math.max(x.suggestedCount ?? -1, y.suggestedCount ?? -1);
    if (count >= 0) m.suggestedCount = count;
    const suggestedAt = later(x.suggestedAt, y.suggestedAt);
    if (suggestedAt !== undefined) m.suggestedAt = suggestedAt;
    const dismissedAt = earlier(x.dismissedAt, y.dismissedAt);
    if (dismissedAt !== undefined) m.dismissedAt = dismissedAt;
    const filed = x.filed === undefined ? y.filed : y.filed === undefined ? x.filed : x.filed.at <= y.filed.at ? x.filed : y.filed;
    if (filed !== undefined) m.filed = filed;
    out.issues[sig] = m;
  }
  const stations = { ...(a.stations ?? {}) };
  for (const [key, s] of Object.entries(b.stations ?? {})) {
    const have = stations[key];
    if (have === undefined || s.at > have.at) stations[key] = s;
  }
  if (Object.keys(stations).length > 0) out.stations = stations;
  return out;
}

/** The occurrence's key for counting it once: its id, or (an old local line without one) its JSON. */
export function occurrenceKey(o: Occurrence): string {
  return o.id ?? JSON.stringify(o);
}

// ------------------------------------------------------------------ git

interface Proc {
  status: number;
  stdout: string;
  stderr: string;
}

/** The environment git runs in: never a prompt, never another repository's GIT_DIR or index, a fixed author. */
function gitEnv(env: Env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|PREFIX|AUTHOR_\w+|COMMITTER_\w+)$/.test(k)) continue;
    out[k] = v;
  }
  return {
    ...out,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
    ...extra,
  };
}

/** 'busy': another process of this user held the clone's lock for LOCK_WAIT_MS; nothing was fetched or pushed. */
export type Sync = 'ok' | 'unreachable' | 'busy';

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

/** What the shared side needs from the Store: owner-only directories and files in the config dir. */
export interface Files {
  ensureDir: (dir: string) => void;
  writeFile: (path: string, text: string) => void;
}

/**
 * The shared log of one remote factory: a bare clone at `<config dir>/shared/<key>/repo.git` (key: a
 * hash of the URL and branch), the queue of occurrences not yet pushed at `.../queue/<id>.json`, and
 * the sessions already warned about a public remote.
 */
export class SharedLog {
  readonly share: ShareConfig;
  readonly dir: string;
  readonly bare: string;
  readonly queueDir: string;
  /** One line each, for the CLI's stderr: what could not be shared or read, and why. */
  readonly notes: string[] = [];

  private readonly env: Env;
  private readonly files: Files;
  private fetched: Sync | 'missing' | null = null;

  constructor(configDir: string, share: ShareConfig, env: Env, files: Files) {
    this.share = share;
    this.env = env;
    this.files = files;
    const key = createHash('sha256').update(`${share.url}\n${share.branch}`).digest('hex').slice(0, 12);
    this.dir = join(configDir, 'shared', key);
    this.bare = join(this.dir, 'repo.git');
    this.queueDir = join(this.dir, 'queue');
  }

  private get tracking(): string {
    return `refs/remotes/origin/${this.share.branch}`;
  }

  private git(args: string[], options: { input?: string; env?: Record<string, string>; network?: boolean } = {}): Proc {
    const p = spawnSync('git', ['--git-dir', this.bare, ...args], {
      encoding: 'utf8',
      env: gitEnv(this.env, options.env),
      timeout: options.network === true ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (p.error !== undefined) return { status: 127, stdout: '', stderr: p.error.message };
    return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
  }

  private must(args: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
    const p = this.git(args, options);
    if (p.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${p.stderr.trim()}`);
    return p.stdout.trim();
  }

  /**
   * Runs `fn` holding the clone's lock (the factory's `locked()`: a hard link that fails while the
   * lock exists; a lock whose pid is not alive is stale and taken over). 'busy' when another live
   * process holds it for LOCK_WAIT_MS.
   */
  private locked<T>(fn: () => T): T | 'busy' {
    this.files.ensureDir(dirname(this.dir));
    this.files.ensureDir(this.dir);
    const lock = join(this.dir, LOCK_FILE);
    const mine = join(this.dir, `lock.${process.pid}.tmp`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    writeFileSync(mine, `${process.pid}\n`, { mode: 0o600 });
    try {
      for (;;) {
        try {
          linkSync(mine, lock);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        let owner = NaN;
        try {
          owner = Number.parseInt(readFileSync(lock, 'utf8'), 10);
        } catch {
          continue; // released between the attempt and the read
        }
        if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) {
          // Stale: moved aside under a unique name first, so two processes never both remove a live lock.
          const aside = join(this.dir, `lock.stale.${process.pid}`);
          try {
            renameSync(lock, aside);
            const again = Number.parseInt(readFileSync(aside, 'utf8'), 10);
            if (again === owner || Number.isNaN(again)) unlinkSync(aside);
            else renameSync(aside, lock); // taken in between: put it back
          } catch {
            // lost a race with another process doing the same; try again
          }
          continue;
        }
        if (Date.now() >= deadline) return 'busy';
        sleep(20);
      }
    } finally {
      rmSync(mine, { force: true });
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  /** Creates the bare clone (owner-only) and points its origin at the configured remote. Under the lock only. */
  private init(): void {
    if (!existsSync(join(this.bare, 'HEAD'))) {
      rmSync(this.bare, { recursive: true, force: true });
      const p = spawnSync('git', ['init', '-q', '--bare', this.bare], { encoding: 'utf8', env: gitEnv(this.env), timeout: LOCAL_TIMEOUT_MS });
      if (p.status !== 0) throw new Error(`git init failed: ${(p.stderr ?? '').trim()}`);
      // No background gc or maintenance: the hook's process must be all there is.
      for (const [k, v] of [['gc.auto', '0'], ['maintenance.auto', 'false'], ['core.hooksPath', '/dev/null']]) this.must(['config', k as string, v as string]);
    }
    if (this.git(['config', '--get', 'remote.origin.url']).stdout.trim() !== this.share.url) this.must(['config', 'remote.origin.url', this.share.url]);
  }

  /** Fetch the branch into the tracking ref: 'missing' when the remote has no such branch yet. */
  private fetch(): Sync | 'missing' {
    const p = this.git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${this.share.branch}:${this.tracking}`], { network: true });
    if (p.status === 0) return 'ok';
    if (/couldn't find remote ref/i.test(p.stderr)) {
      this.git(['update-ref', '-d', this.tracking]);
      return 'missing';
    }
    return 'unreachable';
  }

  private tip(): string | null {
    const p = this.git(['rev-parse', '--verify', '-q', `${this.tracking}^{commit}`]);
    return p.status === 0 ? p.stdout.trim() : null;
  }

  private read(tip: string | null, name: string): string | null {
    if (tip === null) return null;
    const p = this.git(['cat-file', 'blob', `${tip}:${SHARED_DIR}/${name}`]);
    return p.status === 0 ? p.stdout : null;
  }

  /**
   * Pull, change, commit, push; on a lost race, again on the new tip (up to PUSH_ATTEMPTS). `change`
   * gets each shared file as it is on the tip and returns the files to write, or null for no change.
   */
  private update(message: string, change: (read: (name: string) => string | null) => Record<string, string> | null): Sync {
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      const fetched = this.fetch();
      this.fetched = fetched;
      if (fetched === 'unreachable') return 'unreachable';
      const tip = this.tip();
      const files = change((name) => this.read(tip, name));
      if (files === null) return 'ok';
      const index = join(this.dir, `index.${process.pid}`);
      let commit: string;
      try {
        const env = { GIT_INDEX_FILE: index };
        this.must(tip === null ? ['read-tree', '--empty'] : ['read-tree', tip], { env });
        for (const [name, text] of Object.entries(files)) {
          const blob = this.must(['hash-object', '-w', '--stdin'], { input: text });
          this.must(['update-index', '--add', '--cacheinfo', `100644,${blob},${SHARED_DIR}/${name}`], { env });
        }
        const tree = this.must(['write-tree'], { env });
        commit = this.must(['commit-tree', tree, ...(tip === null ? [] : ['-p', tip]), '-m', message]);
      } finally {
        rmSync(index, { force: true });
      }
      const p = this.git(['push', '-q', 'origin', `${commit}:refs/heads/${this.share.branch}`], { network: true });
      if (p.status === 0) {
        this.git(['update-ref', this.tracking, commit]);
        return 'ok';
      }
      const race =
        /\[rejected\].*\((fetch first|non-fast-forward)\)/.test(p.stderr) ||
        /\[remote rejected\].*\((cannot lock ref|failed to update ref|incorrect old value)/.test(p.stderr);
      if (!race) return 'unreachable';
    }
    return 'unreachable';
  }

  /**
   * Puts one occurrence in the queue (a file of its own, written atomically, so concurrent hooks never
   * clash). No git runs here: the occurrence is queued even when the clone cannot be set up.
   */
  queue(o: Occurrence): void {
    this.files.ensureDir(dirname(this.dir));
    this.files.ensureDir(this.dir);
    this.files.ensureDir(this.queueDir);
    this.files.writeFile(join(this.queueDir, `${o.id ?? newId()}.json`), `${JSON.stringify(o)}\n`);
    const all = this.queued();
    if (all.length > QUEUE_MAX) {
      for (const q of all.sort((a, b) => a.o.at.localeCompare(b.o.at)).slice(0, all.length - QUEUE_MAX)) rmSync(join(this.queueDir, q.name), { force: true });
    }
  }

  private queued(): Array<{ name: string; o: Occurrence }> {
    let names: string[];
    try {
      names = readdirSync(this.queueDir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
    } catch {
      return [];
    }
    const out: Array<{ name: string; o: Occurrence }> = [];
    for (const name of names) {
      try {
        const o = sharedOccurrence(JSON.parse(readFileSync(join(this.queueDir, name), 'utf8')));
        if (o !== null) out.push({ name, o });
        else rmSync(join(this.queueDir, name), { force: true });
      } catch {
        // half-written by a concurrent writer: the next sync takes it
      }
    }
    return out;
  }

  /**
   * Pull, and push the queue (oldest first) plus any state change that could not be pushed before.
   * Runs once per command; never throws. When another process holds the clone's lock too long, it
   * does nothing ('busy') and says nothing: the queue waits for the next command.
   */
  sync(): Sync {
    if (this.fetched !== null) return this.fetched === 'missing' ? 'ok' : this.fetched;
    try {
      const result = this.locked(() => this.syncLocked());
      if (result === 'busy') this.fetched = 'busy';
      return result;
    } catch (error) {
      this.notes.push(`shared log: ${(error as Error).message}`);
      this.fetched = 'unreachable';
      return 'unreachable';
    }
  }

  private syncLocked(): Sync {
    this.init();
    let result: Sync = 'ok';
    const tried = new Set<string>();
    for (let round = 1; round <= SYNC_ROUNDS; round++) {
      // Occurrences queued by other processes while this one pushed are taken along (a few rounds at most).
      const queued = this.queued().sort((a, b) => a.o.at.localeCompare(b.o.at));
      if (round > 1 && queued.every((q) => tried.has(q.name))) break;
      for (const q of queued) tried.add(q.name);
      if (queued.length === 0) {
        if (round === 1) {
          const f = this.fetch();
          this.fetched = f;
          result = f === 'unreachable' ? 'unreachable' : 'ok';
        }
        break;
      }
      result = this.update(`factory-plugin-advisor: record ${queued.length} occurrence${queued.length === 1 ? '' : 's'}`, (read) => {
        const current = read(SHARED_LOG) ?? '';
        const have = new Set(parseLog(current, sharedOccurrence).map((o) => o.id));
        const add = queued.filter((q) => !have.has(q.o.id));
        if (add.length === 0) return null;
        let text = `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${add.map((q) => `${JSON.stringify(q.o)}\n`).join('')}`;
        if (Buffer.byteLength(text) > SHARED_MAX_BYTES) text = `${text.split('\n').filter((l) => l !== '').slice(-SHARED_MAX_LINES).join('\n')}\n`;
        return { [SHARED_LOG]: text };
      });
      if (result !== 'ok') break;
      for (const q of queued) rmSync(join(this.queueDir, q.name), { force: true });
    }
    if (result === 'ok' && existsSync(this.pendingPath)) {
      // A state change made while the remote was unreachable: the merged local state carries it.
      try {
        const text = readFileSync(this.pendingPath, 'utf8');
        if (this.pushState(parseState(text)) === 'ok' && readFileSync(this.pendingPath, 'utf8') === text) unlinkSync(this.pendingPath);
      } catch {
        // kept for the next sync
      }
    }
    if (result === 'unreachable') this.notes.push(`cannot reach the remote factory ${displayUrl(this.share.url)} (branch ${this.share.branch}); occurrences wait in ${this.queueDir} and are pushed by the next command that reaches it`);
    return result;
  }

  private get pendingPath(): string {
    return join(this.dir, 'state-pending.json');
  }

  /** The shared occurrences as last fetched (after one sync per command). */
  occurrences(): Occurrence[] {
    this.sync();
    try {
      return parseLog(this.read(this.tip(), SHARED_LOG) ?? '', sharedOccurrence);
    } catch {
      return [];
    }
  }

  /** The shared state as last fetched. */
  state(): State {
    this.sync();
    try {
      return parseState(this.read(this.tip(), SHARED_STATE));
    } catch {
      return parseState(null);
    }
  }

  private pushState(state: State): Sync {
    return this.update('factory-plugin-advisor: update state', (read) => {
      const current = read(SHARED_STATE);
      const text = `${JSON.stringify(mergeState(parseState(current), state), null, 2)}\n`;
      return text === current ? null : { [SHARED_STATE]: text };
    });
  }

  /**
   * Merges `state` into the shared state.json and pushes it. When the remote cannot be reached, the
   * state is kept in state-pending.json and pushed by the next sync that reaches it.
   */
  saveState(state: State): Sync {
    let result: Sync;
    try {
      result = this.locked(() => {
        this.init();
        return this.pushState(state);
      });
    } catch {
      result = 'unreachable';
    }
    if (result === 'ok') {
      rmSync(this.pendingPath, { force: true });
    } else {
      try {
        this.files.writeFile(this.pendingPath, `${JSON.stringify(state)}\n`);
      } catch {
        // the local state.json still holds it
      }
      this.notes.push(
        result === 'busy'
          ? `another factory-plugin-advisor command is using the shared log; the state change is saved locally and pushed by the next command`
          : `cannot reach the remote factory ${displayUrl(this.share.url)} (branch ${this.share.branch}); the state change is saved locally and pushed by the next command that reaches it`,
      );
    }
    return result;
  }

  /**
   * The public-remote warning, once per Claude Code session (CLAUDE_CODE_SESSION_ID); outside a
   * session every run counts as one. Null when there is nothing to warn about or it was said already.
   */
  warnOnce(): string | null {
    const warning = publicWarning(this.share);
    if (warning === null) return null;
    const session = this.env.CLAUDE_CODE_SESSION_ID;
    if (session === undefined || session === '') return warning;
    const path = join(this.dir, 'warned.json');
    let seen: string[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) seen = parsed.filter((s): s is string => typeof s === 'string');
    } catch {
      // never warned yet
    }
    const key = createHash('sha256').update(session).digest('hex').slice(0, 16);
    if (seen.includes(key)) return null;
    try {
      this.files.ensureDir(dirname(this.dir));
      this.files.ensureDir(this.dir);
      this.files.writeFile(path, `${JSON.stringify([...seen, key].slice(-20))}\n`);
    } catch {
      // the warning is printed anyway; it may be printed again
    }
    return warning;
  }
}
