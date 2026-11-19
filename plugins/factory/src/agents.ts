// Station agents: which agent /factory:run launches for each station, the templates a project makes
// its own from, and the rules a project agent must pass.
//
// A project agent for a station is <repo>/.claude/agents/factory-<station>.md, where station is
// `builder`, `verifier` or `reviewer-<name>`. It is used when it passes checkAgent(); otherwise the
// plugin's shipped agent (`factory:<station>`) is, and a reviewer with neither is `missing`.
//
// Fixed sections. Each template marks the line's non-negotiables as
//     <!-- fixed:<id> --> ... <!-- /fixed -->
// A fixed section is present in an agent when its text, with the station's placeholders filled
// ({{lens}}), appears in the agent's body after both are normalized: HTML comments (the markers)
// removed and every run of whitespace collapsed to one space. So line wrapping and markers may
// change; any other edit to the text, a word added, dropped or changed, is a missing section.
// Fill sections (<!-- fill:<id> ... --> ... <!-- /fill -->) are the project's; a line still starting
// with the template's `TODO: ` placeholder fails the check, so a half-made agent is never launched.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN_ROOT, Refused } from './factory.ts';
import type { Command, Config } from './factory.ts';
import { dumps } from './pyfmt.ts';

export const TEMPLATES = join(PLUGIN_ROOT, 'templates', 'agents');
export const SHIPPED = join(PLUGIN_ROOT, 'agents');
/** Where a project keeps its agents, relative to the repository root. */
export const AGENTS_DIR = join('.claude', 'agents');
export const INVOCATION = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory';
/** Human-gated commands (src/gate.ts) no station may pre-approve or run. */
const HUMAN_ONLY = ['merge', 'approve', 'rework', 'close'] as const;
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export type Kind = 'builder' | 'verifier' | 'reviewer';

export interface Station {
  /** `builder`, `verifier` or `reviewer-<lens>`. */
  station: string;
  kind: Kind;
  /** The reviewer's name (as in factory.json and `factory verdict`), else null. */
  lens: string | null;
  /** The `--by` name the station records follow-ups under. */
  by: string;
}

export interface Problem {
  file: string;
  what: string;
  fix: string;
}

/** A station name, or null when it is not one. */
export function parseStation(station: string): Station | null {
  if (station === 'builder' || station === 'verifier') return { station, kind: station, lens: null, by: station };
  const m = /^reviewer-(.+)$/.exec(station);
  if (m?.[1] && NAME.test(m[1])) return { station, kind: 'reviewer', lens: m[1], by: m[1] };
  return null;
}

/** The project agent's name (and file stem) for a station. */
export const agentName = (station: string): string => `factory-${station}`;

const fill = (text: string, values: Record<string, string>): string =>
  text.replace(/\{\{([a-z_]+)\}\}/g, (all, key: string) => values[key] ?? all);

export const normalize = (text: string): string =>
  text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim();

function templateText(kind: Kind): string {
  return readFileSync(join(TEMPLATES, `${kind}.md`), 'utf8');
}

/** The fixed sections of a station's template, placeholders filled: [id, text]. */
export function fixedSections(st: Station): [string, string][] {
  const text = fill(templateText(st.kind), { lens: st.lens ?? '' });
  return [...text.matchAll(/<!-- fixed:([a-z-]+) -->([\s\S]*?)<!-- \/fixed -->/g)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]);
}

/** The lens section of a shipped reviewer (its question and what it checks), or null. */
function shippedLens(lens: string): string | null {
  const path = join(SHIPPED, `reviewer-${lens}.md`);
  if (!existsSync(path)) return null;
  const m = new RegExp(`\\n## Your lens: ${lens}\\n([\\s\\S]*?)\\n## `).exec(readFileSync(path, 'utf8'));
  return m?.[1]?.trim() ?? null;
}

/** The template for a station, with its name (and, for a reviewer, its lens) filled in. */
export function render(st: Station): string {
  const lensFocus =
    st.lens === null
      ? ''
      : (shippedLens(st.lens) ??
        `TODO: the one question the ${st.lens} lens answers, then what it checks in this repository.`);
  return fill(templateText(st.kind), { name: agentName(st.station), lens: st.lens ?? '', lens_focus: lensFocus });
}

/** A YAML scalar with one pair of matching surrounding quotes removed. */
const unquote = (value: string): string => {
  const v = value.trim();
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v;
};

/**
 * A leading `---` block: its top-level `key: value` pairs (key and value unquoted), every
 * `Bash(...)` permission rule anywhere in it (block lists, flow lists, continuation lines) with the
 * top-level key it sits under, and the body after it. Null when there is no such block.
 */
function frontmatter(
  text: string,
): { fields: Record<string, string>; rules: [string, string][]; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  const rules: [string, string][] = [];
  let key = '';
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && !/^[\s-]/.test(line)) {
      key = unquote(line.slice(0, i));
      fields[key] = unquote(line.slice(i + 1));
    }
    // A double-quoted YAML string writes a rule's own quotes as \".
    for (const rule of line.replace(/\\"/g, '"').match(/Bash\([^)]*\)/g) ?? []) rules.push([key, rule]);
  }
  return { fields, rules, body: text.slice(m[0].length) };
}

/** Permission modes that keep the merge, approve and rework prompts (an absent key is `default`). */
const SAFE_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk'];

/**
 * The human-only commands a Bash permission rule would let run without a prompt. A rule's `*` (and a
 * trailing `:*`) is a wildcard; the rule is tried against each human-only command as a station
 * would write it: the npx form with this rule's own --package value (so a rule cut off inside the
 * path still counts), with the plugin root placeholder, and bare `factory <command>`.
 */
function approvesHuman(inner: string): string[] {
  const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const glob = flat(inner.replace(/:\*$/, '*'));
  const re = new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const pkg = /--package=["']?([^"'\s*]*)/.exec(inner)?.[1];
  const roots = ['${CLAUDE_PLUGIN_ROOT}', '/plugin', ...(pkg === undefined ? [] : [pkg, `${pkg}/plugin`])];
  return HUMAN_ONLY.filter((c) =>
    roots
      .flatMap((root) => {
        const npx = INVOCATION.replace('${CLAUDE_PLUGIN_ROOT}', root);
        return [npx, npx.replace(`"${root}"`, root)];
      })
      .concat(['factory'])
      .some((cli) => re.test(flat(`${cli} ${c} 001-job`))),
  );
}

/**
 * Every rule a station agent breaks (empty when it passes). `stem` is the file name without `.md`;
 * `file` is how problems name the file.
 */
export function checkAgent(file: string, stem: string, text: string): Problem[] {
  const problems: Problem[] = [];
  const add = (what: string, fix: string): void => {
    problems.push({ file, what, fix });
  };
  const station = stem.startsWith('factory-') ? parseStation(stem.slice('factory-'.length)) : null;
  if (!station) {
    add(
      'not a station agent name',
      'name the file factory-builder.md, factory-verifier.md or factory-reviewer-<name>.md (lowercase letters, digits, dashes)',
    );
    return problems;
  }
  const template = `templates/agents/${station.kind}.md`;
  const fm = frontmatter(text);
  if (!fm) {
    add('no frontmatter', `start the file with a --- block holding name: ${stem} and a description`);
    return problems;
  }
  if (fm.fields.name !== stem) {
    add(`frontmatter name is '${fm.fields.name ?? ''}', not the file's name`, `set name: ${stem}`);
  }
  if (!fm.fields.description) add('frontmatter has no description', 'add a description: line saying what the station does');

  // The line's human gates: no agent may pre-approve merge, approve or rework, or bypass the prompt.
  // Every Bash(...) rule in the frontmatter counts, whatever key or YAML form it is written in.
  for (const [key, rule] of fm.rules) {
    const inner = rule.slice('Bash('.length, -1).trim();
    const human = HUMAN_ONLY.find((c) => new RegExp(`factory["']?\\s+${c}\\b`).test(inner));
    const approved = approvesHuman(inner);
    if (human) {
      add(`frontmatter ${key} pre-approves the human-only command factory ${human}`, `remove ${rule}`);
    } else if (approved.length > 0) {
      add(
        `frontmatter ${key} rule ${rule} would pre-approve factory ${approved.join(', ').replace(/, (?=[a-z]+$)/, ' and ')}`,
        `remove ${rule}; a station needs no pre-approved factory command`,
      );
    }
  }
  const mode = fm.fields.permissionMode;
  if (mode !== undefined && !SAFE_MODES.includes(mode)) {
    add(
      `frontmatter permissionMode '${mode}' may skip the merge, approve and rework permission prompts`,
      `remove permissionMode, or use one of ${SAFE_MODES.join(', ')} on one line`,
    );
  }
  if ('hooks' in fm.fields) {
    add('frontmatter has hooks, which could answer the merge, approve and rework prompts', 'remove hooks; a station needs none');
  }
  // A lint, not the boundary: indirection (`c=merge; factory $c`) gets past it. The PreToolUse hook
  // (src/gate.ts) is what stops a station running a human-only command.
  for (const c of HUMAN_ONLY) {
    if (new RegExp(`factory["']?\\s+${c}\\b`).test(fm.body)) {
      add(`runs the human-only command factory ${c}`, `remove it: only a person runs factory ${c}`);
    }
  }

  // Fixed sections, compared as documented at the top of this file.
  const body = normalize(fm.body);
  for (const [id, fixed] of fixedSections(station)) {
    if (!body.includes(normalize(fixed))) {
      add(`fixed section '${id}' is missing or altered`, `restore it word for word from ${template} (factory agents new ${station.station} --force rewrites the file)`);
    }
  }

  // A scaffold not yet filled in is not an agent to launch.
  for (const m of fm.body.matchAll(/^TODO: .*$/gm)) {
    add(`still holds the template's placeholder '${m[0]}'`, 'replace it with what this repository needs (see the fill comment above it)');
  }

  // The CLI only through the npx form.
  if (!fm.body.includes(INVOCATION)) {
    add('does not define factory as the npx invocation', `say that factory <command> means ${INVOCATION} <command>`);
  }
  for (const m of fm.body.matchAll(/npx\b[^\n`]*?--\s*factory\b/g)) {
    if (m[0] !== INVOCATION) add(`runs the CLI as '${m[0]}', not the npx form`, `use exactly ${INVOCATION}`);
  }
  for (const m of fm.body.matchAll(/node\s+\S*cli\.ts|\S*bin\/factory\b/g)) {
    add(`runs the CLI as '${m[0]}', not the npx form`, `use exactly ${INVOCATION}`);
  }

  // Its own result and follow-ups, with the right command and name.
  const flat = normalize(fm.body);
  const need = (snippet: string, what: string): void => {
    if (!flat.includes(snippet)) add(what, `say it as in ${template}: ${snippet}`);
  };
  need(`\`factory followup add <job id> --by ${station.by} "<text>"\``, `does not record follow-ups as --by ${station.by}`);
  if (station.kind === 'builder') {
    need('`factory built`', 'does not name factory built, the command that records its build');
  } else if (station.kind === 'verifier') {
    need('`factory proof <job id> pass`', 'does not record a pass with factory proof <job id> pass');
    need('`factory proof <job id> fail`', 'does not record a fail with factory proof <job id> fail');
  } else {
    const lens = station.lens as string;
    need(`\`factory verdict <job id> ${lens} approve\``, `does not record an approval with factory verdict <job id> ${lens} approve`);
    need(`\`factory verdict <job id> ${lens} changes\``, `does not record changes with factory verdict <job id> ${lens} changes`);
    for (const m of flat.matchAll(/factory verdict <job id> ([a-z0-9-]+) /g)) {
      if (m[1] !== lens) add(`records a verdict as '${m[1]}', not '${lens}'`, `use factory verdict <job id> ${lens} approve|changes`);
    }
  }
  return problems;
}

export interface Resolution {
  station: string;
  /** The agent /factory:run launches: a project agent name, `factory:<station>`, or `missing`. */
  agent: string;
  owner: 'project' | 'shipped' | 'missing';
  /** The project agent file, relative to the repo, when there is one. */
  file: string | null;
  note: string | null;
}

/** The stations of the line: builder, verifier and each configured reviewer. */
export function stations(cfg: Config): string[] {
  return ['builder', 'verifier', ...cfg.reviewers.map((r) => `reviewer-${r}`)];
}

function projectFile(repo: string, station: string): [string, string] {
  const rel = join(AGENTS_DIR, `${agentName(station)}.md`);
  return [rel, join(repo, rel)];
}

export function resolveStation(repo: string, station: string): Resolution {
  const [rel, abs] = projectFile(repo, station);
  let note: string | null = null;
  if (existsSync(abs)) {
    const problems = checkAgent(rel, agentName(station), readFileSync(abs, 'utf8'));
    if (problems.length === 0) return { station, agent: agentName(station), owner: 'project', file: rel, note: null };
    note = `${rel} fails factory agents check (${problems.length} problem${problems.length === 1 ? '' : 's'}), so it is not used`;
  }
  if (existsSync(join(SHIPPED, `${station}.md`))) {
    return { station, agent: `factory:${station}`, owner: 'shipped', file: existsSync(abs) ? rel : null, note };
  }
  // Before station agents, the README said to add a lens as .claude/agents/reviewer-<name>.md.
  const old = join(AGENTS_DIR, `${station}.md`);
  const legacy = existsSync(join(repo, old))
    ? `; ${old} has the old name: run factory agents new ${station} and move its lens into the new file`
    : '';
  return {
    station,
    agent: 'missing',
    owner: 'missing',
    file: existsSync(abs) ? rel : null,
    note: (note ?? `no ${rel} and no shipped agent: create it with factory agents new ${station}`) + legacy,
  };
}

const OWNER: Record<Resolution['owner'], string> = { project: 'project', shipped: 'shipped fallback', missing: 'missing' };

/** `factory agents`: the agent /factory:run launches for each station. */
export const cmdAgents: Command = (root, a, io) => {
  const repo = dirname(root);
  const rows = stations(a.cfg as Config).map((s) => resolveStation(repo, s));
  if (a.json === true) {
    io.stdout(`${dumps(rows)}\n`);
    return;
  }
  for (const r of rows) {
    io.stdout(`${r.station.padEnd(20)} ${r.agent.padEnd(30)} ${OWNER[r.owner]}${r.note ? `: ${r.note}` : ''}\n`);
  }
};

/** `factory agents new <station> [--force]`: write a station's template as a project agent. */
export const cmdAgentsNew: Command = (root, a, io) => {
  const repo = dirname(root);
  const name = a.station as string;
  const st = parseStation(name);
  if (!st) {
    throw new Refused(`'${name}' is not a station: use builder, verifier or reviewer-<name> (lowercase letters, digits, dashes)`);
  }
  const [rel, abs] = projectFile(repo, st.station);
  if (existsSync(abs) && a.force !== true) {
    throw new Refused(`${rel} already exists; pass --force to overwrite it with the template`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, render(st));
  io.stdout(`${rel}\n`);
  io.stdout(`fill in its fill sections for this repository, then run factory agents check\n`);
  const cfg = a.cfg as Config;
  if (st.lens !== null && !cfg.reviewers.includes(st.lens)) {
    const next = JSON.stringify([...cfg.reviewers, st.lens]);
    io.stdout(
      `reviewer '${st.lens}' is not in factory.json's reviewers, so no round will run it: to add it, set "reviewers": ${next} in factory.json\n`,
    );
  }
};

/** `factory agents check [--json]`: every rule each .claude/agents/factory-*.md breaks. */
export const cmdAgentsCheck: Command = (root, a, io) => {
  const repo = dirname(root);
  const dir = join(repo, AGENTS_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^factory-.*\.md$/.test(f)).sort() : [];
  const problems = files.flatMap((f) =>
    checkAgent(join(AGENTS_DIR, f), f.slice(0, -'.md'.length), readFileSync(join(dir, f), 'utf8')),
  );
  if (problems.length > 0) {
    const lines = problems.map((p) => `${p.file}: ${p.what}; fix: ${p.fix}`);
    throw new Refused(`${problems.length} problem${problems.length === 1 ? '' : 's'} in station agents:\n${lines.join('\n')}`);
  }
  const checked = files.map((f) => join(AGENTS_DIR, f));
  if (a.json === true) {
    io.stdout(`${dumps({ checked, problems: [] })}\n`);
    return;
  }
  io.stdout(checked.length === 0 ? `no station agents in ${AGENTS_DIR}\n` : `${checked.length} station agent(s) pass: ${checked.join(', ')}\n`);
};
