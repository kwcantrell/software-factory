// `status`: every field it reports, driven through the CLI as a subprocess in a sandbox.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_SSH, type Sandbox, withSandbox } from './helpers.ts';

const skip = NO_SSH ?? false;

const problems = (s: Record<string, any>): string[] => s.problems.map((p: { problem: string }) => p.problem);
const fixes = (s: Record<string, any>): string[] => s.problems.map((p: { fix: string }) => p.fix);

/** A repo set up to sign with a throwaway key loaded in a temp agent. */
function ready(s: Sandbox): { repo: string; key: ReturnType<Sandbox['key']> } {
  const repo = s.repo();
  const key = s.key();
  s.startAgent();
  s.sshAdd(key.key);
  s.ok(['setup', '--confirm'], repo);
  return { repo, key };
}

test('status on an unconfigured repo: every setting unset, no agent, not required, exit 0 with a fix per problem', withSandbox((s) => {
  const repo = s.repo();
  const r = s.json(['status'], repo);
  assert.equal(r.repo, repo);
  assert.equal(r.gpgFormat, null);
  assert.equal(r.signingKey, null);
  assert.equal(r.commitGpgsign, null);
  assert.equal(r.tagGpgsign, null);
  assert.equal(r.agent.reachable, false);
  assert.equal(r.testSignature.ok, null);
  assert.deepEqual(r.requires, { required: false, reasons: [] });
  assert.equal(r.allowedSigners, null);
  assert.equal(r.ok, false);
  assert.ok(problems(r).some((p) => /gpg\.format is not set/.test(p)));
  assert.ok(problems(r).some((p) => /user\.signingkey is not set/.test(p)));
  assert.ok(problems(r).some((p) => /no ssh-agent is reachable/.test(p)));
  assert.equal(fixes(r).length, problems(r).length);
  // Text form, also exit 0.
  const text = s.ok(['status'], repo);
  assert.match(text, /gpg\.format\s+unset/);
  assert.match(text, /fix: /);
}));

test('gpg.format and user.signingkey are reported with their config level; a non-ssh format is a problem', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  s.git(['config', '--global', 'gpg.format', 'openpgp'], repo);
  s.git(['config', 'user.signingkey', k.pub], repo);
  let r = s.json(['status'], repo);
  assert.deepEqual(r.gpgFormat, { scope: 'global', value: 'openpgp', ok: false });
  assert.equal(r.signingKey.scope, 'local');
  assert.equal(r.signingKey.kind, 'path');
  assert.equal(r.signingKey.publicKeyPath, k.pub);
  assert.equal(r.signingKey.publicKey, k.publicKey);
  assert.ok(problems(r).includes("gpg.format is 'openpgp', not ssh"));
  // A key:: literal, set globally.
  s.git(['config', '--unset', 'user.signingkey'], repo);
  s.git(['config', '--global', 'user.signingkey', `key::${k.publicKey}`], repo);
  s.git(['config', 'gpg.format', 'ssh'], repo);
  r = s.json(['status'], repo);
  assert.deepEqual(r.gpgFormat, { scope: 'local', value: 'ssh', ok: true });
  assert.equal(r.signingKey.scope, 'global');
  assert.equal(r.signingKey.kind, 'literal');
  assert.equal(r.signingKey.publicKey, k.publicKey);
  // A private key path is read through its .pub, never itself.
  s.git(['config', 'user.signingkey', k.key], repo);
  r = s.json(['status'], repo);
  assert.equal(r.signingKey.publicKeyPath, k.pub);
  assert.equal(r.signingKey.publicKey, k.publicKey);
  // A path that does not exist.
  s.git(['config', 'user.signingkey', join(s.tmp, 'missing.pub')], repo);
  r = s.json(['status'], repo);
  assert.ok(problems(r).some((p) => /missing\.pub does not exist/.test(p)));
}));

test('commit.gpgsign and tag.gpgsign are reported, and commit.gpgsign=true makes the repo require signing', withSandbox((s) => {
  const repo = s.repo();
  s.git(['config', '--global', 'commit.gpgsign', 'true'], repo);
  s.git(['config', 'tag.gpgsign', 'yes'], repo);
  const r = s.json(['status'], repo);
  assert.deepEqual(r.commitGpgsign, { scope: 'global', value: 'true' });
  assert.deepEqual(r.tagGpgsign, { scope: 'local', value: 'true' });
  assert.deepEqual(r.requires, { required: true, reasons: ['commit.gpgsign=true (global config)'] });
}));

test('the ssh-agent: reachable or not, and whether it holds the signing key; a missing key says to run ! ssh-add', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  s.git(['config', 'gpg.format', 'ssh'], repo);
  s.git(['config', 'user.signingkey', k.pub], repo);
  let r = s.json(['status'], repo);
  assert.equal(r.agent.reachable, false);
  assert.ok(fixes(r).some((f) => f.includes(`! ssh-add ${k.key}`) && /cannot enter your key's passphrase/.test(f)));
  s.startAgent();
  r = s.json(['status'], repo);
  assert.equal(r.agent.reachable, true);
  assert.equal(r.agent.keyLoaded, false);
  assert.equal(r.testSignature.ok, null);
  const missing = r.problems.find((p: { problem: string }) => /not loaded in the ssh-agent/.test(p.problem));
  assert.ok(missing);
  assert.match(missing.fix, new RegExp(`run \`! ssh-add ${k.key.replace(/[.]/g, '\\.')}\` yourself`));
  assert.match(missing.fix, /Claude cannot enter your key's passphrase/);
  s.sshAdd(k.key);
  r = s.json(['status'], repo);
  assert.equal(r.agent.keyLoaded, true);
  assert.equal(r.agent.keys, 1);
}));

test('a test signature is made and verified through the agent, and its temp files are removed', { skip }, withSandbox((s) => {
  const { repo } = ready(s);
  const tmp = join(s.tmp, 'tmpdir');
  mkdirSync(tmp);
  s.env.TMPDIR = tmp;
  const r = s.json(['status'], repo);
  assert.deepEqual(r.testSignature, { ok: true, error: null });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(readdirSync(tmp), [], 'temp files removed');
  assert.match(s.ok(['status'], repo), /No problems/);
}));

test('a remote factory without unsigned_ok requires signing; unsigned_ok: true does not', withSandbox((s) => {
  const repo = s.repo();
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({ remote: { url: 'x', branch: 'state' } }));
  let r = s.json(['status'], repo);
  assert.equal(r.requires.required, true);
  assert.match(r.requires.reasons[0], /factory\.json sets a remote factory without unsigned_ok/);
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({ remote: { url: 'x', branch: 'state', unsigned_ok: true } }));
  r = s.json(['status'], repo);
  assert.deepEqual(r.requires, { required: false, reasons: [] });
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({}));
  r = s.json(['status'], repo);
  assert.equal(r.requires.required, false);
  // Both reasons at once.
  s.git(['config', 'commit.gpgsign', 'true'], repo);
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({ remote: { url: 'x', branch: 'state' } }));
  r = s.json(['status'], repo);
  assert.equal(r.requires.reasons.length, 2);
  // From a linked worktree, factory.json is read from the main checkout.
  const wt = join(s.tmp, 'wt');
  s.git(['worktree', 'add', '-q', wt], repo);
  r = s.json(['status'], wt);
  assert.equal(r.repo, wt);
  assert.equal(r.requires.reasons.length, 2);
}));

test('remote.allowed_signers: whether your key is listed in the file as committed at HEAD', { skip }, withSandbox((s) => {
  const { repo, key } = ready(s);
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({ remote: { url: 'x', branch: 'state', allowed_signers: '.factory/allowed_signers' } }));
  let r = s.json(['status'], repo);
  assert.equal(r.allowedSigners.listed, null);
  assert.ok(problems(r).some((p) => /\.factory\/allowed_signers is not committed at HEAD/.test(p)));
  mkdirSync(join(repo, '.factory'));
  writeFileSync(join(repo, '.factory', 'allowed_signers'), 'someone@example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther\n');
  s.git(['add', '.factory'], repo);
  s.git(['commit', '-q', '-m', 'signers'], repo);
  r = s.json(['status'], repo);
  assert.equal(r.allowedSigners.listed, false);
  const p = r.problems.find((x: { problem: string }) => /not listed/.test(x.problem));
  assert.match(p.fix, /factory-signing allowed-signers.*by pull request/);
  // Listed in the working tree but not committed: still not listed.
  const line = s.ok(['allowed-signers'], repo);
  writeFileSync(join(repo, '.factory', 'allowed_signers'), line);
  assert.equal(s.json(['status'], repo).allowedSigners.listed, false);
  s.git(['commit', '-q', '-am', 'me'], repo);
  r = s.json(['status'], repo);
  assert.equal(r.allowedSigners.listed, true);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(line.includes(key.publicKey));
}));

test('status outside a git repository exits 1; usage errors exit 2', withSandbox((s) => {
  const p = s.cli(['status'], s.tmp);
  assert.equal(p.status, 1);
  assert.equal(p.stdout, '');
  assert.match(p.stderr, /^factory-signing: not inside a git working tree/);
  const repo = s.repo();
  for (const args of [['status', 'x'], ['status', '--key', 'x'], ['status', '--confirm']]) {
    const q = s.cli(args, repo);
    assert.equal(q.status, 2, args.join(' '));
    assert.equal(q.stdout, '');
  }
  assert.equal(s.cli(['status', '--repo', repo], s.tmp).status, 0);
}));
