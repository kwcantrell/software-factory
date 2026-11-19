// The hook's first check, kept in a module with no imports so cli.ts can run it before loading the
// rest of the CLI: most failed Bash calls are not marketplace CLI calls and should cost almost nothing.

/**
 * A cheap test on the raw hook input, before any parsing: true when it cannot be a failure of a
 * marketplace plugin CLI (not a PostToolUseFailure event, or no `npx` and no `src/cli.ts` in it).
 */
export function quickReject(raw: string): boolean {
  if (!raw.includes('PostToolUseFailure')) return true;
  return !raw.includes('npx') && !raw.includes('cli.ts');
}
