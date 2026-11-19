// The PreToolUse hook: JSON on stdin, as Claude Code sends it, to `factory-signing hook`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitCommands, segments } from '../src/hook.ts';
import { CLI, NO_SSH, PLUGIN, type Result, type Sandbox, withSandbox } from './helpers.ts';

const skip = NO_SSH ?? false;

function denied(p: Result, reason: RegExp): void {
  assert.equal(p.status, 0);
  assert.equal(p.stderr, '');
  const out = JSON.parse(p.stdout);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'], 'never updatedInput');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const why: string = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(!why.includes('\n'), 'one line');
  assert.match(why, reason);
  assert.match(why, /factory-signing status/);
}

function allowed(p: Result): void {
  assert.deepEqual(p, { status: 0, stdout: '', stderr: '' });
}

/** A repo that requires signing (commit.gpgsign=true) and is set up with a key loaded in a temp agent. */
function signingRepo(s: Sandbox): { repo: string; key: ReturnType<Sandbox['key']> } {
  const repo = s.repo();
  const key = s.key();
  s.startAgent();
  s.sshAdd(key.key);
  s.ok(['setup', '--confirm'], repo);
  return { repo, key };
}

const COMMITTING = [
  'git commit -m "x"',
  'git merge feature',
  'git rebase main',
  'git cherry-pick abc123',
  'git revert HEAD',
  'git am patch.mbox',
  'git -C . commit -m x',
  'git -c user.name=x commit -m x',
  'GIT_EDITOR=true git --no-pager commit --amend --no-edit',
  'cd . && git commit -m "x"',
  'echo hi; git commit -am "msg with && and ; inside"',
];

test('segments: splits on shell operators outside quotes and removes quotes', () => {
  assert.deepEqual(segments(`cd 'a b' && git commit -m "x && y"; echo 'z' | cat 2>&1`), [
    ['cd', 'a b'],
    ['git', 'commit', '-m', 'x && y'],
    ['echo', 'z'],
    ['cat', '2>&1'],
  ]);
  assert.deepEqual(segments('(cd x && git merge y)'), [['cd', 'x'], ['git', 'merge', 'y']]);
});

test('commitCommands: finds commit-making git and factory commands, with -C, -c and cd', () => {
  const found = commitCommands('cd sub && git -C ../other -c commit.gpgsign=false commit -m x', '/r');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.dir, '/r/other');
  assert.deepEqual(found[0]?.configs, [['commit.gpgsign', 'false']]);
  for (const c of COMMITTING) assert.equal(commitCommands(c, '/r').length, 1, c);
  for (const c of ['git status', 'git log --oneline', 'git push', 'git rebase --abort', 'git merge --abort', 'echo git commit', 'ls', 'git config commit.gpgsign']) {
    assert.deepEqual(commitCommands(c, '/r'), [], c);
  }
  const npx = 'npx --yes --offline --loglevel=error --package="/cache/software-factory/factory/0.4.0" -- factory';
  for (const c of [`${npx} new "x"`, `${npx} built 001`, `${npx} followup add 001 --by builder "t"`, `${npx} remote push`, 'node /x/plugins/factory/src/cli.ts note 1 x', 'node /cache/factory/0.4.0/src/cli.ts start 1']) {
    assert.equal(commitCommands(c, '/r')[0]?.kind, 'factory', c);
  }
  for (const c of [`${npx} status`, `${npx} followup list`, `${npx} remote status`, `${npx} stats --json`, 'node /x/plugins/factory-signing/src/cli.ts status']) {
    assert.deepEqual(commitCommands(c, '/r'), [], c);
  }
});

test('in a repo that does not require signing the hook prints nothing, even with nothing set up', withSandbox((s) => {
  const repo = s.repo();
  for (const c of [...COMMITTING, 'git commit --no-gpg-sign -m x', 'git -c commit.gpgsign=false commit -m x']) allowed(s.hook(c, repo));
}));

test('when signing is usable, commit commands are allowed silently', { skip }, withSandbox((s) => {
  const { repo } = signingRepo(s);
  for (const c of COMMITTING) allowed(s.hook(c, repo));
}));

test('in a repo that requires signing, it denies when the key is not in the agent, there is no key, or the format is not ssh', { skip }, withSandbox((s) => {
  const { repo, key } = signingRepo(s);
  // Key not in the agent.
  s.stopAgent();
  s.startAgent();
  for (const c of COMMITTING) denied(s.hook(c, repo), /not loaded in the ssh-agent/);
  // No agent at all.
  s.stopAgent();
  s.env.SSH_AUTH_SOCK = join(s.tmp, 'gone.sock');
  denied(s.hook('git commit -m x', repo), /no ssh-agent is reachable/);
  // Back, with the key.
  s.startAgent();
  s.sshAdd(key.key);
  allowed(s.hook('git commit -m x', repo));
  // Format not ssh.
  s.git(['config', 'gpg.format', 'openpgp'], repo);
  denied(s.hook('git commit -m x', repo), /gpg\.format is 'openpgp', not ssh/);
  s.git(['config', 'gpg.format', 'ssh'], repo);
  // No key.
  s.git(['config', '--unset', 'user.signingkey'], repo);
  denied(s.hook('git commit -m x', repo), /user\.signingkey is not set/);
  // The command's own -c is taken into account: a key given there makes it usable.
  allowed(s.hook(`git -c user.signingkey=${key.pub} commit -m x`, repo));
}));

test('in a repo that requires signing, it denies a command that turns signing off', { skip }, withSandbox((s) => {
  const { repo } = signingRepo(s);
  for (const [c, why] of [
    ['git commit --no-gpg-sign -m x', /with --no-gpg-sign would make an unsigned commit/],
    ['git -c commit.gpgsign=false commit -m x', /with -c commit\.gpgsign=false/],
    ['git -c commit.gpgSign=off merge feature', /-c commit\.gpgsign=off/],
    ['git -c gpg.format=openpgp commit -m x', /-c gpg\.format=openpgp/],
    ['git rebase --no-gpg-sign main', /git rebase with --no-gpg-sign/],
    ['cd . && git -C . cherry-pick --no-gpg-sign abc', /git cherry-pick with --no-gpg-sign/],
  ] as const) denied(s.hook(c, repo), why);
  // Turning it on is fine.
  allowed(s.hook('git -c gpg.format=ssh -c commit.gpgsign=true commit -S -m x', repo));
}));

test('a compound command is checked in the directory each part runs in', { skip }, withSandbox((s) => {
  const plain = s.repo('plain');
  const { repo } = signingRepo(s);
  s.stopAgent();
  s.startAgent();
  // Run from the plain repo, but cd into the signing one.
  denied(s.hook(`cd ${repo} && git commit -m x`, plain), /not loaded in the ssh-agent/);
  denied(s.hook(`git -C ${repo} commit -m x`, plain), /not loaded in the ssh-agent/);
  allowed(s.hook(`cd ${plain} && git commit -m x`, repo));
  // A linked worktree of the signing repo shares its config.
  const wt = join(s.tmp, 'wt');
  s.git(['worktree', 'add', '-q', '-b', 'side', wt], repo);
  denied(s.hook('git commit -m x', wt), /not loaded in the ssh-agent/);
}));

test('the factory CLI\'s state-changing commands are checked in remote mode, read commands are not', { skip }, withSandbox((s) => {
  const repo = s.repo();
  s.startAgent();
  const npx = 'npx --yes --offline --loglevel=error --package="/cache/factory/0.4.0" -- factory';
  // Local mode: never checked, even with nothing set up.
  allowed(s.hook(`${npx} new "x"`, repo));
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({ remote: { url: 'x', branch: 'state' } }));
  denied(s.hook(`${npx} new "x"`, repo), /factory new would fail or make an unsigned commit: gpg\.format is not set to ssh.*sets a remote factory without unsigned_ok/);
  denied(s.hook(`${npx} followup add 001 --by builder "t"`, repo), /factory followup add/);
  allowed(s.hook(`${npx} status`, repo));
  allowed(s.hook(`${npx} followup list`, repo));
  // unsigned_ok: not required.
  writeFileSync(join(repo, 'factory.json'), JSON.stringify({ remote: { url: 'x', branch: 'state', unsigned_ok: true } }));
  allowed(s.hook(`${npx} new "x"`, repo));
}));

test('the hook is quiet for non-commit commands and allows on its own failures', { skip }, withSandbox((s) => {
  const { repo } = signingRepo(s);
  s.stopAgent();
  for (const c of ['git status', 'ls -la', 'git log', 'npm test', 'git push origin main']) allowed(s.hook(c, repo));
  // Malformed or unexpected payloads.
  for (const payload of ['', 'not json', '[]', '{}', '{"tool_input":{}}', '{"tool_input":{"command":7}}', JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'git commit' }, cwd: repo })]) {
    const p = spawnSync(process.execPath, [CLI, 'hook'], { cwd: repo, env: s.env, input: payload, encoding: 'utf8' });
    allowed({ status: p.status, stdout: p.stdout, stderr: p.stderr });
  }
  // A directory that does not exist, and one that is not a repo.
  allowed(s.hook('cd /nonexistent/dir && git commit -m x', repo));
  allowed(s.hook('git commit -m x', s.tmp));
  // ssh-add missing from the PATH (an internal failure, not a finding): allows.
  const bin = join(s.tmp, 'bin');
  mkdirSync(bin);
  symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'git'));
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo });
  const p = spawnSync(process.execPath, [CLI, 'hook'], { cwd: repo, env: { ...s.env, PATH: bin }, input: payload, encoding: 'utf8' });
  allowed({ status: p.status, stdout: p.stdout, stderr: p.stderr });
  // An ssh-add that never answers in time (a hung agent): the hook gives up and allows.
  const slow = join(s.tmp, 'slow');
  mkdirSync(slow);
  writeFileSync(join(slow, 'ssh-add'), '#!/usr/bin/env node\nsetTimeout(() => {}, 4000);\n', { mode: 0o755 });
  const q = spawnSync(process.execPath, [CLI, 'hook'], { cwd: repo, env: { ...s.env, PATH: `${slow}:${s.env.PATH}` }, input: payload, encoding: 'utf8' });
  allowed({ status: q.status, stdout: q.stdout, stderr: q.stderr });
}));

test('hooks.json runs the hook with node in exec form, on Bash, with a 5 s timeout', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Bash');
  assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/cli.ts', 'hook'], timeout: 5 }]);
});
