#!/usr/bin/env node
// Entry point named by package.json "bin". Skills run it through npx:
//   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder <command>
import { run } from './run.ts';

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
});
