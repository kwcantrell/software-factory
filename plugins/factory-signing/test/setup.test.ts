// `setup` and `allowed-signers`, driven through the CLI with a temp HOME and GIT_CONFIG_GLOBAL.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_SSH, type Sandbox, withSandbox } from './helpers.ts';

const skip = NO_SSH ?? false;

/** The repo's local config file and the global one, to prove what changed and what did not. */
function configs(s: Sandbox, repo: string): { local: string; global: string } {
  return { local: readFileSync(join(repo, '.git', 'config'), 'utf8'), global: readFileSync(s.gitconfig, 'utf8') };
}

/** Every file under HOME/.ssh with its content: setup must never add, change or remove one. */
function sshDir(s: Sandbox): Record<string, string> {
  const dir = join(s.home, '.ssh');
  return Object.fromEntries(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
}

test('setup without --confirm is a dry run: prints the exact git config changes and changes nothing', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  s.startAgent();
  s.sshAdd(k.key);
  const before = configs(s, repo);
  const keys = sshDir(s);
  const text = s.ok(['setup'], repo);
  assert.match(text, /^Dry run: setup would run \(scope repo/);
  for (const line of [
    `git -C ${repo} config --local gpg.format ssh`,
    `git -C ${repo} config --local user.signingkey ${k.pub}`,
    `git -C ${repo} config --local commit.gpgsign true`,
    `git -C ${repo} config --local tag.gpgsign true`,
  ]) assert.ok(text.includes(line), `${line}\n${text}`);
  assert.match(text, /Run again with --confirm to apply/);
  const j = s.json(['setup'], repo);
  assert.equal(j.dryRun, true);
  assert.equal(j.scope, 'repo');
  assert.deepEqual(j.key, { value: k.pub, publicKey: k.publicKey, source: 'agent' });
  assert.deepEqual(j.changes.map((c: { key: string; value: string }) => [c.key, c.value]), [
    ['gpg.format', 'ssh'],
    ['user.signingkey', k.pub],
    ['commit.gpgsign', 'true'],
    ['tag.gpgsign', 'true'],
  ]);
  assert.deepEqual(configs(s, repo), before, 'nothing changed');
  assert.deepEqual(sshDir(s), keys);
}));

test('setup --confirm writes the repo\'s local config (shared by its worktrees), then reruns status', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  s.startAgent();
  s.sshAdd(k.key);
  const before = configs(s, repo);
  const keys = sshDir(s);
  const j = s.json(['setup', '--confirm'], repo);
  assert.equal(j.dryRun, false);
  assert.equal(j.status.ok, true, JSON.stringify(j.status.problems));
  assert.equal(j.status.testSignature.ok, true);
  for (const [key, value] of [['gpg.format', 'ssh'], ['user.signingkey', k.pub], ['commit.gpgsign', 'true'], ['tag.gpgsign', 'true']]) {
    assert.equal(s.git(['config', '--local', '--get', key as string], repo), value);
  }
  assert.equal(configs(s, repo).global, before.global, 'global config untouched');
  assert.deepEqual(sshDir(s), keys, 'no key written or changed');
  // A linked worktree sees the same settings.
  const wt = join(s.tmp, 'wt');
  s.git(['worktree', 'add', '-q', wt], repo);
  assert.equal(s.git(['config', '--get', 'user.signingkey'], wt), k.pub);
  // Text form shows the plan and the status.
  const text = s.ok(['setup', '--confirm'], repo);
  assert.match(text, /^Applied \(scope repo/);
  assert.match(text, /No problems/);
}));

test('setup --scope global writes only the global config (GIT_CONFIG_GLOBAL)', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  s.startAgent();
  s.sshAdd(k.key);
  const before = configs(s, repo);
  const dry = s.ok(['setup', '--scope', 'global'], repo);
  assert.ok(dry.includes(`git config --global user.signingkey ${k.pub}`), dry);
  assert.deepEqual(configs(s, repo), before);
  const j = s.json(['setup', '--scope', 'global', '--confirm'], repo);
  assert.equal(j.scope, 'global');
  assert.equal(configs(s, repo).local, before.local, 'repo config untouched');
  const global = readFileSync(s.gitconfig, 'utf8');
  assert.match(global, /format = ssh/);
  assert.ok(global.includes(k.pub));
  assert.equal(j.status.gpgFormat.scope, 'global');
  assert.equal(j.status.ok, true, JSON.stringify(j.status.problems));
  const bad = s.cli(['setup', '--scope', 'system'], repo);
  assert.equal(bad.status, 2);
}));

test('setup --key takes a public key path; refuses a private key and a file without an ssh-*/sk-* public key', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key('mine');
  const before = configs(s, repo);
  // No agent needed with --key.
  const j = s.json(['setup', '--key', k.pub], repo);
  assert.deepEqual(j.key, { value: k.pub, publicKey: k.publicKey, source: 'flag' });
  // ~ and relative paths.
  assert.equal(s.json(['setup', '--key', '~/.ssh/mine.pub'], repo).key.value, k.pub);
  assert.equal(s.json(['setup', '--repo', repo, '--key', '.ssh/mine.pub'], s.home).key.value, k.pub, 'relative to the cwd');
  const refused = (key: string, message: RegExp): void => {
    const p = s.cli(['setup', '--key', key, '--confirm'], repo);
    assert.equal(p.status, 1, p.stdout + p.stderr);
    assert.equal(p.stdout, '');
    assert.match(p.stderr, message);
  };
  refused(k.key, /is a private key; pass its public key \(.*mine\.pub\)/);
  const notKey = join(s.tmp, 'notes.pub');
  writeFileSync(notKey, 'hello world\n');
  refused(notKey, /does not hold an ssh-\* or sk-\* public key/);
  refused(join(s.tmp, 'nope.pub'), /is not a file/);
  assert.deepEqual(configs(s, repo), before, 'refusals change nothing');
}));

test('setup without --key: refuses with no agent, an empty agent or several keys (listing them); uses a key:: literal when no ~/.ssh file matches', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const before = configs(s, repo);
  const refused = (message: RegExp): string => {
    const p = s.cli(['setup', '--confirm'], repo);
    assert.equal(p.status, 1, p.stdout + p.stderr);
    assert.equal(p.stdout, '');
    assert.match(p.stderr, message);
    return p.stderr;
  };
  refused(/no ssh-agent is reachable/);
  s.startAgent();
  refused(/the ssh-agent holds no key: run `! ssh-add <path to your private key>` yourself/);
  const a = s.key('a', 'a@example.invalid');
  const b = s.key('b', 'b@example.invalid');
  s.sshAdd(a.key);
  s.sshAdd(b.key);
  const err = refused(/the ssh-agent holds 2 keys; choose one with --key/);
  assert.ok(err.includes(a.publicKey) && err.includes(b.publicKey));
  assert.deepEqual(configs(s, repo), before);
  // One key, whose .pub is not in ~/.ssh: the key:: literal.
  s.stopAgent();
  s.startAgent();
  s.sshAdd(a.key);
  rmSync(a.pub);
  const j = s.json(['setup'], repo);
  assert.equal(j.key.value, `key::${a.publicKey}`);
  s.ok(['setup', '--confirm'], repo);
  assert.equal(s.json(['status'], repo).ok, true);
}));

test('allowed-signers prints "<user.email> <public key>" and writes nothing; refuses without the email or a key', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  let p = s.cli(['allowed-signers'], repo);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /user\.signingkey is not set: run `factory-signing setup`/);
  s.git(['config', 'user.signingkey', k.pub], repo);
  const before = configs(s, repo);
  assert.equal(s.ok(['allowed-signers'], repo), `test@example.invalid ${k.publicKey}\n`);
  assert.deepEqual(s.json(['allowed-signers'], repo), { email: 'test@example.invalid', publicKey: k.publicKey, line: `test@example.invalid ${k.publicKey}` });
  assert.deepEqual(configs(s, repo), before);
  s.git(['config', '--unset', 'user.email'], repo);
  p = s.cli(['allowed-signers'], repo);
  assert.equal(p.status, 1);
  assert.equal(p.stdout, '');
  assert.match(p.stderr, /git user\.email is not set: set it with `git config --global user\.email <you@example\.com>`/);
}));
