#!/usr/bin/env node
// Entry point named by package.json "bin". Skills and CI run it through npx:
//   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs <command>
import { run } from './run.ts';

process.exitCode = run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
});
