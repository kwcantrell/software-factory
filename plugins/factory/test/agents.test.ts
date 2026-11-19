// Station agents: `factory agents` (which agent /factory:run launches per station), `factory agents
// new <station>` (a template as a project agent) and `factory agents check` (the rules a project
// agent must pass), all driven through the real CLI.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN, withRepo } from './helpers.ts';
import type { Repo } from './helpers.ts';

const INVOCATION = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory';
const SHIPPED = ['builder', 'verifier', 'reviewer-security', 'reviewer-standards', 'reviewer-behavior'];

const agentsDir = (r: Repo): string => join(r.repo, '.claude', 'agents');
const agentPath = (r: Repo, station: string): string => join(agentsDir(r), `factory-${station}.md`);
const read = (r: Repo, station: string): string => readFileSync(agentPath(r, station), 'utf8');

function writeAgent(r: Repo, station: string, text: string): void {
  mkdirSync(agentsDir(r), { recursive: true });
  writeFileSync(agentPath(r, station), text);
}

/** Scaffold a station and fill in its project-specific sections, as /factory:agents would. */
function made(r: Repo, station: string): string {
  r.ok(['agents', 'new', station]);
  const text = read(r, station).replace(/^TODO: .*$/gm, 'Node 22, TypeScript; `npm test` runs every suite.');
  writeFileSync(agentPath(r, station), text);
  return text;
}

/** `factory agents --json`, by station. */
function resolution(r: Repo): Record<string, Record<string, unknown>> {
  const rows = JSON.parse(r.ok(['agents', '--json'])) as Record<string, unknown>[];
  return Object.fromEntries(rows.map((row) => [row.station as string, row]));
}

/** `factory agents check` must fail; its problem lines (the header line dropped). */
function problems(r: Repo): string[] {
  const p = r.factory(['agents', 'check']);
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.equal(p.stdout, '');
  const lines = p.stderr.trimEnd().split('\n');
  assert.match(lines[0] as string, /^refused: \d+ problems? in station agents:$/);
  for (const line of lines.slice(1)) assert.match(line, /^\.claude\/agents\/factory-[a-z0-9-]+\.md: .+; fix: .+$/);
  return lines.slice(1);
}

function onlyProblem(r: Repo, pattern: RegExp): string {
  const lines = problems(r);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0] as string, pattern);
  return lines[0] as string;
}

// ------------------------------------------------------------------- templates

test('one template per station kind, each with the fixed and fill sections', () => {
  const dir = join(PLUGIN, 'templates', 'agents');
  assert.deepEqual(readdirSync(dir).sort(), ['builder.md', 'reviewer.md', 'verifier.md']);
  for (const kind of ['builder', 'verifier', 'reviewer']) {
    const text = readFileSync(join(dir, `${kind}.md`), 'utf8');
    const fixed = [...text.matchAll(/<!-- fixed:([a-z-]+) -->/g)].map((m) => m[1]);
    for (const id of ['handoff', 'cli', 'state', 'followup', 'result']) assert.ok(fixed.includes(id), `${kind}: fixed ${id}`);
    if (kind === 'reviewer') for (const id of ['role', 'lens']) assert.ok(fixed.includes(id), `${kind}: fixed ${id}`);
    assert.equal(fixed.length, (text.match(/<!-- \/fixed -->/g) ?? []).length, `${kind}: unbalanced fixed markers`);
    const fills = [...text.matchAll(/<!-- fill:([a-z-]+) /g)].map((m) => m[1]);
    const want = kind === 'reviewer' ? ['lens', 'stack', 'checks', 'conventions'] : ['stack', 'checks', 'conventions'];
    assert.deepEqual(fills, want, kind);
    assert.ok(text.includes(`${INVOCATION} <command>`), `${kind}: npx form`);
    assert.match(text, /Never edit `job.json`/, kind);
  }
});

// ------------------------------------------------------------------ resolution

test('with no project agents every station uses the shipped agent', withRepo((r) => {
  const out = r.ok(['agents']);
  for (const s of SHIPPED) assert.match(out, new RegExp(`^${s} +factory:${s} +shipped fallback$`, 'm'));
  assert.deepEqual(resolution(r).builder, {
    station: 'builder', agent: 'factory:builder', owner: 'shipped', file: null, note: null,
  });
  assert.deepEqual(Object.keys(resolution(r)), SHIPPED);
}));

test('a configured reviewer with no agent at all is missing', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), JSON.stringify({ reviewers: ['security', 'perf'] }));
  const rows = resolution(r);
  assert.deepEqual(Object.keys(rows), ['builder', 'verifier', 'reviewer-security', 'reviewer-perf']);
  assert.equal(rows['reviewer-perf']?.agent, 'missing');
  assert.equal(rows['reviewer-perf']?.owner, 'missing');
  assert.match(String(rows['reviewer-perf']?.note), /factory agents new reviewer-perf/);
  assert.match(r.ok(['agents']), /^reviewer-perf +missing +missing: /m);
  // A lens agent under the name the README used to give says how to move it.
  mkdirSync(agentsDir(r), { recursive: true });
  writeFileSync(join(agentsDir(r), 'reviewer-perf.md'), '---\nname: reviewer-perf\n---\n');
  assert.match(String(resolution(r)['reviewer-perf']?.note), /\.claude\/agents\/reviewer-perf\.md has the old name: run factory agents new reviewer-perf/);
  assert.equal(resolution(r)['reviewer-perf']?.agent, 'missing');
}));

test('a project agent that passes check is used, and its owner is the project', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), JSON.stringify({ reviewers: ['security', 'perf'] }));
  for (const s of ['builder', 'reviewer-perf']) made(r, s);
  const rows = resolution(r);
  assert.deepEqual(rows.builder, {
    station: 'builder', agent: 'factory-builder', owner: 'project', file: '.claude/agents/factory-builder.md', note: null,
  });
  assert.equal(rows.verifier?.agent, 'factory:verifier');
  assert.equal(rows['reviewer-security']?.agent, 'factory:reviewer-security');
  assert.equal(rows['reviewer-perf']?.agent, 'factory-reviewer-perf');
  assert.match(r.ok(['agents']), /^builder +factory-builder +project$/m);
}));

test('a project agent that fails check is treated as absent, and agents says so', withRepo((r) => {
  writeFileSync(join(r.repo, 'factory.json'), JSON.stringify({ reviewers: ['security', 'perf'] }));
  r.ok(['agents', 'new', 'verifier']); // still holds TODO placeholders
  const text = made(r, 'reviewer-perf');
  writeFileSync(agentPath(r, 'reviewer-perf'), text.replace('Do not edit the worktree.', ''));
  const rows = resolution(r);
  assert.equal(rows.verifier?.agent, 'factory:verifier');
  assert.equal(rows.verifier?.owner, 'shipped');
  assert.equal(rows.verifier?.file, '.claude/agents/factory-verifier.md');
  assert.match(String(rows.verifier?.note), /^\.claude\/agents\/factory-verifier\.md fails factory agents check \(3 problems\), so it is not used$/);
  assert.equal(rows['reviewer-perf']?.agent, 'missing');
  assert.match(String(rows['reviewer-perf']?.note), /fails factory agents check/);
  assert.match(r.ok(['agents']), /^verifier +factory:verifier +shipped fallback: \.claude\/agents\/factory-verifier\.md fails factory agents check/m);
}));

// ----------------------------------------------------------------- scaffolding

test('agents new writes each station kind with its name filled in', withRepo((r) => {
  for (const station of ['builder', 'verifier', 'reviewer-security', 'reviewer-perf']) {
    const out = r.ok(['agents', 'new', station]);
    assert.match(out, new RegExp(`^\\.claude/agents/factory-${station}\\.md\\n`));
    const text = read(r, station);
    assert.match(text, new RegExp(`^---\\nname: factory-${station}\\n`));
    assert.doesNotMatch(text, /\{\{/, `${station}: unfilled placeholder`);
    assert.match(text, /<!-- fixed:cli -->/);
    assert.match(text, /^TODO: /m, `${station}: fill sections are left for the project`);
  }
  const security = read(r, 'reviewer-security');
  assert.match(security, /review-<round>-security\.md/);
  assert.match(security, /`factory verdict <job id> security approve`/);
  const perf = read(r, 'reviewer-perf');
  assert.match(perf, /`factory followup add <job id> --by perf "<text>"`/);
  assert.match(perf, /^TODO: the one question the perf lens answers/m);
}));

test('the shipped lenses come out of the reviewer template with their own lens text', withRepo((r) => {
  for (const lens of ['security', 'standards', 'behavior']) {
    r.ok(['agents', 'new', `reviewer-${lens}`]);
    const shipped = readFileSync(join(PLUGIN, 'agents', `reviewer-${lens}.md`), 'utf8');
    const section = /\n## Your lens: [a-z]+\n([\s\S]*?)\n## /.exec(shipped)?.[1]?.trim() as string;
    assert.ok(section.length > 50, lens);
    assert.ok(read(r, `reviewer-${lens}`).includes(section), `${lens}: lens text not carried over`);
  }
}));

test('agents new refuses to overwrite without --force, and --force rewrites the template', withRepo((r) => {
  r.ok(['agents', 'new', 'builder']);
  writeFileSync(agentPath(r, 'builder'), 'mine\n');
  const p = r.factory(['agents', 'new', 'builder']);
  assert.equal(p.status, 1);
  assert.equal(p.stdout, '');
  assert.equal(p.stderr, 'refused: .claude/agents/factory-builder.md already exists; pass --force to overwrite it with the template\n');
  assert.equal(read(r, 'builder'), 'mine\n');
  r.ok(['agents', 'new', 'builder', '--force']);
  assert.match(read(r, 'builder'), /^---\nname: factory-builder\n/);
}));

test('agents new for a reviewer not in factory.json says how to add it and leaves factory.json alone', withRepo((r) => {
  const out = r.ok(['agents', 'new', 'reviewer-perf']);
  assert.match(out, /reviewer 'perf' is not in factory\.json's reviewers.*"reviewers": \["security","standards","behavior","perf"\]/);
  assert.equal(existsSync(join(r.repo, 'factory.json')), false);
  writeFileSync(join(r.repo, 'factory.json'), '{"reviewers": ["perf"]}\n');
  assert.doesNotMatch(r.ok(['agents', 'new', 'reviewer-perf', '--force']), /not in factory\.json/);
  assert.equal(readFileSync(join(r.repo, 'factory.json'), 'utf8'), '{"reviewers": ["perf"]}\n');
}));

test('agents new refuses a name that is not a station', withRepo((r) => {
  for (const bad of ['reviewer', 'reviewer-', 'reviewer-Bad', 'tester', '../builder']) {
    const p = r.factory(['agents', 'new', bad]);
    assert.equal(p.status, 1, bad);
    assert.match(p.stderr, /is not a station: use builder, verifier or reviewer-<name>/, bad);
  }
  assert.equal(existsSync(agentsDir(r)), false);
}));

// ------------------------------------------------------------------ validation

test('agents check passes filled agents of every kind, and says there are none when there are none', withRepo((r) => {
  assert.equal(r.ok(['agents', 'check']), 'no station agents in .claude/agents\n');
  for (const s of ['builder', 'verifier', 'reviewer-security', 'reviewer-perf']) made(r, s);
  assert.match(r.ok(['agents', 'check']), /^4 station agent\(s\) pass: /);
  assert.deepEqual(JSON.parse(r.ok(['agents', 'check', '--json'])), {
    checked: ['builder', 'reviewer-perf', 'reviewer-security', 'verifier'].map((s) => `.claude/agents/factory-${s}.md`),
    problems: [],
  });
}));

test('fixed sections may be re-wrapped and lose their markers: equivalence is whitespace-insensitive', withRepo((r) => {
  const text = made(r, 'builder');
  const rewrapped = text.replace(/<!-- \/?fixed[^>]*-->/g, '').replace(/ (?=only to the absolute)/, '\n   ');
  writeAgent(r, 'builder', rewrapped);
  r.ok(['agents', 'check']);
}));

test('each shipped agent passes the check rules, so the fallback is never weaker', withRepo((r) => {
  for (const s of SHIPPED) {
    const text = readFileSync(join(PLUGIN, 'agents', `${s}.md`), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${s}\\n`));
    writeAgent(r, s, text.replace(`name: ${s}\n`, `name: factory-${s}\n`));
  }
  assert.match(r.ok(['agents', 'check']), /^5 station agent\(s\) pass: /);
}));

test('check: frontmatter name must equal the file name', withRepo((r) => {
  writeAgent(r, 'builder', made(r, 'builder').replace('name: factory-builder', 'name: builder'));
  onlyProblem(r, /^\.claude\/agents\/factory-builder\.md: frontmatter name is 'builder', not the file's name; fix: set name: factory-builder$/);
}));

test('check: a description is required, and so is frontmatter', withRepo((r) => {
  const text = made(r, 'verifier');
  writeAgent(r, 'verifier', text.replace(/^description: .*\n/m, ''));
  onlyProblem(r, /frontmatter has no description/);
  writeAgent(r, 'verifier', text.replace(/^---\n[\s\S]*?\n---\n/, ''));
  onlyProblem(r, /factory-verifier\.md: no frontmatter; fix: /);
}));

test('check: a file that is not a station name', withRepo((r) => {
  writeAgent(r, 'tester', '---\nname: factory-tester\ndescription: x\n---\n');
  onlyProblem(r, /factory-tester\.md: not a station agent name; fix: name the file factory-builder\.md/);
}));

test('check: a fixed section reworded or dropped', withRepo((r) => {
  const text = made(r, 'builder');
  writeAgent(r, 'builder', text.replace('stop and report the refusal to the supervisor', 'delete it anyway'));
  onlyProblem(r, /fixed section 'handoff' is missing or altered; fix: restore it word for word from templates\/agents\/builder\.md/);
  writeAgent(r, 'builder', text.replace(/\*\*Job state\.\*\*.*\n/, ''));
  onlyProblem(r, /fixed section 'state' is missing/);
  writeAgent(r, 'builder', text.replace('Never weaken, skip or delete an existing test to get green.', 'Try not to weaken tests.'));
  onlyProblem(r, /fixed section 'integrity' is missing/);
  const reviewer = made(r, 'reviewer-security');
  writeAgent(r, 'reviewer-security', reviewer.replace('## Your lens: security', '## Your lenses'));
  assert.ok(problems(r).some((l) => /factory-reviewer-security\.md: fixed section 'lens' is missing/.test(l)));
}));

test('check: the CLI only through the npx form', withRepo((r) => {
  const text = made(r, 'builder');
  writeAgent(r, 'builder', `${text}\nTo check status, run \`node /opt/factory/src/cli.ts status 1\`.\n`);
  onlyProblem(r, /runs the CLI as 'node \/opt\/factory\/src\/cli\.ts', not the npx form; fix: use exactly npx --yes/);
  writeAgent(r, 'builder', `${text}\nOr run \`npx --yes --package=/opt/factory -- factory status\`.\n`);
  onlyProblem(r, /runs the CLI as 'npx --yes --package=\/opt\/factory -- factory', not the npx form/);
  writeAgent(r, 'builder', text.replaceAll(INVOCATION, 'npx factory'));
  const lines = problems(r);
  assert.ok(lines.some((l) => /does not define factory as the npx invocation/.test(l)), lines.join('\n'));
}));

test('check: the station records its own result with the right command', withRepo((r) => {
  const verifier = made(r, 'verifier');
  writeAgent(r, 'verifier', verifier.replace('or `factory proof <job id> fail`', 'or ask the supervisor'));
  const lines = problems(r);
  assert.ok(lines.some((l) => /does not record a fail with factory proof <job id> fail/.test(l)), lines.join('\n'));
  writeAgent(r, 'verifier', verifier);
  const reviewer = made(r, 'reviewer-security');
  writeAgent(r, 'reviewer-security', `${reviewer}\nIn a hurry, record \`factory verdict <job id> standards approve\` instead.\n`);
  onlyProblem(r, /factory-reviewer-security\.md: records a verdict as 'standards', not 'security'/);
  writeAgent(r, 'reviewer-security', reviewer.replaceAll('--by security', '--by reviewer'));
  assert.ok(problems(r).some((l) => /does not record follow-ups as --by security/.test(l)));
  writeAgent(r, 'reviewer-security', reviewer);
  const builder = made(r, 'builder');
  writeAgent(r, 'builder', builder.replaceAll('`factory built`', '`factory finish`'));
  assert.ok(problems(r).some((l) => /does not name factory built/.test(l)));
}));

test('check: unfilled template placeholders', withRepo((r) => {
  r.ok(['agents', 'new', 'builder']);
  const lines = problems(r);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /still holds the template's placeholder 'TODO: /);
}));

test('check: no agent may pre-approve or run merge, approve, rework or close', withRepo((r) => {
  const text = made(r, 'reviewer-security');
  const withTools = (tools: string): string => text.replace(/^tools: .*$/m, `tools: ${tools}`);
  for (const cmd of ['merge', 'approve', 'rework', 'close']) {
    writeAgent(r, 'reviewer-security', withTools(`Read, Bash(${INVOCATION} ${cmd}:*)`));
    onlyProblem(r, new RegExp(`frontmatter tools pre-approves the human-only command factory ${cmd}`));
  }
  for (const wide of [`Bash(${INVOCATION}:*)`, 'Bash(*)', 'Bash(npx:*)']) {
    writeAgent(r, 'reviewer-security', withTools(`Read, ${wide}`));
    onlyProblem(r, /would pre-approve factory merge, approve, rework and close/);
  }
  writeAgent(r, 'reviewer-security', withTools(`Read, Bash(${INVOCATION} status:*)`));
  r.ok(['agents', 'check']);
  writeAgent(r, 'reviewer-security', text.replace(/^color: .*$/m, 'color: red\npermissionMode: bypassPermissions'));
  onlyProblem(r, /permissionMode 'bypassPermissions' may skip the merge, approve and rework permission prompts/);
  writeAgent(r, 'reviewer-security', `${text}\nWhen you approve, run \`factory merge <job id>\` too.\n`);
  onlyProblem(r, /runs the human-only command factory merge/);
  writeAgent(r, 'reviewer-security', `${text}\nIf the job is not worth it, run \`factory close <job id> not needed\`.\n`);
  onlyProblem(r, /runs the human-only command factory close/);
}));

test('check: the human gates hold whatever YAML form the frontmatter uses', withRepo((r) => {
  const text = made(r, 'reviewer-security');
  const withFrontmatter = (lines: string): string => text.replace(/^color: .*$/m, `color: red\n${lines}`);
  // A block list, under tools or allowed-tools, quoted or not.
  for (const lines of [
    `allowed-tools:\n  - Bash(${INVOCATION} merge:*)`,
    `allowed-tools:\n  - "Bash(${INVOCATION.replace(/"/g, '\\"')} merge:*)"`,
    `allowed-tools:\n  - 'Bash(${INVOCATION} merge:*)'`,
  ]) {
    writeAgent(r, 'reviewer-security', withFrontmatter(lines));
    onlyProblem(r, /frontmatter allowed-tools pre-approves the human-only command factory merge/);
  }
  // A flow list carried onto a continuation line.
  writeAgent(r, 'reviewer-security', withFrontmatter(`allowed-tools: [Read,\n  Bash(${INVOCATION} approve:*)]`));
  onlyProblem(r, /frontmatter allowed-tools pre-approves the human-only command factory approve/);
  // Quoted permission modes, and modes not on the safe list (a block scalar included).
  for (const mode of ['"bypassPermissions"', "'bypassPermissions'", 'auto', '>-\n  bypassPermissions']) {
    writeAgent(r, 'reviewer-security', withFrontmatter(`permissionMode: ${mode}`));
    onlyProblem(r, /frontmatter permissionMode '.*' may skip the merge, approve and rework permission prompts/);
  }
  for (const mode of ['default', '"plan"', 'acceptEdits', 'dontAsk']) {
    writeAgent(r, 'reviewer-security', withFrontmatter(`permissionMode: ${mode}`));
    r.ok(['agents', 'check']);
  }
  writeAgent(r, 'reviewer-security', withFrontmatter('"permissionMode": bypassPermissions'));
  onlyProblem(r, /permissionMode 'bypassPermissions'/);
  // Hooks could answer the prompts, so a station agent has none.
  writeAgent(r, 'reviewer-security', withFrontmatter('hooks:\n  PreToolUse:\n    - matcher: Bash'));
  onlyProblem(r, /frontmatter has hooks/);
}));

test('check: a rule cut short anywhere in the npx form is as wide as factory:*', withRepo((r) => {
  const text = made(r, 'reviewer-behavior');
  const withTools = (tools: string): string => text.replace(/^tools: .*$/m, `tools: ${tools}`);
  const pathForm = INVOCATION.replace('${CLAUDE_PLUGIN_ROOT}', '/home/me/plugin');
  for (const wide of [
    'Bash(npx --yes:*)',
    'Bash(npx --yes --offline *)',
    'Bash(npx --yes --offline --loglevel=error --package=*)',
    'Bash(npx --yes --offline --loglevel=error --package="/home/me/plu:*)',
    `Bash(${pathForm}:*)`,
    `Bash(${pathForm} m*)`,
    'Bash(npx * merge *)',
    'Bash(factory:*)',
  ]) {
    writeAgent(r, 'reviewer-behavior', withTools(`Read, ${wide}`));
    onlyProblem(r, /frontmatter tools rule .* would pre-approve factory (merge|approve|rework)/);
  }
  writeAgent(r, 'reviewer-behavior', withTools(`Read, Bash(${pathForm} m*)`));
  onlyProblem(r, /would pre-approve factory merge; fix/);
  for (const narrow of [`Bash(${pathForm} status:*)`, 'Bash(npm test:*)', 'Bash(git diff:*)']) {
    writeAgent(r, 'reviewer-behavior', withTools(`Read, ${narrow}`));
    r.ok(['agents', 'check']);
  }
}));

test('check: a quoted frontmatter name is the same name', withRepo((r) => {
  const text = made(r, 'builder');
  writeAgent(r, 'builder', text.replace(/^name: .*$/m, 'name: "factory-builder"'));
  r.ok(['agents', 'check']);
}));

test('agents check does not write anything', withRepo((r) => {
  made(r, 'builder');
  const before = readdirSync(agentsDir(r));
  r.ok(['agents', 'check']);
  r.ok(['agents']);
  assert.deepEqual(readdirSync(agentsDir(r)), before);
  assert.equal(r.git(['status', '--porcelain', '--', '.claude']), '?? .claude/');
}));
