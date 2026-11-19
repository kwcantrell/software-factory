// Real signing, end to end: a throwaway passphrase-less key, a temp ssh-agent, temp HOME and
// GIT_CONFIG_GLOBAL. `setup --confirm` alone must make plain commits (in the repo and in a linked
// worktree) and a remote factory's state commits signed, verifiably, with an allowed-signers file
// built from `allowed-signers`. Skipped, saying why, without ssh-agent, ssh-add or ssh-keygen.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_SSH, PLUGIN, withSandbox } from './helpers.ts';

const skip = NO_SSH ? `real signing needs OpenSSH: ${NO_SSH}` : false;

/** The factory CLI of this marketplace, run as a subprocess (plugins never import each other). */
const FACTORY = join(PLUGIN, '..', 'factory', 'src', 'cli.ts');
const TASK = '# A job\n\n## Acceptance criteria\n\n1. It works.\n';

test('setup --confirm makes plain commits signed, in the repo and in a linked worktree, verified against allowed-signers', { skip }, withSandbox((s) => {
  const repo = s.repo();
  const k = s.key();
  s.startAgent();
  s.sshAdd(k.key);
  s.ok(['setup', '--confirm'], repo);
  const signers = join(s.tmp, 'allowed_signers');
  writeFileSync(signers, s.ok(['allowed-signers'], repo));

  writeFileSync(join(repo, 'a.txt'), 'a\n');
  s.git(['add', 'a.txt'], repo);
  s.git(['commit', '-q', '-m', 'in the repo'], repo);
  const wt = join(s.tmp, 'wt');
  s.git(['worktree', 'add', '-q', '-b', 'side', wt], repo);
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  s.git(['add', 'b.txt'], wt);
  s.git(['commit', '-q', '-m', 'in the worktree'], wt);

  for (const [dir, subject] of [[repo, 'in the repo'], [wt, 'in the worktree']] as const) {
    const shown = s.git(['-c', `gpg.ssh.allowedSignersFile=${signers}`, 'log', '-1', '--show-signature', '--format=%s'], dir);
    assert.match(shown, /Good "git" signature for test@example\.invalid with ED25519 key/, shown);
    assert.ok(shown.endsWith(subject));
    assert.equal(s.git(['-c', `gpg.ssh.allowedSignersFile=${signers}`, 'log', '-1', '--format=%G?'], dir), 'G');
  }
}));

test('a remote factory\'s state commits are signed with the key setup chose, and factory merge\'s signature check accepts them', { skip }, withSandbox((s) => {
  // Bare remotes for the code and the factory state, and a clone of the code as the project checkout.
  const code = join(s.tmp, 'code.git');
  const state = join(s.tmp, 'state.git');
  s.git(['init', '-q', '--bare', '-b', 'main', code], s.tmp);
  s.git(['init', '-q', '--bare', '-b', 'main', state], s.tmp);
  const seed = s.repo('seed');
  s.git(['push', '-q', code, 'main'], seed);
  const repo = join(s.tmp, 'project');
  s.git(['clone', '-q', code, repo], s.tmp);
  s.git(['config', 'user.email', 'test@example.invalid'], repo);
  s.git(['config', 'user.name', 'Test'], repo);
  s.env.FACTORY_DIR = join(repo, 'factory');

  const k = s.key();
  s.startAgent();
  s.sshAdd(k.key);
  s.ok(['setup', '--confirm'], repo);
  // The allowed-signers file, from `allowed-signers`, committed by the project as a reviewed change would be.
  mkdirSync(join(repo, '.factory'));
  writeFileSync(join(repo, '.factory', 'allowed_signers'), s.ok(['allowed-signers'], repo));
  s.git(['add', '.factory'], repo);
  s.git(['commit', '-q', '-m', 'Allowed signers'], repo);
  writeFileSync(join(repo, 'factory.json'), `${JSON.stringify({ remote: { url: state, branch: 'factory-state', allowed_signers: '.factory/allowed_signers' } })}\n`);
  const st = s.json(['status'], repo);
  assert.equal(st.ok, true, JSON.stringify(st.problems));
  assert.equal(st.allowedSigners.listed, true);

  const factory = (args: string[]): string => {
    const p = spawnSync(process.execPath, [FACTORY, ...args], { cwd: repo, env: s.env, encoding: 'utf8' });
    assert.equal(p.status, 0, `factory ${args.join(' ')}\n${p.stdout}${p.stderr}`);
    return p.stdout;
  };
  factory(['init']);
  const id = factory(['new', 'Signed job']).split('\n')[0] as string;
  const jobs = join(repo, 'factory', 'jobs');
  writeFileSync(join(jobs, id, 'task.md'), TASK);
  factory(['start', id]);
  const wt = join(repo, 'factory', 'worktrees', id);
  writeFileSync(join(wt, 'feature.txt'), 'feature\n');
  s.git(['add', 'feature.txt'], wt);
  s.git(['commit', '-q', '-m', 'feature'], wt);
  for (const name of ['build.md', 'proof.md', 'review-1-solo.md']) writeFileSync(join(jobs, id, name), '# notes\n');
  factory(['built', id]);
  factory(['proof', id, 'pass']);
  factory(['round', id, 'solo']);
  factory(['verdict', id, 'solo', 'approve']);

  // Every state commit on the remote is a good SSH signature from the listed key.
  const file = join(repo, '.factory', 'allowed_signers');
  const sigs = s.git(['-c', `gpg.ssh.allowedSignersFile=${file}`, 'log', '--format=%G?', 'factory-state'], state).split('\n');
  assert.ok(sigs.length >= 7);
  assert.deepEqual(new Set(sigs), new Set(['G']));
  const shown = s.git(['-c', `gpg.ssh.allowedSignersFile=${file}`, 'log', '-1', '--show-signature', 'factory-state'], state);
  assert.match(shown, /Good "git" signature for test@example\.invalid/);
  // The builder's commit on the job branch is signed too.
  assert.equal(s.git(['-c', `gpg.ssh.allowedSignersFile=${file}`, 'log', '-1', '--format=%G?'], wt), 'G');

  // factory merge verifies the job's whole state history against the committed file, and merges.
  assert.match(factory(['merge', id]), new RegExp(`${id} merged into main`));
  assert.ok(existsSync(join(repo, 'feature.txt')));
}));
