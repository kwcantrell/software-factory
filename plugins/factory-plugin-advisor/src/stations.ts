// `stations` and `stations suggest`: how the factory line's station agents (builder, verifier, each
// reviewer) have done across a repository's factory jobs, and the deterministic rules that turn that
// history into suggestions. Read-only: this module reads factory/jobs/*/job.json and the station
// files next to it, and never writes.
//
// job.json fields used (all optional, so job.json files written by older CLIs work):
// rounds[].reviewers{name:{verdict,at}}, followups[]{n,by,text}, history[]{at,event}.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalise, oneLine } from './redact.ts';

/** Minimum jobs (or failures) a rule needs before it suggests anything, unless --min says otherwise. */
export const DEFAULT_MIN = 3;

/**
 * Themes a finding or follow-up can be about. A text is about a theme when one of its keywords
 * starts a word in it (case-insensitive; a keyword is a word start, so `migrat` matches `migration`).
 * `coveredBy` lists the reviewer names whose lens covers the theme; a theme is also covered by a
 * reviewer named exactly like it. Documented in README.md ("Themes"); keep the two in step.
 */
export const THEMES: Readonly<Record<string, { about: string; keywords: readonly string[]; coveredBy: readonly string[] }>> = {
  security: {
    about: 'injection, secrets, authentication and authorization, unsafe defaults and data leaks',
    keywords: ['security', 'vulnerab', 'inject', 'xss', 'csrf', 'ssrf', 'secret', 'credential', 'privilege', 'unauthori', 'authenticat', 'authoriz', 'sanitiz', 'redact', 'leak'],
    coveredBy: ['security'],
  },
  performance: {
    about: 'speed, memory and work that grows faster than its input',
    keywords: ['performance', 'slow', 'latency', 'throughput', 'memory', 'cpu', 'quadratic', 'o(n^2)', 'n+1', 'benchmark', 'hot path'],
    coveredBy: ['performance'],
  },
  accessibility: {
    about: 'whether people using assistive technology, a keyboard or low vision can use the change',
    keywords: ['accessib', 'a11y', 'aria-', 'screen reader', 'screen-reader', 'keyboard navigation', 'focus order', 'contrast', 'alt text'],
    coveredBy: ['accessibility', 'a11y'],
  },
  docs: {
    about: 'documentation that must move with the code: READMEs, changelogs, guides and docstrings',
    keywords: ['documentation', 'docs', 'readme', 'changelog', 'docstring'],
    coveredBy: ['docs', 'documentation', 'standards'],
  },
  'data-migration': {
    about: 'stored data and file formats across versions: migrations, backfills and backward compatibility',
    keywords: ['migrat', 'backfill', 'schema change', 'backward compat', 'backwards compat', 'old format', 'older format', 'data loss'],
    coveredBy: ['data-migration', 'migration', 'migrations', 'compatibility'],
  },
  concurrency: {
    about: 'races, locks, atomic updates and work that runs at the same time',
    keywords: ['concurren', 'race condition', 'racy', 'race between', 'deadlock', 'atomic', 'mutex', 'thread-safe', 'thread safe', 'simultaneous', 'in parallel'],
    coveredBy: ['concurrency'],
  },
  dependency: {
    about: 'third-party packages: whether each is needed, maintained, pinned and safe',
    keywords: ['dependenc', 'package-lock', 'lockfile', 'supply chain', 'supply-chain', 'third-party', 'npm install', 'unpinned', 'vendored'],
    coveredBy: ['dependency', 'dependencies', 'supply-chain', 'security'],
  },
  tests: {
    about: 'tests that would fail if the feature broke, without flakiness',
    keywords: ['test coverage', 'untested', 'missing test', 'no test', 'flaky', 'weak test', 'assertion'],
    coveredBy: ['tests', 'testing', 'behavior', 'standards'],
  },
  correctness: {
    about: 'wrong results, edge cases, error paths and regressions',
    keywords: ['off-by-one', 'off by one', 'wrong result', 'incorrect', 'crash', 'edge case', 'regression', 'exit code'],
    coveredBy: ['correctness', 'behavior'],
  },
};

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const THEME_RE: ReadonlyArray<[string, RegExp]> = Object.entries(THEMES).map(([name, t]) => [
  name,
  new RegExp(`(?<![A-Za-z0-9])(?:${t.keywords.map(escapeRe).join('|')})`, 'i'),
]);

/** The themes a text is about, in THEMES order. */
export function themesOf(text: string): string[] {
  return THEME_RE.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Whether a reviewer named `lens` covers `theme`. */
export function covers(lens: string, theme: string): boolean {
  return lens === theme || (THEMES[theme]?.coveredBy.includes(lens) ?? false);
}

/** The themes in a reviewer's own lens. */
export function ownThemes(lens: string): string[] {
  return Object.keys(THEMES).filter((t) => covers(lens, t));
}

// ------------------------------------------------------------------ reading the line's history

interface RawSlot {
  verdict?: unknown;
  at?: unknown;
}
interface RawRound {
  n?: unknown;
  reviewers?: Record<string, RawSlot>;
}
interface RawFollowup {
  n?: unknown;
  by?: unknown;
  text?: unknown;
}
interface RawEvent {
  at?: unknown;
  event?: unknown;
}

export interface Round {
  n: number;
  /** reviewer -> verdict ('approve', 'changes') and when; verdict null while pending. */
  verdicts: Record<string, { verdict: string | null; at: string | null }>;
}

export interface ReviewFile {
  round: number;
  reviewer: string;
  /**
   * The text of its Blocking section(s): the findings that block. Empty when none, and when job.json
   * records that this reviewer approved that round (an approval blocks nothing).
   */
  blocking: string;
}

export interface ProofFile {
  /** What its Verdict says; null when it says neither PASS nor FAIL. */
  verdict: 'pass' | 'fail' | null;
  /** The first failure, one line, for a FAIL; else null. */
  reason: string | null;
  /** The whole Failures section, for themes. */
  failures: string;
}

export interface JobHistory {
  id: string;
  rounds: Round[];
  followups: Array<{ n: number; by: string; text: string }>;
  events: Array<{ at: string; event: string }>;
  reviews: ReviewFile[];
  proof: ProofFile | null;
  hasBuild: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Splits markdown into [heading, body] sections; a line that is only `**bold**` counts as a heading. */
export function sections(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let heading = '';
  let body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*\s*(?:[-:].*)?$/.exec(line.trim());
    if (h) {
      out.push([heading, body.join('\n')]);
      heading = (h[1] ?? '').trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  out.push([heading, body.join('\n')]);
  return out;
}

const NONE = /^\s*(?:none|n\/a|no blocking findings?|nothing)\.?\s*$/i;
/** A section whose first line starts like this holds no finding, whatever notes follow it. */
const NONE_FIRST = /^\s*(?:[-*]\s*)?(?:\*\*|_)?(?:none|n\/a|nothing|no (?:blocking )?(?:findings?|issues?))\b/i;

/** The Blocking sections of a review, without the Non-blocking ones; empty when it says none. */
export function blockingText(review: string): string {
  return sections(review)
    .filter(([h]) => /blocking/i.test(h) && !/non-?\s*blocking/i.test(h))
    .map(([, b]) => b.trim())
    .filter((b) => b !== '' && !NONE_FIRST.test(b))
    .join('\n');
}

/** A markdown line as plain text: no list marker, emphasis, backticks or `Criterion N:` prefix. */
function plain(line: string): string {
  return oneLine(
    line
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/[*_`]/g, '')
      .replace(/^(?:criterion|ac)\s*#?\d+\s*[:.-]\s*/i, ''),
  );
}

/**
 * The proof's verdict and, for a FAIL, its first failure reduced to one sentence. proof.md is
 * rewritten on every attempt, so only the latest attempt's reason can be read.
 */
export function parseProof(text: string): ProofFile {
  let verdict: ProofFile['verdict'] = null;
  for (const [h, b] of sections(text)) {
    const where = /verdict/i.test(h) ? `${h}\n${b}` : '';
    const m = /\b(PASS|FAIL)/.exec(where);
    if (m) {
      verdict = m[1] === 'PASS' ? 'pass' : 'fail';
      break;
    }
  }
  if (verdict === null) {
    const m = /verdict\W{0,6}(PASS|FAIL)\b/i.exec(text);
    if (m) verdict = (m[1] ?? '').toUpperCase() === 'PASS' ? 'pass' : 'fail';
  }
  const failures = sections(text)
    .filter(([h]) => /^failures?\b/i.test(h))
    .map(([, b]) => b.trim())
    .join('\n');
  let reason: string | null = null;
  if (verdict === 'fail' && failures !== '' && !NONE.test(failures)) {
    const first = failures.split('\n').map(plain).find((l) => l !== '' && !NONE.test(l)) ?? '';
    const sentence = (/^(.*?[.!?])(?:\s|$)/.exec(first)?.[1] ?? first).slice(0, 200);
    reason = sentence === '' ? null : sentence;
  }
  return { verdict, reason, failures };
}

/** The normalised form of a proof failure's reason: two failures with the same one are the same reason. */
export function reasonKey(reason: string): string {
  // Relative paths too (`test/a.test.ts`), which normalise() keeps: the same failure in another file.
  return normalise(reason.replace(/(?<![\w.-])[\w.-]+(?:\/[\w.-]+)+/g, '/x')).slice(0, 160);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** One job's history; null when its job.json is missing or not a JSON object. */
export function readJob(jobsDir: string, id: string): JobHistory | null {
  const dir = join(jobsDir, id);
  const text = readText(join(dir, 'job.json'));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const job = raw as Record<string, unknown>;
  const rounds: Round[] = arr(job.rounds).flatMap((r, i) => {
    if (typeof r !== 'object' || r === null) return [];
    const rr = r as RawRound;
    const verdicts: Round['verdicts'] = {};
    for (const [name, slot] of Object.entries(rr.reviewers ?? {})) {
      verdicts[name] = { verdict: str(slot?.verdict), at: str(slot?.at) };
    }
    return [{ n: typeof rr.n === 'number' ? rr.n : i + 1, verdicts }];
  });
  const followups = arr(job.followups).flatMap((f, i) => {
    const ff = f as RawFollowup;
    const by = str(ff?.by);
    const t = str(ff?.text);
    return by === null || t === null ? [] : [{ n: typeof ff.n === 'number' ? ff.n : i + 1, by, text: t }];
  });
  const events = arr(job.history).flatMap((e) => {
    const ee = e as RawEvent;
    const event = str(ee?.event);
    return event === null ? [] : [{ at: str(ee.at) ?? '', event }];
  });
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    files = [];
  }
  const reviews: ReviewFile[] = files
    .map((f) => /^review-(\d+)-([a-z0-9][a-z0-9-]*)\.md$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const round = Number(m[1]);
      const reviewer = m[2] as string;
      const approved = rounds.find((r) => r.n === round)?.verdicts[reviewer]?.verdict === 'approve';
      return { round, reviewer, blocking: approved ? '' : blockingText(readText(join(dir, m[0])) ?? '') };
    })
    .sort((a, b) => a.round - b.round || a.reviewer.localeCompare(b.reviewer));
  const proofText = readText(join(dir, 'proof.md'));
  return {
    id: str(job.id) ?? id,
    rounds,
    followups,
    events,
    reviews,
    proof: proofText === null ? null : parseProof(proofText),
    hasBuild: files.includes('build.md') || arr(job.history).some((e) => (e as { stage?: unknown })?.stage === 'build'),
  };
}

/** Every job under `<factoryDir>/jobs`, in id order. Unreadable job.json files are skipped and counted. */
export function readJobs(factoryDir: string): { jobs: JobHistory[]; skipped: string[] } {
  const jobsDir = join(factoryDir, 'jobs');
  const ids = existsSync(jobsDir)
    ? readdirSync(jobsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(jobsDir, d.name, 'job.json')))
        .map((d) => d.name)
        .sort()
    : [];
  const jobs: JobHistory[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const j = readJob(jobsDir, id);
    if (j === null) skipped.push(id);
    else jobs.push(j);
  }
  return { jobs, skipped };
}

// ------------------------------------------------------------------ per-station report

/** How `factory agents` resolves one station (a row of `factory agents --json`). */
export interface Resolution {
  station: string;
  agent: string;
  owner: 'project' | 'shipped' | 'missing' | 'unconfigured';
  file: string | null;
  note: string | null;
}

export interface StationReport extends Resolution {
  kind: 'builder' | 'verifier' | 'reviewer';
  lens: string | null;
  configured: boolean;
  /** Jobs this station worked on. */
  jobs: number;
  /** builder and verifier: the line's proof record. */
  proof?: { jobs: number; firstPassRate: number | null; passes: number; failures: number; failureReasons: Array<{ job: string; reason: string }> };
  /** reviewers: their verdicts, and how many "changes" the next round's rework turned into its approval. */
  reviews?: { approve: number; changes: number; changesThenApproved: number; changesThenApprovedRate: number | null };
  escalations: number;
  followups: number;
}

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part / whole) * 100) / 100);

function proofEvents(j: JobHistory): Array<{ at: string; passed: boolean }> {
  return j.events.filter((e) => /^proof (passed|failed)/.test(e.event)).map((e) => ({ at: e.at, passed: e.event.startsWith('proof passed') }));
}

/** The stations an escalation is charged to, from its `needs human:` event. Empty for one not caused by a station. */
export function escalatedStations(event: string): string[] {
  if (!event.startsWith('needs human:') || event.startsWith('needs human: approved')) return [];
  const reason = event.slice('needs human:'.length).trim();
  if (reason.startsWith('proof failed')) return ['builder', 'verifier'];
  const changes = /^changes still requested after .*\(([^)]*)\)\s*$/.exec(reason);
  if (changes) return ['builder', ...(changes[1] ?? '').split(',').map((r) => `reviewer-${r.trim()}`).filter((r) => r !== 'reviewer-')];
  if (reason.startsWith('no approval after')) return ['builder'];
  return [];
}

function stationOf(name: string): { kind: StationReport['kind']; lens: string | null; by: string } {
  if (name === 'builder' || name === 'verifier') return { kind: name, lens: null, by: name };
  const lens = name.replace(/^reviewer-/, '');
  return { kind: 'reviewer', lens, by: lens };
}

/**
 * One row per station: every station `factory agents` lists (configured), then any reviewer that
 * recorded a verdict in a job but is no longer configured.
 */
export function report(jobs: readonly JobHistory[], resolutions: readonly Resolution[]): StationReport[] {
  const names = resolutions.map((r) => r.station);
  const seen = new Set<string>();
  for (const j of jobs) for (const r of j.rounds) for (const name of Object.keys(r.verdicts)) seen.add(`reviewer-${name}`);
  for (const s of [...seen].sort()) if (!names.includes(s)) names.push(s);

  const escalations = new Map<string, number>();
  for (const j of jobs) {
    for (const e of j.events) for (const s of escalatedStations(e.event)) escalations.set(s, (escalations.get(s) ?? 0) + 1);
  }

  return names.map((name) => {
    const res = resolutions.find((r) => r.station === name) ?? { station: name, agent: 'none', owner: 'unconfigured' as const, file: null, note: 'not in factory.json reviewers' };
    const st = stationOf(name);
    const followups = jobs.reduce((t, j) => t + j.followups.filter((f) => f.by === st.by).length, 0);
    const base = { ...res, kind: st.kind, lens: st.lens, configured: resolutions.some((r) => r.station === name), escalations: escalations.get(name) ?? 0, followups };
    if (st.kind !== 'reviewer') {
      const withProof = jobs.filter((j) => proofEvents(j).length > 0);
      const handled = st.kind === 'builder' ? jobs.filter((j) => j.hasBuild || proofEvents(j).length > 0) : withProof;
      const all = withProof.flatMap(proofEvents);
      const failureReasons = jobs.flatMap((j) => (j.proof?.verdict === 'fail' && j.proof.reason !== null ? [{ job: j.id, reason: j.proof.reason }] : []));
      return {
        ...base,
        jobs: handled.length,
        proof: {
          jobs: withProof.length,
          firstPassRate: rate(withProof.filter((j) => proofEvents(j)[0]?.passed === true).length, withProof.length),
          passes: all.filter((p) => p.passed).length,
          failures: all.filter((p) => !p.passed).length,
          failureReasons,
        },
      };
    }
    const lens = st.lens as string;
    let approve = 0;
    let changes = 0;
    let fixed = 0;
    let handled = 0;
    for (const j of jobs) {
      let worked = false;
      j.rounds.forEach((r, i) => {
        const v = r.verdicts[lens]?.verdict;
        if (v === 'approve') approve += 1;
        if (v === 'changes') {
          changes += 1;
          if (j.rounds[i + 1]?.verdicts[lens]?.verdict === 'approve') fixed += 1;
        }
        if (v === 'approve' || v === 'changes') worked = true;
      });
      if (worked) handled += 1;
    }
    return { ...base, jobs: handled, reviews: { approve, changes, changesThenApproved: fixed, changesThenApprovedRate: rate(fixed, changes) } };
  });
}

// ------------------------------------------------------------------ rules

export type Rule = 'new-reviewer' | 'modify-builder' | 'modify-reviewer' | 'modify-verifier';
/** The rule letters README.md and the task use. */
export const RULE_LETTER: Record<Rule, string> = { 'new-reviewer': 'a', 'modify-builder': 'b', 'modify-reviewer': 'c', 'modify-verifier': 'd' };

export interface Evidence {
  job: string;
  /** Where in the job: `follow-up 2 by builder`, `review round 1 by behavior (blocking)`, `proof.md`. */
  source: string;
  /** The text it quotes, as it is in the job; drafts redact and mask it. */
  text: string;
}

export interface Finding {
  rule: Rule;
  /** The station to add or change: `reviewer-<lens>`, `builder` or `verifier`. */
  station: string;
  /** What groups this finding: the theme, the normalised reason, or the reviewer sub-rule. */
  key: string;
  /** Distinct jobs, in id order. */
  jobs: string[];
  /** Jobs (rules a, c, d) or proof failures (rule b) behind it. */
  count: number;
  evidence: Evidence[];
  theme?: string;
  /** Rule b: the reason as one proof.md put it. */
  reason?: string;
  /** Rule c: `miss` (approved what a later check found in its lens) or `overlap` (another lens raised its finding again). */
  variant?: 'miss' | 'overlap';
  themes?: string[];
}

const byJob = (a: Evidence, b: Evidence): number => a.job.localeCompare(b.job) || a.source.localeCompare(b.source);
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Rule (a): themes no configured reviewer covers that follow-ups or blocking findings raise in at least `min` jobs. */
function newReviewer(jobs: readonly JobHistory[], reviewers: readonly string[], min: number): Finding[] {
  const out: Finding[] = [];
  for (const theme of Object.keys(THEMES)) {
    if (reviewers.some((r) => covers(r, theme))) continue;
    const evidence: Evidence[] = [];
    for (const j of jobs) {
      for (const f of j.followups) if (themesOf(f.text).includes(theme)) evidence.push({ job: j.id, source: `follow-up ${f.n} by ${f.by}`, text: f.text });
      for (const r of j.reviews) if (themesOf(r.blocking).includes(theme)) evidence.push({ job: j.id, source: `review round ${r.round} by ${r.reviewer} (blocking)`, text: r.blocking });
    }
    const ids = uniq(evidence.map((e) => e.job));
    if (ids.length >= min) out.push({ rule: 'new-reviewer', station: `reviewer-${theme}`, key: theme, jobs: ids, count: ids.length, evidence: evidence.sort(byJob), theme });
  }
  return out;
}

/** Rule (b): proof failures with the same normalised reason, at least `min` of them. */
function modifyBuilder(jobs: readonly JobHistory[], min: number): Finding[] {
  const groups = new Map<string, Evidence[]>();
  for (const j of jobs) {
    if (j.proof?.verdict !== 'fail' || j.proof.reason === null) continue;
    const key = reasonKey(j.proof.reason);
    if (key === '') continue;
    groups.set(key, [...(groups.get(key) ?? []), { job: j.id, source: 'proof.md (failures)', text: j.proof.reason }]);
  }
  return [...groups.entries()]
    .filter(([, ev]) => ev.length >= min)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, ev]) => ({ rule: 'modify-builder' as const, station: 'builder', key, jobs: uniq(ev.map((e) => e.job)), count: ev.length, evidence: ev.sort(byJob), reason: (ev[0] as Evidence).text }));
}

/**
 * Rule (c), per configured reviewer R:
 * - miss: R approved in round k, and in that job another reviewer's blocking findings in round k or
 *   later, or a proof that failed after R's approval, were about a theme in R's own lens (R's own
 *   later findings are not counted: they may be about the rework's new code);
 * - overlap: R asked for changes in round k, and in round k+1 another reviewer's blocking findings
 *   were about a theme R's blocking findings in round k were about.
 */
function modifyReviewer(jobs: readonly JobHistory[], reviewers: readonly string[], min: number): Finding[] {
  const out: Finding[] = [];
  for (const lens of reviewers) {
    const own = ownThemes(lens);
    const miss: Evidence[] = [];
    const missThemes: string[] = [];
    const overlap: Evidence[] = [];
    const overlapThemes: string[] = [];
    for (const j of jobs) {
      const review = (round: number, who: string): ReviewFile | undefined => j.reviews.find((r) => r.round === round && r.reviewer === who);
      for (const r of j.rounds) {
        const slot = r.verdicts[lens];
        if (slot?.verdict === 'approve' && own.length > 0) {
          for (const later of j.reviews) {
            if (later.round < r.n || later.reviewer === lens) continue;
            const hit = themesOf(later.blocking).filter((t) => own.includes(t));
            if (hit.length > 0) {
              miss.push({ job: j.id, source: `approved round ${r.n}; review round ${later.round} by ${later.reviewer} (blocking)`, text: later.blocking });
              missThemes.push(...hit);
            }
          }
          const failedAfter = j.events.some((e) => e.event.startsWith('proof failed') && slot.at !== null && e.at > slot.at);
          if (failedAfter && j.proof?.verdict === 'fail') {
            const hit = themesOf(j.proof.failures).filter((t) => own.includes(t));
            if (hit.length > 0) {
              miss.push({ job: j.id, source: `approved round ${r.n}; later proof.md (failures)`, text: j.proof.failures });
              missThemes.push(...hit);
            }
          }
        }
        if (slot?.verdict === 'changes') {
          const mine = themesOf(review(r.n, lens)?.blocking ?? '');
          for (const next of j.reviews.filter((x) => x.round === r.n + 1 && x.reviewer !== lens)) {
            const hit = themesOf(next.blocking).filter((t) => mine.includes(t));
            if (hit.length > 0) {
              overlap.push({ job: j.id, source: `changes in round ${r.n}; review round ${next.round} by ${next.reviewer} (blocking)`, text: next.blocking });
              overlapThemes.push(...hit);
            }
          }
        }
      }
    }
    for (const [variant, ev, themes] of [['miss', miss, missThemes], ['overlap', overlap, overlapThemes]] as const) {
      const ids = uniq(ev.map((e) => e.job));
      if (ids.length >= min) {
        out.push({ rule: 'modify-reviewer', station: `reviewer-${lens}`, key: variant, jobs: ids, count: ids.length, evidence: [...ev].sort(byJob), variant, themes: uniq(themes) });
      }
    }
  }
  return out;
}

const UNMET = /(?<![A-Za-z])(?:criterion|criteria|acceptance)/i;

/** Rule (d): jobs that passed proof and then got a behavior "changes" whose blocking findings name an unmet criterion. */
function modifyVerifier(jobs: readonly JobHistory[], min: number): Finding[] {
  const evidence: Evidence[] = [];
  for (const j of jobs) {
    if (!j.events.some((e) => e.event.startsWith('proof passed'))) continue;
    for (const r of j.rounds) {
      if (r.verdicts.behavior?.verdict !== 'changes') continue;
      const blocking = j.reviews.find((x) => x.round === r.n && x.reviewer === 'behavior')?.blocking ?? '';
      if (UNMET.test(blocking)) evidence.push({ job: j.id, source: `review round ${r.n} by behavior (blocking)`, text: blocking });
    }
  }
  const ids = uniq(evidence.map((e) => e.job));
  return ids.length >= min ? [{ rule: 'modify-verifier', station: 'verifier', key: 'unmet-criterion', jobs: ids, count: ids.length, evidence: evidence.sort(byJob) }] : [];
}

/** Every rule's findings, in rule order (a, b, c, d), then by station and key. Same history, same findings. */
export function findings(jobs: readonly JobHistory[], reviewers: readonly string[], min: number = DEFAULT_MIN): Finding[] {
  return [...newReviewer(jobs, reviewers, min), ...modifyBuilder(jobs, min), ...modifyReviewer(jobs, reviewers, min), ...modifyVerifier(jobs, min)];
}
