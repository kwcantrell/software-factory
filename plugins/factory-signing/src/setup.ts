// `setup`: the git config that makes every commit sign with the user's own SSH key through the
// ssh-agent. A dry run unless confirmed; it never generates a key and writes nothing but git config.
// `allowed-signers`: the user's line for an allowed-signers file (printed, never written).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { agentKeys, exec, expandHome, getSetting, parsePublicKey, peekPrivate, type Repo, resolveKey } from './signing.ts';

/** A refusal: exit 1, the message on stderr, nothing changed. */
export class Refused extends Error {}

export type Scope = 'repo' | 'global';

export interface Change {
  key: string;
  value: string;
  /** The value at this scope now; null when unset there. */
  current: string | null;
}

export interface Plan {
  scope: Scope;
  repo: string;
  key: { value: string; publicKey: string; source: 'flag' | 'agent' };
  changes: Change[];
  commands: string[];
}

/** Shell-quotes one word for display, only when it needs it. */
export function quote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The public key `--key` names: refused when missing, a private key, or not an SSH public key. */
function keyFromFlag(flag: string, cwd: string): Plan['key'] {
  let path = expandHome(flag);
  if (!isAbsolute(path)) path = resolve(cwd, path);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Refused(`--key ${path} is not a file`);
  if (peekPrivate(path)) {
    throw new Refused(`--key ${path} is a private key; pass its public key (${path.endsWith('.pub') ? path : `${path}.pub`}). factory-signing never reads or copies a private key`);
  }
  const pub = statSync(path).size <= 64 * 1024 ? parsePublicKey(readFileSync(path, 'utf8')) : null;
  if (pub === null) throw new Refused(`--key ${path} does not hold an ssh-* or sk-* public key`);
  return { value: path, publicKey: pub, source: 'flag' };
}

/** The one key loaded in the ssh-agent, as the path of its matching ~/.ssh/*.pub or a key:: literal. */
function keyFromAgent(): Plan['key'] {
  const agent = agentKeys();
  if (!agent.reachable) {
    throw new Refused(`no ssh-agent is reachable (${agent.error}): start one, load your key with \`! ssh-add <path to your private key>\`, or pass --key <public key path>`);
  }
  if (agent.keys.length === 0) {
    throw new Refused('the ssh-agent holds no key: run `! ssh-add <path to your private key>` yourself (Claude cannot enter a passphrase), or pass --key <public key path>');
  }
  if (agent.keys.length > 1) {
    throw new Refused(`the ssh-agent holds ${agent.keys.length} keys; choose one with --key <public key path>:\n${agent.keys.map((k) => `  ${k.line}`).join('\n')}`);
  }
  const pub = agent.keys[0]?.key as string;
  const ssh = join(homedir(), '.ssh');
  let names: string[] = [];
  try {
    names = readdirSync(ssh).filter((n) => n.endsWith('.pub')).sort();
  } catch {
    // no ~/.ssh: use the literal
  }
  for (const name of names) {
    const path = join(ssh, name);
    try {
      if (statSync(path).isFile() && statSync(path).size <= 64 * 1024 && parsePublicKey(readFileSync(path, 'utf8')) === pub) return { value: path, publicKey: pub, source: 'agent' };
    } catch {
      // unreadable: skip
    }
  }
  return { value: `key::${pub}`, publicKey: pub, source: 'agent' };
}

export function plan(repo: Repo, opts: { key?: string; scope: Scope; cwd: string }): Plan {
  const key = opts.key !== undefined ? keyFromFlag(opts.key, opts.cwd) : keyFromAgent();
  const level = opts.scope === 'global' ? '--global' : '--local';
  const wanted: [string, string][] = [
    ['gpg.format', 'ssh'],
    ['user.signingkey', key.value],
    ['commit.gpgsign', 'true'],
    ['tag.gpgsign', 'true'],
  ];
  const changes = wanted.map(([k, value]) => {
    const p = exec('git', ['config', level, '--get', k], { cwd: repo.top });
    return { key: k, value, current: p.status === 0 ? p.stdout.replace(/\n$/, '') : null };
  });
  const commands = changes.map((c) => ['git', ...(opts.scope === 'repo' ? ['-C', repo.top] : []), 'config', level, c.key, c.value].map(quote).join(' '));
  return { scope: opts.scope, repo: repo.top, key, changes, commands };
}

/** Applies the plan's git config changes. */
export function apply(p: Plan): void {
  const level = p.scope === 'global' ? '--global' : '--local';
  for (const c of p.changes) {
    const r = exec('git', ['config', level, c.key, c.value], { cwd: p.repo });
    if (r.error || r.status !== 0) throw new Refused(`git config ${level} ${c.key} failed: ${(r.error ?? r.stderr).trim()}`);
  }
}

export function formatPlan(p: Plan, confirmed: boolean): string {
  const source = p.key.source === 'flag' ? 'from --key' : 'the one key loaded in your ssh-agent';
  const lines = [
    `${confirmed ? 'Applied' : 'Dry run: setup would run'} (scope ${p.scope}${p.scope === 'repo' ? `: ${p.repo}, shared by its worktrees` : ': your global git config'}):`,
    ...p.commands.map((c) => `  ${c}`),
    `Signing key: ${p.key.value} (${source})`,
  ];
  for (const c of p.changes) if (c.current !== null && c.current !== c.value) lines.push(`  replaces ${c.key} = ${c.current}`);
  if (!confirmed) lines.push('Nothing changed. Run again with --confirm to apply.');
  return `${lines.join('\n')}\n`;
}

export interface SignerLine {
  email: string;
  publicKey: string;
  line: string;
}

/** `<user.email> <public key>` for an allowed-signers file. */
export function allowedSigners(repo: Repo): SignerLine {
  const email = getSetting(repo.top, 'user.email');
  if (!email || email.value.trim() === '') {
    throw new Refused('git user.email is not set: set it with `git config --global user.email <you@example.com>` (or without --global, in this repository), then run allowed-signers again');
  }
  const configured = getSetting(repo.top, 'user.signingkey');
  if (!configured || configured.value === '') throw new Refused('user.signingkey is not set: run `factory-signing setup` first');
  const key = resolveKey(configured.value, repo.top);
  if (key.publicKey === null) throw new Refused(`${key.problem ?? 'the signing key has no public key'}: run \`factory-signing setup --key <path to your .pub>\``);
  const e = email.value.trim();
  return { email: e, publicKey: key.publicKey, line: `${e} ${key.publicKey}` };
}
