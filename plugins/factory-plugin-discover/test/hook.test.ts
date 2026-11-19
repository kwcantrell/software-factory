// The UserPromptSubmit hook, fed recorded hook inputs (test/fixtures/hooks/*.json, in Claude Code's
// UserPromptSubmit input format) with the cwd rewritten per case.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HINT, hookOutput, originUrl, promptMatches } from '../src/hook.ts';
import { FIXTURES, PLUGIN_ROOT, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

function fixture(name: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURES, 'hooks', `${name}.json`), 'utf8')), ...changes });
}

const HINT_LINE = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: HINT } })}\n`;
let n = 0;
/** A fresh session id per call, so the once-per-session rule does not hide a hint. */
const fresh = (): string => `session-${++n}`;
const TRIGGERS = ['prompt-slash-command', 'prompt-software-factory', 'prompt-cli-command', 'prompt-plugin-name'];

test('the hint is one short line telling Claude to run match first', () => {
  assert.ok(!HINT.includes('\n'));
  assert.ok(HINT.length < 300);
  assert.match(HINT, /factory-plugin-discover/);
  assert.match(HINT, /`match`/);
});

test('recorded software-factory prompts get the additionalContext hint, from an unrelated cwd', () => {
  for (const name of TRIGGERS) {
    assert.equal(hookOutput(fixture(name, { cwd: s.cwd, session_id: fresh() }), s.env), HINT_LINE, name);
  }
});

test('an unrelated prompt in an unrelated cwd, and other events, add nothing', () => {
  assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: s.cwd, session_id: fresh() }), s.env), '');
  assert.equal(hookOutput(fixture('other-event'), s.env), '');
  assert.equal(hookOutput(fixture('prompt-slash-command', { hook_event_name: 'PostToolUse' }), s.env), '');
  for (const raw of ['', 'not json', '{"hook_event_name":"UserPromptSubmit"', '[]', '"UserPromptSubmit"']) assert.equal(hookOutput(raw, s.env), '', raw);
});

test('at most once per session, remembered in the plugin config dir (owner-only), last 200', () => {
  const t = sandbox();
  try {
    const first = fixture('prompt-slash-command', { session_id: 'abc' });
    assert.equal(hookOutput(first, t.env), HINT_LINE);
    assert.equal(hookOutput(first, t.env), '');
    assert.equal(hookOutput(fixture('prompt-plugin-name', { session_id: 'abc' }), t.env), '');
    assert.equal(hookOutput(fixture('prompt-plugin-name', { session_id: 'def' }), t.env), HINT_LINE);
    const file = join(t.configDir, 'hinted-sessions.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { sessions: ['abc', 'def'] });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(t.configDir).mode & 0o777, 0o700);
    // An unrelated prompt does not use up the session's hint.
    assert.equal(hookOutput(fixture('prompt-unrelated', { cwd: t.cwd, session_id: 'ghi' }), t.env), '');
    assert.equal(hookOutput(fixture('prompt-software-factory', { session_id: 'ghi' }), t.env), HINT_LINE);
    // Only the last 200 sessions are kept: the oldest is forgotten (and would be hinted again).
    for (let i = 0; i < 200; i++) hookOutput(fixture('prompt-cli-command', { session_id: `bulk-${i}` }), t.env);
    const kept = JSON.parse(readFileSync(file, 'utf8')).sessions as string[];
    assert.equal(kept.length, 200);
    assert.deepEqual([kept[0], kept.at(-1)], ['bulk-0', 'bulk-199']);
    assert.equal(hookOutput(first, t.env), HINT_LINE);
  } finally {
    t.cleanup();
  }
});

test('when the session cannot be remembered, no hint (rather than one on every prompt)', () => {
  const blocker = join(s.dir, 'a-file');
  writeFileSync(blocker, '');
  assert.equal(hookOutput(fixture('prompt-slash-command', { session_id: fresh() }), { ...s.env, FACTORY_PLUGIN_DISCOVER_CONFIG_DIR: join(blocker, 'cfg') }), '');
});

function repo(name: string, config: string): string {
  const root = join(s.dir, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), config);
  return root;
}

const origin = (url: string): string => `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = https://example.com/x/y.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

/** A linked worktree (a `.git` file) of `main`, at `<dir>/<name>`. */
function worktree(main: string, name: string): string {
  const gitdir = join(main, '.git', 'worktrees', name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  const wt = join(s.dir, name);
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
  return wt;
}

const hinted = (cwd: string): boolean => hookOutput(fixture('prompt-unrelated', { cwd, session_id: fresh() }), s.env) === HINT_LINE;

test('a cwd inside a software-factory checkout gets the hint, even for an unrelated prompt', () => {
  const ssh = repo('sf-ssh', origin('git@github.com:kwcantrell/software-factory.git'));
  const https = repo('sf-https', origin('https://github.com/kwcantrell/software-factory'));
  for (const cwd of [ssh, join(ssh, 'src', 'deep'), https]) assert.ok(hinted(cwd), cwd);
});

test('a linked worktree (.git file) of a software-factory checkout counts', () => {
  const main = repo('sf-main', origin('https://github.com/kwcantrell/software-factory.git'));
  assert.ok(hinted(join(worktree(main, 'sf-wt'), 'src')));
});

test('a checkout without that origin is recognised by its software-factory manifest; other repos are not', () => {
  const fork = repo('fork', origin('https://github.com/someone/fork.git'));
  assert.equal(hinted(fork), false);
  mkdirSync(join(fork, '.claude-plugin'));
  writeFileSync(join(fork, '.claude-plugin', 'marketplace.json'), '{"name": "software-factory", "plugins": []}');
  assert.ok(hinted(fork));
  const other = repo('other-market', origin('https://github.com/someone/other.git'));
  mkdirSync(join(other, '.claude-plugin'));
  writeFileSync(join(other, '.claude-plugin', 'marketplace.json'), '{"name": "other", "plugins": [{"name": "software-factory"}]}');
  assert.equal(hinted(other), false);
  const lookalike = repo('lookalike', origin('https://github.com/kwcantrell/software-factory-docs.git'));
  assert.equal(hinted(lookalike), false);
  assert.equal(hinted(repo('plain', origin('https://github.com/someone/app.git'))), false);
});

test('a repo that uses the factory (factory.json, or factory/jobs/) gets the hint, linked worktrees included', () => {
  const json = repo('uses-json', origin('https://github.com/someone/app.git'));
  writeFileSync(join(json, 'factory.json'), '{}');
  assert.ok(hinted(join(json, 'src', 'deep')));
  const jobs = repo('uses-jobs', origin('https://github.com/someone/app2.git'));
  mkdirSync(join(jobs, 'factory', 'jobs'), { recursive: true });
  assert.ok(hinted(jobs));
  // A factory job's worktree: its main checkout holds factory/jobs/.
  assert.ok(hinted(worktree(jobs, 'uses-jobs-wt')));
  // A `factory/` folder without jobs/ (say, a code package named factory) is not the factory.
  const pkg = repo('factory-package', origin('https://github.com/someone/app3.git'));
  mkdirSync(join(pkg, 'factory', 'widgets'), { recursive: true });
  assert.equal(hinted(pkg), false);
  // Outside any git checkout, a factory.json alone does not count.
  const loose = join(s.dir, 'loose');
  mkdirSync(loose, { recursive: true });
  writeFileSync(join(loose, 'factory.json'), '{}');
  assert.equal(hinted(loose), false);
});

test('originUrl reads only the origin remote', () => {
  assert.equal(originUrl(origin('git@github.com:kwcantrell/software-factory.git')), 'git@github.com:kwcantrell/software-factory.git');
  assert.equal(originUrl('[remote "upstream"]\n\turl = x\n'), undefined);
});

test('the keyword list: software-factory words fire, generic ones do not', () => {
  for (const p of [
    '/factory:run add a toggle',
    'then /factory:ship it',
    'How does the Software Factory work?',
    'clone software-factory first',
    'factory followup list is empty',
    'factory status shows nothing',
    'why did factory verdict refuse',
    'factory merge 004 failed',
    'run `factory new "title"`',
    'npx ... -- factory path 004',
    'add a key to factory.json',
    'look under factory/jobs/004',
    'factory-dev check fails',
    'factory-docs stale lists README',
    'factory-plugin-builder check finds nothing',
    'factory-plugin-advisor suggest',
    'install factory-plugin-discover',
  ]) {
    assert.equal(promptMatches(p), true, p);
  }
  for (const p of [
    'refactor the widget factory',
    'add a factory method to the parser',
    'use the abstract factory pattern',
    'the factory new widgets arrive monday',
    'review and merge the release docs for the build job',
    'my plugin crashes in the worktree',
    'the dashboard shows a spec gate',
    'https://example.com/factory:8080',
    'cut a release and update the changelog',
  ]) {
    assert.equal(promptMatches(p), false, p);
  }
});

test('hooks.json runs `node <root>/src/cli.ts hook` on UserPromptSubmit, synchronously, with a 5 s timeout', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['UserPromptSubmit']);
  const handler = hooks.hooks.UserPromptSubmit[0].hooks[0];
  assert.deepEqual(handler, { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/cli.ts', 'hook'], timeout: 5 });
});

test('the hook process exits 0 and prints the hint or nothing, never blocking', () => {
  const env = { ...process.env, ...s.env } as NodeJS.ProcessEnv;
  const runHook = (input: string, extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'src', 'cli.ts'), 'hook'], { cwd: s.cwd, env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  assert.deepEqual(runHook(fixture('prompt-slash-command', { session_id: fresh() })), { status: 0, stdout: HINT_LINE, stderr: '' });
  assert.deepEqual(runHook(fixture('prompt-unrelated', { cwd: s.cwd, session_id: fresh() })), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(runHook('garbage'), { status: 0, stdout: '', stderr: '' });
  // An unwritable config dir: no hint, no error output, exit 0.
  const blocker = join(s.dir, 'another-file');
  writeFileSync(blocker, '');
  assert.deepEqual(runHook(fixture('prompt-slash-command', { session_id: fresh() }), { FACTORY_PLUGIN_DISCOVER_CONFIG_DIR: join(blocker, 'cfg') }), { status: 0, stdout: '', stderr: '' });
  const out = JSON.parse(runHook(fixture('prompt-cli-command', { session_id: fresh() })).stdout);
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});
