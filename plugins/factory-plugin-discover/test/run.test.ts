import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { configDir } from '../src/config.ts';
import { CLAUDE_TIMEOUT_MS } from '../src/install.ts';
import { CLI_NAME, EXIT, run } from '../src/run.ts';
import { fakeClaude, type Options, sandbox } from './helpers.ts';

function call(...argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

test('--help prints usage on stdout', () => {
  const { code, stdout } = call('--help');
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const c of ['catalog', 'match <task text>', 'settings set mode <mode>', 'install <name> [--confirmed]', 'hook']) assert.ok(stdout.includes(c), c);
});

test('--version prints the package version', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(call('--version'), { code: EXIT.ok, stdout: `${version}\n`, stderr: '' });
});

test('usage errors exit 2 with the message on stderr and nothing on stdout', () => {
  for (const [argv, message] of [
    [['no-such-command', '--json'], /unknown command 'no-such-command'/],
    [[], /missing command/],
    [['catalog', '--nope'], /Unknown option '--nope'/],
    [['catalog', '--confirmed'], /catalog does not take --confirmed/],
    [['catalog', 'extra'], /catalog takes no arguments/],
    [['install', '--json'], /install takes exactly one plugin name/],
    [['install', 'Bad_Name'], /kebab-case/],
    [['settings', 'set', 'mode', 'sometimes', '--json'], /mode must be one of ask, notify, auto-install, off/],
    [['settings', 'get', 'mode'], /settings takes no arguments, or: set mode/],
  ] as const) {
    const s = sandbox();
    try {
      const r = s.call([...argv]);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, message);
      assert.match(r.stderr, new RegExp(`^${CLI_NAME}: `));
    } finally {
      s.cleanup();
    }
  }
});

test('settings: default ask, set validates and persists in an owner-only config file', () => {
  const s = sandbox();
  try {
    assert.deepEqual(JSON.parse(s.call(['settings', '--json']).stdout), {
      mode: 'ask',
      default: true,
      modes: ['ask', 'notify', 'auto-install', 'off'],
      path: join(s.configDir, 'config.json'),
    });
    assert.equal(existsSync(s.configDir), false, 'reading the mode writes nothing');
    for (const mode of ['notify', 'auto-install', 'off', 'ask']) {
      const r = s.call(['settings', 'set', 'mode', mode, '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).mode, mode);
      assert.equal(JSON.parse(s.call(['settings', '--json']).stdout).mode, mode);
    }
    assert.equal(statSync(s.configDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.configDir, 'config.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(s.configDir, 'config.json'), 'utf8')), { mode: 'ask' });
    assert.match(s.call(['settings']).stdout, /^mode: ask {2}\(/);
    // A bad value on disk falls back to the default.
    writeFileSync(join(s.configDir, 'config.json'), '{"mode":"loud"}');
    assert.equal(JSON.parse(s.call(['settings', '--json']).stdout).default, true);
  } finally {
    s.cleanup();
  }
});

/** A sandbox whose PATH holds only a fake claude and node. */
function installSandbox(script?: string, options?: Options): ReturnType<typeof sandbox> & { calls: () => string[][] } {
  const s = sandbox(options);
  const bin = fakeClaude(s.dir, script);
  s.env.PATH = `${bin}:${dirname(process.execPath)}`;
  const calls = (): string[][] => {
    const file = join(s.dir, 'claude-calls.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv) : [];
  };
  return Object.assign(s, { calls });
}

const sandboxes: Array<{ cleanup: () => void }> = [];
after(() => sandboxes.forEach((s) => s.cleanup()));
function fresh(script?: string, options?: Options): ReturnType<typeof installSandbox> {
  const s = installSandbox(script, options);
  sandboxes.push(s);
  return s;
}

test('install in ask mode refuses without --confirmed and runs claude plugin install with it', () => {
  // No project-scoped installs, so factory-plugin-builder is installable too (the text output below).
  const s = fresh(undefined, { elsewhere: [] });
  const refused = s.call(['install', 'factory-docs', '--json']);
  assert.equal(refused.code, EXIT.failure);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /mode is ask: ask the user first, and pass --confirmed only after they say yes/);
  assert.deepEqual(s.calls(), []);
  const r = s.call(['install', 'factory-docs', '--confirmed', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    plugin: 'factory-docs',
    marketplace: 'software-factory',
    command: 'claude plugin install factory-docs@software-factory',
    mode: 'ask',
    installed: true,
    output: 'Successfully installed plugin',
    reload: 'Run /reload-plugins (or restart Claude Code) to load it.',
  });
  assert.deepEqual(s.calls(), [['plugin', 'install', 'factory-docs@software-factory']]);
  assert.match(s.call(['install', 'factory-plugin-builder', '--confirmed']).stdout, /^Installed factory-plugin-builder@software-factory\. Run \/reload-plugins/);
});

test('install in auto-install mode needs no --confirmed', () => {
  const s = fresh();
  s.call(['settings', 'set', 'mode', 'auto-install']);
  const r = s.call(['install', 'factory-docs', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).mode, 'auto-install');
  assert.deepEqual(s.calls(), [['plugin', 'install', 'factory-docs@software-factory']]);
});

test('install refuses in notify mode (printing the command) and off mode, even with --confirmed', () => {
  const s = fresh();
  s.call(['settings', 'set', 'mode', 'notify']);
  const n = s.call(['install', 'factory-docs', '--confirmed', '--json']);
  assert.deepEqual([n.code, n.stdout], [EXIT.failure, '']);
  assert.match(n.stderr, /mode is notify, so nothing is installed; to install it, run: claude plugin install factory-docs@software-factory/);
  s.call(['settings', 'set', 'mode', 'off']);
  const o = s.call(['install', 'factory-docs', '--confirmed', '--json']);
  assert.deepEqual([o.code, o.stdout], [EXIT.failure, '']);
  assert.match(o.stderr, /mode off/);
  assert.deepEqual(s.calls(), []);
});

test('install refuses a plugin outside the marketplace, or one already installed (even disabled)', () => {
  const s = fresh();
  for (const [name, message] of [
    ['other-tools', /'other-tools' is not a plugin in software-factory/],
    ['factory', /factory@software-factory is already installed$/m],
    ['factory-dev', /already installed but disabled/],
  ] as const) {
    const r = s.call(['install', name, '--confirmed', '--json']);
    assert.deepEqual([r.code, r.stdout], [EXIT.failure, ''], name);
    assert.match(r.stderr, message);
  }
  assert.deepEqual(s.calls(), []);
});

test('install refuses, with exit 1, a plugin installed with project scope for another project', () => {
  const s = fresh();
  // Even in auto-install mode: a user-scope install would duplicate it into every project.
  s.call(['settings', 'set', 'mode', 'auto-install']);
  const r = s.call(['install', 'factory-plugin-builder', '--json']);
  assert.deepEqual([r.code, r.stdout], [EXIT.failure, '']);
  assert.equal(
    r.stderr,
    `factory-plugin-discover: factory-plugin-builder@software-factory is already installed with project scope for another project (${join(s.dir, 'some-other-project')}); ` +
      'this command installs only at user scope, which would add it to every project. ' +
      'To use it in this project, install it for this project with /plugin (or claude plugin install factory-plugin-builder@software-factory --scope project, run from this project)\n',
  );
  assert.deepEqual(s.calls(), []);
});

test('install refuses when the marketplace manifest cannot be found', () => {
  const s = sandbox({ knownMarketplace: false });
  sandboxes.push(s);
  const r = s.call(['install', 'factory-docs', '--confirmed']);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /cannot find the software-factory manifest/);
});

test('install reports a failing claude, and a missing one', () => {
  const s = fresh("console.error('Plugin not found in marketplace'); process.exit(3);");
  const r = s.call(['install', 'factory-docs', '--confirmed', '--json']);
  assert.deepEqual([r.code, r.stdout], [EXIT.failure, '']);
  assert.match(r.stderr, /claude plugin install factory-docs@software-factory exited 3: Plugin not found in marketplace/);
  s.env.PATH = join(s.dir, 'empty-path');
  const missing = s.call(['install', 'factory-docs', '--confirmed']);
  assert.equal(missing.code, EXIT.failure);
  assert.match(missing.stderr, /claude is not on PATH; run this yourself: claude plugin install factory-docs@software-factory/);
});

test('the config dir: FACTORY_PLUGIN_DISCOVER_CONFIG_DIR, else XDG_CONFIG_HOME, else ~/.config; never plugin-discover', () => {
  assert.equal(configDir({ FACTORY_PLUGIN_DISCOVER_CONFIG_DIR: '/c/fpd', XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/c/fpd');
  assert.equal(configDir({ FACTORY_PLUGIN_DISCOVER_CONFIG_DIR: '', XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/x/factory-plugin-discover');
  assert.equal(configDir({ HOME: '/h' }), '/h/.config/factory-plugin-discover');
  // Another marketplace's plugin-discover keeps its settings elsewhere; its variable changes nothing here.
  assert.equal(configDir({ PLUGIN_DISCOVER_CONFIG_DIR: '/c/other', HOME: '/h' }), '/h/.config/factory-plugin-discover');
  const s = sandbox();
  sandboxes.push(s);
  const other = join(s.dir, 'config', 'plugin-discover');
  s.env.PLUGIN_DISCOVER_CONFIG_DIR = other;
  assert.equal(s.call(['settings', 'set', 'mode', 'off']).code, EXIT.ok);
  assert.equal(existsSync(other), false);
  assert.deepEqual(JSON.parse(readFileSync(join(s.configDir, 'config.json'), 'utf8')), { mode: 'off' });
  // Through XDG_CONFIG_HOME, with directory 0700 and file 0600.
  const xdg = join(s.dir, 'xdg');
  const env = { HOME: join(s.dir, 'home'), XDG_CONFIG_HOME: xdg };
  const r = run(['settings', 'set', 'mode', 'notify', '--json'], { stdout: () => {}, stderr: () => {}, env, pluginRoot: join(s.dir, 'none') });
  assert.equal(r, EXIT.ok);
  assert.equal(statSync(join(xdg, 'factory-plugin-discover')).mode & 0o777, 0o700);
  assert.equal(statSync(join(xdg, 'factory-plugin-discover', 'config.json')).mode & 0o777, 0o600);
});

test('only install runs claude: catalog, match, settings, hook and --help never do', () => {
  const s = fresh();
  for (const argv of [['catalog', '--json'], ['match', 'are the docs stale', '--json'], ['match', 'fix a flaky react component test'], ['settings'], ['settings', 'set', 'mode', 'auto-install'], ['--help'], ['hook']]) {
    s.call(argv, { stdin: '{"hook_event_name":"UserPromptSubmit","prompt":"/factory:run x","session_id":"s1"}' });
  }
  assert.deepEqual(s.calls(), []);
  assert.equal(s.call(['install', 'factory-docs', '--json']).code, EXIT.ok);
  assert.deepEqual(s.calls(), [['plugin', 'install', 'factory-docs@software-factory']]);
});

test('install times out after 120 s and runs claude without a shell', () => {
  assert.equal(CLAUDE_TIMEOUT_MS, 120_000);
  // A name with shell metacharacters is refused before anything runs.
  const s = fresh();
  const r = s.call(['install', 'factory-docs;touch x', '--confirmed']);
  assert.deepEqual([r.code, r.stdout], [EXIT.usage, '']);
  assert.deepEqual(s.calls(), []);
});
