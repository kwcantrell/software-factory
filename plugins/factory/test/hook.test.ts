// The human-gate PreToolUse hook, run exactly as hooks/hooks.json runs it: `node src/human-gate.ts`
// with the payload on stdin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PLUGIN } from './helpers.ts';

const HOOK = join(PLUGIN, 'src', 'human-gate.ts');
const NPX = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory';

const REASONS = {
  merge:
    'Software Factory merge gate: this merges an agent-built branch into your working branch. Approve only if you have read ship.md.',
  approve:
    "Software Factory spec gate: this approves a job's task.md as the contract agents will build and be judged against.",
  rework:
    'Software Factory rework gate: this sends a job every reviewer approved back to build, with your request saved as rework-<round>.md.',
};

function hook(stdin: string): { status: number | null; stdout: string; stderr: string } {
  const p = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr };
}

const payload = (command: unknown): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });

test('hooks.json runs the TypeScript hook with node, no shell script', () => {
  const config = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const entry = config.hooks.PreToolUse[0];
  assert.equal(entry.matcher, 'Bash');
  assert.equal(entry.hooks[0].command, 'node');
  assert.deepEqual(entry.hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/src/human-gate.ts']);
});

test('merge, approve and rework become a permission prompt, in every form', () => {
  for (const [name, reason] of Object.entries(REASONS)) {
    for (const command of [
      `factory ${name} 3`,
      `"/home/me/.claude/plugins/cache/x/factory" ${name} 3`,
      `'/path with spaces/factory' ${name} 3`,
      `${NPX} ${name} 3`,
      `${NPX.replace('${CLAUDE_PLUGIN_ROOT}', '/a/b')}  ${name} 007-x --into-current`,
      `cd /x && factory ${name} 3`,
    ]) {
      const p = hook(payload(command));
      assert.equal(p.status, 0, command);
      assert.equal(p.stderr, '');
      assert.deepEqual(JSON.parse(p.stdout), {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
      }, command);
    }
  }
});

test('the merge reason wins when a command runs several gated commands, as before', () => {
  const p = hook(payload('factory approve 1 && factory merge 1'));
  assert.equal(JSON.parse(p.stdout).hookSpecificOutput.permissionDecisionReason, REASONS.merge);
});

test('anything else, including malformed input, prints nothing and exits 0', () => {
  for (const stdin of [
    payload('factory status'),
    payload(`${NPX} followup add 3 --by builder "merge the docs"`),
    payload('git merge main'),
    payload('ls factory/jobs'),
    payload(42),
    JSON.stringify({ tool_input: null }),
    JSON.stringify([1, 2]),
    'not json at all factory merge',
    '{"tool_input": {"command": "factory merge 1"',
    '',
  ]) {
    const p = hook(stdin);
    assert.equal(p.status, 0, stdin);
    assert.equal(p.stdout, '', stdin);
    assert.equal(p.stderr, '', stdin);
  }
});
