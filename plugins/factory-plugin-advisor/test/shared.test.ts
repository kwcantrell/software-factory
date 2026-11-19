// Opt-in sharing (factory.json "advisor": {"share": true} with a remote factory): two simulated users,
// each with their own config dir, OS identity and project checkout, against one bare remote. The
// remote's state branch is created by the real factory CLI, so the factory keeps working on it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/run.ts';
import { AUTHOR, ambiguousUrl, displayUrl, mergeState, normaliseUrl, privateHost, publicWarning, remoteHost, type ShareConfig, sharedOccurrence } from '../src/shared.ts';
import { FIXTURES, PLUGIN_ROOT, sandbox, type Sandbox } from './helpers.ts';
import type { Env } from '../src/plugins.ts';

const BRANCH = 'factory-state';
const FACTORY_CLI = fileURLToPath(new URL('../../factory/src/cli.ts', import.meta.url));
const ADVISOR_CLI = join(PLUGIN_ROOT, 'src', 'cli.ts');

const boxes: Sandbox[] = [];
afterEach(() => {
  while (boxes.length > 0) boxes.pop()?.cleanup();
});

function git(args: string[], cwd: string, env: Env = {}): string {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', ...env } as NodeJS.ProcessEnv });
  assert.equal(p.status, 0, `git ${args.join(' ')}: ${p.stderr}`);
  return p.stdout;
}

/** A bare remote in its own sandbox dir. */
function world(): { box: Sandbox; remote: string } {
  const box = sandbox();
  boxes.push(box);
  const remote = join(box.dir, 'state.git');
  git(['init', '-q', '--bare', '-b', 'main', remote], box.dir);
  return { box, remote };
}

interface User {
  box: Sandbox;
  project: string;
  name: string;
  factory: (args: string[]) => string;
}

/**
 * One person: their own config dir, home, username and project checkout (with factory.json). With
 * `ack` (the default) they have acknowledged the remote factory.json shares with (`share allow`).
 */
function user(name: string, factoryJson: unknown, extra: Env = {}, ack = true): User {
  const login = `${name.toLowerCase()}smith`;
  const home = `/home/${login}`;
  // FACTORY_DIR points at the project's factory dir; factory.json is read from its parent.
  const box = sandbox({ USER: login, HOME: home, ...extra }, PLUGIN_ROOT, { homedir: home, username: login });
  boxes.push(box);
  const project = join(box.dir, 'project');
  mkdirSync(project);
  git(['init', '-q', '-b', 'main', project], project);
  box.env.FACTORY_DIR = join(project, 'factory');
  writeFileSync(join(project, 'factory.json'), `${JSON.stringify(factoryJson)}\n`);
  // The remote factory signs its state commits: a throwaway SSH key, set in the project's own git config.
  const key = join(box.dir, 'signing_ed25519');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]).status, 0, 'ssh-keygen');
  git(['config', 'gpg.format', 'ssh'], project);
  git(['config', 'user.signingkey', key], project);
  const factory = (args: string[]): string => {
    const env = { PATH: process.env.PATH, HOME: box.dir, GIT_CONFIG_NOSYSTEM: '1', FACTORY_DIR: box.env.FACTORY_DIR, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${login}@example.com`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${login}@example.com` };
    const p = spawnSync(process.execPath, [FACTORY_CLI, ...args], { cwd: project, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(p.status, 0, `factory ${args.join(' ')}: ${p.stdout}${p.stderr}`);
    return p.stdout;
  };
  if (ack) ok(box.call(['share', 'allow', '--repo', project]));
  return { box, project, name, factory };
}

const shared = (remote: string): unknown => ({ remote: { url: remote, branch: BRANCH }, advisor: { share: true } });

function sharedLog(remote: string): any[] {
  const p = spawnSync('git', ['--git-dir', remote, 'show', `${BRANCH}:advisor/occurrences.jsonl`], { encoding: 'utf8' });
  if (p.status !== 0) return [];
  return p.stdout.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

function sharedRaw(remote: string, file: string): string {
  const p = spawnSync('git', ['--git-dir', remote, 'show', `${BRANCH}:advisor/${file}`], { encoding: 'utf8' });
  return p.status === 0 ? p.stdout : '';
}

const ok = (r: { code: number; stdout: string; stderr: string }): string => {
  assert.equal(r.code, EXIT.ok, r.stderr);
  return r.stdout;
};

const record = (u: User, summary: string, detail?: string): { code: number; stdout: string; stderr: string } =>
  u.box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', summary, ...(detail === undefined ? [] : ['--detail', detail])]);

const list = (u: User): any[] => JSON.parse(ok(u.box.call(['list', '--json']))).issues;

// ------------------------------------------------------------------ 1. opt-in

test('off (no advisor.share, share false, or no remote) is exactly the local log: no id, no shared dir, no remote writes', () => {
  const { remote } = world();
  for (const cfg of [{}, { remote: { url: remote, branch: BRANCH } }, { remote: { url: remote, branch: BRANCH }, advisor: { share: false } }, { remote: null, advisor: { share: true } }]) {
    const u = user('Ann', cfg, {}, false);
    const r = record(u, 'docs gate fails on a fresh clone');
    assert.deepEqual(r, { code: EXIT.ok, stdout: `Recorded ${JSON.parse(ok(u.box.call(['list', '--json']))).issues[0].signature} (factory-docs, workaround): seen 1 time.\n`, stderr: '' }, JSON.stringify(cfg));
    const line = JSON.parse(readFileSync(join(u.box.config, 'occurrences.jsonl'), 'utf8'));
    assert.deepEqual(Object.keys(line).sort(), ['at', 'kind', 'plugin', 'signature', 'source', 'summary'], 'no id or by field');
    assert.equal(existsSync(join(u.box.config, 'shared')), false, JSON.stringify(cfg));
  }
  assert.equal(spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', BRANCH]).status, 1, 'nothing was pushed');
});

test('sharing on still refuses a local log inside a git checkout, and then shares nothing', () => {
  const { remote } = world();
  const u = user('Ann', shared(remote));
  u.box.env.FACTORY_PLUGIN_ADVISOR_CONFIG_DIR = join(u.project, 'advisor-log');
  const r = record(u, 'docs gate fails on a fresh clone');
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /refusing to keep the log in .*inside the git checkout/);
  assert.deepEqual(sharedLog(remote), []);
});

// ------------------------------------------------------------------ 1b. the user's own acknowledgement

const branchTip = (remote: string, branch = BRANCH): string => spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', branch], { encoding: 'utf8' }).stdout.trim();
const NOTICE = /turns on sharing with .* but you have not acknowledged that remote, so nothing is shared or read from it; to share, run: factory-plugin-advisor share allow --repo /;

test('unacknowledged: record, the hook, list, show, suggest and dismiss act exactly as with sharing off', () => {
  const { remote } = world();
  // Bob acknowledged the remote: his occurrence and his dismiss are on the branch.
  const bob = user('Bob', shared(remote));
  ok(record(bob, 'docs gate fails on a fresh clone'));
  const sig = list(bob)[0].signature;
  ok(bob.box.call(['dismiss', sig]));
  const tip = branchTip(remote);
  assert.notEqual(tip, '');
  // Ann's repository asks for sharing, but she never acknowledged it.
  const ann = user('Ann', shared(remote), { CLAUDE_CODE_SESSION_ID: 'session-1' }, false);
  const first = record(ann, 'docs gate fails on a fresh clone');
  assert.equal(first.code, EXIT.ok);
  assert.match(first.stdout, /seen 1 time\./, 'the shared occurrence is not counted');
  const notices = (text: string): string[] => text.split('\n').filter((l) => NOTICE.test(l));
  assert.equal(notices(first.stderr).length, 1, first.stderr);
  assert.equal(first.stderr.split('\n').filter((l) => l !== '').length, 1, 'one line, nothing else');
  assert.ok(first.stderr.startsWith(`factory-plugin-advisor: ${join(ann.project, 'factory.json')} turns on sharing with ${remote} (branch ${BRANCH})`), first.stderr);
  assert.ok(first.stderr.trimEnd().endsWith(`share allow --repo ${ann.project}`), first.stderr);
  assert.deepEqual(notices(record(ann, 'docs gate fails on a fresh clone').stderr), [], 'once per session');
  ann.box.env.CLAUDE_CODE_SESSION_ID = 'session-2';
  assert.equal(notices(record(ann, 'x happened').stderr).length, 1, 'a new session is told again');
  // The hook records locally and stays silent.
  const hook = readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8');
  assert.deepEqual(ann.box.call(['hook'], { stdin: hook }), { code: EXIT.ok, stdout: '', stderr: '' });
  const lines = readFileSync(join(ann.box.config, 'occurrences.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  for (const l of lines) assert.equal(l.id, undefined, 'an unshared occurrence carries no id, as with sharing off');
  // Reading: only the local log and local state. Bob's occurrence and his dismiss are not seen.
  const issues = list(ann);
  const mine = issues.find((i: any) => i.signature === sig);
  assert.equal(mine.count, 2);
  assert.equal(mine.status, 'open');
  assert.equal(JSON.parse(ok(ann.box.call(['show', sig, '--json']))).occurrences.length, 2);
  const s = JSON.parse(ok(ann.box.call(['suggest', '--threshold', '2', '--json'])));
  assert.deepEqual(s.suggestions.map((x: any) => x.signature), [sig], 'suggested from local data, though Bob dismissed it');
  ok(ann.box.call(['dismiss', sig]));
  // Nothing was pushed, fetched or even cloned for Ann, and no notice came from the read commands.
  assert.equal(branchTip(remote), tip, 'the branch did not move');
  assert.equal(existsSync(join(ann.box.config, 'shared')), false, 'no clone, no queue: nothing read from the branch');
  assert.deepEqual(notices(ann.box.call(['list']).stderr), [], 'only record gives the notice');
});

test('acknowledged: share allow records the normalised remote in the config dir, and sharing starts; share list shows it', () => {
  const { remote } = world();
  const bob = user('Bob', shared(remote));
  ok(record(bob, 'docs gate fails on a fresh clone'));
  const ann = user('Ann', shared(remote), {}, false);
  assert.equal(list(ann).length, 0);
  assert.deepEqual(JSON.parse(ok(ann.box.call(['share', 'list', '--json']))), { remotes: [] });
  assert.match(ok(ann.box.call(['share', 'list'])), /No remote factory is acknowledged/);
  // Without --repo, from FACTORY_DIR like every command.
  const r = JSON.parse(ok(ann.box.call(['share', 'allow', '--json'])));
  assert.equal(r.url, remote);
  assert.equal(r.branch, BRANCH);
  assert.equal(r.added, true);
  assert.equal(r.configPath, join(ann.project, 'factory.json'));
  assert.equal(r.warning, undefined, 'a local path is not public');
  assert.equal(JSON.parse(ok(ann.box.call(['share', 'allow', '--json']))).added, false, 'twice is once');
  // In the config dir, owner-only; never in the repository.
  const file = join(ann.box.config, 'share-allowed.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).remotes.map((x: any) => [x.url, x.branch]), [[remote, BRANCH]]);
  assert.deepEqual(readdirSync(ann.project).sort(), ['.git', 'factory.json']);
  const listed = JSON.parse(ok(ann.box.call(['share', 'list', '--json']))).remotes;
  assert.deepEqual(listed.map((x: any) => [x.url, x.branch]), [[remote, BRANCH]]);
  assert.match(ok(ann.box.call(['share', 'list'])), new RegExp(`^${remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  branch ${BRANCH}  since `));
  // Now Ann reads Bob's occurrence and shares her own.
  assert.equal(list(ann)[0].count, 1);
  const rec = record(ann, 'docs gate fails on a fresh clone');
  assert.match(rec.stdout, /seen 2 times/);
  assert.doesNotMatch(rec.stderr, NOTICE);
  assert.equal(sharedLog(remote).length, 2);
});

test('a changed URL or branch in factory.json needs a new acknowledgement; the same remote spelled differently does not', () => {
  const { box: w, remote } = world();
  const other = join(w.dir, 'other.git');
  git(['init', '-q', '--bare', '-b', 'main', other], w.dir);
  const ann = user('Ann', shared(remote));
  ok(record(ann, 'docs gate fails on a fresh clone'));
  assert.equal(sharedLog(remote).length, 1);
  const tip = branchTip(remote);
  const setRemote = (url: string, branch = BRANCH): void => writeFileSync(join(ann.project, 'factory.json'), `${JSON.stringify({ remote: { url, branch }, advisor: { share: true } })}\n`);
  // Another URL: nothing goes there, and nothing more to the old one; record says why.
  setRemote(other);
  const r = record(ann, 'docs gate fails again');
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, NOTICE);
  assert.ok(r.stderr.includes(other));
  assert.equal(branchTip(other), '', 'nothing pushed to the new remote');
  assert.equal(branchTip(remote), tip);
  assert.equal(list(ann).reduce((n: number, i: any) => n + i.count, 0), 2, 'local only');
  // Another branch of the acknowledged URL: also a new acknowledgement.
  setRemote(remote, 'other-branch');
  assert.match(record(ann, 'docs gate fails a third time').stderr, NOTICE);
  assert.equal(branchTip(remote, 'other-branch'), '');
  assert.equal(branchTip(remote), tip);
  // The acknowledged remote with a trailing slash (or `//`, `/./`) is the same remote.
  setRemote(`${remote.replace(/\/state\.git$/, '//./state.git')}/`);
  const back = record(ann, 'docs gate fails on a fresh clone');
  assert.doesNotMatch(back.stderr, NOTICE);
  assert.equal(sharedLog(remote).length, 2);
  // Acknowledging the other remote shares there too.
  setRemote(other);
  ok(ann.box.call(['share', 'allow']));
  ok(record(ann, 'docs gate fails on a fresh clone'));
  assert.equal(sharedLog(other).length, 1);
  assert.equal(JSON.parse(ok(ann.box.call(['share', 'list', '--json']))).remotes.length, 2);
});

test('a URL git reads as another host never matches an acknowledged remote, and is never acknowledged', () => {
  const ann = user('Ann', {}, {}, false);
  // Ann acknowledged https://good.invalid/team/x from another repository.
  const good = join(ann.box.dir, 'good');
  mkdirSync(good);
  git(['init', '-q', '-b', 'main', good], good);
  const goodUrl = 'https://good.invalid/team/x';
  writeFileSync(join(good, 'factory.json'), `${JSON.stringify({ remote: { url: goodUrl, branch: BRANCH }, advisor: { share: true } })}\n`);
  ok(ann.box.call(['share', 'allow', '--repo', good]));
  const allowFile = join(ann.box.config, 'share-allowed.json');
  const acknowledged = readFileSync(allowFile, 'utf8');
  assert.deepEqual(JSON.parse(acknowledged).remotes.map((x: any) => x.url), [goodUrl]);
  // Ann's own repository names a URL that looks like that remote but that git sends elsewhere.
  const sneaky = ['https://evil.invalid?@good.invalid/team/x', 'https://evil.invalid#@good.invalid/team/x', 'https://evil.invalid\\@good.invalid/team/x', 'https://a@evil.invalid@good.invalid/team/x'];
  sneaky.forEach((url, i) => {
    writeFileSync(join(ann.project, 'factory.json'), `${JSON.stringify({ remote: { url, branch: BRANCH }, advisor: { share: true } })}\n`);
    ann.box.env.CLAUDE_CODE_SESSION_ID = `session-${i}`;
    const r = record(ann, `docs gate fails ${i}`);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.match(r.stdout, new RegExp(`seen ${i + 1} times?\\.`), 'counted locally only');
    assert.equal(r.stderr.split('\n').filter((l) => l !== '').length, 1, r.stderr);
    assert.match(r.stderr, /but that URL cannot be acknowledged \(.*\), so nothing is shared or read from it$/m, url);
    assert.doesNotMatch(r.stderr, /share allow/, 'no advice to acknowledge what cannot be');
    assert.equal(existsSync(join(ann.box.config, 'shared')), false, `${url}: no clone, no queue, nothing pushed or read`);
    const lines = readFileSync(join(ann.box.config, 'occurrences.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const l of lines) assert.equal(l.id, undefined, `${url}: the occurrence was not shared`);
    // share allow refuses it and names the host git would actually reach.
    const allow = ann.box.call(['share', 'allow']);
    assert.equal(allow.code, EXIT.failure, url);
    assert.equal(allow.stdout, '');
    assert.match(allow.stderr, /^factory-plugin-advisor: refusing to acknowledge /);
    if (!url.startsWith('https://a@')) assert.ok(allow.stderr.includes('git connects to "evil.invalid"'), allow.stderr);
    assert.equal(readFileSync(allowFile, 'utf8'), acknowledged, 'the acknowledgements are unchanged');
  });
  // The hook is silent and shares nothing either.
  const hook = readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8');
  assert.deepEqual(ann.box.call(['hook'], { stdin: hook }), { code: EXIT.ok, stdout: '', stderr: '' });
  assert.equal(existsSync(join(ann.box.config, 'shared')), false);
  // An acknowledgement written for such a URL (by hand, say) is ignored.
  writeFileSync(allowFile, `${JSON.stringify({ version: 1, remotes: [{ url: sneaky[0], branch: BRANCH, at: '2026-01-01T00:00:00Z' }] })}\n`);
  assert.deepEqual(JSON.parse(ok(ann.box.call(['share', 'list', '--json']))).remotes, []);
});

test('revoked: share revoke stops sharing and reading at once; an unknown remote is refused', () => {
  const { remote } = world();
  const bob = user('Bob', shared(remote));
  ok(record(bob, 'docs gate fails on a fresh clone'));
  const ann = user('Ann', shared(remote));
  assert.equal(list(ann)[0].count, 1);
  const r = JSON.parse(ok(ann.box.call(['share', 'revoke', remote, BRANCH, '--json'])));
  assert.deepEqual(r.removed.map((x: any) => [x.url, x.branch]), [[remote, BRANCH]]);
  assert.deepEqual(JSON.parse(ok(ann.box.call(['share', 'list', '--json']))).remotes, []);
  const tip = branchTip(remote);
  const rec = record(ann, 'docs gate fails on a fresh clone');
  assert.match(rec.stdout, /seen 1 time\./, "Bob's occurrence is no longer read");
  assert.match(rec.stderr, NOTICE);
  assert.equal(branchTip(remote), tip, 'nothing pushed');
  assert.equal(list(ann)[0].count, 1);
  // Without a branch, every branch of the URL goes; a remote that is not acknowledged is refused.
  ok(ann.box.call(['share', 'allow']));
  const all = JSON.parse(ok(ann.box.call(['share', 'revoke', `${remote}/`, '--json'])));
  assert.equal(all.removed.length, 1);
  const none = ann.box.call(['share', 'revoke', 'https://user:s3cret@example.com/x.git']);
  assert.equal(none.code, EXIT.failure);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /^factory-plugin-advisor: https:\/\/example\.com\/x\.git is not acknowledged/);
  assert.equal(none.stderr.includes('s3cret'), false);
});

test('share: usage errors, nothing to acknowledge, and credentials never stored', () => {
  const { remote } = world();
  const ann = user('Ann', {}, {}, false);
  for (const args of [['share'], ['share', 'nope'], ['share', 'list', 'x'], ['share', 'list', '--repo', '.'], ['share', 'revoke'], ['share', 'revoke', 'a', 'b', 'c'], ['share', 'allow', 'x'], ['share', 'allow', '--min', '2'], ['share', 'allow', '--repo', join(ann.box.dir, 'missing')]]) {
    const r = ann.box.call(args);
    assert.equal(r.code, EXIT.usage, args.join(' '));
    assert.equal(r.stdout, '');
  }
  const off = ann.box.call(['share', 'allow']);
  assert.equal(off.code, EXIT.failure);
  assert.match(off.stderr, /nothing to acknowledge: .*does not set "advisor": \{"share": true\}/);
  assert.equal(existsSync(join(ann.box.config, 'share-allowed.json')), false);
  // --repo reads that repository's factory.json, not FACTORY_DIR's.
  const other = join(ann.box.dir, 'other');
  mkdirSync(other);
  git(['init', '-q', '-b', 'main', other], other);
  writeFileSync(join(other, 'factory.json'), `${JSON.stringify({ remote: { url: 'https://ann:tok3n@GitHub.com/Org/x.git/', branch: BRANCH }, advisor: { share: true } })}\n`);
  const r = ann.box.call(['share', 'allow', '--repo', other]);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.match(r.stdout, /^Acknowledged: sharing the redacted friction log with https:\/\/GitHub\.com\/Org\/x\.git\/ \(branch factory-state\)/);
  assert.match(r.stdout, /warning: sharing the redacted friction log on github\.com/, 'the public-remote warning, before any sharing');
  const stored = readFileSync(join(ann.box.config, 'share-allowed.json'), 'utf8');
  assert.equal(stored.includes('tok3n'), false, 'no credentials on disk');
  assert.equal(r.stdout.includes('tok3n'), false);
  assert.equal(JSON.parse(stored).remotes[0].url, 'https://github.com/Org/x.git');
  assert.ok(remote !== '');
});

test('normaliseUrl: credentials, case of scheme and host, trailing slashes and dot segments', () => {
  const cases: Array<[string, string]> = [
    ['https://u:pw@GitHub.COM/Org/Repo.git/', 'https://github.com/Org/Repo.git'],
    ['HTTPS://token@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['ssh://git@Host.Example:2222/o/r.git', 'ssh://host.example:2222/o/r.git'],
    ['git@GitHub.com:org/repo.git/', 'git@github.com:org/repo.git'],
    ['/srv//git/./state.git/', '/srv/git/state.git'],
    ['/srv/git/x/../state.git', '/srv/git/state.git'],
    ['file:///srv/state.git/', 'file:///srv/state.git'],
  ];
  for (const [input, want] of cases) assert.equal(normaliseUrl(input), want, input);
  assert.notEqual(normaliseUrl('git@github.com:org/repo.git'), normaliseUrl('git@github.com:org/other.git'));
  // The authority ends where git ends it: at the first '/', '?', '#' or '\\', user info at its last '@'.
  for (const sep of ['?', '#', '\\']) {
    const url = `https://evil.example${sep}@good.example/x`;
    assert.equal(normaliseUrl(url), url, url);
    assert.notEqual(normaliseUrl(url), normaliseUrl('https://good.example/x'));
    assert.equal(displayUrl(url), url, 'nothing that looks like user info is dropped');
    assert.equal(remoteHost(url), 'evil.example');
    assert.match(ambiguousUrl(url) ?? '', /git connects to "evil\.example"/);
  }
  assert.equal(displayUrl('https://u:p@evil.example?x=@good/y'), 'https://evil.example?x=@good/y');
  assert.equal(remoteHost('https://a@evil.example@good.example/x'), 'good.example');
  assert.match(ambiguousUrl('https://a@evil.example@good.example/x') ?? '', /more than one '@'/);
  for (const fine of ['https://u:pw@github.com/o/r.git', 'https://github.com', 'ssh://git@host:22/x', 'git@github.com:o/r.git', '/srv/x.git', 'https://host/x?y@z']) assert.equal(ambiguousUrl(fine), null, fine);
});

// ------------------------------------------------------------------ 2. what is shared

test('only the redacted, masked occurrence reaches the shared file; no identity unless opted in, commits by a fixed author', () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  ann.factory(['init']);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
  const summary = `docs gate failed in /home/annsmith/work/app for annsmith: token=${secret} ann.smith@example.com cc @annsmith-gh`;
  ok(record(ann, summary, `trace /Users/annsmith/x\nAuthorization: Bearer ${secret}\nmail ann.smith@example.com @octo-person`));
  const text = sharedRaw(remote, 'occurrences.jsonl');
  assert.notEqual(text, '');
  for (const raw of [secret, 'annsmith', 'ann.smith@example.com', '@annsmith-gh', '@octo-person', '/home/', '/Users/']) {
    assert.equal(text.includes(raw), false, `${raw} reached the shared file: ${text}`);
  }
  const [o, ...more] = sharedLog(remote);
  assert.equal(more.length, 0);
  assert.match(o.summary, /\[redacted\]/);
  assert.match(o.summary, /\[email\]/);
  assert.match(o.summary, /@\[user\]/);
  assert.match(o.id, /^[0-9a-f]{16}$/);
  assert.equal(o.by, undefined, 'no identity without FACTORY_PLUGIN_ADVISOR_SHARE_AS');
  assert.deepEqual(Object.keys(o).sort(), ['at', 'detail', 'id', 'kind', 'plugin', 'signature', 'source', 'summary']);
  // The local log holds the same occurrence (same id).
  const local = JSON.parse(readFileSync(join(ann.box.config, 'occurrences.jsonl'), 'utf8'));
  assert.deepEqual(local, o);
  // The commit that carried it names neither the user nor their git identity.
  const log = git(['--git-dir', remote, 'log', '--format=%an <%ae>|%cn <%ce>|%s', BRANCH], ann.box.dir).trim().split('\n');
  assert.equal(log[0], `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|factory-plugin-advisor: record 1 occurrence`);
  // The opt-in: the chosen name, and nothing else.
  const bob = user('Bob', shared(remote), { FACTORY_PLUGIN_ADVISOR_SHARE_AS: 'Bob B' });
  ok(record(bob, 'docs gate fails on a fresh clone'));
  assert.equal(sharedLog(remote)[1].by, 'Bob B');
  // A name that could be an email or a mention is ignored, and the CLI says so.
  const eve = user('Eve', shared(remote), { FACTORY_PLUGIN_ADVISOR_SHARE_AS: 'eve@example.com' });
  const r = record(eve, 'docs gate fails on a fresh clone');
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, /FACTORY_PLUGIN_ADVISOR_SHARE_AS is ignored/);
  assert.equal(sharedLog(remote)[2].by, undefined);
});

// ------------------------------------------------------------------ 3. reading

test('two users: list, show and suggest read both logs, group one issue across people, and never double-count', () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  const bob = user('Bob', shared(remote));
  ann.factory(['init']);
  ok(record(ann, 'factory-docs stale fails in /home/annsmith/app/README.md with exit 1'));
  ok(record(bob, 'factory-docs stale fails in /home/bobsmith/code/README.md with exit 2'));
  const r = record(ann, 'factory-docs stale fails in /home/annsmith/other/README.md with exit 3');
  assert.match(r.stdout, /seen 3 times/, 'record counts the team');
  for (const u of [ann, bob]) {
    const issues = list(u);
    assert.equal(issues.length, 1, `${u.name}: one issue across people`);
    assert.equal(issues[0].count, 3, `${u.name}: own occurrences in both logs count once`);
    const shown = JSON.parse(ok(u.box.call(['show', issues[0].signature, '--json'])));
    assert.equal(shown.occurrences.length, 3);
  }
  // Bob's local log holds only his own occurrence.
  assert.equal(readFileSync(join(bob.box.config, 'occurrences.jsonl'), 'utf8').trim().split('\n').length, 1);
  // suggest: state.json moves to the shared location; one person's dismiss applies to the team.
  const sig = list(ann)[0].signature;
  const s = JSON.parse(ok(ann.box.call(['suggest', '--threshold', '3', '--json'])));
  assert.equal(s.suggestions.length, 1);
  assert.equal(JSON.parse(sharedRaw(remote, 'state.json')).issues[sig].suggestedCount, 3);
  assert.equal(list(bob)[0].status, 'suggested', "Bob sees Ann's suggestion");
  ok(bob.box.call(['dismiss', sig]));
  assert.ok(JSON.parse(sharedRaw(remote, 'state.json')).issues[sig].dismissedAt);
  assert.equal(list(ann)[0].status, 'dismissed', "Ann sees Bob's dismiss");
  for (let i = 0; i < 3; i++) ok(record(ann, `factory-docs stale fails in /home/annsmith/x${i}/README.md with exit ${i}`));
  assert.deepEqual(JSON.parse(ok(ann.box.call(['suggest', '--threshold', '3', '--json']))).suggestions, [], 'dismissed stays dismissed');
  const state = JSON.parse(sharedRaw(remote, 'state.json')).issues[sig];
  assert.equal(state.suggestedCount, 3);
  assert.ok(state.dismissedAt);
  // The factory still works on the branch, and its checkout brings the advisor's files along.
  const id = ann.factory(['new', 'After sharing']).split('\n')[0] as string;
  assert.match(id, /^001-/);
  assert.equal(existsSync(join(ann.project, 'factory', 'jobs', 'advisor', 'occurrences.jsonl')), true);
  ok(record(bob, 'factory-docs stale fails in /home/bobsmith/later/README.md with exit 9'));
  ann.factory(['note', id, 'still works after an advisor push']);
});

test('concurrent records from two users race for the branch; every occurrence lands once', async () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  const bob = user('Bob', shared(remote));
  ann.factory(['init']);
  const runs: Promise<number>[] = [];
  for (const u of [ann, bob, ann, bob]) {
    runs.push(
      new Promise((done) => {
        const p = spawn(process.execPath, [ADVISOR_CLI, 'record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', `parallel ${u.name} ${runs.length}`], { env: { ...u.box.env, PATH: process.env.PATH } as NodeJS.ProcessEnv, cwd: u.project, stdio: 'ignore' });
        p.on('close', (code) => done(code ?? 1));
      }),
    );
  }
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  // A record that lost every race leaves its occurrence queued; the next command pushes it.
  list(ann);
  list(bob);
  const ids = sharedLog(remote).map((o) => o.id);
  assert.equal(ids.length, 4, JSON.stringify(sharedLog(remote)));
  assert.equal(new Set(ids).size, 4);
  assert.equal(list(ann).reduce((n, i) => n + i.count, 0), 4);
});

/** The real git, for the wrapper below to run. */
function realGit(): string {
  for (const d of (process.env.PATH ?? '').split(':')) {
    if (d !== '' && existsSync(join(d, 'git'))) return join(d, 'git');
  }
  throw new Error('git not on PATH');
}

/**
 * A `git` first on PATH that holds every `git init` at a barrier until `n` of them have started (or
 * `waitMs` passed), so `n` processes of one user that all find no bare clone yet set it up at once,
 * every time. Everything else goes straight to the real git.
 */
function barrierGit(dir: string, n: number, waitMs: number): string {
  const bin = join(dir, 'barrier-bin');
  const marks = join(dir, 'barrier-marks');
  mkdirSync(bin, { recursive: true });
  mkdirSync(marks, { recursive: true });
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'init') {
  fs.writeFileSync(${JSON.stringify(marks)} + '/' + process.pid, '');
  const until = Date.now() + ${waitMs};
  while (fs.readdirSync(${JSON.stringify(marks)}).length < ${n} && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const p = spawnSync(${JSON.stringify(realGit())}, args, { stdio: 'inherit' });
process.exit(p.status ?? 1);
`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}

/** Every push to the remote takes `ms` longer, so pushes from different processes overlap. */
function slowPushes(remote: string, ms: number): void {
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!${process.execPath}\nrequire('node:fs').readFileSync(0);\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});\n`);
  chmodSync(hook, 0o755);
}

/** The ids of a user's own occurrences: their local log. */
const localIds = (u: User): string[] => readFileSync(join(u.box.config, 'occurrences.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);

/** The ids waiting in a user's queue. */
function queuedIds(u: User): string[] {
  const shared = join(u.box.config, 'shared');
  if (!existsSync(shared)) return [];
  return readdirSync(shared).flatMap((key) => {
    const q = join(shared, key, 'queue');
    return existsSync(q) ? readdirSync(q).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)) : [];
  });
}

function spawnAdvisor(u: User, env: NodeJS.ProcessEnv, args: string[], stdin?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [ADVISOR_CLI, ...args], { env, cwd: u.project, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.stdin.end(stdin ?? '');
    p.on('close', (code) => done({ code: code ?? 1, stderr }));
  });
}

test('concurrent records and hooks of one user and of two race for one bare clone, one queue and the branch; no occurrence is ever lost', async () => {
  const hook = readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8');
  const PER_USER = 4; // three records and one hook
  for (let round = 1; round <= 3; round++) {
    const { remote } = world();
    slowPushes(remote, 150);
    const ann = user('Ann', shared(remote));
    const bob = user('Bob', shared(remote));
    ann.factory(['init']);
    const runs: Array<Promise<{ code: number; stderr: string }>> = [];
    for (const u of [ann, bob]) {
      // Every process of this user reaches `git init` of its (missing) bare clone together.
      const env = { ...u.box.env, PATH: `${barrierGit(u.box.dir, PER_USER, 1500)}:${process.env.PATH}` } as NodeJS.ProcessEnv;
      for (let i = 0; i < PER_USER - 1; i++) runs.push(spawnAdvisor(u, env, ['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', `round ${round} ${u.name} ${i}`]));
      runs.push(spawnAdvisor(u, env, ['hook'], hook));
    }
    const results = await Promise.all(runs);
    assert.deepEqual(results.map((r) => r.code), Array(2 * PER_USER).fill(0), results.map((r) => r.stderr).join(''));
    const expected = [...localIds(ann), ...localIds(bob)];
    assert.equal(expected.length, 2 * PER_USER);
    // Right after the race: each occurrence is on the branch exactly once, or still in its owner's queue.
    const landed = sharedLog(remote).map((o) => o.id);
    assert.equal(new Set(landed).size, landed.length, `round ${round}: an occurrence landed twice`);
    const waiting = [...queuedIds(ann), ...queuedIds(bob)];
    for (const id of expected) assert.ok(landed.includes(id) || waiting.includes(id), `round ${round}: ${id} is neither on the branch nor queued`);
    for (const r of results) assert.doesNotMatch(r.stderr, /cannot queue/);
    // One more command each: every occurrence is on the branch exactly once, and the queues are empty.
    list(ann);
    list(bob);
    const after = sharedLog(remote).map((o) => o.id);
    assert.deepEqual([...after].sort(), [...expected].sort(), `round ${round}`);
    assert.deepEqual([...queuedIds(ann), ...queuedIds(bob)], []);
  }
});

test('a record or hook that cannot take the shared lock in time leaves its occurrence queued and exits 0 silently; a stale lock is taken over', async () => {
  const { remote } = world();
  const ann = user('Ann', shared(remote));
  ok(record(ann, 'first one creates the bare clone'));
  const [key] = readdirSync(join(ann.box.config, 'shared'));
  const lock = join(ann.box.config, 'shared', key as string, 'lock');
  // A live process holds the lock (this test's own pid): the commands wait a bounded time, then give up.
  writeFileSync(lock, `${process.pid}\n`);
  const env = { ...ann.box.env, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const started = Date.now();
  const [r, h] = await Promise.all([
    spawnAdvisor(ann, env, ['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', 'while locked']),
    spawnAdvisor(ann, env, ['hook'], readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8')),
  ]);
  assert.ok(Date.now() - started < 15_000, 'bounded wait');
  assert.deepEqual([r.code, r.stderr, h.code, h.stderr], [0, '', 0, '']);
  const ids = localIds(ann);
  assert.equal(ids.length, 3);
  assert.deepEqual(queuedIds(ann).sort(), ids.slice(1).sort(), 'both wait in the queue');
  assert.equal(sharedLog(remote).length, 1);
  // The holder died without releasing it: the next command takes the lock over and pushes the queue.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeFileSync(lock, `${dead}\n`);
  list(ann);
  assert.deepEqual(sharedLog(remote).map((o) => o.id).sort(), [...ids].sort());
  assert.deepEqual(queuedIds(ann), []);
  assert.equal(existsSync(lock), false, 'released');
});

test('the hook stays silent and queues locally when the remote is unreachable; the next command pushes the queue', () => {
  const { box: w, remote } = world();
  const missing = join(w.dir, 'not-yet.git');
  const ann = user('Ann', { remote: { url: missing, branch: BRANCH }, advisor: { share: true } });
  const hook = readFileSync(join(FIXTURES, 'hook-factory-refused.json'), 'utf8');
  assert.deepEqual(ann.box.call(['hook'], { stdin: hook }), { code: EXIT.ok, stdout: '', stderr: '' });
  const local = JSON.parse(readFileSync(join(ann.box.config, 'occurrences.jsonl'), 'utf8'));
  assert.equal(local.source, 'hook');
  const queueDir = join(ann.box.config, 'shared');
  const [key] = readdirSync(queueDir);
  assert.deepEqual(readdirSync(join(queueDir, key as string, 'queue')), [`${local.id}.json`]);
  // A CLI command says it could not reach the remote, and still works on the local log.
  const r = ann.box.call(['list']);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, /cannot reach the remote factory .*not-yet\.git .*occurrences wait in/);
  assert.match(r.stdout, /1x {2}factory/);
  // Back online (the remote now exists at that path): the next command pushes the queue, once.
  renameSync(remote, missing);
  const again = ann.box.call(['list', '--json']);
  assert.equal(again.stderr, '');
  assert.equal(JSON.parse(again.stdout).issues[0].count, 1);
  const pushed = spawnSync('git', ['--git-dir', missing, 'show', `${BRANCH}:advisor/occurrences.jsonl`], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(pushed, [local]);
  assert.deepEqual(readdirSync(join(queueDir, key as string, 'queue')), []);
  // The exact hook command (hooks/hooks.json) also prints nothing and exits 0 while unreachable.
  const offline = { ...ann.box.env, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  writeFileSync(join(ann.project, 'factory.json'), `${JSON.stringify({ remote: { url: join(w.dir, 'gone.git'), branch: BRANCH }, advisor: { share: true } })}\n`);
  const p = spawnSync(process.execPath, [ADVISOR_CLI, 'hook'], { input: hook, env: offline, encoding: 'utf8' });
  assert.deepEqual([p.status, p.stdout, p.stderr], [0, '', '']);
});

test('a dismiss made while offline is kept locally and pushed by the next command that reaches the remote', () => {
  const { box: w, remote } = world();
  const ann = user('Ann', shared(remote));
  const bob = user('Bob', shared(remote));
  ok(record(ann, 'docs gate fails on a fresh clone'));
  const sig = list(ann)[0].signature;
  const away = join(w.dir, 'away.git');
  renameSync(remote, away);
  const r = ann.box.call(['dismiss', sig]);
  assert.equal(r.code, EXIT.ok);
  assert.match(r.stderr, /the state change is saved locally/);
  assert.equal(list(ann)[0].status, 'dismissed');
  renameSync(away, remote);
  assert.equal(list(bob)[0].status, 'open', 'not pushed yet');
  list(ann);
  assert.equal(list(bob)[0].status, 'dismissed');
});

// ------------------------------------------------------------------ 4. the public-remote warning

test('record and suggest warn once per session about a remote that is or may be public; never offline-fatal', () => {
  const { box: w } = world();
  // No network in tests: git may not use https at all, so the remote is unreachable (as offline).
  const ann = user('Ann', { remote: { url: 'https://ann:tok3n@github.com/org/project-factory.git', branch: BRANCH }, advisor: { share: true } }, { GIT_ALLOW_PROTOCOL: 'file', CLAUDE_CODE_SESSION_ID: 'session-1' });
  const first = record(ann, 'docs gate fails on a fresh clone');
  assert.equal(first.code, EXIT.ok);
  const warnings = (s: string): string[] => s.split('\n').filter((l) => l.includes('warning: sharing'));
  assert.deepEqual(warnings(first.stderr), ['factory-plugin-advisor: warning: sharing the redacted friction log on github.com, which hosts public repositories (factory.json advisor.share); if that repository is public, anyone can read the shared occurrences']);
  assert.equal(first.stderr.includes('tok3n'), false, 'credentials are never printed');
  assert.deepEqual(warnings(record(ann, 'docs gate fails again').stderr), [], 'once per session');
  assert.deepEqual(warnings(ann.box.call(['suggest']).stderr), []);
  assert.deepEqual(warnings(ann.box.call(['list']).stderr), [], 'list never warns');
  ann.box.env.CLAUDE_CODE_SESSION_ID = 'session-2';
  assert.equal(warnings(ann.box.call(['suggest']).stderr).length, 1, 'a new session warns again');
  // Outside a Claude Code session every run is its own session.
  delete ann.box.env.CLAUDE_CODE_SESSION_ID;
  assert.equal(warnings(record(ann, 'x happened').stderr).length, 1);
  assert.equal(warnings(record(ann, 'x happened').stderr).length, 1);
  // A local path remote: no warning.
  const bob = user('Bob', shared(join(w.dir, 'state.git')));
  assert.deepEqual(warnings(record(bob, 'docs gate fails on a fresh clone').stderr), []);
});

test('how the warning decides: no network, local paths and private hosts are quiet, public or unknown hosts warn', () => {
  const cfg = (url: string): ShareConfig => ({ url, branch: BRANCH, configPath: '/x/factory.json' });
  for (const url of ['/srv/git/state.git', './state.git', '../s.git', 'file:///srv/state.git', 'C:\\repos\\s.git', 'git@gitserver:team/state.git', 'ssh://git@git.corp/x.git', 'https://10.0.0.5/x.git', 'https://192.168.1.2/x.git', 'https://git.internal/x.git', 'http://localhost:3000/x.git']) {
    assert.equal(publicWarning(cfg(url)), null, url);
  }
  for (const url of ['git@github.com:org/x.git', 'https://github.com/org/x.git', 'ssh://git@gitlab.com/org/x.git', 'https://user:pw@bitbucket.org/o/x.git', 'git@codeberg.org:o/x.git']) {
    assert.match(publicWarning(cfg(url)) ?? '', /which hosts public repositories/, url);
  }
  for (const url of ['https://git.example.com/x.git', 'git@git.example.org:o/x.git']) {
    assert.match(publicWarning(cfg(url)) ?? '', /which the advisor cannot tell is private/, url);
  }
  assert.equal(remoteHost('git@github.com:org/x.git'), 'github.com');
  assert.equal(remoteHost('/abs/path'), null);
  assert.equal(privateHost('172.20.1.1'), true);
  assert.equal(privateHost('172.32.1.1'), false);
  assert.equal(displayUrl('https://u:secret@github.com/o/x.git'), 'https://github.com/o/x.git');
});

// ------------------------------------------------------------------ untrusted shared content

test('shared lines and state are validated: unknown fields, control characters and bad shapes are dropped', () => {
  const good = { signature: '0123456789ab', plugin: 'factory', kind: 'workaround', summary: 'ok', at: '2026-11-01T10:00:00.000Z', source: 'record', id: '0123456789abcdef' };
  assert.deepEqual(sharedOccurrence(good), good);
  for (const bad of [{ ...good, id: undefined }, { ...good, summary: 'a\u001b[31mred' }, { ...good, extra: 1 }, { ...good, by: 'x@y.com' }, { ...good, kind: 'other' }, { ...good, signature: '../../etc' }]) {
    assert.equal(sharedOccurrence(JSON.parse(JSON.stringify(bad))), null, JSON.stringify(bad));
  }
  const merged = mergeState(
    { version: 1, issues: { '0123456789ab': { suggestedCount: 3, suggestedAt: '2026-11-01T10:00:00.000Z' } } },
    { version: 1, issues: { '0123456789ab': { suggestedCount: 2, dismissedAt: '2026-11-02T10:00:00.000Z' } } },
  );
  assert.deepEqual(merged.issues['0123456789ab'], { suggestedCount: 3, suggestedAt: '2026-11-01T10:00:00.000Z', dismissedAt: '2026-11-02T10:00:00.000Z' });
});
