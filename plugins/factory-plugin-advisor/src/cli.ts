#!/usr/bin/env node
// Entry point named by package.json "bin". Skills run it through npx, and hooks/hooks.json runs
// `node <plugin>/src/cli.ts hook` directly; see README.md.
import { readFileSync } from 'node:fs';

// Read stdin only when a command asks for it, and never from a terminal (it would wait for input).
let input: string | undefined;
const stdin = (): string => (input ??= process.stdin.isTTY ? '' : readFileSync(0, 'utf8'));
const argv = process.argv.slice(2);

if (argv.length === 1 && argv[0] === 'hook') {
  // The hook runs after every failed Bash call: reject non-matching input before loading the CLI.
  try {
    const { quickReject } = await import('./hook-filter.ts');
    if (!quickReject(stdin())) {
      const { run } = await import('./run.ts');
      run(argv, { stdout: () => {}, stderr: () => {}, stdin });
    }
  } catch {
    // The hook never fails a tool call; nothing is recorded.
  }
  process.exitCode = 0;
} else {
  const { run } = await import('./run.ts');
  process.exitCode = run(argv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdin,
  });
}
