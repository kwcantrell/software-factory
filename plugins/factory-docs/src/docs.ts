// which / stale / lint / gate: plain functions over a checkout and its doc map.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matches } from './glob.ts';
import { CommandError, MAP_PATH, UNMAPPED_DIRS, UsageError, git, gitZ, isRepoRelative, loadMap, repoPath, workingFiles } from './repo.ts';
import type { DocMap, Repo } from './repo.ts';

// ---------------------------------------------------------------- which

/** For each path argument (relative to cwd), its repo-relative form -> the docs whose globs cover it. */
export function which(repo: Repo, paths: readonly string[], map: DocMap = loadMap(repo.root)): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const arg of paths) {
    const path = repoPath(repo, arg);
    out[path] = [...map.docs].filter(([, globs]) => matches(path, globs)).map(([doc]) => doc);
  }
  return out;
}

// ---------------------------------------------------------------- stale

export interface StaleDoc {
  doc: string;
  /** The changed files its globs cover. */
  covered: string[];
}

export interface StaleResult {
  /** The merge-base commit the change is measured from, or null when no base resolves. */
  base: string | null;
  /** The ref the base was resolved from (--base, origin/main or main). */
  baseRef: string | null;
  changed: string[];
  stale: StaleDoc[];
}

export const DEFAULT_BASES = ['origin/main', 'main'] as const;

function isCommit(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], true).ok;
}

function mergeBase(root: string, ref: string): string {
  return git(root, ['merge-base', ref, 'HEAD'], true).stdout.trim();
}

/**
 * The merge-base of HEAD with `explicit`, or with the first of origin/main and main that resolves.
 * An explicit ref must resolve (exit 2 otherwise); with no explicit ref and none resolving, null.
 */
export function resolveBase(root: string, explicit?: string): { base: string; ref: string } | null {
  if (explicit !== undefined) {
    if (explicit === '' || explicit.startsWith('-') || !isCommit(root, explicit)) throw new UsageError(`--base ${explicit}: not a commit in this checkout`);
    const base = mergeBase(root, explicit);
    if (!base) throw new CommandError(`--base ${explicit}: no merge-base with HEAD`);
    return { base, ref: explicit };
  }
  for (const ref of DEFAULT_BASES) {
    if (!isCommit(root, ref)) continue;
    const base = mergeBase(root, ref);
    if (base) return { base, ref };
  }
  return null;
}

/**
 * Files changed since `base` (committed, staged or unstaged), plus untracked files git does not ignore.
 * Without a base: the uncommitted changes against HEAD (every indexed file when there is no HEAD).
 */
export function changedFiles(root: string, base: string | null): string[] {
  const files = new Set<string>();
  const hasHead = isCommit(root, 'HEAD');
  const from = base ?? (hasHead ? 'HEAD' : null);
  const add = (list: string[]) => list.forEach((f) => files.add(f));
  if (from === null) add(gitZ(root, ['ls-files', '-z']));
  else {
    add(gitZ(root, ['diff', '--name-only', '--no-renames', '-z', from, '--']));
    add(gitZ(root, ['diff', '--name-only', '--no-renames', '-z', '--cached', from, '--']));
  }
  add(gitZ(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  return [...files].sort();
}

/**
 * Docs that did not change although files their globs cover did. A changed file that is itself a doc
 * in the map counts only for the changelog doc (skills and agents ship to users), so a doc-only change
 * never leaves another doc stale.
 */
export function staleDocs(map: DocMap, changed: readonly string[]): StaleDoc[] {
  const changedSet = new Set(changed);
  const out: StaleDoc[] = [];
  for (const [doc, globs] of map.docs) {
    if (changedSet.has(doc)) continue;
    const counts = (f: string) => f !== doc && (doc === map.changelog || !map.docs.has(f));
    const covered = changed.filter((f) => counts(f) && matches(f, globs));
    if (covered.length > 0) out.push({ doc, covered });
  }
  return out;
}

export function stale(repo: Repo, explicitBase?: string, map: DocMap = loadMap(repo.root)): StaleResult {
  const resolved = resolveBase(repo.root, explicitBase);
  const changed = changedFiles(repo.root, resolved?.base ?? null);
  return { base: resolved?.base ?? null, baseRef: resolved?.ref ?? null, changed, stale: staleDocs(map, changed) };
}

export function formatStale(s: StaleDoc): string {
  return `${s.doc}: not changed, but it covers changed file(s): ${s.covered.join(', ')} - fix: update ${s.doc} for them (or check it still holds and touch what is now wrong)`;
}

export function describeBase(r: StaleResult): string {
  return r.base === null ? `uncommitted changes (no base: ${DEFAULT_BASES.join(' and ')} do not resolve)` : `${r.baseRef} (merge-base ${r.base.slice(0, 12)})`;
}

// ---------------------------------------------------------------- lint

export interface Problem {
  file: string;
  what: string;
  fix: string;
}

export interface LintResult {
  docs: number;
  /** Plugin name -> the commands its CLI's --help lists. */
  clis: Record<string, string[]>;
  problems: Problem[];
}

export function formatProblem(p: Problem): string {
  return `${p.file}: ${p.what} - fix: ${p.fix}`;
}

/** The command names in a --help text's `Commands:` section (lines indented exactly two spaces). */
export function helpCommands(help: string): string[] | null {
  const lines = help.split('\n');
  const start = lines.findIndex((l) => /^commands:\s*$/i.test(l));
  if (start === -1) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const m = /^ {2}([a-z][a-z0-9-]*)(?:\s|$)/.exec(line);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/**
 * True when `text` mentions `command` of the CLI `bin`: as `<bin> <command>` (also `<bin>/src/cli.ts
 * <command>`), or in a code span that starts with the command (`` `check` ``, `` `release <tag>` ``).
 */
export function mentions(text: string, bin: string, command: string): boolean {
  const cmd = escapeRe(command);
  const invoked = new RegExp(`(?<![\\w-])${escapeRe(bin)}(?:/src/cli\\.ts)?\\s+${cmd}(?![\\w-])`);
  const span = new RegExp(`\`${cmd}(?=[\\s\`\\[])`);
  return invoked.test(text) || span.test(text);
}

interface PluginCli {
  plugin: string;
  dir: string;
  bin: string;
  entry: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The CLIs of the plugins listed in .claude-plugin/marketplace.json (none when there is no marketplace). */
export function pluginClis(root: string, problems: Problem[]): PluginCli[] {
  const marketplacePath = '.claude-plugin/marketplace.json';
  if (!existsSync(join(root, marketplacePath))) return [];
  const marketplace = readJson(join(root, marketplacePath));
  const plugins = isObject(marketplace) && Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const out: PluginCli[] = [];
  for (const entry of plugins) {
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.source !== 'string') continue;
    if (!entry.source.startsWith('./')) continue;
    const dir = entry.source.slice(2).replace(/\/+$/, '');
    if (!isRepoRelative(dir)) continue;
    const pkg = readJson(join(root, dir, 'package.json'));
    const bins = isObject(pkg) && isObject(pkg.bin) ? Object.entries(pkg.bin) : [];
    if (bins.length === 0) {
      problems.push({ file: `${dir}/package.json`, what: `plugin ${entry.name} has no "bin", so its CLI's commands cannot be listed`, fix: 'add "bin": {"<name>": "src/cli.ts"} (see CLAUDE.md "Plugin layout")' });
      continue;
    }
    for (const [bin, file] of bins) {
      if (typeof file !== 'string' || !isRepoRelative(file)) continue;
      out.push({ plugin: entry.name, dir, bin, entry: `${dir}/${file}` });
    }
  }
  return out;
}

/** Runs `node <entry> --help` from the checkout root. */
function cliHelp(root: string, entry: string): { ok: boolean; stdout: string; reason: string } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [entry, '--help'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  if (r.error) return { ok: false, stdout: '', reason: r.error.message };
  if (r.status !== 0) return { ok: false, stdout: '', reason: `exit ${r.status ?? r.signal}: ${r.stderr.trim().split('\n')[0] ?? ''}` };
  return { ok: true, stdout: r.stdout, reason: '' };
}

/**
 * The map's docs exist and its globs each match a file; every *.md file is a doc or ignored (outside
 * docs/research/ and factory/); every command each plugin CLI's --help lists is mentioned in its doc.
 */
export function lint(repo: Repo, map: DocMap = loadMap(repo.root)): LintResult {
  const { root } = repo;
  const files = workingFiles(root);
  const fileSet = new Set(files);
  const problems: Problem[] = [];

  for (const [doc, globs] of map.docs) {
    if (!fileSet.has(doc)) problems.push({ file: MAP_PATH, what: `doc ${doc} does not exist (or is ignored by git)`, fix: `create ${doc}, or remove its entry from "docs"` });
    for (const glob of globs) {
      if (!files.some((f) => matches(f, [glob]))) {
        problems.push({ file: MAP_PATH, what: `glob ${glob} of ${doc} matches no file`, fix: 'correct the glob to the code the doc describes, or remove it' });
      }
    }
  }
  for (const glob of map.ignore) {
    if (!files.some((f) => matches(f, [glob]))) problems.push({ file: MAP_PATH, what: `ignore glob ${glob} matches no file`, fix: 'correct the glob, or remove it from "ignore"' });
  }

  for (const file of files) {
    if (!file.endsWith('.md') || UNMAPPED_DIRS.some((d) => file.startsWith(d))) continue;
    if (map.docs.has(file) || matches(file, map.ignore)) continue;
    problems.push({ file, what: `markdown file is not in ${MAP_PATH}`, fix: `add it under "docs" with the globs of the code it describes, or to "ignore" if it describes no code` });
  }

  const clis: Record<string, string[]> = {};
  const listed = pluginClis(root, problems);
  for (const plugin of map.cliDocs.keys()) {
    if (!listed.some((c) => c.plugin === plugin)) problems.push({ file: MAP_PATH, what: `cli_docs names ${plugin}, which is not a marketplace plugin with a bin`, fix: 'remove the entry or correct the plugin name' });
  }
  for (const cli of listed) {
    const doc = map.cliDocs.get(cli.plugin) ?? `${cli.dir}/README.md`;
    const help = cliHelp(root, cli.entry);
    if (!help.ok) {
      problems.push({ file: cli.entry, what: `${cli.bin} --help failed (${help.reason})`, fix: `make node ${cli.entry} --help exit 0` });
      continue;
    }
    const commands = helpCommands(help.stdout);
    if (commands === null || commands.length === 0) {
      problems.push({ file: cli.entry, what: `${cli.bin} --help lists no commands under a "Commands:" heading`, fix: 'list each command in --help under "Commands:", indented two spaces' });
      continue;
    }
    clis[cli.plugin] = commands;
    if (!existsSync(join(root, doc))) {
      problems.push({ file: doc, what: `plugin ${cli.plugin} has no README documenting its CLI`, fix: `write ${doc}, or point "cli_docs" in ${MAP_PATH} at the doc that documents it` });
      continue;
    }
    const text = readFileSync(join(root, doc), 'utf8');
    for (const command of commands) {
      if (!mentions(text, cli.bin, command)) {
        problems.push({ file: doc, what: `does not mention the ${cli.bin} command ${command} (its --help lists it)`, fix: `document \`${cli.bin} ${command}\` in ${doc}` });
      }
    }
  }
  return { docs: map.docs.size, clis, problems };
}
