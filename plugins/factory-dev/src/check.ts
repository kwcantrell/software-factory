// check: every gate CI runs, in one command, from the checkout root. Every step runs even after one fails;
// each step's own output streams through `stream` (stderr) so stdout keeps only the CLI's result.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { releaseCheck } from './release.ts';
import { entryDir, marketplaceEntries } from './repo.ts';

export type StepStatus = 'pass' | 'fail' | 'skipped';

export interface Step {
  name: string;
  command: string[];
  status: StepStatus;
  exitCode?: number;
  reason?: string;
}

export interface CheckResult {
  ok: boolean;
  steps: Step[];
}

export interface CheckOptions {
  /** Fail the validate steps when `claude` is not on the PATH, instead of skipping them. */
  requireClaude: boolean;
  /** Environment for the commands the steps run (PATH decides whether `claude` is found). */
  env: NodeJS.ProcessEnv;
  /** Receives the steps' own output and a line per step as it starts and finishes. */
  stream: (text: string) => void;
}

/** The convention checker the steps call: the checkout's own factory-plugin-builder. */
export const PLUGIN_BUILDER_CLI = 'plugins/factory-plugin-builder/src/cli.ts';
export const TEMPLATE_PATH = 'templates/plugin';

/** The first executable named `name` on the PATH in `env`, or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

interface Exec {
  exitCode: number;
  stdout: string;
  error?: string;
}

/** Runs a command in `cwd`; its stdout is streamed unless `capture`, its stderr always is. */
function exec(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, stream: (text: string) => void, capture = false): Promise<Exec> {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(file, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', (text: string) => (capture ? (stdout += text) : stream(text)));
    child.stderr.setEncoding('utf8').on('data', stream);
    child.on('error', (error) => resolve({ exitCode: 127, stdout, error: error.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}

function fromExec(name: string, command: string[], r: Exec): Step {
  return { name, command, status: r.exitCode === 0 ? 'pass' : 'fail', exitCode: r.exitCode, ...(r.error ? { reason: r.error } : {}) };
}

/** Every tracked, and untracked-but-not-ignored, *.json file parses. */
async function jsonStep(root: string, env: NodeJS.ProcessEnv, stream: (text: string) => void): Promise<Step> {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.json'];
  const command = ['git', ...args];
  const listed = await exec(findOnPath('git', env) ?? 'git', args, root, env, stream, true);
  if (listed.exitCode !== 0) return { ...fromExec('json', command, listed), reason: listed.error ?? 'git ls-files failed' };
  const bad: string[] = [];
  for (const path of listed.stdout.split('\0').filter(Boolean)) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    try {
      JSON.parse(text);
      stream(`ok   ${path}\n`);
    } catch (error) {
      stream(`BAD  ${path} - ${error instanceof Error ? error.message : String(error)}\n`);
      bad.push(path);
    }
  }
  return bad.length === 0
    ? { name: 'json', command, status: 'pass', exitCode: 0 }
    : { name: 'json', command, status: 'fail', exitCode: 1, reason: `invalid JSON: ${bad.join(', ')}` };
}

/** `claude plugin validate` targets: the marketplace, each listed plugin, and the template. */
export function validateTargets(root: string): string[] {
  const targets = ['.'];
  for (const entry of marketplaceEntries(root)) {
    const dir = entryDir(entry);
    if (dir !== null && !targets.includes(dir)) targets.push(dir);
  }
  if (existsSync(join(root, TEMPLATE_PATH))) targets.push(TEMPLATE_PATH);
  return targets;
}

function header(stream: (text: string) => void, name: string, command: string[]): void {
  stream(`\n== ${name}: ${command.join(' ')}\n`);
}

/**
 * Runs, in order and all of them: json, `claude plugin validate` on each target, `npm run typecheck`,
 * `npm test`, the release check (no tag) and `factory-plugin-builder check --all`.
 */
export async function checkAll(root: string, options: CheckOptions): Promise<CheckResult> {
  const { env, stream } = options;
  // Set by node --test in its children; a nested node --test would otherwise report to it, not run.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const steps: Step[] = [];
  const done = (s: Step) => {
    steps.push(s);
    stream(`${formatStep(s)}\n`);
  };

  header(stream, 'json', ['git ls-files *.json']);
  done(await jsonStep(root, childEnv, stream));

  const claude = findOnPath('claude', env);
  for (const target of validateTargets(root)) {
    const name = `validate ${target}`;
    const command = ['claude', 'plugin', 'validate', target];
    header(stream, name, command);
    if (claude === null) {
      done(
        options.requireClaude
          ? { name, command, status: 'fail', reason: 'claude is not on PATH and --require-claude was given (npm install -g @anthropic-ai/claude-code)' }
          : { name, command, status: 'skipped', reason: 'claude is not on PATH' },
      );
      continue;
    }
    done(fromExec(name, command, await exec(claude, command.slice(1), root, childEnv, stream)));
  }

  const npm = findOnPath('npm', env) ?? 'npm';
  for (const [name, args] of [['typecheck', ['run', 'typecheck']], ['test', ['test']]] as const) {
    const command = ['npm', ...args];
    header(stream, name, command);
    done(fromExec(name, command, await exec(npm, args, root, childEnv, stream)));
  }

  const releaseCommand = ['factory-dev', 'release'];
  header(stream, 'release', releaseCommand);
  try {
    const r = releaseCheck(root);
    stream(`version ${r.version} of ${r.plugins.join(', ')} has a CHANGELOG.md section\n`);
    done({ name: 'release', command: releaseCommand, status: 'pass', exitCode: 0 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    done({ name: 'release', command: releaseCommand, status: 'fail', exitCode: 1, reason });
  }

  const conventionArgs = [PLUGIN_BUILDER_CLI, 'check', '--all', '--repo', '.'];
  const conventionCommand = ['node', ...conventionArgs];
  header(stream, 'plugin-convention', conventionCommand);
  if (!existsSync(join(root, PLUGIN_BUILDER_CLI))) {
    done({ name: 'plugin-convention', command: conventionCommand, status: 'fail', reason: `${PLUGIN_BUILDER_CLI} is missing` });
  } else {
    done(fromExec('plugin-convention', conventionCommand, await exec(process.execPath, conventionArgs, root, childEnv, stream)));
  }

  return { ok: steps.every((s) => s.status !== 'fail'), steps };
}

export function formatStep(s: Step): string {
  const label = s.status === 'pass' ? 'PASS' : s.status === 'fail' ? 'FAIL' : 'SKIP';
  const detail = s.status === 'pass' ? '' : ` (${[s.exitCode === undefined ? '' : `exit ${s.exitCode}`, s.reason ?? ''].filter(Boolean).join(': ')})`;
  return `${label}  ${s.name.padEnd(32)} ${s.command.join(' ')}${detail}`;
}
