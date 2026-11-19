// End to end: runs the exact npx command lines from the skill, the way Claude Code would after installing
// the plugin (a fresh copy, no npm install or build step), from inside a fixture git
// checkout with a doc map in a temp dir that is unrelated to the plugin's folder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanEnv, fixture, PLUGIN } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const CLI_NAME = 'factory-docs';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
// Every command is read-only; each is pre-approved by name.
const ALLOWED_TOOLS = `allowed-tools: ${['which', 'stale', 'lint', 'gate', '--help'].map((c) => `Bash(${INVOCATION} ${c}:*)`).join(', ')}`;

// Skill command lines name their arguments as placeholders; the test fills them in.
const PLACEHOLDERS: Record<string, string> = { '<path>': 'src/run.ts' };

const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`)));
const fixtures: Fixture[] = [];
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  fixtures.forEach((f) => f.cleanup());
});

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder (path with a space).
const pluginRoot = join(scratch, 'plugin cache', CLI_NAME);
cpSync(PLUGIN, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const env = cleanEnv();
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';

const skills = readdirSync(join(pluginRoot, 'skills'));

function skillText(skill: string): string {
  return readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
}

function skillCommands(skill: string): string[] {
  const blocks = [...skillText(skill).matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((b) => b.split('\n')).map((line) => line.trim()).filter((line) => line.startsWith('npx '));
}

function fill(command: string): string {
  let out = command;
  for (const [placeholder, value] of Object.entries(PLACEHOLDERS)) out = out.replaceAll(placeholder, value);
  assert.doesNotMatch(out, /<[a-z-]+>/, `unknown placeholder in: ${command}`);
  return out;
}

function sh(command: string, cwd: string, shellEnv: NodeJS.ProcessEnv = env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, env: shellEnv, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function checkout(): Fixture {
  const f = fixture();
  fixtures.push(f);
  return f;
}

test('there is the one skill; it calls the CLI only through the shared npx invocation and pre-approves its read-only commands', () => {
  assert.deepEqual(skills, ['factory-docs']);
  const text = skillText('factory-docs');
  assert.match(text, /^---\nname: factory-docs\n/);
  assert.ok(text.includes(`\n${ALLOWED_TOOLS}\n`), 'allowed-tools');
  const commands = skillCommands('factory-docs');
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  // Every npx line in the skill is inside a sh block, so the test below runs all of them.
  const allNpxLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('npx '));
  assert.deepEqual(allNpxLines, commands);
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('the skill: stale, gate, which <path>, lint and --help all exit 0 in order from a fresh copy', () => {
  const f = checkout();
  const commands = skillCommands('factory-docs');
  assert.deepEqual(commands.map((c) => c.slice(INVOCATION.length + 1).split(' ')[0]), ['stale', 'gate', 'which', 'lint', '--help']);
  const cwd = join(f.root, 'plugins', 'demo'); // anywhere inside the checkout
  for (const command of commands.map(fill)) {
    const { status, stdout, stderr } = sh(command, cwd);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    if (command.endsWith(' stale')) assert.match(stdout, /^no stale docs: 0 changed file\(s\) against main /);
    if (command.endsWith(' gate')) assert.match(stdout, /\ngate passed\n$/);
    if (command.includes(' which ')) assert.equal(stdout, 'plugins/demo/src/run.ts: CHANGELOG.md, plugins/demo/README.md, plugins/demo/skills/demo/SKILL.md\n');
    if (command.endsWith(' lint')) assert.match(stdout, /^doc map ok: 5 doc\(s\)/);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  }
});

test('npx --package=<copy without node_modules> -- factory-docs --help exits 0 from a temp dir', () => {
  const cwd = join(scratch, 'unrelated-cwd');
  mkdirSync(cwd, { recursive: true });
  const r = spawnSync('npx', ['--yes', '--offline', `--package=${pluginRoot}`, '--', CLI_NAME, '--help'], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Usage: ${CLI_NAME} `));
});

test('stale and gate through npx: a stale doc exits 1, stdout empty, the doc named on stderr', () => {
  const f = checkout();
  f.write('src/a.ts', 'export const a = 2;\n');
  for (const command of ['stale', 'gate']) {
    const { status, stdout, stderr } = sh(`${INVOCATION} ${command}`, f.root);
    assert.equal(status, 1, command);
    assert.equal(stdout, '');
    assert.match(stderr, /^README\.md: not changed, but it covers changed file\(s\): src\/a\.ts /m);
  }
});

test('lint through npx: a problem exits 1 with one line per problem on stderr', () => {
  const f = checkout();
  f.write('extra.md', '# unmapped\n');
  const { status, stdout, stderr } = sh(`${INVOCATION} lint`, f.root);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^extra\.md: markdown file is not in docs\/docs-map\.json - fix: /m);
});

test('outside a git checkout with a map, through npx: exit 2 with the message on stderr', () => {
  const cwd = join(scratch, 'unrelated-cwd');
  mkdirSync(cwd, { recursive: true });
  const { status, stdout, stderr } = sh(`${INVOCATION} gate`, cwd);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^factory-docs: not inside a git checkout/);
});

test('an unknown command through npx exits 2 with the message on stderr', () => {
  const { status, stdout, stderr } = sh(`${INVOCATION} no-such-command`, scratch);
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
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd: scratch, env: onlineEnv });
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
