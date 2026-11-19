// Station suggestions as drafts, and `stations apply`: the concrete change for each finding of
// stations.ts (a new project agent made from the factory plugin's template, or a unified diff against
// the current one), written to the advisor's log dir with its evidence, and applied to the
// repository's .claude/agents/ (and factory.json) only with --confirm.
//
// The factory plugin is read, never changed: its templates/agents/*.md and agents/*.md files, and its
// CLI's `factory agents --json`, `factory agents check` and `factory config`, run with node.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError } from './advisor.ts';
import { findManifest, type Env } from './plugins.ts';
import { cleanSummary, type Identity, maskPersonal, NO_IDENTITY, oneLine } from './redact.ts';
import { type Finding, findings as allFindings, readJobs, report, type Resolution, RULE_LETTER, type StationReport, THEMES } from './stations.ts';
import { CliError, type StationState, type Store } from './store.ts';

/** Evidence items quoted in a draft. */
export const EVIDENCE_MAX = 10;
export const FACTORY_TIMEOUT_MS = 60_000;
const AGENT_PATH = /^\.claude\/agents\/factory-[a-z0-9][a-z0-9-]*\.md$/;
const CONFIG_PATH = 'factory.json';
const LESSONS = '## Lessons from this line';

// ------------------------------------------------------------------ the repository and the factory CLI

export interface Line {
  /** The repository: where .claude/agents/ and factory.json are. */
  repo: string;
  /** Its factory dir: `<repo>/factory`, or FACTORY_DIR. */
  factoryDir: string;
  /** The factory plugin's folder (templates, shipped agents, src/cli.ts). */
  factoryRoot: string;
  env: Env;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The repository and its factory dir: `--repo <path>` (its `factory/`), else FACTORY_DIR (and its
 * parent), else the main checkout of the git repository holding `cwd`.
 */
export function locateRepo(repoArg: string | undefined, env: Env, cwd: string): { repo: string; factoryDir: string } {
  if (repoArg !== undefined) {
    const repo = real(resolve(cwd, repoArg));
    if (!existsSync(repo) || !lstatSync(repo).isDirectory()) throw new UsageError(`--repo ${JSON.stringify(repoArg)} is not a directory`);
    return { repo, factoryDir: join(repo, 'factory') };
  }
  if (env.FACTORY_DIR !== undefined && env.FACTORY_DIR !== '') {
    const factoryDir = real(resolve(cwd, env.FACTORY_DIR));
    return { repo: dirname(factoryDir), factoryDir };
  }
  const p = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  if (p.status !== 0 || !(p.stdout ?? '').startsWith('worktree ')) {
    throw new CliError('not inside a git repository; run from the repository or pass --repo <path>');
  }
  const repo = real((p.stdout.split(/\r?\n/)[0] ?? '').slice('worktree '.length));
  return { repo, factoryDir: join(repo, 'factory') };
}

/**
 * The factory plugin's folder: next to this plugin in a checkout (`plugins/factory`), the same
 * version in the plugin cache (`<cache>/software-factory/factory/<version>`), else the marketplace's
 * `factory` entry.
 */
export function locateFactory(pluginRoot: string, env: Env): string {
  const root = resolve(pluginRoot);
  const ok = (dir: string): boolean => existsSync(join(dir, 'src', 'cli.ts')) && existsSync(join(dir, 'templates', 'agents'));
  const candidates = [join(root, '..', 'factory'), join(root, '..', '..', 'factory', basename(root))];
  const manifest = findManifest(root, env);
  if (manifest !== null) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { plugins?: Array<{ name?: unknown; source?: unknown }> };
      const entry = parsed.plugins?.find((p) => p.name === 'factory');
      if (typeof entry?.source === 'string') candidates.push(join(dirname(dirname(manifest)), entry.source));
    } catch {
      // an unreadable manifest: the other candidates only
    }
  }
  const found = candidates.find(ok);
  if (found === undefined) throw new CliError('cannot find the factory plugin (its templates and CLI); install factory from the software-factory marketplace');
  return resolve(found);
}

export interface Proc {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the factory CLI with node, in `repo`, on `factoryDir`, without a shell. */
export function factory(factoryRoot: string, repo: string, factoryDir: string, env: Env, args: readonly string[]): Proc {
  const p = spawnSync(process.execPath, [join(factoryRoot, 'src', 'cli.ts'), ...args], {
    cwd: repo,
    env: { ...(env as NodeJS.ProcessEnv), FACTORY_DIR: factoryDir },
    encoding: 'utf8',
    timeout: FACTORY_TIMEOUT_MS,
    shell: false,
  });
  if (p.error !== undefined) return { status: 127, stdout: '', stderr: p.error.message };
  return { status: p.status ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

/** `factory agents --json`: how each configured station resolves. */
export function resolutions(line: Line): Resolution[] {
  const p = factory(line.factoryRoot, line.repo, line.factoryDir, line.env, ['agents', '--json']);
  if (p.status !== 0) throw new CliError(`factory agents --json failed: ${oneLine(p.stderr) || `exit ${p.status}`}`);
  try {
    return JSON.parse(p.stdout) as Resolution[];
  } catch {
    throw new CliError('factory agents --json printed something that is not JSON');
  }
}

// ------------------------------------------------------------------ stations: the report

export interface StationsReport {
  repo: string;
  factoryDir: string;
  jobs: number;
  skipped: string[];
  stations: StationReport[];
}

function requireJobs(line: Line): void {
  if (!existsSync(join(line.factoryDir, 'jobs'))) throw new CliError(`no factory jobs in ${line.factoryDir}; run the factory on this repository first, or pass --repo <path>`);
}

export function stationsReport(line: Line): StationsReport {
  requireJobs(line);
  const { jobs, skipped } = readJobs(line.factoryDir);
  return { repo: line.repo, factoryDir: line.factoryDir, jobs: jobs.length, skipped, stations: report(jobs, resolutions(line)) };
}

// ------------------------------------------------------------------ agent text

const fillValues = (text: string, values: Record<string, string>): string => text.replace(/\{\{([a-z_]+)\}\}/g, (all, key: string) => values[key] ?? all);

function kindOf(station: string): 'builder' | 'verifier' | 'reviewer' {
  return station === 'builder' || station === 'verifier' ? station : 'reviewer';
}

/** The `fill:<id>` sections of an agent: id -> its text. */
export function fillSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/<!-- fill:([a-z-]+)[\s\S]*?-->\n?([\s\S]*?)<!-- \/fill -->/g)) out.set(m[1] as string, m[2] as string);
  return out;
}

function replaceFill(text: string, id: string, value: string): string {
  return text.replace(new RegExp(`(<!-- fill:${id}\\b[\\s\\S]*?-->\\n?)[\\s\\S]*?(<!-- /fill -->)`), (_m, open: string, close: string) => `${open}${value.trimEnd()}\n${close}`);
}

const DEFAULT_FILL: Record<string, string> = {
  stack: "Read this repository's README, CLAUDE.md and AGENTS.md (where they exist) for its languages, frameworks and layout before you start.",
  checks: "Use the test, typecheck, lint and build commands that this repository's README, CLAUDE.md, CONTRIBUTING or package scripts name, from the worktree root.",
  conventions: "Follow the written rules in this repository's CLAUDE.md, AGENTS.md, CONTRIBUTING and lint configuration.",
};

/** The lens text for a reviewer with no shipped agent: the theme's question and the line's evidence. */
function lensFocus(lens: string, f: Finding | null): string {
  const theme = THEMES[lens];
  const lines = [
    theme === undefined ? `Does this change hold up through the ${lens} lens?` : `Does this change get ${theme.about} right?`,
    '',
    ...(theme === undefined ? [] : [`- Read the diff for ${theme.about}, and the callers and data the change touches.`]),
    '- Name the input or state that fails and the wrong outcome, with file:line, for every blocking finding.',
    ...(f === null ? [] : [`- On this line, ${f.count} jobs raised ${lens} issues that no reviewer was checking for: ${f.jobs.join(', ')}. Read those jobs' follow-ups and reviews for what to look for here.`]),
    '',
    `If the diff touches nothing ${lens}-relevant, say so and approve.`,
  ];
  return lines.join('\n');
}

/** The shipped reviewer's lens section, as `factory agents new` fills it. */
function shippedLens(factoryRoot: string, lens: string): string | null {
  const path = join(factoryRoot, 'agents', `reviewer-${lens}.md`);
  if (!existsSync(path)) return null;
  const m = new RegExp(`\\n## Your lens: ${lens}\\n([\\s\\S]*?)\\n## `).exec(readFileSync(path, 'utf8'));
  return m?.[1]?.trim() ?? null;
}

/**
 * A new project agent for `station`, from the factory plugin's template: placeholders filled as
 * `factory agents new` fills them, each `fill` section taken from the repository's other project
 * agents where one has it, else a pointer to the repository's own docs (never the template's TODO).
 */
export function newAgent(factoryRoot: string, repo: string, station: string, f: Finding | null): string {
  const kind = kindOf(station);
  const lens = kind === 'reviewer' ? station.slice('reviewer-'.length) : '';
  const focus = kind === 'reviewer' ? (shippedLens(factoryRoot, lens) ?? lensFocus(lens, f)) : '';
  let text = fillValues(readFileSync(join(factoryRoot, 'templates', 'agents', `${kind}.md`), 'utf8'), { name: `factory-${station}`, lens, lens_focus: focus });
  const others = existingAgents(repo).sort(([a], [b]) => Number(kindOf(b.slice(8, -3)) === kind) - Number(kindOf(a.slice(8, -3)) === kind) || a.localeCompare(b));
  for (const [id, value] of fillSections(text)) {
    if (!/^TODO: /m.test(value)) continue;
    const borrowed = others.map(([, t]) => fillSections(t).get(id)).find((v) => v !== undefined && v.trim() !== '' && !/^TODO: /m.test(v));
    text = replaceFill(text, id, borrowed ?? DEFAULT_FILL[id] ?? `See this repository's README and CLAUDE.md for its ${id}.`);
  }
  return text;
}

/** The repository's project agents: [file name, text]. */
function existingAgents(repo: string): Array<[string, string]> {
  const dir = join(repo, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /^factory-[a-z0-9-]+\.md$/.test(f))
      .sort()
      .map((f): [string, string] => [f, readFileSync(join(dir, f), 'utf8')]);
  } catch {
    return [];
  }
}

/** Text safe to put in an agent: one line, no backticks, and never a human-only factory command. */
function agentSafe(text: string): string {
  return oneLine(text).replaceAll('`', "'").replace(/factory["']?\s+(merge|approve|rework)\b/gi, 'a human-only factory command');
}

/** The agent with `bullet` added under its "Lessons from this line" section (made before the steps when missing). */
export function addLesson(text: string, bullet: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === LESSONS);
  if (at !== -1) {
    let end = lines.findIndex((l, i) => i > at && /^## /.test(l));
    if (end === -1) end = lines.length;
    while (end > at + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1;
    lines.splice(end, 0, bullet);
    return lines.join('\n');
  }
  const before = lines.findIndex((l) => /^## (Rules|How to review)\s*$/.test(l));
  const block = [LESSONS, '', 'Patterns from this repository\'s factory jobs, found by factory-plugin-advisor; keep them in mind on every job.', '', bullet, ''];
  if (before === -1) return `${text.trimEnd()}\n\n${block.join('\n')}`;
  lines.splice(before, 0, ...block);
  return lines.join('\n');
}

/** The lesson a modification adds to the station's agent. Job ids and counts only, no quoted text. */
function lesson(f: Finding): string {
  const jobs = f.jobs.join(', ');
  switch (f.rule) {
    case 'modify-builder':
      return `- Proof failed ${f.count} times for the same reason: "${agentSafe(f.key)}" (jobs ${jobs}). Before handing off, check for this yourself and show the evidence in build.md.`;
    case 'modify-verifier':
      return `- ${f.count} jobs passed proof and then got a behavior "changes" verdict for an unmet acceptance criterion (jobs ${jobs}). Trace every criterion to first-hand evidence before a pass; a criterion you did not exercise is a fail.`;
    case 'modify-reviewer':
      return f.variant === 'miss'
        ? `- You approved jobs where a later review or proof found ${(f.themes ?? []).join(', ')} issues, which are in your lens (jobs ${jobs}). Check those explicitly before approving.`
        : `- After your "changes" on ${(f.themes ?? []).join(', ')}, another lens raised the same finding in the next round (jobs ${jobs}). Check that your earlier findings were really fixed, and say precisely which fix resolves each one.`;
    default:
      return '';
  }
}

// ------------------------------------------------------------------ unified diff

/** A unified diff (3 lines of context) of `before` -> `after`; `before` null for a new file. */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const lines = (text: string | null): string[] => (text === null || text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n'));
  const a = lines(before);
  const b = lines(after);
  const n = a.length;
  const m = b.length;
  // LCS table; agent files are a few hundred lines at most.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (lcs[i] as number[])[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, lcs[i]?.[j + 1] ?? 0);
  const ops: Array<{ op: ' ' | '-' | '+'; text: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ op: ' ', text: a[i++] as string, ai: i, bi: ++j });
    else if (j < m && (i >= n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) ops.push({ op: '+', text: b[j++] as string, ai: i, bi: j });
    else ops.push({ op: '-', text: a[i++] as string, ai: i, bi: j });
  }
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  const changed = ops.map((o, k) => (o.op === ' ' ? -1 : k)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, (changed[k] as number) - 3);
    let end = Math.min(ops.length, (changed[k] as number) + 4);
    while (k + 1 < changed.length && (changed[k + 1] as number) - 3 <= end) end = Math.min(ops.length, (changed[++k] as number) + 4);
    k += 1;
    const hunk = ops.slice(start, end);
    let aStart = 0;
    let bStart = 0;
    for (const o of ops.slice(0, start)) {
      if (o.op !== '+') aStart += 1;
      if (o.op !== '-') bStart += 1;
    }
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${aLen === 0 ? aStart : aStart + 1},${aLen} +${bLen === 0 ? bStart : bStart + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.text}`);
  }
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------------ drafts

export interface DraftFile {
  /** Relative to the repository: `.claude/agents/factory-<station>.md` or `factory.json`. */
  path: string;
  /** sha256 of the file when the draft was made; null when it did not exist. */
  before: string | null;
  after: string;
}

export interface DraftRecord {
  version: 1;
  id: string;
  rule: Finding['rule'];
  station: string;
  key: string;
  repo: string;
  title: string;
  createdAt: string;
  files: DraftFile[];
}

export interface StationSuggestion {
  id: string;
  rule: Finding['rule'];
  letter: string;
  station: string;
  title: string;
  jobs: string[];
  count: number;
  files: Array<{ path: string; action: 'create' | 'overwrite' }>;
  draft: string;
  factoryRun: string;
}

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The key a repository's drafts are kept under in the log dir. */
export const repoKey = (repo: string): string => sha(repo).slice(0, 12);
/** A suggestion's stable id: the same rule, station and key give the same id. */
export const suggestionId = (f: Finding): string => sha(`${f.rule}\n${f.station}\n${f.key}`).slice(0, 12);

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function titleOf(f: Finding): string {
  switch (f.rule) {
    case 'new-reviewer':
      return `add a ${f.theme} reviewer: ${f.count} jobs raised ${f.theme} issues no reviewer covers`;
    case 'modify-builder':
      return `builder: proof failed ${f.count} times for the same reason`;
    case 'modify-reviewer':
      return f.variant === 'miss'
        ? `${f.station}: approved ${f.count} jobs where later checks found issues in its lens`
        : `${f.station}: its "changes" were raised again by another lens in ${f.count} jobs`;
    case 'modify-verifier':
      return `verifier: ${f.count} jobs passed proof, then behavior found an unmet criterion`;
  }
}

function rationale(f: Finding): string {
  switch (f.rule) {
    case 'new-reviewer':
      return `Follow-ups or blocking review findings in ${f.count} jobs (${f.jobs.join(', ')}) are about ${f.theme} (${THEMES[f.theme ?? '']?.about ?? ''}), and no configured reviewer's lens covers it. A ${f.theme} reviewer would raise these before merge instead of leaving them to follow-ups.`;
    case 'modify-builder':
      return `The verifier failed ${f.count} builds for the same normalised reason ("${f.key}") in jobs ${f.jobs.join(', ')}. The builder should check for it before handing off.`;
    case 'modify-reviewer':
      return f.variant === 'miss'
        ? `${f.station} approved ${f.count} jobs (${f.jobs.join(', ')}) in which a later review or proof found ${(f.themes ?? []).join(', ')} issues, which are in its own lens.`
        : `In ${f.count} jobs (${f.jobs.join(', ')}), after ${f.station} asked for changes on ${(f.themes ?? []).join(', ')}, another lens raised a finding on the same theme in the next round.`;
    case 'modify-verifier':
      return `${f.count} jobs (${f.jobs.join(', ')}) passed proof and then got a behavior "changes" verdict whose blocking findings name an unmet acceptance criterion: the proof missed it.`;
  }
}

/** The concrete change: the files a finding writes, with their content now and after. */
function changeFor(line: Line, f: Finding, reviewers: readonly string[]): Array<{ path: string; current: string | null; after: string }> {
  const rel = `.claude/agents/factory-${f.station}.md`;
  const current = readOrNull(join(line.repo, rel));
  const files: Array<{ path: string; current: string | null; after: string }> = [];
  if (f.rule === 'new-reviewer') {
    if (current === null) files.push({ path: rel, current, after: newAgent(line.factoryRoot, line.repo, f.station, f) });
    const configText = readOrNull(join(line.repo, CONFIG_PATH));
    let config: Record<string, unknown> = {};
    if (configText !== null) {
      try {
        const parsed: unknown = JSON.parse(configText);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      } catch {
        throw new CliError(`${join(line.repo, CONFIG_PATH)} is not valid JSON`);
      }
    }
    const lens = f.theme as string;
    const listed = Array.isArray(config.reviewers) ? (config.reviewers as unknown[]).filter((r): r is string => typeof r === 'string') : [...reviewers];
    files.push({ path: CONFIG_PATH, current: configText, after: `${JSON.stringify({ ...config, reviewers: [...listed.filter((r) => r !== lens), lens] }, null, 2)}\n` });
    return files;
  }
  const base = current ?? newAgent(line.factoryRoot, line.repo, f.station, null);
  files.push({ path: rel, current, after: addLesson(base, lesson(f)) });
  return files;
}

/** A fence longer than any run of backticks in `text`. */
const fence = (text: string, info = ''): string => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${info}\n${text.endsWith('\n') ? text : `${text}\n`}${f}`;
};

function renderDraft(rec: DraftRecord, f: Finding, line: Line, files: Array<{ path: string; current: string | null; after: string }>, factoryRun: string, identity: Identity): string {
  const quote = (text: string): string => cleanSummary(text.replaceAll('`', "'"), identity);
  const evidence = f.evidence.slice(0, EVIDENCE_MAX);
  const lines = [
    `# Station suggestion ${rec.id}: ${maskPersonal(rec.title, identity)}`,
    '',
    `Rule: (${RULE_LETTER[f.rule]}) ${f.rule}. Station: \`${f.station}\`. Repository: ${maskPersonal(line.repo, identity)}`,
    '',
    '## Rationale',
    '',
    maskPersonal(rationale(f), identity),
    '',
    '## Evidence',
    '',
    `${f.count} ${f.rule === 'modify-builder' ? 'proof failures' : 'jobs'}: ${f.jobs.join(', ')}. Quoted text is redacted and capped (${evidence.length} of ${f.evidence.length} items):`,
    '',
    ...evidence.map((e) => `- ${e.job}, ${e.source}: ${quote(e.text)}`),
    '',
    '## Change',
    '',
  ];
  for (const file of files) {
    if (file.current === null && file.path !== CONFIG_PATH) {
      lines.push(`New file \`${file.path}\`, made from the factory plugin's ${kindOf(f.station)} template:`, '', fence(file.after, 'markdown'), '');
    } else {
      lines.push(`${file.current === null ? 'New file' : 'Change to'} \`${file.path}\`:`, '', fence(unifiedDiff(file.path, file.current, file.after), 'diff'), '');
    }
  }
  lines.push(
    '## Apply',
    '',
    'Review this draft, then run the dry run (`stations apply <id>`) and, once you agree, `stations apply <id> --confirm`. It writes only the files above, backs up any it overwrites, runs `factory agents check` and rolls back if that fails. It never commits.',
    '',
    '## Factory request',
    '',
    'Or paste this into Claude Code to make the change through the factory instead:',
    '',
    '```',
    factoryRun,
    '```',
    '',
  );
  return lines.join('\n');
}

function factoryRunLine(f: Finding, files: ReadonlyArray<{ path: string }>, id: string, identity: Identity): string {
  const change = f.rule === 'new-reviewer' ? `Add a ${f.theme} reviewer station: create ${files[0]?.path ?? `.claude/agents/factory-${f.station}.md`} from the factory reviewer template (factory agents new ${f.station}), fill its lens for this repository, and add "${f.theme}" to factory.json reviewers.` : `Update the ${f.station} station agent (${files[0]?.path ?? ''}) so it covers this pattern.`;
  return maskPersonal(oneLine(`/factory:run ${change} ${rationale(f)} factory-plugin-advisor station suggestion ${id}.`), identity);
}

/** Every drafted agent must pass `factory agents check`: tried in a scratch repository first. */
function checkDrafted(line: Line, files: ReadonlyArray<{ path: string; after: string }>): string | null {
  const scratch = mkdtempSync(join(tmpdir(), 'factory-plugin-advisor-check-'));
  try {
    for (const f of files) {
      const path = join(scratch, f.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.after);
    }
    const p = factory(line.factoryRoot, scratch, join(scratch, 'factory'), line.env, ['agents', 'check']);
    return p.status === 0 ? null : (p.stderr.trim() || `exit ${p.status}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface SuggestResult {
  repo: string;
  min: number;
  suggestions: StationSuggestion[];
  /** Findings whose drafted agent failed `factory agents check` (none expected). */
  problems: Array<{ id: string; station: string; problem: string }>;
}

/**
 * Runs the rules and writes a draft for every finding that has not been applied or dismissed. A
 * draft that already exists is rewritten against the files as they are now.
 */
export function suggestStations(line: Line, store: Store, min: number, now: Date, identity: Identity = NO_IDENTITY): SuggestResult {
  requireJobs(line);
  const { jobs } = readJobs(line.factoryDir);
  const rows = resolutions(line);
  const reviewers = rows.filter((r) => r.station.startsWith('reviewer-')).map((r) => r.station.slice('reviewer-'.length));
  const key = repoKey(line.repo);
  const state = store.state();
  const out: StationSuggestion[] = [];
  const problems: SuggestResult['problems'] = [];
  for (const f of allFindings(jobs, reviewers, min)) {
    const id = suggestionId(f);
    const status = state.stations?.[`${key}/${id}`]?.status;
    if (status === 'applied' || status === 'dismissed') continue;
    const files = changeFor(line, f, reviewers);
    const problem = checkDrafted(line, files);
    if (problem !== null) {
      problems.push({ id, station: f.station, problem });
      continue;
    }
    const rec: DraftRecord = {
      version: 1,
      id,
      rule: f.rule,
      station: f.station,
      key: f.key,
      repo: line.repo,
      title: titleOf(f),
      createdAt: now.toISOString(),
      files: files.map((x) => ({ path: x.path, before: x.current === null ? null : sha(x.current), after: x.after })),
    };
    const factoryRun = factoryRunLine(f, files, id, identity);
    const draft = store.writeStationFile(key, `${id}.md`, renderDraft(rec, f, line, files, factoryRun, identity));
    store.writeStationFile(key, `${id}.json`, `${JSON.stringify(rec, null, 2)}\n`);
    state.stations ??= {};
    state.stations[`${key}/${id}`] = { status: 'drafted', at: now.toISOString() };
    out.push({
      id,
      rule: f.rule,
      letter: RULE_LETTER[f.rule],
      station: f.station,
      title: maskPersonal(rec.title, identity),
      jobs: f.jobs,
      count: f.count,
      files: files.map((x) => ({ path: x.path, action: x.current === null ? 'create' : 'overwrite' })),
      draft,
      factoryRun,
    });
  }
  if (out.length > 0) store.saveState(state);
  return { repo: maskPersonal(line.repo, identity), min, suggestions: out, problems };
}

// ------------------------------------------------------------------ apply and dismiss

function readRecord(store: Store, line: Line, wanted: string): DraftRecord {
  if (!/^[0-9a-f]{12}$/.test(wanted)) throw new UsageError(`a station suggestion id is 12 hex characters, got ${JSON.stringify(wanted)}`);
  const text = store.readStationFile(repoKey(line.repo), `${wanted}.json`);
  if (text === null) throw new CliError(`no station suggestion ${wanted} for ${line.repo}; run stations suggest first`);
  let rec: DraftRecord;
  try {
    rec = JSON.parse(text) as DraftRecord;
  } catch {
    throw new CliError(`the draft record for ${wanted} is not valid JSON; run stations suggest again`);
  }
  if (rec.version !== 1 || rec.id !== wanted || rec.repo !== line.repo || !Array.isArray(rec.files)) {
    throw new CliError(`the draft record for ${wanted} does not belong to ${line.repo}; run stations suggest again`);
  }
  return rec;
}

function statusOf(store: Store, line: Line, id: string): StationState | undefined {
  return store.state().stations?.[`${repoKey(line.repo)}/${id}`];
}

/**
 * The absolute path of a draft's file, refused unless it is `<repo>/.claude/agents/factory-*.md` or
 * `<repo>/factory.json`, with no symlink on the way (so a write can't land anywhere else).
 */
export function safeTarget(repo: string, rel: string): string {
  if (rel !== CONFIG_PATH && !AGENT_PATH.test(rel)) throw new CliError(`refusing to write ${rel}: a station suggestion writes only .claude/agents/factory-*.md and factory.json`);
  const parts = rel.split('/');
  let at = repo;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    if (!existsSync(at) && !isLink(at)) continue;
    const st = lstatSync(at);
    if (st.isSymbolicLink()) throw new CliError(`refusing to write ${rel}: ${at} is a symbolic link`);
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new CliError(`refusing to write ${rel}: ${at} is not a ${i < parts.length - 1 ? 'directory' : 'regular file'}`);
  }
  return at;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface ApplyResult {
  id: string;
  repo: string;
  applied: boolean;
  dryRun: boolean;
  files: Array<{ path: string; action: 'create' | 'overwrite'; diff: string; backup?: string }>;
}

export function applyStation(line: Line, store: Store, wanted: string, confirm: boolean, now: Date): ApplyResult {
  const rec = readRecord(store, line, wanted);
  const status = statusOf(store, line, rec.id)?.status;
  if (status === 'applied') throw new CliError(`station suggestion ${rec.id} was already applied; run stations suggest for new ones`);
  if (status === 'dismissed') throw new CliError(`station suggestion ${rec.id} is dismissed; not applying it`);
  const plan = rec.files.map((f) => {
    const abs = safeTarget(line.repo, f.path);
    const current = readOrNull(abs);
    if ((current === null ? null : sha(current)) !== f.before) {
      throw new CliError(`refusing to apply ${rec.id}: ${f.path} ${current === null ? 'was deleted' : f.before === null ? 'was created' : 'changed'} since the draft was made; run stations suggest again`);
    }
    return { ...f, abs, current };
  });
  const files: ApplyResult['files'] = plan.map((f) => ({ path: f.path, action: f.current === null ? 'create' : 'overwrite', diff: unifiedDiff(f.path, f.current, f.after) }));
  const result: ApplyResult = { id: rec.id, repo: line.repo, applied: false, dryRun: !confirm, files };
  if (!confirm) return result;

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const key = repoKey(line.repo);
  plan.forEach((f, i) => {
    if (f.current !== null) (files[i] as ApplyResult['files'][number]).backup = store.writeStationFile(key, join('backups', `${rec.id}-${stamp}`, f.path), f.current);
  });
  const madeDirs: string[] = [];
  const written: typeof plan = [];
  const rollback = (): void => {
    for (const f of [...written].reverse()) {
      if (f.current === null) rmSync(f.abs, { force: true });
      else writeFileSync(f.abs, f.current);
    }
    for (const d of madeDirs.reverse()) {
      try {
        rmdirSync(d);
      } catch {
        // not empty: something else is in it now
      }
    }
  };
  try {
    for (const f of plan) {
      for (let d = dirname(f.abs), chain: string[] = []; ; d = dirname(d)) {
        if (existsSync(d)) {
          for (const c of chain.reverse()) {
            mkdirSync(c);
            madeDirs.push(c);
          }
          break;
        }
        chain.push(d);
      }
      writeFileSync(f.abs, f.after);
      written.push(f);
    }
  } catch (error) {
    rollback();
    throw new CliError(`could not write the files, so nothing was changed: ${(error as Error).message}`);
  }
  const check = factory(line.factoryRoot, line.repo, line.factoryDir, line.env, ['agents', 'check']);
  if (check.status !== 0) {
    rollback();
    throw new CliError(`factory agents check failed after applying ${rec.id}, so every file was put back as it was:\n${check.stderr.trim() || `exit ${check.status}`}`);
  }
  const state = store.state();
  state.stations ??= {};
  state.stations[`${key}/${rec.id}`] = { status: 'applied', at: now.toISOString() };
  store.saveState(state);
  return { ...result, applied: true };
}

export function dismissStation(line: Line, store: Store, wanted: string, now: Date): { id: string; dismissed: true } {
  const rec = readRecord(store, line, wanted);
  const status = statusOf(store, line, rec.id)?.status;
  if (status === 'applied') throw new CliError(`station suggestion ${rec.id} was already applied`);
  const state = store.state();
  state.stations ??= {};
  state.stations[`${repoKey(line.repo)}/${rec.id}`] = { status: 'dismissed', at: now.toISOString() };
  store.saveState(state);
  return { id: rec.id, dismissed: true };
}

