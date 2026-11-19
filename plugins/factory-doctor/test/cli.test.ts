// End to end: runs the exact npx command lines from the skill, the way Claude Code would after
// installing the plugin (a fresh copy, no npm install or build step), each in a fresh temp
// repository with a temp HOME and CLAUDE_CONFIG_DIR (never the user's).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_NAME = 'factory-doctor';
const SKILL = 'skills/factory-doctor/SKILL.md';
const INVOCATION = `npx --yes --offline --loglevel=error --package="\${CLAUDE_PLUGIN_ROOT}" -- ${CLI_NAME}`;

const source = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `${CLI_NAME}-e2e-`));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Simulate the plugin cache: Claude Code installs a plugin by copying its folder.
const pluginRoot = join(scratch, 'plugin-cache', CLI_NAME);
cpSync(source, pluginRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
// The factory plugin, installed beside it in a fake Claude Code install record, for `migrate`'s
// plumbing; and a fake `claude` first on PATH, so `migrate --update-plugins --confirmed` never runs
// the real one.
const factoryRoot = join(scratch, 'plugin-cache', 'factory');
cpSync(join(source, '..', 'factory'), factoryRoot, { recursive: true, filter: (path) => !path.includes('node_modules') });
const fakeBin = join(scratch, 'bin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'claude'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(join(scratch, 'claude-calls.log'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
chmodSync(join(fakeBin, 'claude'), 0o755);
const cwd = join(scratch, 'unrelated-cwd');
mkdirSync(cwd);
const env: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')),
);
env.CLAUDE_PLUGIN_ROOT = pluginRoot;
// Empty npx cache, and offline: proves nothing is fetched from the registry.
env.npm_config_cache = join(scratch, 'npm-cache');
env.npm_config_offline = 'true';
env.HOME = join(scratch, 'home');
env.CLAUDE_CONFIG_DIR = join(scratch, 'claude');
env.PATH = `${fakeBin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
mkdirSync(join(scratch, 'claude', 'plugins'), { recursive: true });
writeFileSync(
  join(scratch, 'claude', 'plugins', 'installed_plugins.json'),
  JSON.stringify({ version: 2, plugins: { 'factory@software-factory': [{ scope: 'user', installPath: factoryRoot, version: '0.4.0' }], 'factory-doctor@software-factory': [{ scope: 'user', installPath: pluginRoot, version: '0.4.0' }] } }),
);
delete env.FACTORY_DOCTOR_PROFILE;

let repoCount = 0;
/** A fresh repository: a .git dir, a .env.example for scan, and (unless bare) a doctor file. */
function repo(withFile = true): string {
  const dir = join(scratch, `repo-${++repoCount}`);
  mkdirSync(dir, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  writeFileSync(join(dir, '.env.example'), 'DATABASE_URL=\n');
  if (withFile) {
    mkdirSync(join(dir, '.factory'));
    const file = { version: 1, default_profile: 'dev', profiles: { dev: { requires: [{ kind: 'tool', name: 'node', why: 'runs the app' }, { kind: 'env', name: 'OLD_VAR', optional: true, why: 'legacy' }] } } };
    writeFileSync(join(dir, '.factory', 'doctor.json'), `${JSON.stringify(file, null, 2)}\n`);
  }
  return dir;
}

const VALUES: Record<string, string> = { profile: 'dev', n: '1', kind: 'env', name: 'NEW_VAR', why: 'the app reads it', version: '0.4.0' };

/** Fills a skill line's `<placeholder>` values; `remove` removes the env var the file holds. */
function fill(command: string): string {
  const filled = command.replace(/<([a-z]+)>/g, (m, name: string) => VALUES[name] ?? m);
  return filled.includes(' remove ') ? filled.replace('NEW_VAR', 'OLD_VAR') : filled;
}

function skillCommands(): string[] {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((b) => b.split('\n')).filter((line) => line.startsWith('npx '));
}

function sh(command: string, dir = cwd): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', ['-c', command], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the skill calls the CLI only through the shared npx invocation', () => {
  const commands = skillCommands();
  assert.ok(commands.length >= 2, `expected npx command lines in ${SKILL}`);
  for (const command of commands) assert.ok(command.startsWith(`${INVOCATION} `), command);
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
});

test('allowed-tools pre-approves only check, scan, profiles, --help and the migrate dry run, never --apply or --update-plugins', () => {
  const text = readFileSync(join(pluginRoot, SKILL), 'utf8');
  const line = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? '';
  const rules = [...line.matchAll(/Bash\((.*?)\)(?:, |$)/g)].map((m) => m[1] ?? '');
  assert.deepEqual(rules, [
    ...['check', 'scan', 'profiles', '--help'].map((c) => `${INVOCATION} ${c}:*`),
    `${INVOCATION} migrate`,
    `${INVOCATION} migrate --json`,
  ]);
  assert.doesNotMatch(line, /--apply|--update-plugins|--confirmed|migrate:\*/);
});

test('every skill command line runs from a fresh copy, in a fresh repository, and exits 0', () => {
  const commands = skillCommands();
  for (const c of ['check', 'scan', 'profiles', 'init', 'add', 'remove', 'migrate', '--help']) {
    assert.ok(commands.some((l) => l.startsWith(`${INVOCATION} ${c}`)), `the skill runs ${c}`);
  }
  for (const line of commands) {
    const command = fill(line);
    const dir = repo(!command.includes(' init'));
    const before = existsSync(join(dir, '.factory', 'doctor.json')) ? readFileSync(join(dir, '.factory', 'doctor.json'), 'utf8') : null;
    const { status, stdout, stderr } = sh(command, dir);
    assert.equal(status, 0, `${command}\nstderr: ${stderr}`);
    assert.notEqual(stdout, '', command);
    if (command.includes('--update-plugins --confirmed')) assert.match(readFileSync(join(scratch, 'claude-calls.log'), 'utf8'), /^plugin marketplace update software-factory\nplugin update factory-doctor@software-factory\nplugin update factory@software-factory\n/);
    if (command.endsWith(' --help')) assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
    if (command.includes(' --json')) JSON.parse(stdout);
    const after = existsSync(join(dir, '.factory', 'doctor.json')) ? readFileSync(join(dir, '.factory', 'doctor.json'), 'utf8') : null;
    if (/--confirm( |$)/.test(command)) assert.notEqual(after, before, `${command} wrote the file`);
    else assert.equal(after, before, `${command} changed nothing`);
  }
});

test('check through npx: exit 1 with the report on stderr when something required is missing', () => {
  const dir = repo();
  const { status, stdout, stderr } = sh(`${INVOCATION} add env NEEDED_VAR --profile dev --why "needed" --confirm && ${INVOCATION} check`, dir);
  assert.equal(status, 1);
  assert.match(stdout, /^Added in/);
  assert.match(stderr, /^missing env NEEDED_VAR: not set\n {8}fix: set NEEDED_VAR yourself/m);
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
