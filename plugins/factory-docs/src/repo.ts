// The git checkout the CLI works on, git access, and the doc map (docs/docs-map.json).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAP_PATH = 'docs/docs-map.json';
/** Directories whose *.md files never need a map entry: reference material and the factory's runtime state. */
export const UNMAPPED_DIRS = ['docs/research/', 'factory/'] as const;

/** Exit 2: bad arguments. */
export class UsageError extends Error {}
/** Exit 2: not inside a git checkout that has a doc map. */
export class NotARepoError extends Error {}
/** Exit 1: the command could not do its job (git failed, the map could not be read, ...). */
export class CommandError extends Error {}

export interface Repo {
  /** The checkout's top level (real path). */
  root: string;
  /** The directory the CLI was run from (real path); relative path arguments resolve against it. */
  cwd: string;
}

export interface DocMap {
  /** Doc path -> the globs of the code it describes, in map order. */
  docs: Map<string, string[]>;
  /** The doc whose globs also count changes to other docs (skills and agents ship to users). */
  changelog: string | null;
  /** Globs of *.md files that are not docs (templates, fixtures). */
  ignore: string[];
  /** Plugin name -> the doc that documents its CLI's commands, when it is not plugins/<name>/README.md. */
  cliDocs: Map<string, string>;
}

export function git(root: string, args: readonly string[], allowFailure = false): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new CommandError(`could not run git: ${r.error.message}`);
  const ok = r.status === 0;
  if (!ok && !allowFailure) throw new CommandError(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return { ok, stdout: r.stdout, stderr: r.stderr };
}

export function gitZ(root: string, args: readonly string[]): string[] {
  return git(root, args).stdout.split('\0').filter((f) => f !== '');
}

/** The git top level containing `repoOption` (relative to cwd) or cwd; it must have docs/docs-map.json. */
export function findRepo(cwd: string, repoOption?: string): Repo {
  const start = repoOption === undefined ? cwd : resolve(cwd, repoOption);
  if (!existsSync(start) || !statSync(start).isDirectory()) throw new NotARepoError(`--repo ${repoOption}: no such directory`);
  const hint = repoOption === undefined ? '; run it inside the checkout or pass --repo <path>' : '';
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8' });
  if (r.error) throw new CommandError(`could not run git: ${r.error.message}`);
  if (r.status !== 0) throw new NotARepoError(`not inside a git checkout: ${start}${hint}`);
  const root = realpathSync(r.stdout.trim());
  if (!existsSync(join(root, MAP_PATH))) throw new NotARepoError(`no doc map: ${root} has no ${MAP_PATH}${hint}`);
  return { root, cwd: realpathSync(cwd) };
}

/**
 * A path argument as a repo-relative POSIX path. Relative paths resolve against the current directory
 * when it is inside the checkout, else against the root.
 */
export function repoPath(repo: Repo, path: string): string {
  const cwdRel = relative(repo.root, repo.cwd);
  const cwdInside = cwdRel === '' || (!cwdRel.startsWith(`..${sep}`) && cwdRel !== '..' && !isAbsolute(cwdRel));
  const abs = isAbsolute(path) ? path : resolve(cwdInside ? repo.cwd : repo.root, path);
  const rel = relative(repo.root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UsageError(`${path} is not inside the checkout ${repo.root}`);
  }
  return rel.split(sep).join('/');
}

/** A safe repo-relative path: not empty, not absolute, no `..`, `.` or empty segment, no backslash. */
export function isRepoRelative(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const MAP_KEYS = ['$comment', 'docs', 'changelog', 'ignore', 'cli_docs'];

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((g) => typeof g !== 'string' || g === '')) {
    throw new CommandError(`${MAP_PATH}: ${where} must be a list of non-empty strings`);
  }
  return value as string[];
}

/** Parses and validates the map text; throws CommandError naming what is wrong. */
export function parseMap(text: string): DocMap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new CommandError(`${MAP_PATH}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new CommandError(`${MAP_PATH}: the top level must be an object`);
  const obj = data as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !MAP_KEYS.includes(k));
  if (unknown.length > 0) throw new CommandError(`${MAP_PATH}: unknown key(s) ${unknown.join(', ')} (allowed: ${MAP_KEYS.join(', ')})`);

  const rawDocs = obj.docs;
  if (typeof rawDocs !== 'object' || rawDocs === null || Array.isArray(rawDocs)) {
    throw new CommandError(`${MAP_PATH}: "docs" must be an object mapping each doc to its list of globs`);
  }
  const docs = new Map<string, string[]>();
  for (const [doc, globs] of Object.entries(rawDocs)) {
    if (!isRepoRelative(doc)) throw new CommandError(`${MAP_PATH}: doc "${doc}" is not a repo-relative path`);
    const list = stringArray(globs, `docs["${doc}"]`);
    if (list.length === 0) throw new CommandError(`${MAP_PATH}: docs["${doc}"] lists no globs`);
    docs.set(doc, list);
  }

  let changelog: string | null = null;
  if (obj.changelog !== undefined) {
    if (typeof obj.changelog !== 'string' || !docs.has(obj.changelog)) {
      throw new CommandError(`${MAP_PATH}: "changelog" must name a doc listed in "docs"`);
    }
    changelog = obj.changelog;
  }

  const ignore = obj.ignore === undefined ? [] : stringArray(obj.ignore, '"ignore"');

  const cliDocs = new Map<string, string>();
  if (obj.cli_docs !== undefined) {
    const raw = obj.cli_docs;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CommandError(`${MAP_PATH}: "cli_docs" must be an object mapping plugin names to docs`);
    for (const [plugin, doc] of Object.entries(raw)) {
      if (typeof doc !== 'string' || !isRepoRelative(doc)) throw new CommandError(`${MAP_PATH}: cli_docs["${plugin}"] must be a repo-relative path`);
      cliDocs.set(plugin, doc);
    }
  }
  return { docs, changelog, ignore, cliDocs };
}

export function loadMap(root: string): DocMap {
  return parseMap(readFileSync(join(root, MAP_PATH), 'utf8'));
}

/** Tracked files, plus untracked files git does not ignore, that exist in the working tree. */
export function workingFiles(root: string): string[] {
  const files = gitZ(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return [...new Set(files)].filter((f) => existsSync(join(root, f))).sort();
}
