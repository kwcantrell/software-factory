// Where things are: the repository root (the nearest directory up from the cwd holding `.git`, else
// the cwd), the requirements file in it, and dotenv files read for their variable NAMES only.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_FILE } from './requirements.ts';

export function findRoot(cwd: string): string {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return resolve(cwd);
  }
}

export interface Location {
  root: string;
  /** Absolute path of the requirements file. */
  path: string;
  /** How messages name it: relative to the root when inside it. */
  label: string;
}

export function locate(cwd: string, file: string | undefined): Location {
  const root = findRoot(cwd);
  const path = file === undefined ? join(root, DEFAULT_FILE) : resolve(cwd, file);
  const rel = relative(root, path);
  return { root, path, label: rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path };
}

/** A path from the requirements file: `~/` is the home dir, a relative path is from the root. */
export function resolvePath(root: string, p: string, home: string | undefined): string {
  if (p === '~' || p.startsWith('~/')) return join(home ?? homedir(), p.slice(1));
  return resolve(root, p);
}

/** `NAME=` (optionally after `export `) at the start of a line: only the name is captured. */
const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * The variable names a dotenv file sets, each with its 1-based line. Values are never kept: each line
 * is matched against DOTENV_LINE, which captures the name and nothing after the `=`.
 */
export function dotenvNames(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = DOTENV_LINE.exec(l);
    if (m?.[1] !== undefined) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

export function readDotenvNames(path: string): Set<string> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return new Set(dotenvNames(text).map((n) => n.name));
}
