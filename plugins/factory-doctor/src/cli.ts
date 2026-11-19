#!/usr/bin/env node
// Entry point named by package.json "bin". Skills run it through npx; see CLAUDE.md.
import { run } from './run.ts';

process.exitCode = run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
