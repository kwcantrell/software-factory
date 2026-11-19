// End to end: the CLI run the way skills and agents run it, through npx from a fresh copy of the
// plugin (as Claude Code's plugin cache holds it: no node_modules, no install or build step), from an
// unrelated directory, offline and with an empty npm cache.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanEnv, PLUGIN, TASK } from './helpers.ts';

const INVOCATION = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-npx-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const pluginRoot = join(scratch, 'plugin cache', 'factory'); // a space, as real paths may have
cpSync(PLUGIN, pluginRoot, { recursive: true, filter: (p) => !p.includes('node_modules') });
const env = cleanEnv(scratch, {
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_offline: 'true',
  npm_config_update_notifier: 'false',
});

function sh(command: string, cwd: string, extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const p = spawnSync('sh', ['-c', command], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  return { status: p.status, stdout: p.stdout, stderr: p.stderr };
}

const COMMANDS = [
  'init', 'new', 'start', 'spec', 'approve', 'built', 'proof', 'round', 'verdict', 'human', 'resume', 'merge',
  'rework', 'close', 'config', 'note', 'followup', 'path', 'status', 'stats', 'upgrade', 'dashboard',
];

test('the copy has no node_modules and the package has no dependencies', () => {
  assert.equal(existsSync(join(pluginRoot, 'node_modules')), false);
  const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(pkg.bin, { factory: 'src/cli.ts' });
});

test('--help through npx lists every command', () => {
  const cwd = join(scratch, 'unrelated');
  mkdirSync(cwd, { recursive: true });
  const p = sh(`${INVOCATION} --help`, cwd);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stderr, '');
  for (const c of COMMANDS) assert.match(p.stdout, new RegExp(`^  ${c}\\b`, 'm'), c);
  assert.match(p.stdout, /followup \{add,list,done,drop\}/);
  assert.equal(readdirSync(cwd).length, 0, '--help writes nothing');
});

test('init, new and start through npx in a git repo with one commit', () => {
  const repo = join(scratch, 'repo');
  mkdirSync(repo);
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'initial']]) {
    assert.equal(spawnSync('git', args, { cwd: repo, env: gitEnv }).status, 0);
  }
  let p = sh(`${INVOCATION} init`, repo);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^factory ready at .*\/repo\/factory\n/);
  assert.ok(existsSync(join(repo, 'factory', 'index.html')));
  p = sh(`${INVOCATION} new "Try it out"`, repo);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.split('\n')[0], '001-try-it-out');
  writeFileSync(join(repo, 'factory', 'jobs', '001-try-it-out', 'task.md'), TASK);
  p = sh(`${INVOCATION} start 1`, repo);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^worktree: .*factory\/worktrees\/001-try-it-out\nbranch: factory\/001-try-it-out\n/);
  // A refusal keeps its exit code through npx.
  p = sh(`${INVOCATION} start 1`, repo);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /^refused: 001-try-it-out is in 'build', expected intake\n$/);
});

// Every ```sh command line of every skill, run as written through npx from the fresh copy (the
// convention's e2e skill-line test). `<command>` is the line that defines `factory` for the prompt;
// it is filled with --help. The dashboard line starts a server: it runs on a free port until it
// prints where it serves, then it is stopped.
function skillCommands(): { skill: string; line: string }[] {
  return readdirSync(join(pluginRoot, 'skills')).flatMap((skill) => {
    const text = readFileSync(join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    return [...text.matchAll(/```sh\n([\s\S]*?)```/g)]
      .flatMap((m) => (m[1] ?? '').split('\n'))
      .map((line) => line.trim())
      .filter((line) => line.startsWith('npx '))
      .map((line) => ({ skill, line }));
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

test('every skill command line runs through npx from a fresh copy', async () => {
  const commands = skillCommands();
  assert.deepEqual([...new Set(commands.map((c) => c.skill))].sort(), ['approve', 'dashboard', 'run', 'ship', 'upgrade']);
  const repo = join(scratch, 'skill-lines');
  mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'initial']]) {
    assert.equal(spawnSync('git', args, { cwd: repo, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null' } }).status, 0);
  }
  assert.equal(sh(`${INVOCATION} init`, repo).status, 0);
  for (const { skill, line } of commands) {
    assert.ok(line.startsWith(`${INVOCATION} `), `${skill}: ${line}`);
    const filled = line.replaceAll('<command>', '--help');
    assert.doesNotMatch(filled, /<[a-z-]+>/, `${skill}: unknown placeholder in ${line}`);
    if (/ -- factory dashboard /.test(filled)) {
      const port = await freePort();
      const child = spawn('sh', ['-c', filled.replace(/--port \d+/, `--port ${port}`)], { cwd: repo, env, detached: true });
      let out = '';
      child.stderr.resume();
      const banner = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes('\n')) resolve(out);
        });
        child.on('close', (code) => reject(new Error(`${skill}: ${line} exited ${code}`)));
      });
      process.kill(-(child.pid as number), 'SIGTERM');
      assert.match(banner, new RegExp(`^dashboard: http://127\\.0\\.0\\.1:${port}/ `), `${skill}: ${line}`);
      continue;
    }
    const p = sh(filled, repo);
    assert.equal(p.status, 0, `${skill}: ${line}\n${p.stderr}`);
    assert.match(p.stdout, /^usage: factory /im, `${skill}: ${line}`);
  }
});

// Guard against `--package=""`: npm reads an empty spec as the registry package `undefined` (owned by
// a third party), and `--yes` would install and run it unprompted. `--offline` in the invocation must
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
    const online: NodeJS.ProcessEnv = {
      ...env,
      CLAUDE_PLUGIN_ROOT: '',
      npm_config_cache: join(scratch, 'npm-cache-empty-root'),
      npm_config_registry: `http://127.0.0.1:${port}/`,
    };
    delete online.npm_config_offline;
    const child = spawn('sh', ['-c', `${INVOCATION} --help`], { cwd: scratch, env: online });
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
