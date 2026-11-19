// record, list, show, suggest and dismiss: the occurrence log grouped into issues, and the draft
// suggestions written for issues that recur.
import { cleanDetail, cleanSummary, oneLine, cap, type Identity, NO_IDENTITY, maskPersonal, signature as signatureOf } from './redact.ts';
import { CliError, type Occurrence, type State, type Store } from './store.ts';

export const KINDS = {
  'cli-failure': 'a marketplace plugin CLI command failed',
  workaround: "a plugin's bug or gap had to be worked around",
  'manual-step': 'a step a plugin should do was done by hand',
  'missing-guidance': "a skill's guidance was missing or wrong",
  'user-correction': 'the user corrected how a plugin was used',
} as const;
export type Kind = keyof typeof KINDS;

export const PLUGIN_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const DEFAULT_THRESHOLD = 3;
export const MARKETPLACE_REPO = 'kwcantrell/software-factory';
/** Occurrences quoted in a draft's evidence, newest first. */
export const EVIDENCE_MAX = 10;

export function isKind(value: string): value is Kind {
  return Object.hasOwn(KINDS, value);
}

export interface RecordInput {
  plugin: string;
  kind: string;
  summary: string;
  detail?: string;
  subcommand?: string;
  exitCode?: number;
}

export interface RecordResult {
  signature: string;
  plugin: string;
  kind: string;
  summary: string;
  count: number;
  redacted: boolean;
}

/** Checks one occurrence's fields; throws UsageError (exit 2) when they are invalid. */
export function validateInput(input: RecordInput): void {
  if (input.plugin !== 'none' && !PLUGIN_NAME.test(input.plugin)) {
    throw new UsageError(`--plugin must be a kebab-case plugin name or 'none', got ${JSON.stringify(input.plugin)}`);
  }
  if (input.plugin.length > 64) throw new UsageError('--plugin is longer than 64 characters');
  if (!isKind(input.kind)) throw new UsageError(`--kind must be one of ${Object.keys(KINDS).join(', ')}; got ${JSON.stringify(input.kind)}`);
  if (oneLine(input.summary) === '') throw new UsageError('--summary is required and must not be empty');
}

export class UsageError extends CliError {}

export function record(store: Store, input: RecordInput, now: Date, source: Occurrence['source'] = 'record', identity: Identity = NO_IDENTITY): RecordResult {
  validateInput(input);
  const summary = cleanSummary(input.summary, identity);
  const detail = input.detail === undefined ? undefined : cleanDetail(input.detail, identity);
  const sig = signatureOf(input.plugin, input.kind, summary);
  const occurrence: Occurrence = {
    signature: sig,
    plugin: input.plugin,
    kind: input.kind,
    summary,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    at: now.toISOString(),
    source,
    ...(input.subcommand === undefined ? {} : { subcommand: input.subcommand }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  };
  store.append(occurrence);
  const count = store.occurrences().filter((o) => o.signature === sig).length;
  const redacted = summary.includes('[redacted]') || (detail?.includes('[redacted]') ?? false);
  return { signature: sig, plugin: input.plugin, kind: input.kind, summary, count, redacted };
}

export type Status = 'open' | 'suggested' | 'dismissed' | 'filed';

export interface Issue {
  signature: string;
  plugin: string;
  kind: string;
  /** The most recent occurrence's summary. */
  summary: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: Status;
  issueUrl?: string;
}

export function statusOf(state: State, sig: string): Status {
  const s = state.issues[sig];
  if (s?.dismissedAt !== undefined) return 'dismissed';
  if (s?.filed !== undefined) return 'filed';
  if (s?.suggestedCount !== undefined) return 'suggested';
  return 'open';
}

/** Occurrences grouped by signature, most frequent first (then most recent). */
export function issues(occurrences: readonly Occurrence[], state: State): Issue[] {
  const groups = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const list = groups.get(o.signature);
    if (list === undefined) groups.set(o.signature, [o]);
    else list.push(o);
  }
  const out: Issue[] = [];
  for (const [sig, list] of groups) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0] as Occurrence;
    const last = sorted[sorted.length - 1] as Occurrence;
    const filed = state.issues[sig]?.filed;
    out.push({
      signature: sig,
      plugin: last.plugin,
      kind: last.kind,
      summary: last.summary,
      count: sorted.length,
      firstSeen: first.at,
      lastSeen: last.at,
      status: statusOf(state, sig),
      ...(filed === undefined ? {} : { issueUrl: filed.url }),
    });
  }
  return out.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

export function list(store: Store, options: { min?: number; plugin?: string }): Issue[] {
  return issues(store.occurrences(), store.state()).filter(
    (i) => i.count >= (options.min ?? 1) && (options.plugin === undefined || i.plugin === options.plugin),
  );
}

/** Finds an issue by its signature, or by a unique prefix of at least 4 characters. */
export function resolveSignature(all: readonly Issue[], wanted: string): Issue {
  if (!/^[0-9a-f]{4,12}$/.test(wanted)) throw new UsageError(`a signature is 4 to 12 hex characters, got ${JSON.stringify(wanted)}`);
  const matches = all.filter((i) => i.signature.startsWith(wanted));
  if (matches.length === 0) throw new CliError(`no recorded issue has signature ${wanted}; run list to see them`);
  if (matches.length > 1) throw new CliError(`signature prefix ${wanted} matches ${matches.length} issues; give more characters`);
  return matches[0] as Issue;
}

export interface IssueDetail extends Issue {
  occurrences: Array<Omit<Occurrence, 'signature' | 'plugin' | 'kind'>>;
  draft?: string;
}

export function show(store: Store, wanted: string): IssueDetail {
  const all = store.occurrences();
  const issue = resolveSignature(issues(all, store.state()), wanted);
  const occurrences = all
    .filter((o) => o.signature === issue.signature)
    .map(({ signature: _s, plugin: _p, kind: _k, ...rest }) => rest)
    .sort((a, b) => a.at.localeCompare(b.at));
  const draft = store.readDraft(issue.signature) === null ? undefined : store.draftPath(issue.signature);
  return { ...issue, occurrences, ...(draft === undefined ? {} : { draft }) };
}

export interface Target {
  kind: 'existing' | 'new';
  plugin: string | null;
  /** Human text: `existing plugin \`x\`` or `new plugin: \`x\``. */
  text: string;
}

export function targetOf(plugin: string, known: readonly string[]): Target {
  if (known.includes(plugin)) return { kind: 'existing', plugin, text: `existing marketplace plugin \`${plugin}\`` };
  if (plugin === 'none') return { kind: 'new', plugin: null, text: 'new plugin: `<name to be chosen>`' };
  return { kind: 'new', plugin, text: `new plugin: \`${plugin}\`` };
}

/** One sentence: the change to make, by kind and target. */
export function proposedChange(kind: string, target: Target, subcommand?: string): string {
  if (target.kind === 'new') {
    const name = target.plugin ?? '<name>';
    return `Create a new marketplace plugin \`${name}\` (npm run new-plugin -- ${name}) whose CLI does this work and whose skill tells Claude when to call it, unless an existing plugin can reasonably take it on.`;
  }
  const p = target.plugin ?? '';
  switch (kind) {
    case 'cli-failure':
      return `Fix \`${p}${subcommand === undefined ? '' : ` ${subcommand}`}\` so this case succeeds, or fails with a message that says what to do next, and add a test that reproduces it.`;
    case 'workaround':
      return `Fix the bug or gap in \`${p}\` that needed this workaround, add a test for it, and update its skill if the workaround was in the guidance.`;
    case 'manual-step':
      return `Add or extend a \`${p}\` CLI command that does this step, and have its skill call that command instead of leaving the step to be done by hand.`;
    case 'missing-guidance':
      return `Update \`${p}\`'s skill (SKILL.md) so it covers this case correctly, and add a skill command line or test that exercises it.`;
    case 'user-correction':
      return `Change \`${p}\`'s skill (or CLI defaults) so Claude uses the plugin the way the user corrected it to, and add a test for that path.`;
    default:
      return `Change \`${p}\` so this no longer happens.`;
  }
}

export interface Suggestion {
  signature: string;
  plugin: string;
  kind: string;
  summary: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  target: Target;
  title: string;
  draft: string;
  factoryRun: string;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Text placed in markdown that must not break out of its line or fence. */
function inline(text: string): string {
  return oneLine(text).replaceAll('`', "'");
}

export const TITLE_MAX = 120;

/** The title's fixed start, `factory-plugin-advisor: <who>: `; the (capped) summary follows it. */
function titlePrefix(target: Target): string {
  const who = target.kind === 'existing' ? target.plugin : `new plugin${target.plugin === null ? '' : ` ${target.plugin}`}`;
  return `factory-plugin-advisor: ${who}: `;
}

/**
 * A stored summary as a draft quotes it: one line, backticks made quotes, personal details masked
 * again (a log written before masking existed still holds them, and once its backticks are gone a
 * mention in a code span would link).
 */
function quoted(summary: string, identity: Identity): string {
  return maskPersonal(inline(summary), identity);
}

/**
 * The summary as the title quotes it after `prefix`: capped on its own, so it is a clean field too.
 * Masked after the cut as well, which can turn an npm scope (`@scope/name`) into a mention.
 */
function titleSummary(prefix: string, summary: string, identity: Identity): string {
  return maskPersonal(cap(quoted(summary, identity), Math.max(TITLE_MAX - [...prefix].length, 20)), identity);
}

export function draftTitle(issue: Issue, target: Target, identity: Identity = NO_IDENTITY): string {
  const prefix = titlePrefix(target);
  return `${prefix}${titleSummary(prefix, issue.summary, identity)}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The draft lines that quote a stored field, as `renderDraft` writes them: the fixed text before the
 * field and after it. The field always runs between the two, so `file` can check the field and the
 * text around it separately (see `draftFields`).
 */
export const FIELD_LINES: ReadonlyArray<readonly [before: RegExp, after: RegExp]> = [
  // # <title>
  [/^# factory-plugin-advisor: [a-z0-9 -]+: $/, /^$/],
  // Problem: `<Kind text>: <summary>`
  [new RegExp(`^(?:${Object.values(KINDS).map((k) => escapeRe(capitalise(k))).join('|')}): $`), /^$/],
  // Evidence: `- <at>: <summary> (<command, exit, source>)`
  [/^- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z: $/, /^(?: \([^()\n]*\))?$/],
  // Evidence detail: `  > <line>`
  [/^ {2}> $/, /^$/],
  // Factory request: `/factory:run ...: "<summary>". factory-plugin-advisor signature <sig>.`
  [/^\/factory:run .*: "$/, /^"\. factory-plugin-advisor signature [0-9a-f]{12}\.$/],
];

/**
 * Every stored field of these occurrences in the form a draft quotes it: summaries (whole, and as a
 * title cuts them) and detail lines. Each was redacted when it was stored. `file` checks each one on
 * its own, and the draft's other text without them, rather than re-redacting the rendered lines,
 * where appended text (` (exit 2, ...)`, `". factory-plugin-advisor signature ...`) sits next to a
 * redacted value and can read as part of it.
 */
export function draftFields(plugin: string, occurrences: readonly Occurrence[], identity: Identity = NO_IDENTITY): string[] {
  const prefixes = [
    titlePrefix({ kind: 'existing', plugin, text: '' }),
    titlePrefix({ kind: 'new', plugin: plugin === 'none' ? null : plugin, text: '' }),
  ];
  const out = new Set<string>();
  for (const o of occurrences) {
    out.add(quoted(o.summary, identity));
    for (const prefix of prefixes) out.add(titleSummary(prefix, o.summary, identity));
    for (const d of o.detail?.split('\n') ?? []) out.add(detailLine(d, identity));
  }
  out.delete('');
  return [...out];
}

function detailLine(line: string, identity: Identity): string {
  return maskPersonal(line.replaceAll('`', "'"), identity);
}

/** The draft markdown: the first line is `# <title>`, the rest is the issue body. */
export function renderDraft(
  issue: Issue,
  occurrences: readonly Occurrence[],
  target: Target,
  filedUrl?: string,
  identity: Identity = NO_IDENTITY,
): { title: string; text: string; factoryRun: string } {
  const title = draftTitle(issue, target, identity);
  const subcommand = [...occurrences].reverse().find((o) => o.subcommand !== undefined)?.subcommand;
  const change = proposedChange(issue.kind, target, subcommand);
  const kindText = isKind(issue.kind) ? KINDS[issue.kind] : issue.kind;
  const factoryRun = `/factory:run ${target.kind === 'existing' ? `${target.plugin}` : 'new plugin'}: ${oneLine(change)} Recurring issue (${issue.kind}, seen ${issue.count} times, ${day(issue.firstSeen)} to ${day(issue.lastSeen)}): "${quoted(issue.summary, identity)}". factory-plugin-advisor signature ${issue.signature}.`;
  const newest = [...occurrences].sort((a, b) => b.at.localeCompare(a.at)).slice(0, EVIDENCE_MAX);
  const lines = [
    `# ${title}`,
    '',
    `Signature: \`${issue.signature}\` (factory-plugin-advisor)`,
    ...(filedUrl === undefined ? [] : [`Already filed: ${filedUrl}`]),
    '',
    '## Target',
    '',
    capitalise(target.text),
    '',
    '## Problem',
    '',
    `${capitalise(kindText)}: ${quoted(issue.summary, identity)}`,
    '',
    '## Evidence',
    '',
    `- Seen ${issue.count} times, first ${issue.firstSeen}, last ${issue.lastSeen}.`,
    `- Kind: \`${issue.kind}\`. All text below was redacted before it was stored.`,
    '',
    `Most recent occurrences (${newest.length} of ${issue.count}):`,
    '',
  ];
  for (const o of newest) {
    const extra = [o.subcommand === undefined ? '' : `command \`${inline(o.subcommand)}\``, o.exitCode === undefined ? '' : `exit ${o.exitCode}`, o.source === 'hook' ? 'recorded by the hook' : '']
      .filter((x) => x !== '')
      .join(', ');
    lines.push(`- ${o.at}: ${quoted(o.summary, identity)}${extra === '' ? '' : ` (${extra})`}`);
    if (o.detail !== undefined && o.detail !== '') {
      for (const d of o.detail.split('\n')) lines.push(`  > ${detailLine(d, identity)}`);
    }
  }
  lines.push('', '## Proposed change', '', change, '', '## Factory request', '', 'Paste this into Claude Code to build the change through the factory:', '', '```', factoryRun, '```', '');
  return { title, text: lines.join('\n'), factoryRun };
}

/**
 * Issues seen at least `threshold` times that have no draft yet, or whose count has grown by
 * `threshold` since they were last suggested; dismissed issues never. Writes each draft and records
 * the suggestion.
 */
export function suggest(store: Store, threshold: number, known: readonly string[], now: Date, identity: Identity = NO_IDENTITY): Suggestion[] {
  const all = store.occurrences();
  const state = store.state();
  const out: Suggestion[] = [];
  for (const issue of issues(all, state)) {
    const s = state.issues[issue.signature] ?? {};
    if (s.dismissedAt !== undefined || issue.count < threshold) continue;
    if (s.suggestedCount !== undefined && issue.count < s.suggestedCount + threshold) continue;
    const target = targetOf(issue.plugin, known);
    const occurrences = all.filter((o) => o.signature === issue.signature);
    const { title, text, factoryRun } = renderDraft(issue, occurrences, target, s.filed?.url, identity);
    const draft = store.writeDraft(issue.signature, text);
    state.issues[issue.signature] = { ...s, suggestedCount: issue.count, suggestedAt: now.toISOString() };
    out.push({ signature: issue.signature, plugin: issue.plugin, kind: issue.kind, summary: issue.summary, count: issue.count, firstSeen: issue.firstSeen, lastSeen: issue.lastSeen, target, title, draft, factoryRun });
  }
  if (out.length > 0) store.saveState(state);
  return out;
}

export function dismiss(store: Store, wanted: string, now: Date): Issue {
  const state = store.state();
  const issue = resolveSignature(issues(store.occurrences(), state), wanted);
  state.issues[issue.signature] = { ...state.issues[issue.signature], dismissedAt: now.toISOString() };
  store.saveState(state);
  return { ...issue, status: 'dismissed' };
}
