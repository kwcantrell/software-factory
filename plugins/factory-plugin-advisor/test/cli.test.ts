// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step), with the log in a
// scratch config dir and a fake gh on PATH (the real one is never run). Also runs the hook command
// exactly as hooks/hooks.json declares it, from the fresh copy.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeGh } from './helpers.ts';
import { APPROVED, type JobSpec, writeLine } from './stations-fixtures.ts';

const CLI_NAME = 'factory-plugin-advisor';
const SKILL = 'skills/factory-plugin-advisor/SKILL.md';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
const ISSUE_URL = 'https://github.com/kwcantrell/software-factory/issues/1';

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
// The factory plugin next to it, as the marketplace installs both: `stations` reads its templates
// and runs its CLI.
cpSync(join(source, '..', 'factory'), join(scratch, 'plugin-cache', 'factory'), { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);
const config = join(scratch, 'config', 'factory-plugin-advisor');
const ghBin = fakeGh(scratch, `console.log(${JSON.stringify(ISSUE_URL)});`);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.FACTORY_PLUGIN_ADVISOR_CONFIG_DIR = config;
env.HOME = join(scratch, 'home');
env.PATH = `${ghBin}:${process.env.PATH ?? ''}`;
// A repository whose factory line has history enough for two station suggestions (rules a and d).
const lineRepo = join(scratch, 'line-repo');
const perf = (id: string): JobSpec => ({ id, events: APPROVED(), followups: [['builder', 'The job list is slow.']], proof: 'PASS' });
const unmet = (id: string): JobSpec => ({
  id,
  events: ['created', 'building', 'awaiting independent proof', 'proof passed', 'review round 1 opened', 'round 1: security -> approve', 'round 1: standards -> approve', 'round 1: behavior -> changes'],
  blocking: { '1-behavior': '1. Criterion 2 is not met.' },
  proof: 'PASS',
});
writeLine(join(lineRepo, 'factory'), [perf('001-a'), perf('002-b'), perf('003-c'), unmet('004-d'), unmet('005-e'), unmet('006-f')]);
env.FACTORY_DIR = join(lineRepo, 'factory');

function skillText(): string {
  return readFileSync(join(pluginRoot, SKILL), 'utf8');
}

function skillCommands(): string[] {
  const blocks = [...skillText().matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((b) => b.split('\n')).map((l) => l.trim()).filter((line) => line.startsWith('npx '));
}

// A repository whose factory.json turns on sharing with a remote factory, for the skill's `share`
// lines (which only read factory.json and write the acknowledgement; no git runs for them).
const shareRepo = join(scratch, 'share-repo');
const shareRemote = join(scratch, 'state.git');
mkdirSync(shareRepo);
spawnSync('git', ['init', '-q', '-b', 'main', shareRepo]);
writeFileSync(join(shareRepo, 'factory.json'), `${JSON.stringify({ remote: { url: shareRemote, branch: 'factory-state' }, advisor: { share: true } })}\n`);
const shareEnv: NodeJS.ProcessEnv = { ...env, FACTORY_DIR: join(shareRepo, 'factory') };

function sh(command: string, input?: string, shellEnv: NodeJS.ProcessEnv = env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env: shellEnv, encoding: 'utf8', timeout: 60_000, ...(input === undefined ? {} : { input }) });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const VALUES: Record<string, string> = {
  path: shareRepo,
  url: shareRemote,
  branch: 'factory-state',
  plugin: 'factory-docs',
  kind: 'workaround',
  summary: 'factory-docs stale needed a second run after 2 changed files',
  detail: 'retried once; worked',
};

/** Fills a skill line's `<placeholder>` values. */
function fill(command: string, signature: string): string {
  return command.replace(/<([a-z]+)>/g, (m, name: string) => (name === 'signature' ? signature : (VALUES[name] ?? m)));
}

test('the skill calls the CLI only through the shared npx invocation', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 8, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  for (const command of ['record', 'list', 'show', 'suggest', 'file', 'dismiss', '--help', 'stations', 'stations suggest', 'stations apply', 'stations dismiss', 'share list', 'share allow', 'share revoke']) {
    assert.ok(commands.some((c) => c.startsWith(`${INVOCATION} ${command}`)), `the skill runs ${command}`);
  }
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('allowed-tools pre-approves record, list, show, suggest, --help, stations, stations suggest and share list, and never file, dismiss, stations apply, share allow or share revoke', () => {
  const line = /^allowed-tools: (.*)$/m.exec(skillText())?.[1] ?? '';
  const rules = [...line.matchAll(/Bash\(([^)]*)\)/g)].map((m) => m[1] ?? '');
  assert.deepEqual(rules, [
    ...['record', 'list', 'show', 'suggest', '--help'].map((c) => `${INVOCATION} ${c}:*`),
    `${INVOCATION} stations --json`,
    `${INVOCATION} stations suggest:*`,
    `${INVOCATION} share list:*`,
  ]);
  // No rule matches a stations apply or dismiss line (a `:*` rule is a prefix, the others exact).
  const allows = (cmd: string): boolean => rules.some((r) => (r.endsWith(':*') ? cmd.startsWith(r.slice(0, -2)) : cmd === r));
  for (const cmd of ['stations apply 0123456789ab --confirm --json', 'stations dismiss 0123456789ab --json', 'stations --repo /x apply', 'file abcd --confirm', 'dismiss abcd', 'share allow --json', 'share allow --repo /x --json', 'share revoke /x.git factory-state --json', 'share --repo /x allow']) {
    assert.equal(allows(`${INVOCATION} ${cmd}`), false, cmd);
  }
  assert.equal(allows(`${INVOCATION} stations suggest --json`), true);
  assert.equal(allows(`${INVOCATION} share list --json`), true);
});

test('every skill command line runs from a fresh copy, in order, and exits 0', () => {
  // One earlier occurrence, so the skill's two record lines bring the issue to the threshold (3).
  const seed = sh(`${INVOCATION} record --plugin factory-docs --kind workaround --summary "factory-docs stale needed a second run after 7 changed files" --json`);
  assert.equal(seed.status, 0, seed.stderr);
  const signature: string = JSON.parse(seed.stdout).signature;
  let ids: string[] = [];
  for (const line of skillCommands()) {
    // A station suggestion's <id>: the first one is applied, the second dismissed.
    const command = fill(line, signature).replace('<id>', line.includes(' stations dismiss ') ? (ids[1] ?? '<id>') : (ids[0] ?? '<id>'));
    // The share lines run against a repository whose factory.json turns sharing on.
    const { status, stdout, stderr } = sh(command, undefined, command.includes(' share ') ? shareEnv : env);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) {
      const value = JSON.parse(stdout);
      if (command.includes(' suggest ') && !command.includes(' stations ')) assert.equal(value.suggestions[0]?.signature, signature);
      if (command.includes(' file ') && !command.includes('--confirm')) assert.equal(value.dryRun, true);
      if (command.includes(' file ') && command.includes('--confirm')) assert.equal(value.url, ISSUE_URL);
      if (command.includes(' dismiss ')) assert.equal(value.dismissed, true);
      if (command.includes(' stations --json')) assert.equal(value.jobs, 6);
      if (command.includes(' stations suggest ')) ids = value.suggestions.map((s: { id: string }) => s.id);
      if (command.includes(' stations apply ')) assert.equal(value.applied, command.includes('--confirm'));
      if (command.includes(' share allow ')) assert.deepEqual([value.url, value.branch], [shareRemote, 'factory-state']);
      if (command.includes(' share revoke ')) assert.deepEqual(value.removed.map((r: { url: string }) => r.url), [shareRemote]);
    }
  }
  assert.equal(ids.length, 2);
  assert.ok(existsSync(join(lineRepo, '.claude', 'agents', 'factory-reviewer-performance.md')));
  // The fake gh was called exactly once, by the --confirm line, with the body on stdin.
  const calls = readFileSync(join(scratch, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[3], 'kwcantrell/software-factory');
  assert.match(calls[0].stdin, /## Proposed change/);
});

test('the hook command from hooks/hooks.json records a failed marketplace CLI call from the fresh copy', () => {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const handler = hooks.hooks.PostToolUseFailure[0].hooks[0];
  const args: string[] = handler.args.map((a: string) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
  const fixture = readFileSync(join(pluginRoot, 'test', 'fixtures', 'hook-npx-failure.json'), 'utf8');
  const r = spawnSync(handler.command, args, { cwd, env, input: fixture, encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  const list = sh(`${INVOCATION} list --plugin factory-docs --json`);
  const issues: Array<{ kind: string; summary: string }> = JSON.parse(list.stdout).issues;
  assert.ok(issues.some((i) => i.kind === 'cli-failure' && i.summary.startsWith('factory-docs which exited 1:')), list.stdout);
});

test('an unknown command through npx exits 2 with the message on stderr', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} no-such-command`);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown command 'no-such-command'/);
});

// Guard against `--package=""`: npm reads an empty spec as the registry package `undefined` (owned by a
// third party), and `--yes` would install and run it unprompted. `--offline` in the invocation must
// stop that before any request, even when npm itself is allowed online.
test('with CLAUDE_PLUGIN_ROOT empty, the invocation fails without contacting a registry', async () => {
  const requests: string[] = [];
  const registry = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = registry.address() as AddressInfo;
    const onlineEnv: NodeJS.ProcessEnv = {
      ...env,
      CLAUDE_PLUGIN_ROOT: '',
      npm_config_cache: join(scratch, 'npm-cache-empty-root'),
      npm_config_registry: `http://127.0.0.1:${port}/`,
      // npm's own version check also uses the registry; it is not what this test is about.
      npm_config_update_notifier: 'false',
    };
    delete onlineEnv.npm_config_offline;
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd, env: onlineEnv });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.resume();
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.notEqual(status, 0);
    assert.equal(stdout, '');
    assert.deepEqual(requests, [], 'npx contacted the registry');
  } finally {
    registry.close();
  }
});
