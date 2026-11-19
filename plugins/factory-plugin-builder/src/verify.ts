// verify: the full gate for one plugin, run from the checkout root. Each step's own output streams to
// stderr so stdout keeps only the CLI's result.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { check, formatFinding } from './check.ts';

export type StepStatus = 'pass' | 'fail' | 'skipped';

export interface Step {
  name: string;
  command: string[];
  status: StepStatus;
  exitCode?: number;
  reason?: string;
}

export interface VerifyResult {
  plugin: string;
  ok: boolean;
  steps: Step[];
}

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

function exec(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, stream: (text: string) => void): Promise<{ exitCode: number; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', stream);
    child.stderr.setEncoding('utf8').on('data', stream);
    child.on('error', (error) => resolve({ exitCode: 127, error: error.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function step(name: string, command: string[], r: { exitCode: number; error?: string }): Step {
  return { name, command, status: r.exitCode === 0 ? 'pass' : 'fail', exitCode: r.exitCode, ...(r.error ? { reason: r.error } : {}) };
}

/**
 * Runs, in order and all of them: `check <name>` (in process), `claude plugin validate plugins/<name>`,
 * `claude plugin validate .`, `npm run typecheck`, and the plugin's own tests with
 * `node --test plugins/<name>/test/**\/*.test.ts` (the root `npm test`, limited to this plugin).
 * The caller has checked that plugins/<name> exists.
 */
export async function verify(root: string, name: string, env: NodeJS.ProcessEnv, stream: (text: string) => void): Promise<VerifyResult> {
  const steps: Step[] = [];
  // Set by node --test in its children; a nested node --test would otherwise report to it, not run.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;

  const { findings } = check(root, [name]);
  for (const f of findings) stream(`${formatFinding(f)}\n`);
  steps.push({ name: 'check', command: ['factory-plugin-builder', 'check', name], status: findings.length ? 'fail' : 'pass', exitCode: findings.length ? 1 : 0 });

  const claude = findOnPath('claude', env);
  for (const [stepName, target] of [['validate-plugin', `plugins/${name}`], ['validate-marketplace', '.']] as const) {
    const command = ['claude', 'plugin', 'validate', target];
    if (claude === null) {
      steps.push({ name: stepName, command, status: 'skipped', reason: 'claude is not on PATH' });
      continue;
    }
    steps.push(step(stepName, command, await exec(claude, command.slice(1), root, childEnv, stream)));
  }

  const npm = findOnPath('npm', env) ?? 'npm';
  steps.push(step('typecheck', ['npm', 'run', 'typecheck'], await exec(npm, ['run', 'typecheck'], root, childEnv, stream)));
  const testArgs = ['--test', '--test-timeout=120000', `plugins/${name}/test/**/*.test.ts`];
  steps.push(step('test', ['node', ...testArgs], await exec(process.execPath, testArgs, root, childEnv, stream)));

  return { plugin: name, ok: steps.every((s) => s.status !== 'fail'), steps };
}

export function formatStep(s: Step): string {
  const label = s.status === 'pass' ? 'PASS' : s.status === 'fail' ? 'FAIL' : 'SKIP';
  const detail = s.status === 'skipped' ? ` (${s.reason})` : s.status === 'fail' ? ` (exit ${s.exitCode}${s.reason ? `: ${s.reason}` : ''})` : '';
  return `${label}  ${s.name.padEnd(20)} ${s.command.join(' ')}${detail}`;
}
