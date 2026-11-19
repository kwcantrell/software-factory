// The factory's human gates, decided for a Claude Code PreToolUse hook on Bash (hooks/hooks.json runs
// human-gate.ts with node, which calls decide()). Any Bash call that runs `factory merge`,
// `factory approve`, `factory rework` or `factory claim` (through npx, a path, or the entry script
// `src/cli.ts`) is turned into a permission prompt, so no agent can ship a job, approve a spec,
// reopen an approved job or take a job over from another person without a person saying yes. Reads
// the PreToolUse payload on stdin; for anything else, and for a payload it cannot read, it prints
// nothing and exits 0.
/** Checked in this order; the first that matches gives the reason. */
export const GATES: readonly (readonly [string, string])[] = [
  [
    'merge',
    'Software Factory merge gate: this merges an agent-built branch into your working branch. Approve only if you have read ship.md.',
  ],
  [
    'approve',
    "Software Factory spec gate: this approves a job's task.md as the contract agents will build and be judged against.",
  ],
  [
    'rework',
    'Software Factory rework gate: this sends a job every reviewer approved back to build, with your request saved as rework-<round>.md.',
  ],
  [
    'claim',
    'Software Factory claim gate: this takes a job in the shared remote factory over from the person who claimed it.',
  ],
];

/** The hook's output for a raw PreToolUse payload: a permission prompt, or '' to stay silent. */
export function decide(payload: string): string {
  let command: unknown;
  try {
    const data: unknown = JSON.parse(payload);
    const input = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).tool_input : undefined;
    command = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined;
  } catch {
    return '';
  }
  if (typeof command !== 'string') return '';
  for (const [name, reason] of GATES) {
    // `factory merge`, a quoted path (`".../factory" merge`, `'.../factory' merge`), the npx form
    // (`... -- factory merge`) or the entry script run directly (`node ".../src/cli.ts" merge`,
    // `./src/cli.ts merge`), with any whitespace between the two words.
    if (new RegExp(`(?:factory|cli\\.ts)["']?\\s+${name}`).test(command)) {
      const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
      return `${JSON.stringify(out)}\n`;
    }
  }
  return '';
}
