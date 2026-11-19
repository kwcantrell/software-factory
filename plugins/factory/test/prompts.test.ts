// Skills and agents call the CLI only through the npx invocation, and never pre-approve a human gate.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN } from './helpers.ts';

const INVOCATION = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory';
const HUMAN_ONLY = ['merge', 'approve', 'rework'];
// The old CLI path, its interpreter, the old hook script and the PATH fallback. Spelled in pieces so
// that grepping the plugin for those words finds nothing, this file included.
const STALE = new RegExp(['bin/' + 'factory', 'not on PATH', 'pyth' + 'on3', 'human-gate\\.' + 'sh'].join('|'));

const ESCAPED = INVOCATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const skills = readdirSync(join(PLUGIN, 'skills')).map((name) => join(PLUGIN, 'skills', name, 'SKILL.md'));
const agents = readdirSync(join(PLUGIN, 'agents')).map((name) => join(PLUGIN, 'agents', name));
const prompts = [...skills, ...agents];

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  return Object.fromEntries(
    block.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  );
}

test('every skill and agent says once that `factory` means the npx invocation', () => {
  assert.equal(skills.length, 6);
  assert.equal(agents.length, 5);
  for (const file of prompts) {
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(`${INVOCATION} <command>`), `${file} does not define factory as the npx invocation`);
    assert.match(text, /\*\*The `factory` CLI\.\*\* Wherever this (skill|prompt) says `factory <command>`, run exactly/, file);
    assert.doesNotMatch(text, STALE, file);
  }
});

test('every npx command line in a ```sh block uses the exact invocation', () => {
  for (const file of skills) {
    const text = readFileSync(file, 'utf8');
    const lines = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => (m[1] ?? '').split('\n')).filter(Boolean);
    assert.ok(lines.length > 0, file);
    for (const line of lines) assert.ok(line.startsWith(`${INVOCATION} `), `${file}: ${line}`);
  }
});

test('allowed-tools pre-approves only npx station commands, never merge, approve or rework', () => {
  for (const file of skills) {
    const allowed = frontmatter(readFileSync(file, 'utf8'))['allowed-tools'];
    if (allowed === undefined) continue;
    const rules = allowed.split(/,\s*(?=Bash\()/);
    for (const rule of rules) {
      // A command (and subcommand) prefix with :*, or one exact command line with its flags.
      const m = new RegExp(`^Bash\\(${ESCAPED} (--help|[a-z]+)((?: [a-z]+)?:\\*|(?: --[a-z]+)*)\\)$`).exec(rule);
      assert.ok(m, `${file}: ${rule}`);
      assert.ok(!HUMAN_ONLY.includes(m[1] as string), `${file} pre-approves ${m[1]}`);
    }
  }
});

test('the upgrade skill pre-approves only the dry run and --help, never --apply', () => {
  const allowed = frontmatter(readFileSync(join(PLUGIN, 'skills', 'upgrade', 'SKILL.md'), 'utf8'))['allowed-tools'] ?? '';
  const rules = allowed.split(/,\s*(?=Bash\()/).map((r) => r.slice(`Bash(${INVOCATION} `.length, -1));
  assert.deepEqual(rules, ['upgrade', 'upgrade --json', 'upgrade --help', '--help:*']);
});

test('the human-gate skills stay user-only', () => {
  for (const name of ['approve', 'ship']) {
    const fm = frontmatter(readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8'));
    assert.equal(fm['disable-model-invocation'], 'true', name);
  }
});

test('every station writes its handoff file only to the job dir and deletes a stray copy only if it wrote it', () => {
  const handoff: Record<string, [string, string]> = {
    'builder.md': ['build.md', 'built'],
    'verifier.md': ['proof.md', 'proof'],
    'reviewer-security.md': ['review-<round>-security.md', 'verdict'],
    'reviewer-standards.md': ['review-<round>-standards.md', 'verdict'],
    'reviewer-behavior.md': ['review-<round>-behavior.md', 'verdict'],
  };
  for (const [agent, [name, cmd]] of Object.entries(handoff)) {
    const text = readFileSync(join(PLUGIN, 'agents', agent), 'utf8');
    const rule = `**Handoff files.** Write \`${name}\` (and anything under \`evidence/\``;
    assert.ok(text.includes(rule), `${agent} does not name its handoff file and evidence/`);
    assert.ok(
      text.includes('only to the absolute `<job dir>` path given in your prompt, never to the current directory or the worktree.'),
      `${agent} does not say to write only to the absolute job dir`,
    );
    assert.ok(
      text.includes(
        `If \`factory ${cmd}\` refuses because of a stray copy of \`${name}\` outside the job dir, delete that copy and retry only if you wrote it in this job, that is, its content matches your own \`${name}\` in the job dir (the refusal says whether the two are byte-identical).`,
      ),
      `${agent} does not say to delete a stray copy only when it matches the job-dir copy`,
    );
    assert.ok(
      text.includes('Otherwise do not delete it: stop and report the refusal to the supervisor.'),
      `${agent} does not say to stop and report a stray copy it did not write`,
    );
    assert.ok(!text.includes('delete your own stray copy and retry'), `${agent} still says to delete any stray copy`);
  }
});

test('the agents skill pre-approves only the read-only factory agents and factory agents check', () => {
  const allowed = frontmatter(readFileSync(join(PLUGIN, 'skills', 'agents', 'SKILL.md'), 'utf8'))['allowed-tools'] ?? '';
  const rules = allowed.split(/,\s*(?=Bash\()/).map((r) => r.slice(`Bash(${INVOCATION} `.length, -1));
  assert.deepEqual(rules, ['agents', 'agents --json', 'agents check:*']);
});

test('the agents skill walks through reading the repo, new, filling, check and asking before a commit', () => {
  const text = readFileSync(join(PLUGIN, 'skills', 'agents', 'SKILL.md'), 'utf8');
  for (const needle of [
    'factory agents new <station>',
    'replace every `TODO:` line',
    'Run `factory agents check` and fix each problem',
    'ask whether to commit `.claude/agents/`',
    'Commit only after a yes',
    '`specs_dir`',
    'Never reword, shorten or drop them',
    'make it only after they confirm',
  ]) {
    assert.ok(text.includes(needle), `agents skill lacks: ${needle}`);
  }
});

test('the run skill takes each station agent from factory agents, not a hard-coded name', () => {
  const text = readFileSync(join(PLUGIN, 'skills', 'run', 'SKILL.md'), 'utf8');
  for (const name of ['factory:builder', 'factory:verifier', 'factory:reviewer-<name>']) {
    assert.ok(!text.includes(`\`${name}\` agent`) && !text.includes(`\`${name}\` for`), `run skill hard-codes ${name}`);
  }
  assert.match(text, /Run `factory agents` before launching any/);
  assert.match(text, /Launch the builder agent `factory agents` names/);
  assert.match(text, /Launch the verifier agent `factory agents` names/);
  assert.match(text, /the agent `factory agents` names for `reviewer-<name>`\. If it says `missing` for a reviewer in the round, escalate with `factory human`/);
  // The builder's model rules are unchanged.
  assert.match(text, /Pick the builder's model from `task\.md` and pass it as the Agent tool's `model`/);
  assert.match(text, /When unsure, use `opus`\./);
  assert.match(text, /you do not write product code, judge proof, or review diffs yourself/);
});
