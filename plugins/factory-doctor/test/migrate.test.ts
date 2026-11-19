// `migrate`: the version registry kept in sync with the checkout, detection, the plan and its order,
// --apply through the factory CLI's `factory migrate-repo` plumbing (run through npx from the factory
// plugin's folder, found in a fake Claude Code install record), downgrades (and the 0.4.0 CLI reading
// the result), refusals, and --update-plugins with a fake `claude` on PATH. Every test runs in temp
// dirs with a temp HOME, CLAUDE_CONFIG_DIR, npm cache and FACTORY_DIR: none touches ~/.claude, the
// installed plugins, a real factory/ dir, or runs the real `claude`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/claude.ts';
import { installedAt } from '../src/migrate.ts';
import { entry, LATEST, REGISTRY, stateOf } from '../src/registry.ts';
import { run } from '../src/run.ts';

const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));
const FACTORY = join(CHECKOUT, 'plugins', 'factory');
const DOCTOR = join(CHECKOUT, 'plugins', 'factory-doctor');
const FIXTURES = join(FACTORY, 'test', 'fixtures');
const read = (rel: string): string => readFileSync(join(CHECKOUT, rel), 'utf8');
const REPO_VERSION = JSON.parse(read('plugins/factory/package.json')).version as string;
const V040 = entry('0.4.0').commit as string;

// ---------------------------------------------------------------- the registry, against the checkout

/** The keys of a `{ ... }` block that starts at `start` in a TypeScript source (one key per line). */
function blockKeys(source: string, start: RegExp): string[] {
  const at = source.search(start);
  assert.ok(at >= 0, `no ${start} in the source`);
  const body = source.slice(at, source.indexOf('\n}', at));
  return [...body.matchAll(/^ {2}([a-z_]+)\??:/gm)].map((m) => m[1] as string);
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

/** The registry's names for the newest version: every name the code has, and pending ones only when it has them not. */
function assertSynced(area: string, code: string[], registry: string[], pending: string[]): void {
  const missing = code.filter((n) => !registry.includes(n));
  assert.deepEqual(missing, [], `${area}: in the code but not in the registry's ${LATEST} entry (plugins/factory-doctor/src/registry.ts): add a change for each`);
  const extra = registry.filter((n) => !code.includes(n) && !pending.includes(`${area}:${n}`));
  assert.deepEqual(extra, [], `${area}: in the registry but not in the code`);
  const landed = registry.filter((n) => code.includes(n) && pending.includes(`${area}:${n}`));
  assert.deepEqual(landed, [], `${area}: marked pending in the registry but now in the code: remove its 'pending'`);
}

test('registry: factory.json keys of the newest version are DEFAULTS in factory.ts', () => {
  const s = stateOf(LATEST);
  assertSynced('factory.json', blockKeys(read('plugins/factory/src/factory.ts'), /^export const DEFAULTS\b/m), s.config_keys, s.pending);
});

test('registry: job.json fields of the newest version are the fields checkJob accepts (the Job interface)', () => {
  const s = stateOf(LATEST);
  assertSynced('job.json', blockKeys(read('plugins/factory/src/factory.ts'), /^export interface Job \{/m), s.job_fields, s.pending);
});

test('registry: fixed sections of the newest version are those of plugins/factory/templates/agents/', () => {
  const code: string[] = [];
  for (const kind of ['builder', 'verifier', 'reviewer']) {
    for (const m of read(`plugins/factory/templates/agents/${kind}.md`).matchAll(/<!-- fixed:([a-z-]+) -->/g)) code.push(`${kind}:${m[1]}`);
  }
  const s = stateOf(LATEST);
  assertSynced('agents', sorted(code), sorted(s.fixed_sections), s.pending);
});

test('registry: plugins of the newest version are the marketplace', () => {
  const names = JSON.parse(read('.claude-plugin/marketplace.json')).plugins.map((p: { name: string }) => p.name) as string[];
  const s = stateOf(LATEST);
  assertSynced('plugins', sorted(names), sorted(s.plugins), s.pending);
});

test('registry: one entry per released version, the newest keyed by the repo version, tags at their commits', () => {
  const ids = REGISTRY.map((v) => v.id);
  for (const m of read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)) assert.ok(ids.includes(m[1] as string), `CHANGELOG.md has ${m[1]} but the registry does not`);
  assert.deepEqual(ids.slice(0, 2), ['kwcantrell', '0.2.0']);
  const last = REGISTRY[REGISTRY.length - 1];
  if (last?.id === 'unreleased') {
    assert.equal(last.plugin_version, REPO_VERSION, 'the [Unreleased] entry carries the repo version');
    assert.equal(REGISTRY[REGISTRY.length - 2]?.id, REPO_VERSION, 'the entry before [Unreleased] is the repo version');
  } else {
    assert.equal(last?.id, REPO_VERSION);
  }
  for (const v of REGISTRY) {
    for (const c of v.changes) {
      assert.ok(c.down.kind !== 'refused' || c.down.text.length > 0, `${v.id} ${c.area}:${c.name}`);
      assert.notEqual(c.up.kind, 'refused', `${v.id} ${c.area}:${c.name}: only a downgrade is refused`);
    }
    if (v.tag === undefined) continue;
    const p = spawnSync('git', ['rev-parse', '-q', '--verify', `${v.tag}^{commit}`], { cwd: CHECKOUT, encoding: 'utf8' });
    if (p.status === 0) assert.equal(p.stdout.trim(), v.commit, `${v.tag} is at ${p.stdout.trim()}`);
  }
});

test("registry: the factory CLI's migrate-repo knows the same versions, keys and fields", () => {
  const p = spawnSync(process.execPath, [join(FACTORY, 'src', 'cli.ts'), 'migrate-repo', '--versions'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const plumbing = JSON.parse(p.stdout) as { id: string; config_keys: string[]; job_fields: string[] }[];
  assert.deepEqual(plumbing.map((v) => v.id), REGISTRY.map((v) => v.id));
  for (const v of plumbing) {
    const s = stateOf(v.id);
    assert.deepEqual(sorted(v.config_keys), sorted(s.config_keys), `${v.id} factory.json keys`);
    assert.deepEqual(sorted(v.job_fields), sorted(s.job_fields), `${v.id} job.json fields`);
  }
});

test('an install resolves to a registry version by its release commit, else by its version', () => {
  assert.equal(installedAt('0.4.0', V040, 'software-factory'), '0.4.0');
  assert.equal(installedAt('0.4.0', null, 'software-factory'), '0.4.0');
  assert.equal(installedAt('0.4.0', 'f'.repeat(40), 'software-factory'), 'unreleased');
  assert.equal(installedAt('0.3.1', null, 'software-factory'), '0.3.1');
  assert.equal(installedAt('9.9.9', null, 'software-factory'), null);
  assert.equal(installedAt('0.1.0', null, 'kwcantrell-plugins'), 'kwcantrell');
});

// ---------------------------------------------------------------- sandbox

interface Box {
  dir: string;
  repo: string;
  fdir: string;
  claude: string;
  bin: string;
  log: string;
  env: Env;
  git: (args: string[], cwd?: string) => string;
  /** The factory CLI from this checkout, as a subprocess. */
  factory: (args: string[], cli?: string) => { status: number | null; stdout: string; stderr: string };
  migrate: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  install: (plugins: Record<string, { version: string; sha?: string; path?: string; scope?: string }>) => void;
  /** Every `claude` call the fake recorded, as argv lists. */
  calls: () => string[][];
}

function box(fn: (b: Box) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-doctor-migrate-')));
    const repo = join(dir, 'repo');
    const claude = join(dir, 'claude');
    const bin = join(dir, 'bin');
    const log = join(dir, 'claude-calls.jsonl');
    for (const d of [repo, claude, bin, join(dir, 'home')]) mkdirSync(d, { recursive: true });
    const env: Env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GIT_') || k.startsWith('FACTORY_') || k.toLowerCase().startsWith('npm_') || k.startsWith('CLAUDE')) continue;
      env[k] = v;
    }
    Object.assign(env, {
      HOME: join(dir, 'home'),
      CLAUDE_CONFIG_DIR: claude,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      FACTORY_DIR: join(repo, 'factory'),
      npm_config_cache: join(dir, 'npm-cache'),
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      FAKE_CLAUDE_LOG: log,
    });
    // A fake `claude` that records its argv and fails when FAKE_CLAUDE_FAIL names its subcommand.
    writeFileSync(
      join(bin, 'claude'),
      `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nrequire('node:fs').appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(a) + '\\n');\nif (process.env.FAKE_CLAUDE_FAIL && a.join(' ').includes(process.env.FAKE_CLAUDE_FAIL)) { console.error('failed: ' + a.join(' ')); process.exit(3); }\nconsole.log('done: ' + a.join(' '));\n`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const git = (args: string[], cwd = repo): string => {
      const p = spawnSync('git', args, { cwd, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
      assert.equal(p.status, 0, `git ${args.join(' ')}: ${p.stderr}`);
      return p.stdout.trim();
    };
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'README.md'), 'test\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'initial']);
    const b: Box = {
      dir,
      repo,
      fdir: join(repo, 'factory'),
      claude,
      bin,
      log,
      env,
      git,
      factory: (args, cli = join(FACTORY, 'src', 'cli.ts')) => {
        const p = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
        return { status: p.status, stdout: p.stdout, stderr: p.stderr };
      },
      migrate: async (args) => {
        let stdout = '';
        let stderr = '';
        const code = await run(['migrate', ...args], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env, cwd: repo });
        return { code, stdout, stderr };
      },
      install: (plugins) => {
        const records: Record<string, unknown[]> = {};
        for (const [id, p] of Object.entries(plugins)) {
          records[id] = [{ scope: p.scope ?? 'project', projectPath: repo, installPath: p.path ?? (id.startsWith('factory@') ? FACTORY : DOCTOR), version: p.version, ...(p.sha ? { gitCommitSha: p.sha } : {}) }];
        }
        mkdirSync(join(claude, 'plugins'), { recursive: true });
        writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), `${JSON.stringify({ version: 2, plugins: records }, null, 2)}\n`);
      },
      calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    };
    try {
      await fn(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** This checkout's plugins, installed as the newest version (a commit after the last release). */
const CURRENT = { 'factory@software-factory': { version: REPO_VERSION, sha: 'f'.repeat(40) }, 'factory-doctor@software-factory': { version: REPO_VERSION, sha: 'f'.repeat(40) } };

/** A fixture's factory dir (written by the Python CLI), with the worktrees of its active jobs. */
function fromFixture(b: Box, commit: string): void {
  const src = join(FIXTURES, `upgrade-${commit}`);
  cpSync(join(src, 'factory'), b.fdir, { recursive: true });
  if (existsSync(join(src, 'factory.json'))) cpSync(join(src, 'factory.json'), join(b.repo, 'factory.json'));
  const base = b.git(['rev-parse', 'HEAD']);
  for (const id of readdirSync(join(b.fdir, 'jobs'))) {
    const path = join(b.fdir, 'jobs', id, 'job.json');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('<FACTORY>', b.fdir).replaceAll('<BASE>', base));
  }
  for (const id of ['002-build-job', '003-ship-job']) b.git(['worktree', 'add', '-q', '-b', `factory/${id}`, join(b.fdir, 'worktrees', id), base]);
  const wt = join(b.fdir, 'worktrees', '003-ship-job');
  writeFileSync(join(wt, 'shipped.txt'), 'x\n');
  b.git(['add', 'shipped.txt'], wt);
  b.git(['commit', '-q', '-m', 'shipped'], wt);
}

/** Every file under dir and its content, minus git's own object store, logs, index and lock files. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (/(^|\/)\.git\/(objects|logs)(\/|$)|\.lock$|(^|\/)\.git\/index$|npm-cache/.test(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.set(rel, readFileSync(p, 'latin1'));
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------- dry run and --apply (the old factory upgrade flows)

test('a dry run on a factory dir from the Python CLI plans the plugins first, then the repo, and writes nothing', box(async (b) => {
  fromFixture(b, '979c870');
  b.install({ 'factory@software-factory': { version: '0.4.0', sha: V040 }, 'factory-doctor@software-factory': { version: '0.4.0', sha: V040 } });
  const before = snapshot(b.dir);
  const { code, stdout, stderr } = await b.migrate([]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(snapshot(b.dir), before, 'the dry run changed a file');
  assert.match(stdout, /^factory-doctor migrate: .* \(dry run: nothing was written\)\n {2}repo: {4}kwcantrell \(/);
  assert.match(stdout, /\n {2}plugins: 0\.4\.0 \(/);
  assert.match(stdout, /\n {2}target: {2}unreleased .* the latest this factory-doctor knows\n {2}move: {4}upgrade: the plugins first, then the repo\n/);
  assert.match(stdout, /factory\/\.lock: the Python CLI's lock file: at most 0\.2\.0/);
  const plan = stdout.slice(stdout.indexOf('plan, in order:'));
  assert.match(plan, /^ {2}1\. \[plugin\] update every installed software-factory plugin to unreleased, together/m);
  assert.match(plan, /runs: claude plugin marketplace update software-factory\n.*runs: claude plugin update factory-doctor@software-factory\n.*runs: claude plugin update factory@software-factory\n/s);
  for (const step of ['remove .lock', 'replace index.html with the current dashboard', 'create .gitignore', 'jobs/001-intake-job/job.json: add followups ([])']) {
    assert.match(plan, new RegExp(`\\d+\\. \\[automatic\\] ${step.replace(/[.()[\]]/g, '\\$&')}`));
  }
  assert.match(plan, new RegExp(`files: ${b.fdir}/jobs/004-done-job/job\\.json\\n +why: job\\.json fields the current CLI writes`));
  assert.ok(plan.indexOf('[plugin]') < plan.indexOf('[automatic]'));
  assert.match(stdout, /next: factory-doctor migrate --update-plugins shows the plugin commands/);
  assert.match(stdout, /next: factory-doctor migrate --apply makes the automatic repo steps/);
  const json = await b.migrate(['--json']);
  const p = JSON.parse(json.stdout);
  assert.equal(p.direction, 'upgrade');
  assert.deepEqual(p.from, { repo: 'kwcantrell', plugins: '0.4.0', used: 'kwcantrell' });
  assert.equal(p.steps[0].kind, 'plugin');
  assert.deepEqual(p.steps[0].commands[0], ['plugin', 'marketplace', 'update', 'software-factory']);
}));

for (const commit of ['979c870', 'd7923b8']) {
  test(`--apply on a factory dir from ${commit}: backups first, the factory CLI rewrites it, status and stats as before, nothing automatic left`, box(async (b) => {
    fromFixture(b, commit);
    b.install(CURRENT);
    const index = readFileSync(join(b.fdir, 'index.html'));
    const { code, stdout, stderr } = await b.migrate(['--apply']);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^factory-doctor migrate --apply: /);
    assert.match(stdout, /applying \(the automatic repo steps\):\n {2}1\. \[automatic\] remove \.lock/);
    const backup = /^backup of the originals: (.*)$/m.exec(stdout)?.[1] as string;
    assert.ok(backup.startsWith(join(b.fdir, 'upgrade-backup-')), stdout);
    assert.deepEqual(readFileSync(join(backup, 'index.html')), index);
    assert.deepEqual(readFileSync(join(b.fdir, 'index.html')), readFileSync(join(FACTORY, 'dashboard', 'index.html')));
    assert.equal(existsSync(join(b.fdir, '.lock')), false);
    for (const id of readdirSync(join(b.fdir, 'jobs'))) assert.deepEqual(JSON.parse(readFileSync(join(b.fdir, 'jobs', id, 'job.json'), 'utf8')).followups !== undefined, true);
    const left = stdout.slice(stdout.indexOf('left (plan again):'));
    assert.doesNotMatch(left, /\[automatic\]/);
    assert.match(stdout, /only manual or plugin steps are left: they are yours\n$|nothing left\n$/);
    const expected = (n: string): string => readFileSync(join(FIXTURES, `upgrade-${commit}`, 'expected', n), 'utf8');
    assert.equal(b.factory(['status']).stdout, expected('status.txt'));
    assert.equal(b.factory(['stats']).stdout, expected('stats.txt'));
    assert.equal(b.factory(['followup', 'list', '--all']).status, 0);
    // Again: nothing to do, nothing changes.
    const again = snapshot(b.dir);
    const second = await b.migrate([]);
    assert.doesNotMatch(second.stdout, /\[automatic\]/);
    assert.deepEqual(snapshot(b.dir), again);
  }));
}

test('--apply is refused when the factory plugin is not installed, and changes nothing', box(async (b) => {
  fromFixture(b, '979c870');
  b.install({ 'factory-doctor@software-factory': CURRENT['factory-doctor@software-factory'] });
  const before = snapshot(b.dir);
  const dry = await b.migrate([]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /note: the factory plugin \(factory@software-factory\) is not installed for this repo/);
  const { code, stdout, stderr } = await b.migrate(['--apply']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^factory-doctor: the factory plugin \(factory@software-factory\) is not installed for this repo.*claude plugin install factory@software-factory --scope project/);
  assert.deepEqual(snapshot(b.dir), before);
}));

test('--apply with a factory plugin older than migrate-repo says to update the plugins first', box(async (b) => {
  fromFixture(b, 'd7923b8');
  const old = join(b.dir, 'factory-0.4.0');
  mkdirSync(old);
  const p = spawnSync('sh', ['-c', `git -C '${CHECKOUT}' archive ${V040} plugins/factory | tar -x -C '${old}'`]);
  if (p.status !== 0) return; // no history (a shallow clone): nothing to compare against
  b.install({ 'factory@software-factory': { version: '0.4.0', sha: V040, path: join(old, 'plugins', 'factory') }, 'factory-doctor@software-factory': CURRENT['factory-doctor@software-factory'] });
  const { code, stderr } = await b.migrate(['--apply']);
  assert.equal(code, 1);
  assert.match(stderr, /cannot plan the repo steps .* it is older than this factory-doctor; update the plugins first/);
}));

test('settings: project and local switch on --apply; user only with --scope user, else a manual step naming it', box(async (b) => {
  b.install(CURRENT);
  const old = { enabledPlugins: { 'factory@kwcantrell-plugins': true, 'x@y': false } };
  const project = join(b.repo, '.claude', 'settings.json');
  const user = join(b.claude, 'settings.json');
  mkdirSync(dirname(project), { recursive: true });
  writeFileSync(project, `${JSON.stringify(old, null, 2)}\n`);
  writeFileSync(user, `${JSON.stringify(old, null, 2)}\n`);
  chmodSync(user, 0o600);
  const dry = await b.migrate([]);
  assert.match(dry.stdout, /\[automatic\] project settings: enabledPlugins: "factory@kwcantrell-plugins": true -> "factory@software-factory": true/);
  assert.match(dry.stdout, /\[manual\] user settings \(.*\) still enable the old plugin; to switch them run `factory-doctor migrate --apply --scope user`/);
  const applied = await b.migrate(['--apply']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(JSON.parse(readFileSync(project, 'utf8')).enabledPlugins, { 'factory@software-factory': true, 'x@y': false });
  assert.deepEqual(JSON.parse(readFileSync(user, 'utf8')), old, 'user settings changed without --scope user');
  const settingsBackup = /^backup of the settings files \(and factory\.json\): (.*)$/m.exec(applied.stdout)?.[1] as string;
  assert.ok(settingsBackup.startsWith(join(b.repo, '.git', 'factory-upgrade-backup-')), applied.stdout);
  assert.equal(statSync(settingsBackup).mode & 0o777, 0o700);
  const scoped = await b.migrate(['--apply', '--scope', 'user']);
  assert.equal(scoped.code, 0, scoped.stderr);
  assert.deepEqual(JSON.parse(readFileSync(user, 'utf8')).enabledPlugins, { 'factory@software-factory': true, 'x@y': false });
  assert.equal(statSync(user).mode & 0o777, 0o600);
}));

test('a project agent without the doctor section is a manual step pointing to /factory:agents', box(async (b) => {
  b.install({ 'factory@software-factory': { version: '0.4.0', sha: V040 }, 'factory-doctor@software-factory': CURRENT['factory-doctor@software-factory'] });
  mkdirSync(join(b.repo, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(b.repo, '.claude', 'agents', 'factory-builder.md'), '---\nname: factory-builder\n---\n<!-- fixed:handoff -->x<!-- /fixed -->\n');
  writeFileSync(join(b.repo, '.claude', 'agents', 'factory-reviewer-security.md'), '---\nname: factory-reviewer-security\n---\n<!-- fixed:role -->x<!-- /fixed -->\n');
  const { code, stdout } = await b.migrate([]);
  assert.equal(code, 0);
  assert.match(stdout, /\[manual\] \.claude\/agents\/factory-builder\.md: project agents of this station fail `factory agents check`.*run \/factory:agents, or `factory agents new builder --force`/);
  assert.match(stdout, /why: fixed section 'doctor': the factory-doctor check runs first \(030\) \(unreleased\)/);
  assert.doesNotMatch(stdout, /factory-reviewer-security\.md: project agents/, 'reviewers gained no section');
}));

test('after the plugins are updated, the repo still gets its own manual steps (an agent without the doctor section, remote signing)', box(async (b) => {
  // The plugins were updated first (the upgrade order), so they are at the target already; the repo is not.
  b.install(CURRENT);
  mkdirSync(join(b.repo, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(b.repo, '.claude', 'agents', 'factory-builder.md'), '---\nname: factory-builder\n---\n<!-- fixed:handoff -->x<!-- /fixed -->\n');
  writeFileSync(join(b.repo, 'factory.json'), `${JSON.stringify({ remote: { url: '../state.git', branch: 'factory-state', allowed_signers: '.github/allowed_signers' } })}\n`);
  const { code, stdout, stderr } = await b.migrate([]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\n {2}plugins: unreleased /);
  assert.match(stdout, /\[manual\] \.claude\/agents\/factory-builder\.md: project agents of this station fail `factory agents check`.*run \/factory:agents/);
  assert.match(stdout, /\[manual\] set up SSH signing for this repo: git config gpg\.format ssh/);
  assert.doesNotMatch(stdout, /nothing to do/);
  assert.match(stdout, /nothing to apply: only the steps above, which are yours/);
  // Once the repo has them, nothing is left.
  writeFileSync(join(b.repo, '.claude', 'agents', 'factory-builder.md'), '---\nname: factory-builder\n---\n<!-- fixed:handoff -->x<!-- /fixed -->\n<!-- fixed:doctor -->y<!-- /fixed -->\n');
  b.git(['config', 'gpg.format', 'ssh']);
  b.git(['config', 'user.signingkey', 'ssh-ed25519 AAAA test']);
  const again = await b.migrate([]);
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /\[manual\]/);
}));

test('usage errors exit 2 with the message on stderr', box(async (b) => {
  for (const args of [['--apply', '--update-plugins'], ['--confirmed'], ['--to', '7.7.7'], ['--scope', 'everywhere'], ['extra'], ['--repo', join(b.dir, 'nowhere')]]) {
    const { code, stdout, stderr } = await b.migrate(args);
    assert.equal(code, 2, `${args.join(' ')}: ${stderr}`);
    assert.equal(stdout, '');
    assert.match(stderr, /^factory-doctor: .+\nRun 'factory-doctor --help' for usage\.\n$/);
  }
  mkdirSync(join(b.dir, 'plain'));
  const { code, stderr } = await b.migrate(['--repo', join(b.dir, 'plain')]);
  assert.equal(code, 2);
  assert.match(stderr, /plain is not inside a git checkout/);
}));

// ---------------------------------------------------------------- downgrades

/** A factory dir and factory.json written by this checkout's CLI. */
function currentFactory(b: Box, config: Record<string, unknown>): void {
  writeFileSync(join(b.repo, 'factory.json'), `${JSON.stringify(config, null, 2)}\n`);
  for (const args of [['init'], ['new', 'First job'], ['new', 'Second job'], ['followup', 'add', '1', '--by', 'builder', 'a later fix']]) {
    const p = b.factory(args);
    assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`);
  }
  writeFileSync(join(b.fdir, 'jobs', '002-second-job', 'task.md'), '# A job\n\n## Acceptance criteria\n\n1. It works.\n');
  assert.equal(b.factory(['start', '2']).status, 0);
}

const hasV040 = spawnSync('git', ['cat-file', '-e', `${V040}^{commit}`], { cwd: CHECKOUT }).status === 0;

test('downgrade to 0.4.0: the repo first, then the plugins by hand; the 0.4.0 CLI then runs status, followup list and stats', { skip: !hasV040 && 'needs the v0.4.0 commit (full history)' }, box(async (b) => {
  b.install(CURRENT);
  // "remote": null is the documented local default: no remote factory, so nothing to refuse.
  currentFactory(b, { max_review_rounds: 2, remote: null, advisor: { share: false } });
  // The 0.4.0 CLI, from git show v0.4.0:plugins/factory, in a temp dir.
  const old = join(b.dir, 'v0.4.0');
  mkdirSync(old);
  const x = spawnSync('sh', ['-c', `git -C '${CHECKOUT}' archive ${V040} plugins/factory | tar -x -C '${old}'`], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  const cli040 = join(old, 'plugins', 'factory', 'src', 'cli.ts');
  const refusedBefore = b.factory(['status'], cli040);
  assert.equal(refusedBefore.status, 1, 'the 0.4.0 CLI should refuse the current factory.json before the migration');
  assert.match(refusedBefore.stderr, /unknown key '(remote|advisor)'/);

  const dry = await b.migrate(['--to', '0.4.0']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\n {2}repo: {4}unreleased .*\n {2}plugins: unreleased .*\n {2}target: {2}0\.4\.0 .*\n {2}move: {4}downgrade: the repo first, while the newer tools are installed, then the plugins\n/);
  const plan = dry.stdout.slice(dry.stdout.indexOf('plan, in order:'));
  assert.doesNotMatch(dry.stdout, /refused/);
  assert.match(plan, /1\. \[automatic\] factory\.json: remove "remote": null \(0\.4\.0 refuses the key\)/);
  assert.match(plan, /\[automatic\] factory\.json: remove "advisor": \{"share":false\} \(0\.4\.0 refuses the key\)/);
  assert.match(plan, /\[manual\] factory-doctor: not in the target version: uninstall it yourself/);
  assert.match(plan, /\[plugin\] switch the plugins to 0\.4\.0 by hand: Claude Code cannot install a plugin version that is not its marketplace's latest/);
  assert.match(plan, /git -C <dir> checkout v0\.4\.0\n.*claude plugin disable factory-doctor@software-factory\n.*claude plugin disable factory@software-factory\n.*claude --plugin-dir <dir>\/plugins/s);
  assert.ok(plan.indexOf('[automatic]') < plan.indexOf('[plugin]'), 'a downgrade migrates the repo before the plugins');

  const applied = await b.migrate(['--apply', '--to', '0.4.0']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(b.repo, 'factory.json'), 'utf8')), { max_review_rounds: 2 });
  const backup = /^backup of the settings files \(and factory\.json\): (.*)$/m.exec(applied.stdout)?.[1] as string;
  assert.deepEqual(JSON.parse(readFileSync(join(backup, 'config', 'factory.json'), 'utf8')).advisor, { share: false });
  assert.equal(JSON.parse(readFileSync(join(backup, 'config', 'factory.json'), 'utf8')).remote, null);
  assert.doesNotMatch(applied.stdout.slice(applied.stdout.indexOf('left')), /\[automatic\]/);

  for (const args of [['status'], ['followup', 'list'], ['stats']]) {
    const p = b.factory(args, cli040);
    assert.equal(p.status, 0, `0.4.0 ${args.join(' ')}: ${p.stderr}`);
    assert.equal(p.stderr, '');
  }
  assert.match(b.factory(['status'], cli040).stdout, /^001-first-job +intake +active/m);
  assert.match(b.factory(['followup', 'list'], cli040).stdout, /001-first-job #1 \(builder, intake\)\n {2}a later fix/);
}));

test('downgrade refused up front: a remote factory relies on signing (exit 1, nothing changed)', box(async (b) => {
  b.install(CURRENT);
  writeFileSync(join(b.repo, 'factory.json'), `${JSON.stringify({ remote: { url: '../state.git', branch: 'factory-state', allowed_signers: '.github/allowed_signers' } })}\n`);
  const before = snapshot(b.dir);
  for (const args of [['--to', '0.4.0'], ['--to', '0.4.0', '--apply']]) {
    const { code, stdout, stderr } = await b.migrate(args);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    if (args.includes('--apply')) assert.match(stderr, /^factory-doctor: refused:\n {2}- factory\.json key 'remote'/);
    else {
      assert.match(stderr, /\n\nrefused: migrate does not make this move \(nothing was changed\):\n {2}- factory\.json key 'remote': a remote factory.*: the target has no remote factory: .*signed history \(remote\.allowed_signers\).*Stay on this version, or stop using the remote factory first/);
      assert.ok(stderr.indexOf('refused:') < stderr.indexOf('found:'), 'the refusal comes first');
    }
  }
  assert.deepEqual(snapshot(b.dir), before);
}));

test('downgrade refused: an unfinished job with a recorded commit protecting its merge', box(async (b) => {
  b.install(CURRENT);
  currentFactory(b, {});
  const path = join(b.fdir, 'jobs', '002-second-job', 'job.json');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  job.head = 'c'.repeat(40);
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`);
  const { code, stderr } = await b.migrate(['--to', '0.4.0']);
  assert.equal(code, 1);
  assert.match(stderr, /- job\.json field 'head'.*: an unfinished job that records it is refused: the target would merge whatever the branch holds\. Finish the job first .* \(factory\/jobs\/002-second-job\/job\.json\)/);
}));

test('refused: moving to the Python CLI (0.2.0 or kwcantrell)', box(async (b) => {
  b.install(CURRENT);
  for (const to of ['0.2.0', 'kwcantrell']) {
    const { code, stderr } = await b.migrate(['--to', to]);
    assert.equal(code, 1);
    assert.match(stderr, /the Python CLI \(kwcantrell-plugins and 0\.2\.0\) is retired: migrate never moves a repo before 0\.3\.0/);
  }
}));

// ---------------------------------------------------------------- --update-plugins

test('--update-plugins prints the exact commands and runs nothing without --confirmed', box(async (b) => {
  b.install({ 'factory@software-factory': { version: '0.4.0', sha: V040 }, 'factory-doctor@software-factory': { version: '0.4.0', sha: V040 }, 'other@elsewhere': { version: '1.0.0' } });
  const { code, stdout } = await b.migrate(['--update-plugins']);
  assert.equal(code, 0);
  assert.equal(
    stdout,
    'would run, in order (nothing was run; add --confirmed to run them):\n  claude plugin marketplace update software-factory\n  claude plugin update factory-doctor@software-factory\n  claude plugin update factory@software-factory\n\nthen restart Claude Code, and run factory-doctor migrate again for the repo steps\n',
  );
  assert.deepEqual(b.calls(), []);
}));

test('--update-plugins --confirmed runs exactly those commands, for installed plugins only, and says to restart', box(async (b) => {
  b.install({ 'factory@software-factory': { version: '0.4.0', sha: V040 }, 'factory-docs@software-factory': { version: '0.4.0', sha: V040, path: join(CHECKOUT, 'plugins', 'factory-docs') }, 'other@elsewhere': { version: '1.0.0' } });
  const { code, stdout, stderr } = await b.migrate(['--update-plugins', '--confirmed']);
  assert.equal(code, 0, stderr);
  assert.deepEqual(b.calls(), [
    ['plugin', 'marketplace', 'update', 'software-factory'],
    ['plugin', 'update', 'factory-docs@software-factory'],
    ['plugin', 'update', 'factory@software-factory'],
  ]);
  assert.match(stdout, /^ok: claude plugin marketplace update software-factory\n {4}done: plugin marketplace update software-factory\nok: claude plugin update factory-docs@software-factory\n/);
  assert.match(stdout, /Restart Claude Code so the updated plugins load/);
}));

test('--update-plugins --confirmed stops at the first failure and exits 1', box(async (b) => {
  b.install({ 'factory@software-factory': { version: '0.4.0', sha: V040 } });
  b.env.FAKE_CLAUDE_FAIL = 'marketplace update';
  const { code, stdout, stderr } = await b.migrate(['--update-plugins', '--confirmed']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^failed \(exit 3\): claude plugin marketplace update software-factory\n {4}failed: plugin marketplace update software-factory\nnot run: claude plugin update factory@software-factory\n/);
  assert.deepEqual(b.calls(), [['plugin', 'marketplace', 'update', 'software-factory']]);
}));

test('--update-plugins to an older version is refused with the manual steps, and runs nothing', box(async (b) => {
  b.install(CURRENT);
  const { code, stdout, stderr } = await b.migrate(['--update-plugins', '--confirmed', '--to', '0.4.0']);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^factory-doctor: refused: --update-plugins cannot move the plugins to 0\.4\.0\.\n {2}Claude Code cannot install a plugin version that is not its marketplace's latest/);
  assert.match(stderr, /git clone https:\/\/github\.com\/kwcantrell\/software-factory <dir> && git -C <dir> checkout v0\.4\.0/);
  assert.deepEqual(b.calls(), []);
}));

test('--update-plugins with nothing installed has nothing to update and never installs', box(async (b) => {
  const { code, stdout } = await b.migrate(['--update-plugins', '--confirmed']);
  assert.equal(code, 0);
  assert.match(stdout, /no software-factory plugin is installed for this repo: nothing to update \(migrate never installs one\)/);
  assert.deepEqual(b.calls(), []);
}));
