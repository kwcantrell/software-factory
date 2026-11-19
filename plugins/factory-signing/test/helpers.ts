// Shared test setup: a sandbox with its own HOME, global git config, no system config and its own
// SSH_AUTH_SOCK, so no test ever touches the user's ~/.ssh, ssh-agent, ~/.gitconfig, ~/.config or
// ~/.claude. Throwaway passphrase-less keys and a temp ssh-agent come from ssh-keygen and ssh-agent.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(PLUGIN, 'src', 'cli.ts');

export interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function has(program: string, args: string[]): boolean {
  const p = spawnSync(program, args, { encoding: 'utf8' });
  return !(p.error && (p.error as NodeJS.ErrnoException).code === 'ENOENT');
}

/** Why the real-signing tests cannot run here, or null when ssh-agent, ssh-add and ssh-keygen exist. */
export const NO_SSH: string | null = (() => {
  for (const [program, args] of [['ssh-keygen', ['-?']], ['ssh-agent', ['-?']], ['ssh-add', ['-?']]] as const) {
    if (!has(program, [...args])) return `${program} is not installed`;
  }
  return null;
})();

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export class Sandbox {
  readonly tmp: string;
  readonly home: string;
  readonly gitconfig: string;
  env: NodeJS.ProcessEnv;
  private agent: ChildProcess | null = null;
  private agents = 0;

  constructor() {
    this.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'fsign-')));
    this.home = join(this.tmp, 'home');
    mkdirSync(join(this.home, '.ssh'), { recursive: true });
    this.gitconfig = join(this.home, '.gitconfig');
    writeFileSync(this.gitconfig, '');
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GIT_') || k.startsWith('SSH_') || k.startsWith('FACTORY_') || k.toLowerCase().startsWith('npm_')) continue;
      env[k] = v;
    }
    this.env = {
      ...env,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.gitconfig,
      // No background maintenance or auto-gc: it writes lock files under .git/objects mid-test.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'gc.auto',
      GIT_CONFIG_VALUE_1: '0',
      // No agent unless startAgent() runs: a socket path that does not exist.
      SSH_AUTH_SOCK: join(this.tmp, 'no-agent.sock'),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
  }

  cleanup(): void {
    this.stopAgent();
    rmSync(this.tmp, { recursive: true, force: true });
  }

  git(args: string[], cwd: string): string {
    const p = spawnSync('git', args, { cwd, env: this.env, encoding: 'utf8' });
    assert.equal(p.status, 0, `git ${args.join(' ')}: ${p.stderr}`);
    return p.stdout.trim();
  }

  /** A new repository with one commit and user.email set. */
  repo(name = 'repo'): string {
    const dir = join(this.tmp, name);
    mkdirSync(dir);
    this.git(['init', '-q', '-b', 'main'], dir);
    this.git(['config', 'user.email', 'test@example.invalid'], dir);
    this.git(['config', 'user.name', 'Test'], dir);
    writeFileSync(join(dir, 'README.md'), 'test\n');
    this.git(['add', 'README.md'], dir);
    this.git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial'], dir);
    return dir;
  }

  /** A throwaway passphrase-less key in HOME/.ssh: its private path, public path and public key. */
  key(name = 'id_ed25519', email = 'test@example.invalid'): { key: string; pub: string; publicKey: string } {
    const key = join(this.home, '.ssh', name);
    const p = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', email, '-f', key], { encoding: 'utf8' });
    assert.equal(p.status, 0, `ssh-keygen: ${p.stderr}`);
    const parts = readFileSync(`${key}.pub`, 'utf8').trim().split(' ');
    return { key, pub: `${key}.pub`, publicKey: `${parts[0]} ${parts[1]}` };
  }

  /** Starts a temp ssh-agent on a socket in the sandbox and points SSH_AUTH_SOCK at it. */
  startAgent(): void {
    // A new socket path each time: a stopped agent removes its own socket as it exits, which could
    // otherwise race with the next agent's.
    const sock = join(this.tmp, `agent-${++this.agents}.sock`);
    this.agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore', env: this.env });
    for (let i = 0; i < 200 && !existsSync(sock); i++) sleep(25);
    assert.ok(existsSync(sock), 'ssh-agent did not start');
    this.env.SSH_AUTH_SOCK = sock;
  }

  stopAgent(): void {
    this.agent?.kill();
    this.agent = null;
  }

  sshAdd(key: string): void {
    const p = spawnSync('ssh-add', ['-q', key], { env: this.env, encoding: 'utf8' });
    assert.equal(p.status, 0, `ssh-add: ${p.stderr}`);
  }

  cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = this.env): Result {
    const p = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    return { status: p.status, stdout: p.stdout, stderr: p.stderr };
  }

  ok(args: string[], cwd: string): string {
    const p = this.cli(args, cwd);
    assert.equal(p.status, 0, `factory-signing ${args.join(' ')}\n${p.stdout}${p.stderr}`);
    return p.stdout;
  }

  json(args: string[], cwd: string): Record<string, any> {
    return JSON.parse(this.ok([...args, '--json'], cwd));
  }

  /** Runs the hook with a PreToolUse payload for `command` in `cwd`. */
  hook(command: string, cwd: string): Result {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
    const p = spawnSync(process.execPath, [CLI, 'hook'], { cwd, env: this.env, input: payload, encoding: 'utf8' });
    return { status: p.status, stdout: p.stdout, stderr: p.stderr };
  }
}

/** A fresh Sandbox per test, removed afterwards. */
export function withSandbox(fn: (s: Sandbox) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const s = new Sandbox();
    try {
      await fn(s);
    } finally {
      s.cleanup();
    }
  };
}
