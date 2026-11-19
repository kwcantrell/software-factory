// The plugin's local log: occurrences (one JSON object per line), per-issue state (suggested,
// dismissed, filed) and the draft suggestions. All of it lives in the user's config dir, owner-only
// (directories 0700, files 0600), never inside a git checkout, and never where the other
// marketplace's `plugin-advisor` keeps its log: the two logs must not mix.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Env } from './plugins.ts';

export class CliError extends Error {}

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
/** The log is trimmed to its newest MAX_LINES occurrences once it grows past MAX_BYTES. */
export const MAX_BYTES = 1024 * 1024;
export const MAX_LINES = 2000;

export interface Occurrence {
  signature: string;
  plugin: string;
  kind: string;
  summary: string;
  detail?: string;
  /** ISO timestamp. */
  at: string;
  source: 'record' | 'hook';
  /** Set by the hook: the plugin CLI's subcommand and exit code. */
  subcommand?: string;
  exitCode?: number;
}

export interface IssueState {
  /** The issue's count when it was last suggested. */
  suggestedCount?: number;
  suggestedAt?: string;
  dismissedAt?: string;
  filed?: { url: string; repo: string; at: string };
}

/** A station suggestion's state (see station-drafts.ts), keyed `<repo key>/<id>`. */
export interface StationState {
  status: 'drafted' | 'applied' | 'dismissed';
  at: string;
}

export interface State {
  version: 1;
  issues: Record<string, IssueState>;
  /** Optional: state files written before station suggestions existed have none. */
  stations?: Record<string, StationState>;
}

/** `$FACTORY_PLUGIN_ADVISOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/factory-plugin-advisor`, else `~/.config/factory-plugin-advisor`. */
export function configDir(env: Env): string {
  const override = env.FACTORY_PLUGIN_ADVISOR_CONFIG_DIR;
  if (override !== undefined && override !== '') return resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : join(env.HOME ?? homedir(), '.config');
  return resolve(base, 'factory-plugin-advisor');
}

/**
 * Where a `plugin-advisor` from another marketplace keeps its log (`$PLUGIN_ADVISOR_CONFIG_DIR`, else
 * `$XDG_CONFIG_HOME/plugin-advisor`, else `~/.config/plugin-advisor`), every candidate. This plugin's
 * log never shares one of them.
 */
export function otherAdvisorDirs(env: Env): string[] {
  const out = new Set<string>();
  const override = env.PLUGIN_ADVISOR_CONFIG_DIR;
  if (override !== undefined && override !== '') out.add(resolve(override));
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '') out.add(resolve(xdg, 'plugin-advisor'));
  out.add(resolve(env.HOME ?? homedir(), '.config', 'plugin-advisor'));
  return [...out];
}

/** Whether `a` and `b` are the same directory or one is inside the other. */
export function overlaps(a: string, b: string): boolean {
  const within = (inner: string, outer: string): boolean => {
    const rel = relative(outer, inner);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return within(a, b) || within(b, a);
}

/** The git work tree containing `dir` (or the nearest existing ancestor), if any. */
export function enclosingRepo(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `mkdir -p`, with `mode` on each directory it creates. Not `mkdirSync(dir, { recursive: true })`:
 * on Node 24 (seen on 24.22.2) that never returns when mkdir keeps failing with ENOENT although the
 * parent exists, as it does under /proc, so the hook would spin until it is killed. Walking up by
 * hand throws that ENOENT instead. An existing path that is not a directory (a regular file where
 * the config dir should be) throws ENOTDIR, so the caller never chmods or writes through it.
 */
export function makeDirs(dir: string, mode: number): void {
  const mkdir = (path: string): void => {
    try {
      mkdirSync(path, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!statSync(path).isDirectory()) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${path}'`), { code: 'ENOTDIR', path });
      }
    }
  };
  try {
    mkdir(dir);
  } catch (error) {
    const parent = dirname(dir);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) throw error;
    makeDirs(parent, mode);
    mkdir(dir);
  }
}

export class Store {
  readonly dir: string;
  readonly logPath: string;
  readonly statePath: string;
  readonly draftsDir: string;

  private readonly others: string[];

  constructor(env: Env) {
    this.dir = configDir(env);
    this.others = otherAdvisorDirs(env);
    this.logPath = join(this.dir, 'occurrences.jsonl');
    this.statePath = join(this.dir, 'state.json');
    this.draftsDir = join(this.dir, 'drafts');
  }

  /**
   * Refuses a config dir inside a git checkout (the log must never be committed by accident), and one
   * that is, holds or sits inside another marketplace's `plugin-advisor` log dir.
   */
  private checkLocation(): void {
    const shared = this.others.find((other) => overlaps(this.dir, other));
    if (shared !== undefined) {
      throw new CliError(`refusing to keep the log in ${this.dir}: it overlaps ${shared}, where another plugin-advisor keeps its log; set FACTORY_PLUGIN_ADVISOR_CONFIG_DIR to a directory of its own`);
    }
    const repo = enclosingRepo(this.dir);
    if (repo !== null) {
      throw new CliError(`refusing to keep the log in ${this.dir}: it is inside the git checkout ${repo}; set FACTORY_PLUGIN_ADVISOR_CONFIG_DIR to a directory outside any repository`);
    }
  }

  private ensureDir(dir: string): void {
    makeDirs(dir, DIR_MODE);
    chmodSync(dir, DIR_MODE);
  }

  /** Creates the config dir (0700) for a write. */
  prepare(): void {
    this.checkLocation();
    this.ensureDir(this.dir);
  }

  append(occurrence: Occurrence): void {
    this.prepare();
    appendFileSync(this.logPath, `${JSON.stringify(occurrence)}\n`, { mode: FILE_MODE });
    chmodSync(this.logPath, FILE_MODE);
    if (statSync(this.logPath).size > MAX_BYTES) {
      const lines = readFileSync(this.logPath, 'utf8').split('\n').filter((l) => l !== '');
      this.writeFile(this.logPath, `${lines.slice(-MAX_LINES).join('\n')}\n`);
    }
  }

  occurrences(): Occurrence[] {
    let text: string;
    try {
      text = readFileSync(this.logPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new CliError(`cannot read ${this.logPath}: ${(error as Error).message}`);
    }
    const out: Occurrence[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isOccurrence(value)) out.push(value);
      } catch {
        // A torn or hand-edited line: skip it rather than lose the rest of the log.
      }
    }
    return out;
  }

  state(): State {
    let text: string;
    try {
      text = readFileSync(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, issues: {} };
      throw new CliError(`cannot read ${this.statePath}: ${(error as Error).message}`);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && (parsed as State).version === 1 && typeof (parsed as State).issues === 'object') {
        return parsed as State;
      }
    } catch {
      // fall through
    }
    throw new CliError(`${this.statePath} is not valid factory-plugin-advisor state; move it aside to start over`);
  }

  saveState(state: State): void {
    this.prepare();
    this.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  draftPath(signature: string): string {
    return join(this.draftsDir, `${signature}.md`);
  }

  writeDraft(signature: string, text: string): string {
    this.prepare();
    this.ensureDir(this.draftsDir);
    const path = this.draftPath(signature);
    this.writeFile(path, text);
    return path;
  }

  /** `stations/<repo key>`: one repository's station suggestion drafts, records and backups. */
  stationDir(key: string): string {
    if (!/^[0-9a-f]{12}$/.test(key)) throw new CliError(`not a repository key: ${key}`);
    return join(this.dir, 'stations', key);
  }

  /** Writes `stations/<key>/<name>` (name may hold subdirectories, never `..`), 0600 in 0700 dirs. */
  writeStationFile(key: string, name: string, text: string): string {
    if (name.split(/[\\/]/).some((p) => p === '..' || p === '') || isAbsolute(name)) throw new CliError(`not a station file name: ${name}`);
    this.prepare();
    const path = join(this.stationDir(key), name);
    for (let d = dirname(path), chain: string[] = []; ; d = dirname(d)) {
      if (d === this.dir || existsSync(d)) {
        for (const c of [d, ...chain.reverse()]) if (c !== this.dir) this.ensureDir(c);
        break;
      }
      chain.push(d);
    }
    this.writeFile(path, text);
    return path;
  }

  readStationFile(key: string, name: string): string | null {
    const path = join(this.stationDir(key), name);
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CliError(`cannot read ${path}: ${(error as Error).message}`);
    }
  }

  readDraft(signature: string): string | null {
    try {
      return readFileSync(this.draftPath(signature), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CliError(`cannot read ${this.draftPath(signature)}: ${(error as Error).message}`);
    }
  }

  /** Writes a file 0600 through a temp file and rename, so a reader never sees half of it. */
  private writeFile(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: FILE_MODE });
    chmodSync(tmp, FILE_MODE);
    renameSync(tmp, path);
  }
}

function isOccurrence(value: unknown): value is Occurrence {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  if (!['signature', 'plugin', 'kind', 'summary', 'at'].every((k) => typeof o[k] === 'string')) return false;
  // The signature names a draft file (`drafts/<signature>.md`), so it must be exactly the 12 hex chars.
  return /^[0-9a-f]{12}$/.test(o.signature as string);
}
