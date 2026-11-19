// Shared test setup: a temp repository (never the real one), a temp HOME, CLAUDE_CONFIG_DIR and PATH
// (never the user's ~/.claude, ~/.config or environment values), and run() with a fake Io.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Env } from '../src/claude.ts';
import { run } from '../src/run.ts';

export interface Sandbox {
  dir: string;
  /** The repository root (has a .git dir). */
  repo: string;
  home: string;
  claudeDir: string;
  bin: string;
  env: Env;
  write: (rel: string, text: string) => string;
  writeJson: (rel: string, value: unknown) => string;
  /** An executable fake tool on PATH that prints `output` (a Node script; no shell). */
  tool: (name: string, output: string, stream?: 'stdout' | 'stderr') => void;
  call: (argv: string[], extraEnv?: Env, cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup: () => void;
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'factory-doctor-test-'));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const claudeDir = join(dir, 'claude');
  const bin = join(dir, 'bin');
  for (const d of [join(repo, '.git'), home, claudeDir, bin]) mkdirSync(d, { recursive: true });
  // Only the fake tools and node itself (fake tools are `#!/usr/bin/env node` scripts).
  const env: Env = { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: `${bin}:${dirname(process.execPath)}` };
  const write = (rel: string, text: string): string => {
    const path = join(repo, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const writeJson = (rel: string, value: unknown): string => write(rel, `${JSON.stringify(value, null, 2)}\n`);
  const tool: Sandbox['tool'] = (name, output, stream = 'stdout') => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env node\nprocess.${stream}.write(${JSON.stringify(`${output}\n`)});\n`);
    chmodSync(path, 0o755);
  };
  const call: Sandbox['call'] = async (argv, extraEnv = {}, cwd = repo) => {
    let stdout = '';
    let stderr = '';
    const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: { ...env, ...extraEnv }, cwd });
    return { code, stdout, stderr };
  };
  return { dir, repo, home, claudeDir, bin, env, write, writeJson, tool, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal valid file with the given profiles. */
export function doc(profiles: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, ...extra, profiles };
}
