// Shared test setup: a scratch config dir per test (outside any git checkout) and run() with a fake Io.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.ts';
import type { Env } from '../src/plugins.ts';

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

export interface Sandbox {
  dir: string;
  config: string;
  env: Env;
  /** run() with this sandbox's env; `now` advances one minute per call unless given. */
  call: (argv: string[], options?: { stdin?: string; now?: Date }) => { code: number; stdout: string; stderr: string };
  cleanup: () => void;
}

export function sandbox(extraEnv: Env = {}, pluginRoot: string = PLUGIN_ROOT): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'factory-plugin-advisor-test-'));
  const config = join(dir, 'config', 'factory-plugin-advisor');
  const env: Env = { HOME: join(dir, 'home'), PATH: process.env.PATH, FACTORY_PLUGIN_ADVISOR_CONFIG_DIR: config, ...extraEnv };
  let clock = Date.parse('2026-11-01T10:00:00.000Z');
  const call: Sandbox['call'] = (argv, options = {}) => {
    let stdout = '';
    let stderr = '';
    const now = options.now ?? new Date((clock += 60_000));
    const code = run(argv, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
      stdin: () => options.stdin ?? '',
      env,
      now: () => now,
      pluginRoot,
      // Only the sandbox's own HOME/USER count as the current user, never whoever runs the tests.
      system: {},
    });
    return { code, stdout, stderr };
  };
  return { dir, config, env, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes an executable fake `gh` into `<dir>/bin` that logs its argv and stdin, then behaves per `script`. */
export function fakeGh(dir: string, script: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'gh');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(join(dir, 'gh-calls.jsonl'))}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }) + '\\n');
${script}
`,
  );
  chmodSync(path, 0o755);
  return bin;
}
