// match: ranks the catalog against a short task description. Local and deterministic: the same
// catalog and text always give the same result. It is a shortlist for Claude, which reads the
// descriptions and decides; the score only orders and filters.
//
// Scoring, per entry (an installed plugin with its skills, a user skill, or an available plugin):
//   - The task and the entry's text (name, description, skill names and descriptions, and the CLI
//     commands its skills run) are split into terms: lowercase words, split on anything but letters
//     and digits (`list_jobs` is `list` + `jobs`), with a few two-word spellings joined (COMPOUNDS:
//     `follow-up` is `followup`), stop words and generic words dropped, then lightly stemmed
//     (`jobs` -> `job`).
//   - Each distinct task term found in the entry scores 1, or DOMAIN_WEIGHT for a software-factory
//     term (DOMAIN_TERMS); the score doubles when the term is in the entry's name. The name is the
//     plugin (or skill) name without the marketplace's shared `factory-` prefix (only the `factory`
//     plugin is named `factory`), plus the CLI commands its skills run (`factory-dev release`).
//   - Each two-word phrase of the task (adjacent kept terms) also found adjacent in the entry adds
//     PHRASE_BONUS.
//   - An entry is a match when its score is at least THRESHOLD: one software-factory term plus any
//     other term, a domain or name term, a phrase, or three plain terms. Below that,
//     `none_applicable` is true.
import { DEFAULT_MODE, type Mode } from './config.ts';
import { type AvailablePlugin, type Catalog, type ElsewherePlugin, type InstalledPlugin, SELF, type Skill, type UserSkill } from './catalog.ts';

export const THRESHOLD = 3;
export const DOMAIN_WEIGHT = 2;
export const NAME_FACTOR = 2;
export const PHRASE_BONUS = 2;
/** Entries kept per list. */
export const LIMIT = 5;
export const ADVISOR = 'factory-plugin-advisor';
/** Longest task text kept in the factory-plugin-advisor summary. */
export const SUMMARY_MAX = 120;
/** The prefix every marketplace plugin but `factory` shares; it does not tell them apart. */
export const SHARED_PREFIX = 'factory';

/** Common English words, plus words every entry here shares ("software", "repository", "claude"). */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a about after all also an and any are as at be been before but by can could do does doing done for from get got ' +
    'has have help how i if in into is it its just let like make me more my need needs no not now of on once one or our ' +
    'out over please run see set should so some such than that the their them then there these they this those to too ' +
    'up us use used uses using via want was way we what when where which while who why will with would you your ' +
    'software repository repo skill skills claude code cli command commands tool tools typescript npx ' +
    'task work working thing things something new user users'
  ).split(' '),
);

/**
 * Terms specific to software-factory and its tooling (stemmed), weighted DOMAIN_WEIGHT: the line
 * (factory, job, worktree, stations, gates), its records (spec, follow-up, changelog, release), and
 * the marketplace's own tooling (docs, plugins, their convention, the advisor).
 */
export const DOMAIN_TERMS: ReadonlySet<string> = new Set(
  (
    'factory job worktree builder verifier reviewer proof review ship merge spec gate dashboard ' +
    'follow followup changelog release docs plugin ' +
    'intake triage approve rework upgrade stale lint convention scaffold template marketplace ' +
    'advisor friction workaround recurring hook ci typecheck'
  )
    .split(' ')
    .map(stem),
);

/** A light, deterministic suffix stripper: enough that `events`/`event` and `logged`/`log` meet. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else return w;
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

/**
 * Two-word spellings of one software-factory term, joined before anything else: `follow-up`,
 * `follow up` and `followup` are all `followup` (the `factory followup` command), and the same for
 * worktree, changelog and typecheck.
 */
export const COMPOUNDS: ReadonlyMap<string, string> = new Map([
  ['follow up', 'followup'],
  ['follow ups', 'followups'],
  ['work tree', 'worktree'],
  ['work trees', 'worktrees'],
  ['change log', 'changelog'],
  ['type check', 'typecheck'],
]);

/** The kept terms of a text, in order (stop words dropped, so phrases are pairs of kept terms). */
export function terms(text: string): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  const joined: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const compound = COMPOUNDS.get(`${words[i]} ${words[i + 1]}`);
    if (compound !== undefined) {
      joined.push(compound);
      i++;
    } else joined.push(words[i] ?? '');
  }
  return joined.filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)).map(stem);
}

function pairs(list: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < list.length; i++) out.add(`${list[i]} ${list[i + 1]}`);
  return out;
}

export interface Score {
  score: number;
  /** The task's terms and phrases found in the entry, in the task's order. */
  matched: string[];
}

/**
 * The words of an entry's name: its name without the shared `factory-` prefix (but `factory` itself
 * stays `factory`), plus `commands`, the CLI commands its skills run.
 */
export function nameText(name: string, commands: readonly string[] = []): string {
  const words = name.split('-');
  const own = words.length > 1 && words[0] === SHARED_PREFIX ? words.slice(1) : words;
  return [...own, ...commands].join(' ');
}

/**
 * Scores one entry against the task's terms. `name` is the plugin or skill name, `text` the rest of
 * its text, `commands` the CLI commands its skills run (counted as part of the name).
 */
export function score(task: readonly string[], name: string, text: string, commands: readonly string[] = []): Score {
  const nameTerms = new Set(terms(nameText(name, commands)));
  const textTerms = terms(`${name.replace(/-/g, ' ')} ${commands.join(' ')} ${text}`);
  const have = new Set(textTerms);
  const havePairs = pairs(textTerms);
  let total = 0;
  const matched: string[] = [];
  for (const t of new Set(task)) {
    if (!have.has(t)) continue;
    total += (DOMAIN_TERMS.has(t) ? DOMAIN_WEIGHT : 1) * (nameTerms.has(t) ? NAME_FACTOR : 1);
    matched.push(t);
  }
  for (const p of pairs(task)) {
    if (!havePairs.has(p)) continue;
    total += PHRASE_BONUS;
    matched.push(`"${p}"`);
  }
  return { score: total, matched };
}

export interface InstalledMatch {
  kind: 'plugin' | 'user-skill';
  /** The plugin's name, or the user skill's name. */
  name: string;
  /** `<plugin>@<marketplace>`; absent for a user skill. */
  id?: string;
  /** The skill that fits best, when the entry has skills. */
  skill?: string;
  description: string;
  enabled: boolean;
  score: number;
  reason: string[];
}

export interface AvailableMatch {
  name: string;
  skill?: string;
  description: string;
  score: number;
  reason: string[];
  installCommand: string;
}

/** A fitting plugin installed only for another project (project or local scope). */
export interface ElsewhereMatch {
  name: string;
  id: string;
  skill?: string;
  description: string;
  scope: string;
  projectPath: string;
  score: number;
  reason: string[];
}

export interface Advisor {
  record: string;
  suggest: string;
}

export interface MatchResult {
  task: string;
  threshold: number;
  /** The factory-plugin-discover mode; with `off`, `available` and `elsewhere` are always empty. */
  mode: Mode;
  installed: InstalledMatch[];
  available: AvailableMatch[];
  /** Fitting plugins installed only for another project: installed elsewhere, not missing. */
  elsewhere: ElsewhereMatch[];
  /**
   * True when no installed, marketplace or installed-elsewhere plugin fits. Decided before mode `off`
   * empties `available` and `elsewhere`, so it stays false when a marketplace plugin fits.
   */
  none_applicable: boolean;
  /** Set when none_applicable and factory-plugin-advisor is installed and enabled. */
  advisor?: Advisor;
}

/** Best skill of an entry, by its own name and description; ties keep the first (sorted) skill. */
function bestSkill(task: readonly string[], skills: readonly Skill[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const s of skills) {
    const { score: v } = score(task, s.name, s.description, s.commands);
    if (best === undefined || v > best.score) best = { name: s.name, score: v };
  }
  return best === undefined || best.score === 0 ? skills[0]?.name : best.name;
}

function pluginText(p: { description: string; skills: readonly Skill[] }): string {
  // The plugin's description, then each skill's name (as words) and description.
  return [p.description, ...p.skills.map((s) => `${s.name.replace(/-/g, ' ')} ${s.description}`)].join(' ');
}

/** Every CLI command the plugin's skills run, sorted. */
function pluginCommands(p: { skills: readonly Skill[] }): string[] {
  return [...new Set(p.skills.flatMap((s) => s.commands))].sort();
}

function scorePlugin(task: readonly string[], p: { name: string; description: string; skills: readonly Skill[] }): Score {
  return score(task, p.name, pluginText(p), pluginCommands(p));
}

/** POSIX shell single-quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Characters that are special inside a shell double-quoted string (plus `!`, history expansion). */
const DOUBLE_QUOTE_SPECIAL = /["$`\\!\n]/;

/**
 * The `--package` argument for factory-plugin-advisor. Its skill pre-approves its commands as
 * `--package="${CLAUDE_PLUGIN_ROOT}"`, so the path goes in double quotes, the same form, and the
 * printed line matches that rule without a permission prompt. A path that double quotes cannot hold
 * literally falls back to single quotes: safe, but then Claude Code asks first.
 */
export function packageArg(installPath: string): string {
  return DOUBLE_QUOTE_SPECIAL.test(installPath) ? `--package=${shellQuote(installPath)}` : `--package="${installPath}"`;
}

export function advisorCommands(installPath: string, task: string): Advisor {
  const prefix = `npx --yes --offline --loglevel=error ${packageArg(installPath)} -- ${ADVISOR}`;
  const oneLine = task.replace(/\s+/g, ' ').trim();
  const text = oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 3)}...` : oneLine;
  const summary = `no installed or marketplace plugin fits: ${text}`;
  return {
    record: `${prefix} record --plugin none --kind missing-guidance --summary ${shellQuote(summary)} --json`,
    suggest: `${prefix} suggest --json`,
  };
}

const byScore = <T extends { score: number; name: string }>(a: T, b: T): number => b.score - a.score || a.name.localeCompare(b.name);

export function match(catalog: Catalog, task: string, mode: Mode = DEFAULT_MODE, threshold: number = THRESHOLD): MatchResult {
  const words = terms(task);
  const installed: InstalledMatch[] = [];
  const plugin = (p: InstalledPlugin): void => {
    if (p.name === SELF) return;
    const s = scorePlugin(words, p);
    if (s.score < threshold) return;
    const skill = bestSkill(words, p.skills);
    installed.push({ kind: 'plugin', name: p.name, id: p.id, ...(skill === undefined ? {} : { skill }), description: p.description, enabled: p.enabled, score: s.score, reason: s.matched });
  };
  const userSkill = (u: UserSkill): void => {
    const s = score(words, u.name, u.description, u.commands);
    if (s.score >= threshold) installed.push({ kind: 'user-skill', name: u.name, skill: u.name, description: u.description, enabled: true, score: s.score, reason: s.matched });
  };
  catalog.installed.forEach(plugin);
  catalog.userSkills.forEach(userSkill);
  const available: AvailableMatch[] = [];
  const offer = (p: AvailablePlugin): void => {
    if (p.name === SELF) return;
    const s = scorePlugin(words, p);
    if (s.score < threshold) return;
    const skill = bestSkill(words, p.skills);
    available.push({ name: p.name, ...(skill === undefined ? {} : { skill }), description: p.description, score: s.score, reason: s.matched, installCommand: p.installCommand });
  };
  const elsewhere: ElsewhereMatch[] = [];
  const other = (p: ElsewherePlugin): void => {
    if (p.name === SELF) return;
    const s = scorePlugin(words, p);
    if (s.score < threshold) return;
    const skill = bestSkill(words, p.skills);
    elsewhere.push({ name: p.name, id: p.id, ...(skill === undefined ? {} : { skill }), description: p.description, scope: p.scope, projectPath: p.projectPath, score: s.score, reason: s.matched });
  };
  catalog.available.forEach(offer);
  catalog.installedElsewhere.forEach(other);
  installed.sort(byScore);
  available.sort(byScore);
  elsewhere.sort(byScore);
  // Decided on every fitting plugin, before mode off hides the ones not installed here: "nothing
  // fits" (and the factory-plugin-advisor record line that says so) must not be claimed when one does.
  const noneApplicable = installed.length === 0 && available.length === 0 && elsewhere.length === 0;
  // Mode off: never suggest a plugin that is not installed here.
  const suggest = mode !== 'off';
  const result: MatchResult = {
    task,
    threshold,
    mode,
    installed: installed.slice(0, LIMIT),
    available: suggest ? available.slice(0, LIMIT) : [],
    elsewhere: suggest ? elsewhere.slice(0, LIMIT) : [],
    none_applicable: noneApplicable,
  };
  if (result.none_applicable) {
    const advisor = catalog.installed.find((p) => p.name === ADVISOR && p.enabled);
    if (advisor !== undefined) result.advisor = advisorCommands(advisor.installPath, task);
  }
  return result;
}
