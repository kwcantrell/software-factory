// What makes a commit signed with the user's own SSH key, read from git, the ssh-agent and
// factory.json. Everything here only reads: it runs `git`, `ssh-add` and `ssh-keygen` (never through
// a shell) and never opens a private key. The one exception to reading a key file is `peekPrivate`,
// which looks at the first bytes of a path to recognise a private key and refuse it, without keeping
// or using anything it reads.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Every subprocess is bounded: the hook has 5 s in all (hooks/hooks.json). */
export const PROC_TIMEOUT_MS = 2000;

export interface Proc {
  status: number | null;
  stdout: string;
  stderr: string;
  /** A spawn failure (not found, timed out), as opposed to the program exiting non-zero. */
  error: string | null;
}

/** Runs one of the three programs this plugin uses, with no shell. */
export function exec(program: 'git' | 'ssh-add' | 'ssh-keygen', args: readonly string[], opts: { cwd?: string; input?: string } = {}): Proc {
  const p = spawnSync(program, [...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    timeout: PROC_TIMEOUT_MS,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const code = (p.error as NodeJS.ErrnoException | undefined)?.code;
  // A timed-out answer is no answer: never read it as "unset" (the hook would deny on it). Callers
  // fail; the hook then allows.
  if (code === 'ETIMEDOUT') throw new Error(`${program} ${args[0] ?? ''} did not answer within ${PROC_TIMEOUT_MS} ms`);
  return {
    status: p.status,
    stdout: p.stdout ?? '',
    stderr: p.stderr ?? '',
    error: p.error ? (code === 'ENOENT' ? `${program} is not installed (not on the PATH)` : p.error.message) : null,
  };
}

// ---------------------------------------------------------------- the repository

export interface Repo {
  /** The working tree's top (a linked worktree's own top, if run in one). */
  top: string;
  /** The main checkout: where factory.json and the factory dir live. */
  main: string;
}

/** The repository at `dir`, or null when `dir` is not inside a git working tree. */
export function findRepo(dir: string, gitArgs: readonly string[] = []): Repo | null {
  if (!existsSync(dir)) return null;
  const p = exec('git', [...gitArgs, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: dir });
  if (p.status !== 0) return null;
  const [top = '', common = ''] = p.stdout.split('\n');
  if (top === '') return null;
  const main = common.endsWith('/.git') ? dirname(common) : top;
  return { top, main };
}

// ---------------------------------------------------------------- git config

export interface Setting {
  value: string;
  /** git's config level: local, global, system, worktree or command. */
  scope: string;
}

/** One effective git setting with the level it comes from, or null when unset. */
export function getSetting(cwd: string, key: string, opts: { bool?: boolean; gitArgs?: readonly string[] } = {}): Setting | null {
  const p = exec('git', [...(opts.gitArgs ?? []), 'config', '--show-scope', ...(opts.bool ? ['--type=bool'] : []), '--get', key], { cwd });
  if (p.status !== 0) return null;
  const line = p.stdout.replace(/\n$/, '');
  const tab = line.indexOf('\t');
  return { scope: line.slice(0, tab), value: line.slice(tab + 1) };
}

// ---------------------------------------------------------------- keys

/** An SSH public key: `<type> <base64>`, or with ecdsa/sk types. */
const PUBLIC_KEY = /^(ssh-[a-z0-9-]+|sk-[a-z0-9@.-]+|ecdsa-sha2-[a-z0-9-]+)\s+([A-Za-z0-9+/]+={0,3})(?:\s|$)/;

/** `<type> <base64>` of the first public key line in `text`, without its comment; null if none. */
export function parsePublicKey(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = PUBLIC_KEY.exec(line);
    return m ? `${m[1]} ${m[2]}` : null;
  }
  return null;
}

/**
 * Whether `path` holds a private key, from its first bytes only (PEM/OpenSSH armour). Used only to
 * refuse it: nothing read is kept, printed or used.
 */
export function peekPrivate(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('latin1').startsWith('-----BEGIN');
  } finally {
    closeSync(fd);
  }
}

/** Reads a public key file (small; never a private key: callers peek first). */
function readPublic(path: string): string | null {
  if (statSync(path).size > 64 * 1024) return null;
  return parsePublicKey(readFileSync(path, 'utf8'));
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export interface KeyInfo {
  /** user.signingkey as configured. */
  configured: string;
  kind: 'path' | 'literal';
  /** The public key file used (a path key only). */
  path: string | null;
  /** `<type> <base64>`, or null when it cannot be found. */
  publicKey: string | null;
  /** The private key's likely path, for the `ssh-add` fix line; null when unknown. */
  privatePath: string | null;
  problem: string | null;
}

/**
 * What a user.signingkey value names. A literal (`key::...`, or a value starting with an SSH key
 * type) is the public key itself; otherwise it is a path, relative to the repository like git's.
 * For a path to a private key, its `.pub` next to it is read, never the private key.
 */
export function resolveKey(configured: string, cwd: string): KeyInfo {
  const base = { configured, path: null, privatePath: null };
  if (configured.startsWith('key::') || /^(ssh-|sk-|ecdsa-)/.test(configured)) {
    const pub = parsePublicKey(configured.replace(/^key::/, ''));
    return { ...base, kind: 'literal', publicKey: pub, problem: pub ? null : `user.signingkey '${configured}' is not an SSH public key` };
  }
  let path = expandHome(configured);
  if (!isAbsolute(path)) path = resolve(cwd, path);
  const info = { ...base, kind: 'path' as const };
  if (!existsSync(path)) return { ...info, publicKey: null, problem: `user.signingkey ${path} does not exist` };
  let pubPath = path;
  let privatePath: string | null = null;
  if (path.endsWith('.pub')) {
    privatePath = path.slice(0, -4);
  } else if (existsSync(`${path}.pub`)) {
    pubPath = `${path}.pub`;
    privatePath = path;
  } else if (peekPrivate(path)) {
    return { ...info, privatePath: path, publicKey: null, problem: `user.signingkey ${path} is a private key with no ${path}.pub next to it` };
  }
  if (peekPrivate(pubPath)) {
    return { ...info, path: pubPath, publicKey: null, problem: `${pubPath} holds a private key, not a public key` };
  }
  const pub = readPublic(pubPath);
  return {
    ...info,
    path: pubPath,
    privatePath: privatePath !== null && existsSync(privatePath) ? privatePath : null,
    publicKey: pub,
    problem: pub ? null : `${pubPath} does not hold an SSH public key`,
  };
}

// ---------------------------------------------------------------- ssh-agent

export interface Agent {
  reachable: boolean;
  /** Each loaded key as `<type> <base64>`, with its full `ssh-add -L` line (comment included). */
  keys: { key: string; line: string }[];
  /** Why the agent cannot be used, when not reachable. */
  error: string | null;
  /** True when ssh-add itself failed to run (not found, timed out), rather than finding no agent. */
  spawnFailed: boolean;
}

/** The keys loaded in the ssh-agent (`ssh-add -L`): exit 1 = none, 2 = no agent. */
export function agentKeys(): Agent {
  const p = exec('ssh-add', ['-L']);
  if (p.error) return { reachable: false, keys: [], error: p.error, spawnFailed: true };
  if (p.status === 0) {
    const keys = p.stdout
      .split('\n')
      .map((line) => ({ key: parsePublicKey(line), line: line.trim() }))
      .filter((k): k is { key: string; line: string } => k.key !== null);
    return { reachable: true, keys, error: null, spawnFailed: false };
  }
  if (p.status === 1) return { reachable: true, keys: [], error: null, spawnFailed: false };
  const why = process.env.SSH_AUTH_SOCK ? `cannot connect to the agent at SSH_AUTH_SOCK (${p.stderr.trim()})` : 'SSH_AUTH_SOCK is not set';
  return { reachable: false, keys: [], error: why, spawnFailed: false };
}

// ---------------------------------------------------------------- a test signature

export interface Signature {
  ok: boolean;
  error: string | null;
}

/**
 * Signs a temp file through the agent, as git does (`ssh-keygen -Y sign -n git`), and verifies it.
 * Signing is given only the public key, so ssh-keygen must use the agent and never prompts for a
 * passphrase. The temp files are removed afterwards.
 */
export function testSignature(publicKey: string): Signature {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-signing-'));
  try {
    const pub = join(tmp, 'key.pub');
    const msg = join(tmp, 'message');
    const signers = join(tmp, 'allowed_signers');
    const text = 'factory-signing test signature\n';
    writeFileSync(pub, `${publicKey}\n`);
    writeFileSync(msg, text);
    writeFileSync(signers, `factory-signing@test ${publicKey}\n`);
    const sign = exec('ssh-keygen', ['-Y', 'sign', '-n', 'git', '-f', pub, msg]);
    if (sign.error || sign.status !== 0) return { ok: false, error: `ssh-keygen -Y sign failed: ${(sign.error ?? sign.stderr).trim()}` };
    const verify = exec('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', 'factory-signing@test', '-n', 'git', '-s', `${msg}.sig`], { input: text });
    if (verify.error || verify.status !== 0) return { ok: false, error: `ssh-keygen -Y verify failed: ${(verify.error ?? verify.stderr).trim()}` };
    return { ok: true, error: null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- factory.json

export interface FactoryConfig {
  path: string;
  /** factory.json's `remote`, when it is an object. */
  remote: { allowed_signers?: unknown; unsigned_ok?: unknown } | null;
  error: string | null;
}

/**
 * The project's factory.json: next to FACTORY_DIR if set (as the factory CLI reads it), else in the
 * main checkout, else in this working tree. Null when there is none.
 */
export function factoryConfig(repo: Repo): FactoryConfig | null {
  const dirs = [process.env.FACTORY_DIR ? dirname(resolve(process.env.FACTORY_DIR)) : null, repo.main, repo.top];
  for (const dir of dirs) {
    if (dir === null) continue;
    const path = join(dir, 'factory.json');
    if (!existsSync(path)) continue;
    try {
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const remote = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).remote : undefined;
      return { path, remote: typeof remote === 'object' && remote !== null ? (remote as FactoryConfig['remote']) : null, error: null };
    } catch (error) {
      return { path, remote: null, error: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return null;
}

// ---------------------------------------------------------------- does the repo require signing?

export interface Requirement {
  required: boolean;
  reasons: string[];
  factory: FactoryConfig | null;
  /** True when factory.json's remote requires signed state commits. */
  factoryRemote: boolean;
}

/** Whether commits in `repo` must be signed: commit.gpgsign=true, and/or a remote factory without unsigned_ok. */
export function requirement(repo: Repo, gitArgs: readonly string[] = []): Requirement {
  const reasons: string[] = [];
  const gpgsign = getSetting(repo.top, 'commit.gpgsign', { bool: true, gitArgs });
  if (gpgsign?.value === 'true') reasons.push(`commit.gpgsign=true (${gpgsign.scope} config)`);
  const factory = factoryConfig(repo);
  const factoryRemote = factory?.remote != null && factory.remote.unsigned_ok !== true;
  if (factoryRemote) reasons.push(`${factory?.path} sets a remote factory without unsigned_ok`);
  return { required: reasons.length > 0, reasons, factory, factoryRemote };
}

// ---------------------------------------------------------------- allowed signers

export interface SignersCheck {
  file: string;
  /** Whether the user's public key is listed; null when unknown (no key, or the file is not committed). */
  listed: boolean | null;
  error: string | null;
}

/** Whether `publicKey` is listed in the allowed-signers file `file`, as committed at HEAD of `dir`. */
export function signersCheck(dir: string, file: string, publicKey: string | null): SignersCheck {
  const p = exec('git', ['show', `HEAD:${file}`], { cwd: dir });
  if (p.error || p.status !== 0) return { file, listed: null, error: `${file} is not committed at HEAD of ${dir}` };
  if (publicKey === null) return { file, listed: null, error: null };
  const [type, blob] = publicKey.split(' ');
  for (const raw of p.stdout.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const words = line.split(/\s+/);
    for (let i = 0; i + 1 < words.length; i++) if (words[i] === type && words[i + 1] === blob) return { file, listed: true, error: null };
  }
  return { file, listed: false, error: null };
}

// ---------------------------------------------------------------- usable for signing (the hook's question)

/**
 * Why signing cannot work for a commit in `repo` right now, or null when it can: SSH format, a key
 * whose public key is found, and that key loaded in the agent. `gitArgs` are the command's own git
 * options (`-c ...`), which change the effective settings.
 */
export function unusable(repo: Repo, gitArgs: readonly string[] = []): string | null {
  const format = getSetting(repo.top, 'gpg.format', { gitArgs });
  if (format?.value !== 'ssh') return format ? `gpg.format is '${format.value}', not ssh` : 'gpg.format is not set to ssh';
  const configured = getSetting(repo.top, 'user.signingkey', { gitArgs });
  if (!configured || configured.value === '') return 'user.signingkey is not set';
  const key = resolveKey(configured.value, repo.top);
  if (key.publicKey === null) return key.problem ?? 'the signing key has no public key';
  const agent = agentKeys();
  if (agent.spawnFailed) throw new Error(agent.error ?? 'ssh-add failed');
  if (!agent.reachable) return `no ssh-agent is reachable (${agent.error})`;
  if (!agent.keys.some((k) => k.key === key.publicKey)) return `the signing key ${key.path ?? key.configured} is not loaded in the ssh-agent`;
  return null;
}
