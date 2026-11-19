import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CLI_NAME, EXIT, run } from '../src/run.ts';
import { findCheckout } from '../src/repo.ts';
import { findOnPath } from '../src/verify.ts';
import { PLUGIN, REPO, cleanEnv, fixture, scaffoldInto, withFakeClaude, withoutClaude } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const fixtures: Fixture[] = [];
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-plugin-builder-run-')));
after(() => {
  fixtures.forEach((f) => f.cleanup());
  rmSync(scratch, { recursive: true, force: true });
});

function checkout(options: { typecheckExit?: number } = {}): Fixture {
  const f = fixture(options);
  fixtures.push(f);
  return f;
}

async function call(cwd: string, argv: string[], env: NodeJS.ProcessEnv = cleanEnv()): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env });
  return { code, stdout, stderr };
}

test('--help prints usage on stdout', async () => {
  const { code, stdout } = await call(scratch, ['--help']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const word of ['new <name>', 'check <name>', 'verify <name>', '--json', '--repo']) assert.ok(stdout.includes(word), word);
});

test('--version prints the package version', async () => {
  const { code, stdout } = await call(scratch, ['--version']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [[], ['nope'], ['nope', '--json'], ['check'], ['check', 'a', '--all'], ['check', 'Bad_Name'], ['verify', 'Bad_Name'], ['new'], ['new', 'x', '--all'], ['new', 'a', 'b'], ['verify'], ['verify', '--all'], ['check', '--description', 'x', 'a'], ['check', '--bogus']]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, async () => {
    const { code, stdout, stderr } = await call(scratch, argv);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}

test('outside a marketplace checkout: exit 2 with a clear message, for every command', async () => {
  for (const argv of [['new', 'x-y'], ['check', '--all'], ['verify', 'x-y']]) {
    const { code, stdout, stderr } = await call(scratch, [...argv, '--json']);
    assert.equal(code, EXIT.usage, argv.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^factory-plugin-builder: not inside a software-factory checkout: .*pass --repo <path>\n$/);
  }
});

test('a marketplace.json with another name is not a checkout', async () => {
  const dir = join(scratch, 'other-market');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'someone-else', plugins: [] }));
  assert.throws(() => findCheckout(dir), /not inside a software-factory checkout/);
  const { code } = await call(dir, ['check', '--all']);
  assert.equal(code, EXIT.usage);
});

test('the checkout is the nearest ancestor of the cwd, or --repo', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const deep = join(f.root, 'plugins', 'demo-a', 'src');
  assert.equal(findCheckout(deep), f.root);
  assert.equal((await call(deep, ['check', 'demo-a'])).code, EXIT.ok);
  const viaRepo = await call(scratch, ['check', '--all', '--json', '--repo', deep]);
  assert.equal(viaRepo.code, EXIT.ok, viaRepo.stderr);
  assert.deepEqual(JSON.parse(viaRepo.stdout), { plugins: ['demo-a'], findings: [] });
  const missing = await call(scratch, ['check', '--all', '--repo', join(scratch, 'nope')]);
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.stderr, /--repo .*nope: no such directory/);
});

function snapshot(root: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)).map((p) => `${e.name}/${p}`) : [`${e.name}:${readFileSync(join(dir, e.name), 'utf8')}`]));
  return walk(root).sort().join('\n');
}

test('new scaffolds plugins/<name> from the template and appends the marketplace entry', async () => {
  const f = checkout();
  const { code, stdout, stderr } = await call(f.root, ['new', 'log-tools', '--description', 'Tools for logs.', '--json']);
  assert.equal(code, EXIT.ok, stderr);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { name: 'log-tools', path: 'plugins/log-tools', marketplace: '.claude-plugin/marketplace.json', description: 'Tools for logs.' });
  const dir = join(f.root, 'plugins', 'log-tools');
  const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual([manifest.name, manifest.description], ['log-tools', 'Tools for logs.']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin, { 'log-tools': 'src/cli.ts' });
  assert.match(readFileSync(join(dir, 'skills', 'log-tools', 'SKILL.md'), 'utf8'), /^---\nname: log-tools\n/);
  assert.ok(!existsSync(join(dir, 'skills', 'plugin-template')));
  // the token is gone from every path and file
  assert.doesNotMatch(snapshot(dir), /plugin-template/);
  const marketplace = JSON.parse(readFileSync(join(f.root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.deepEqual(marketplace.plugins, [{ name: 'log-tools', source: './plugins/log-tools', description: 'Tools for logs.' }]);
  assert.equal(marketplace.name, 'software-factory');
  // and the result follows the convention
  assert.equal((await call(f.root, ['check', 'log-tools'])).code, EXIT.ok);
});

test('new without --json prints one line; without --description it leaves a TODO description', async () => {
  const f = checkout();
  const { code, stdout } = await call(join(f.root, 'plugins'), ['new', 'log-tools']);
  assert.equal(code, EXIT.ok);
  assert.equal(stdout, "Created plugins/log-tools and added 'log-tools' to .claude-plugin/marketplace.json.\n");
  assert.match(JSON.parse(readFileSync(join(f.root, 'plugins', 'log-tools', '.claude-plugin', 'plugin.json'), 'utf8')).description, /TODO/);
});

test('new: an existing folder exits 1, writing nothing', async () => {
  const f = checkout();
  scaffoldInto(f, 'log-tools');
  const before = snapshot(f.root);
  const { code, stdout, stderr } = await call(f.root, ['new', 'log-tools', '--json']);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.equal(stderr, 'factory-plugin-builder: plugins/log-tools already exists\n');
  assert.equal(snapshot(f.root), before);
});

test('new: an existing marketplace entry without a folder exits 1, writing nothing', async () => {
  const f = checkout();
  const path = join(f.root, '.claude-plugin', 'marketplace.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.plugins.push({ name: 'log-tools', source: './plugins/log-tools' });
  writeFileSync(path, JSON.stringify(m, null, 2));
  const before = snapshot(f.root);
  const { code, stdout, stderr } = await call(f.root, ['new', 'log-tools']);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /already lists a plugin named 'log-tools'/);
  assert.equal(snapshot(f.root), before);
});

for (const bad of ['Bad_Name', 'log--tools', 'log_tools', '9lives', 'log-', 'a'.repeat(65), 'plugin-template']) {
  test(`new: bad name ${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 8)}...(${bad.length})` : bad)} exits 2, writing nothing`, async () => {
    const f = checkout();
    const before = snapshot(f.root);
    const { code, stdout, stderr } = await call(f.root, ['new', bad, '--json']);
    assert.equal(code, EXIT.usage);
    assert.equal(stdout, '');
    assert.match(stderr, /^factory-plugin-builder: (invalid plugin name|'plugin-template' is the template's own name)/);
    assert.equal(snapshot(f.root), before);
  });
}

test('new: a 64-character name is accepted', async () => {
  const f = checkout();
  const name = `a${'-b'.repeat(31)}a`;
  assert.equal(name.length, 64);
  assert.equal((await call(f.root, ['new', name])).code, EXIT.ok);
});

test('new: a checkout without templates/plugin exits 1', async () => {
  const f = checkout();
  rmSync(join(f.root, 'templates'), { recursive: true });
  const { code, stdout, stderr } = await call(f.root, ['new', 'log-tools']);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /templates\/plugin not found/);
});

/** The `version` of a plugin's plugin.json and package.json. */
function versions(root: string, name: string): [unknown, unknown] {
  const dir = join(root, 'plugins', name);
  return [
    JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version,
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version,
  ];
}

/** Sets a fixture plugin's version in both its plugin.json and package.json. */
function setVersions(root: string, name: string, version: string): void {
  for (const rel of [join('.claude-plugin', 'plugin.json'), 'package.json']) {
    const path = join(root, 'plugins', name, rel);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version }, null, 2));
  }
}

test('new: the plugin starts at the version the marketplace plugins share (the template\'s own when there are none)', async () => {
  const f = checkout();
  const template = JSON.parse(readFileSync(join(f.root, 'templates', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.equal((await call(f.root, ['new', 'first-one'])).code, EXIT.ok);
  assert.deepEqual(versions(f.root, 'first-one'), [template, template]);

  scaffoldInto(f, 'second-one');
  setVersions(f.root, 'first-one', '1.2.0');
  setVersions(f.root, 'second-one', '1.2.0');
  const { code, stderr } = await call(f.root, ['new', 'log-tools']);
  assert.equal(code, EXIT.ok, stderr);
  assert.deepEqual(versions(f.root, 'log-tools'), ['1.2.0', '1.2.0']);

  // versions that differ (factory-dev check refuses that): the highest, compared numerically
  setVersions(f.root, 'second-one', '1.10.0');
  assert.equal((await call(f.root, ['new', 'later-tools'])).code, EXIT.ok);
  assert.deepEqual(versions(f.root, 'later-tools'), ['1.10.0', '1.10.0']);
});

test('npm run new-plugin runs the same scaffold (the root script, in a fixture checkout)', () => {
  const f = checkout();
  const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.equal(rootPkg.scripts['new-plugin'], 'node plugins/factory-plugin-builder/src/cli.ts new');
  cpSync(PLUGIN, join(f.root, 'plugins', 'factory-plugin-builder'), { recursive: true, filter: (p) => !p.includes('node_modules') });
  const pkgPath = join(f.root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.scripts['new-plugin'] = rootPkg.scripts['new-plugin'];
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const r = spawnSync('npm', ['run', '--silent', 'new-plugin', '--', 'log-tools', '--description', 'Via npm.'], { cwd: f.root, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "Created plugins/log-tools and added 'log-tools' to .claude-plugin/marketplace.json.\n");
  assert.equal(JSON.parse(readFileSync(join(f.root, 'plugins', 'log-tools', '.claude-plugin', 'plugin.json'), 'utf8')).description, 'Via npm.');
  // with plugins at 1.2.0, npm run new-plugin starts the next one at 1.2.0 too
  setVersions(f.root, 'log-tools', '1.2.0');
  assert.equal(spawnSync('npm', ['run', '--silent', 'new-plugin', '--', 'more-tools'], { cwd: f.root, env: cleanEnv(), encoding: 'utf8' }).status, 0);
  assert.deepEqual(versions(f.root, 'more-tools'), ['1.2.0', '1.2.0']);
  const taken = spawnSync('npm', ['run', '--silent', 'new-plugin', '--', 'log-tools'], { cwd: f.root, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(taken.status, 1);
  const bad = spawnSync('npm', ['run', '--silent', 'new-plugin', '--', 'Bad_Name'], { cwd: f.root, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('check: findings go to stderr with file, line, rule and fix; exit 1, stdout empty', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const cli = join(f.root, 'plugins', 'demo-a', 'src', 'cli.ts');
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('#!/usr/bin/env node\n', '// no shebang\n'));
  const { code, stdout, stderr } = await call(f.root, ['check', 'demo-a', '--json']);
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.equal(
    stderr,
    'factory-plugin-builder: 1 convention finding(s):\n' +
      'plugins/demo-a/src/cli.ts:1: [bin-shebang] first line is "// no shebang"; npx runs the bin as an executable script\n' +
      '  fix: make the first line exactly #!/usr/bin/env node\n',
  );
});

test('check: an unknown plugin exits 1', async () => {
  const f = checkout();
  const { code, stderr } = await call(f.root, ['check', 'nope']);
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /plugins\/nope does not exist/);
});

test('check --all without --json prints a short summary', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  scaffoldInto(f, 'demo-b');
  assert.deepEqual(await call(f.root, ['check', '--all']), { code: 0, stdout: '2 plugin(s) follow the convention: demo-a, demo-b\n', stderr: '' });
});

test('verify: every step passes with a working claude; it runs from the checkout root', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const { code, stdout, stderr } = await call(join(f.root, 'plugins'), ['verify', 'demo-a', '--json'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.ok, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s: { name: string; status: string; command: string[] }) => [s.name, s.status, s.command.join(' ')]),
    [
      ['check', 'pass', 'factory-plugin-builder check demo-a'],
      ['validate-plugin', 'pass', 'claude plugin validate plugins/demo-a'],
      ['validate-marketplace', 'pass', 'claude plugin validate .'],
      ['typecheck', 'pass', 'npm run typecheck'],
      ['test', 'pass', 'node --test --test-timeout=120000 plugins/demo-a/test/**/*.test.ts'],
    ],
  );
  assert.equal(readFileSync(f.claudeLog, 'utf8'), 'plugin validate plugins/demo-a\nplugin validate .\n');
  // the plugin's own tests ran (their output streams on stderr), and only that plugin's
  assert.match(stderr, /^(#|ℹ) pass [1-9]/m);
  assert.match(stderr, /^(#|ℹ) fail 0$/m);
});

test('verify: claude not on PATH is reported as skipped, not passed', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a'], withoutClaude(cleanEnv(), f));
  assert.equal(code, EXIT.ok, stderr);
  assert.match(stdout, /^SKIP {2}validate-plugin +claude plugin validate plugins\/demo-a \(claude is not on PATH\)$/m);
  assert.match(stdout, /^SKIP {2}validate-marketplace /m);
  assert.match(stdout, /^PASS {2}typecheck /m);
  assert.match(stdout, /every step passed or was skipped/);
  assert.match(stdout, /^PASS {2}test /m);
  assert.equal(existsSync(f.claudeLog), false, 'no claude ran');
});

test('verify: a failing step and a failing check make it exit 1 with every step reported on stderr', async () => {
  const f = checkout({ typecheckExit: 3 });
  scaffoldInto(f, 'demo-a');
  const pkg = join(f.root, 'plugins', 'demo-a', 'package.json');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"private": true', '"private": false'));
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a', '--json'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.failure);
  assert.equal(stdout, '');
  assert.match(stderr, /\[package-private\]/);
  assert.match(stderr, /^factory-plugin-builder: verify demo-a failed: check, typecheck$/m);
  assert.match(stderr, /^FAIL {2}typecheck +npm run typecheck \(exit 3\)$/m);
  assert.match(stderr, /^PASS {2}test /m);
});

test('verify: a failing claude plugin validate fails the step', async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  writeFileSync(join(f.fakeBin, 'claude'), '#!/bin/sh\necho "invalid manifest" >&2\nexit 1\n');
  const { code, stderr } = await call(f.root, ['verify', 'demo-a'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /invalid manifest/);
  assert.match(stderr, /failed: validate-plugin, validate-marketplace$/m);
});

test('verify: an unknown plugin exits 1 before running any step', async () => {
  const f = checkout();
  const { code, stderr } = await call(f.root, ['verify', 'nope'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.failure);
  assert.match(stderr, /plugins\/nope does not exist/);
});

const realClaude = findOnPath('claude', cleanEnv());
test('verify with the real claude validates the fixture plugin and marketplace', { skip: realClaude === null ? 'claude is not installed' : false }, async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a', '--json']);
  assert.equal(code, EXIT.ok, stderr);
  const steps = JSON.parse(stdout).steps as { name: string; status: string }[];
  assert.deepEqual(steps.map((s) => s.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.match(stderr, /Validation passed/);
});

// The fixture's typecheck is a stub elsewhere; here it is the real root tsconfig and tsc, so a freshly
// scaffolded plugin is shown to pass the strict typecheck too.
const hasTsc = existsSync(join(REPO, 'node_modules', 'typescript'));
test('verify: a freshly scaffolded plugin passes the real strict typecheck', { skip: hasTsc ? false : 'npm ci has not been run' }, async () => {
  const f = checkout();
  scaffoldInto(f, 'demo-a');
  const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { typecheck: rootPkg.scripts.typecheck } }));
  cpSync(join(REPO, 'tsconfig.json'), join(f.root, 'tsconfig.json'));
  symlinkSync(join(REPO, 'node_modules'), join(f.root, 'node_modules'));
  const { code, stdout, stderr } = await call(f.root, ['verify', 'demo-a', '--json'], withFakeClaude(cleanEnv(), f));
  assert.equal(code, EXIT.ok, stderr);
  assert.deepEqual(JSON.parse(stdout).steps.map((s: { name: string; status: string }) => `${s.name}:${s.status}`), [
    'check:pass', 'validate-plugin:pass', 'validate-marketplace:pass', 'typecheck:pass', 'test:pass',
  ]);
  // and a type error fails that step
  writeFileSync(join(f.root, 'plugins', 'demo-a', 'src', 'broken.ts'), 'export const n: number = "x";\n');
  const broken = await call(f.root, ['verify', 'demo-a'], withFakeClaude(cleanEnv(), f));
  assert.equal(broken.code, EXIT.failure);
  assert.match(broken.stderr, /^FAIL {2}typecheck /m);
});
