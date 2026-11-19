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
  assert.equal(skills.length, 5);
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
