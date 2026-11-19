// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, unrelated cwd, no npm install or build step), against a
// fixture Claude Code config dir, a scratch factory-plugin-discover config dir and a fake `claude` on PATH
// (the real one is never run). Also runs the hook command exactly as hooks/hooks.json declares it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIXTURES, fakeClaude, sandbox } from './helpers.ts';

const CLI_NAME = 'factory-plugin-discover';
const SKILL = 'skills/factory-plugin-discover/SKILL.md';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
// Claude Code's records come from the fixtures (never the real ~/.claude), and `claude` is a fake.
const fixture = sandbox();
after(fixture.cleanup);
env.CLAUDE_CONFIG_DIR = fixture.claudeDir;
env.FACTORY_PLUGIN_DISCOVER_CONFIG_DIR = join(scratch, 'config', 'factory-plugin-discover');
env.HOME = join(scratch, 'home');
env.PATH = `${fakeClaude(scratch)}:${process.env.PATH ?? ''}`;

function skillCommands(): string[] {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((b) => b.split('\n')).map((l) => l.trim()).filter((line) => line.startsWith('npx '));
}

function sh(command: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8', timeout: 60_000, input: input ?? '' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const VALUES: Record<string, string> = { 'one-line task summary': 'are the docs stale', name: 'factory-docs', mode: 'ask' };

/** Fills a skill line's `<placeholder>` values. */
function fill(command: string): string {
  return command.replace(/<([a-z -]+)>/g, (m, name: string) => VALUES[name] ?? m);
}

function claudeCalls(): string[][] {
  const file = join(scratch, 'claude-calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv) : [];
}

test('the skill calls the CLI only through the shared npx invocation', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 2, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('allowed-tools pre-approves only match, catalog and --help: never install or settings', () => {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const line = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? '';
  const rules = [...line.matchAll(/Bash\((.*?):\*\)/g)].map((m) => m[1] ?? '');
  assert.deepEqual(rules, ['match', 'catalog', '--help'].map((c) => `${INVOCATION} ${c}`));
});

test('every skill command line runs from a fresh copy, in order, and exits 0', () => {
  const commands = skillCommands();
  for (const c of ['match', 'install', 'settings', 'catalog', '--help']) {
    assert.ok(commands.some((l) => l.startsWith(`${INVOCATION} ${c}`)), `the skill runs ${c}`);
  }
  for (const line of commands) {
    const command = fill(line);
    // The install line without --confirmed is the auto-install mode's; the one with it is ask mode's.
    const auto = command.includes(' install ') && !command.includes('--confirmed');
    sh(`${INVOCATION} settings set mode ${auto ? 'auto-install' : 'ask'}`);
    const { status, stdout, stderr } = sh(command);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (!command.includes(' --json')) continue;
    const value = JSON.parse(stdout);
    if (command.includes(' match ')) {
      assert.equal(value.available[0].name, 'factory-docs');
      assert.equal(value.mode, 'ask');
    }
    if (command.includes(' install ')) assert.deepEqual([value.installed, value.mode], [true, auto ? 'auto-install' : 'ask']);
    if (command.includes(' catalog ')) assert.ok(value.installed.some((p: { name: string }) => p.name === 'factory'));
    if (command.includes(' settings ')) assert.equal(value.mode, 'ask');
  }
  // The fake claude ran once per install line, with exactly the marketplace install command.
  assert.deepEqual(claudeCalls(), [
    ['plugin', 'install', 'factory-docs@software-factory'],
    ['plugin', 'install', 'factory-docs@software-factory'],
  ]);
});

test('install through npx in ask mode without --confirmed exits 1 and runs nothing', () => {
  const before = claudeCalls().length;
  sh(`${INVOCATION} settings set mode ask`);
  const { status, stdout, stderr } = sh(`${INVOCATION} install factory-docs --json`);
  assert.deepEqual([status, stdout], [1, '']);
  assert.match(stderr, /^factory-plugin-discover: mode is ask: ask the user first/);
  assert.equal(claudeCalls().length, before);
});

test('match through npx reports none_applicable with the factory-plugin-advisor record command', () => {
  const { status, stdout } = sh(`${INVOCATION} match "fix a flaky react component test" --json`);
  assert.equal(status, 0);
  const value = JSON.parse(stdout);
  assert.equal(value.none_applicable, true);
  assert.match(value.advisor.record, / -- factory-plugin-advisor record --plugin none --kind missing-guidance --summary /);
});

test('the hook command from hooks/hooks.json adds the hint once per session from the fresh copy', () => {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  const handler = hooks.hooks.UserPromptSubmit[0].hooks[0];
  const args: string[] = handler.args.map((a: string) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
  const input = readFileSync(join(FIXTURES, 'hooks', 'prompt-slash-command.json'), 'utf8');
  const hook = (stdin: string): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(handler.command, args, { cwd, env, input: stdin, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const first = hook(input);
  assert.deepEqual([first.status, first.stderr], [0, '']);
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /run its `match` command/);
  assert.deepEqual(hook(input), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(hook(readFileSync(join(FIXTURES, 'hooks', 'prompt-unrelated.json'), 'utf8')), { status: 0, stdout: '', stderr: '' });
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
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd, env: onlineEnv, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
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
