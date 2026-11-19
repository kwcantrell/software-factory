// End to end: runs the exact npx command lines from every skill, the way Claude Code would after
// installing the plugin (a fresh copy, no npm install or build step), from inside a fixture
// software-factory checkout in a temp dir that is unrelated to the plugin's folder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanEnv, fixture, withFakeClaude } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const CLI_NAME = 'factory-plugin-builder';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;
// check, verify and --help run unprompted; new writes into the checkout, so it asks.
const ALLOWED_TOOLS = `allowed-tools: ${['check', 'verify', '--help'].map((c) => `Bash(${INVOCATION} ${c}:*)`).join(', ')}`;

// Skill command lines name their arguments as placeholders; the test fills them in.
const PLACEHOLDERS: Record<string, string> = {
  '<name>': 'demo-tool',
  '<text>': 'A demo plugin, made end to end.',
};

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`)));
const fixtures: Fixture[] = [];
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  fixtures.forEach((f) => f.cleanup());
});

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder (path with a space).
const pluginRoot = join(scratch, 'plugin cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
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

test('there is the one skill, and it calls the CLI only through the shared npx invocation', () => {
  assert.deepEqual(skills, ['build-plugin']);
  for (const skill of skills) {
    const text = skillText(skill);
    assert.match(text, new RegExp(`^---\\nname: ${skill}\\n`), `${skill}: frontmatter name`);
    assert.ok(text.includes(`\n${ALLOWED_TOOLS}\n`), `${skill}: allowed-tools`);
    assert.doesNotMatch(text.split('\n---\n')[0] ?? '', / new:\*\)/, `${skill}: new must not be pre-approved`);
    const commands = skillCommands(skill);
    assert.ok(commands.length >= 2, `expected npx command lines in ${skill}`);
    for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
    // Every npx line in the skill is inside a sh block, so the test below runs all of them.
    const allNpxLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('npx '));
    assert.deepEqual(allNpxLines, commands);
  }
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('build-plugin skill: new, check, verify, check --all, --help all exit 0 in order from a fresh copy', () => {
  const f = checkout();
  const commands = skillCommands('build-plugin');
  assert.deepEqual(
    commands.map((c) => c.slice(INVOCATION.length + 1).split(' ')[0]),
    ['new', 'check', 'verify', 'check', '--help'],
  );
  const cwd = join(f.root, 'plugins'); // anywhere inside the checkout
  for (const command of commands.map(fill)) {
    const { status, stdout, stderr } = sh(command, cwd, withFakeClaude(env, f));
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    if (command.endsWith(' --help')) {
      assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
      continue;
    }
    const value = JSON.parse(stdout);
    if (command.includes(' new ')) {
      assert.deepEqual(value, { name: 'demo-tool', path: 'plugins/demo-tool', marketplace: '.claude-plugin/marketplace.json', description: PLACEHOLDERS['<text>'] });
      const manifest = JSON.parse(readFileSync(join(f.root, 'plugins/demo-tool/.claude-plugin/plugin.json'), 'utf8'));
      assert.equal(manifest.description, PLACEHOLDERS['<text>']);
    }
    if (command.includes(' check ')) assert.deepEqual(value, { plugins: ['demo-tool'], findings: [] });
    if (command.includes(' verify ')) {
      assert.equal(value.ok, true);
      assert.deepEqual(value.steps.map((s: { status: string }) => s.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
    }
  }
});

test('check through npx: a broken plugin exits 1, stdout empty, findings on stderr', () => {
  const f = checkout();
  assert.equal(sh(`${INVOCATION} new demo-tool --json`, f.root).status, 0);
  rmSync(join(f.root, 'plugins/demo-tool/test/cli.test.ts'));
  const { status, stdout, stderr } = sh(`${INVOCATION} check demo-tool --json`, f.root);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^factory-plugin-builder: 1 convention finding\(s\):\nplugins\/demo-tool\/test: \[e2e-test\] /);
});

test('new through npx: 1 for a taken name, 2 for a bad one', () => {
  const f = checkout();
  assert.equal(sh(`${INVOCATION} new demo-tool --json`, f.root).status, 0);
  const taken = sh(`${INVOCATION} new demo-tool --json`, f.root);
  assert.deepEqual([taken.status, taken.stdout], [1, '']);
  assert.match(taken.stderr, /already exists/);
  const bad = sh(`${INVOCATION} new Demo_Tool --json`, f.root);
  assert.deepEqual([bad.status, bad.stdout], [2, '']);
  assert.match(bad.stderr, /invalid plugin name/);
});

test('outside a marketplace checkout through npx: exit 2 with the message on stderr', () => {
  const cwd = join(scratch, 'unrelated-cwd');
  mkdirSync(cwd, { recursive: true });
  const { status, stdout, stderr } = sh(`${INVOCATION} check --all --json`, cwd);
  assert.equal(status, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^factory-plugin-builder: not inside a software-factory checkout/);
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
