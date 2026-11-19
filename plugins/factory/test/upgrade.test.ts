// `factory migrate-repo` (the plumbing `factory-doctor migrate` runs; `factory upgrade` moved there),
// driven as a subprocess. Every behaviour the old `factory upgrade` tests covered is kept here,
// asserted on the plumbing's JSON report; factory-doctor's test/migrate.test.ts covers the same flows
// through `factory-doctor migrate`, and the downgrades. fixtures/upgrade-<commit>/ are factory dirs written by the
// original Python CLI at that commit (979c870: no follow-ups; d7923b8: follow-ups and specs_dir), with
// jobs at intake, build (with a worktree), ship (with a worktree) and done; expected/ holds that CLI's
// `status` and `stats` output. fixtures/upgrade-README.md says how they were made. Every test runs in
// a temporary repo with FACTORY_DIR, HOME and CLAUDE_CONFIG_DIR inside it: none touches ~/.claude.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLUGIN, Repo, withRepo } from './helpers.ts';

const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const DASHBOARD = readFileSync(join(PLUGIN, 'dashboard', 'index.html'));
const COMMITS = ['979c870', 'd7923b8'] as const;
const OLD_KEY = 'factory@' + 'kwcantrell-plugins';
const NEW_KEY = 'factory@software-factory';

/** The keys of a job.json the current CLI writes, in its order. */
const CURRENT_ORDER = (() => {
  const fresh = new Repo();
  try {
    return Object.keys(fresh.job(fresh.newJob()));
  } finally {
    fresh.cleanup();
  }
})();

/** Point the repo at its own Claude config dir, and return it. */
function claudeDir(r: Repo): string {
  const dir = join(r.tmp, 'claude-config');
  mkdirSync(dir, { recursive: true });
  r.env = { ...r.env, CLAUDE_CONFIG_DIR: dir };
  return dir;
}

/** Install a fixture's factory dir into the repo, its active jobs' worktrees and branches included. */
function fromFixture(r: Repo, commit: string): void {
  claudeDir(r);
  const src = join(FIXTURES, `upgrade-${commit}`);
  cpSync(join(src, 'factory'), r.fdir, { recursive: true });
  if (existsSync(join(src, 'factory.json'))) cpSync(join(src, 'factory.json'), join(r.repo, 'factory.json'));
  const base = r.git(['rev-parse', 'HEAD']);
  for (const id of readdirSync(join(r.fdir, 'jobs'))) {
    const path = join(r.fdir, 'jobs', id, 'job.json');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('<FACTORY>', r.fdir).replaceAll('<BASE>', base));
  }
  for (const id of ['002-build-job', '003-ship-job']) {
    const wt = join(r.fdir, 'worktrees', id);
    r.git(['worktree', 'add', '-q', '-b', `factory/${id}`, wt, base]);
  }
  r.commitIn('003-ship-job', 'shipped.txt');
}

/**
 * True for what git itself writes and rewrites on its own under a `.git` dir: lock files, the object
 * store, reflogs and the index. Anything else in there (a backup dir, a pointer file) is the code
 * under test's doing and stays visible.
 */
function isGitVolatile(rel: string): boolean {
  const parts = rel.split('/');
  const at = parts.lastIndexOf('.git');
  if (at < 0) return false;
  const inside = parts.slice(at + 1);
  const name = inside[inside.length - 1] ?? '';
  return name.endsWith('.lock') || (name === 'index' && inside.length === 1) || inside[0] === 'objects' || inside[0] === 'logs' ||
    (inside[0] === 'worktrees' && (inside[2] === 'logs' || inside[2] === 'index'));
}

/** Every file under dir (worktrees' .git pointers included) and its content, minus git's own volatile files. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) {
        // Skip a directory only when everything inside it is git-volatile (.git itself is always walked).
        if (!isGitVolatile(`${rel}/x`)) walk(p);
      } else if (!isGitVolatile(rel)) out.set(rel, readFileSync(p, 'latin1'));
    }
  };
  walk(dir);
  return out;
}

/** The version the fixtures and settings tests move from, and the one they move to. */
const FROM = 'kwcantrell';
const TO = 'unreleased';

/** `factory migrate-repo --from FROM --to TO <args>`: stdout (JSON) on success, stderr on a refusal. */
function migrate(r: Repo, args: string[], status = 0, opts: { cwd?: string; from?: string; to?: string } = {}): string {
  const p = r.factory(['migrate-repo', '--from', opts.from ?? FROM, '--to', opts.to ?? TO, ...args], opts);
  assert.equal(p.status, status, p.stdout + p.stderr);
  if (status !== 0) assert.equal(p.stdout, '', 'a refusal prints nothing on stdout');
  return status === 0 ? p.stdout : p.stderr;
}

const json = (r: Repo, args: string[], opts: { from?: string; to?: string } = {}): Record<string, any> => JSON.parse(migrate(r, args, 0, opts));
const changesOf = (rep: Record<string, any>): string[] => rep.runtime.changes.map((c: { change: string }) => c.change);
const expected = (commit: string, name: string): string =>
  readFileSync(join(FIXTURES, `upgrade-${commit}`, 'expected', name), 'utf8');

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- command

test('factory upgrade moved: it names factory-doctor migrate and exits 2, whatever its arguments', withRepo((r) => {
  assert.match(r.ok(['--help']), /^ {2}upgrade +moved: run factory-doctor migrate/m);
  assert.match(r.ok(['--help']), /^ {2}migrate-repo +plumbing for factory-doctor migrate/m);
  for (const args of [[], ['--apply'], ['--apply', '--scope', 'user', '--json']]) {
    const p = r.factory(['upgrade', ...args]);
    assert.equal(p.status, 2);
    assert.equal(p.stdout, '');
    assert.match(p.stderr, /^factory upgrade moved to factory-doctor migrate/);
    assert.ok(p.stderr.includes('-- factory-doctor migrate\n'), p.stderr);
    assert.match(p.stderr, /claude plugin install factory-doctor@software-factory/);
  }
  assert.equal(existsSync(r.fdir), false, 'factory upgrade wrote a factory dir');
}));

test('migrate-repo --help lists its options; --versions prints the version table', withRepo((r) => {
  const help = r.ok(['migrate-repo', '--help']);
  assert.match(help, /^usage: factory migrate-repo \[-h\] \[--from FROM\] \[--to TO\] \[--repo REPO\] \[--apply\] \[--scope \{project,local,user\}\] \[--versions\]/);
  const versions = JSON.parse(r.ok(['migrate-repo', '--versions']));
  assert.deepEqual(versions.map((v: { id: string }) => v.id), ['kwcantrell', '0.2.0', '0.3.0', '0.3.1', '0.4.0', 'unreleased']);
  const current = versions.at(-1);
  assert.deepEqual([...current.config_keys].sort(), Object.keys(JSON.parse(r.ok(['config']))).sort(), 'unreleased = what this CLI accepts');
}));

test('a usage error, an unknown version or a path that is not a git checkout exits 2', withRepo((r) => {
  claudeDir(r);
  let err = migrate(r, ['--scope', 'everywhere'], 2);
  assert.match(err, /invalid choice: 'everywhere'/);
  assert.match(r.factory(['migrate-repo', '--to', TO]).stderr, /required: --from, --to/);
  assert.match(migrate(r, [], 2, { to: '9.9.9' }), /--to: unknown version '9\.9\.9' \(known: kwcantrell, 0\.2\.0/);
  assert.match(migrate(r, [], 2, { from: 'nope' }), /--from: unknown version 'nope'/);
  const outside = join(r.tmp, 'not-a-repo');
  mkdirSync(outside);
  err = migrate(r, ['--repo', outside], 2);
  assert.match(err, /not-a-repo is not inside a git checkout/);
  err = migrate(r, [], 2, { cwd: outside });
  assert.match(err, /is not inside a git checkout/);
  migrate(r, ['--repo', join(r.tmp, 'missing')], 2);
}));

test('a repo that never used the factory has nothing to do, and the dry run creates no factory dir', withRepo((r) => {
  claudeDir(r);
  const rep = json(r, []);
  assert.equal(rep.mode, 'dry-run');
  assert.equal(rep.direction, 'upgrade');
  assert.equal(rep.nothing_to_do, true);
  assert.deepEqual(rep.manual, []);
  assert.equal(existsSync(r.fdir), false);
  json(r, ['--apply']);
  assert.equal(existsSync(r.fdir), false);
}));

// ---------------------------------------------------------------- runtime dir

for (const commit of COMMITS) {
  test(`dry run on a factory dir from ${commit} lists the changes and writes nothing`, withRepo((r) => {
    fromFixture(r, commit);
    const before = snapshot(r.tmp);
    const rep = json(r, []);
    assert.deepEqual(snapshot(r.tmp), before, 'the dry run changed a file');
    assert.ok(rep.found.some((f: string) => /\.lock, the lock file of the Python CLI/.test(f)), rep.found.join('\n'));
    const label = commit === '979c870' ? 'before follow-ups' : 'with follow-ups';
    assert.ok(rep.found.some((f: string) => new RegExp(`dashboard \\(index\\.html\\) from the (original )?Python CLI.*${label}`).test(f)));
    assert.deepEqual(rep.settings.flatMap((s: { changes: string[] }) => s.changes), []);
    assert.equal(rep.runtime.dir, r.fdir);
    const changes = changesOf(rep);
    assert.ok(changes.some((c) => c.startsWith('remove .lock ')));
    assert.ok(changes.includes('replace index.html with the current dashboard'));
    assert.ok(changes.some((c) => c.startsWith('create .gitignore')));
    assert.deepEqual(rep.runtime.changes.find((c: { change: string }) => c.change.startsWith('remove .lock')).file, '.lock');
    if (commit === '979c870') {
      for (const id of ['001-intake-job', '002-build-job', '003-ship-job', '004-done-job']) {
        assert.ok(changes.includes(`jobs/${id}/job.json: add followups ([])`), changes.join('\n'));
        assert.ok(rep.runtime.changes.some((c: { file: string }) => c.file === `jobs/${id}/job.json`));
      }
      assert.ok(rep.found.includes('runtime dir: 4 job(s) written by an older CLI (missing followups)'));
    } else {
      assert.equal(changes.some((c) => c.includes('job.json: add')), false);
    }
    assert.equal(rep.changes, changes.length);
    assert.equal(rep.nothing_to_do, false);
  }));

  test(`--apply migrates a factory dir from ${commit}; status, followup list and stats work after`, withRepo((r) => {
    fromFixture(r, commit);
    const jobsBefore = Object.fromEntries(
      readdirSync(join(r.fdir, 'jobs')).map((id) => [id, readFileSync(join(r.jobDir(id), 'job.json'), 'utf8')]),
    );
    const indexBefore = readFileSync(join(r.fdir, 'index.html'));
    const rep = json(r, ['--apply']);
    assert.equal(rep.mode, 'apply');
    const backup = rep.backup as string;
    assert.ok(backup && backup.startsWith(join(r.fdir, 'upgrade-backup-')), backup);

    // The dashboard, .gitignore and lock file.
    assert.deepEqual(readFileSync(join(r.fdir, 'index.html')), DASHBOARD);
    assert.equal(readFileSync(join(r.fdir, '.gitignore'), 'utf8'), '# Factory runtime state: job records, worktrees, dashboard copy.\n*\n');
    assert.equal(existsSync(join(r.fdir, '.lock')), false);
    // The originals, in the backup.
    assert.deepEqual(readFileSync(join(backup, 'index.html')), indexBefore);
    assert.ok(existsSync(join(backup, '.lock')));

    // Each job gains the fields it lacked, where the current CLI writes them; nothing else changes.
    for (const [id, text] of Object.entries(jobsBefore)) {
      const now = readFileSync(join(r.jobDir(id), 'job.json'), 'utf8');
      const old = JSON.parse(text);
      if (commit === 'd7923b8') {
        assert.equal(now, text, `${id} already had every field and must not be rewritten`);
        assert.equal(existsSync(join(backup, 'jobs', id)), false);
        continue;
      }
      const job = JSON.parse(now);
      assert.deepEqual(job.followups, []);
      assert.deepEqual({ ...job, followups: undefined }, { ...old, followups: undefined });
      assert.deepEqual(Object.keys(job), CURRENT_ORDER, `${id} keys are in the current CLI's order`);
      assert.equal(readFileSync(join(backup, 'jobs', id, 'job.json'), 'utf8'), text);
    }

    // The same jobs, stages and rounds as the old CLI showed.
    assert.equal(r.ok(['status']), expected(commit, 'status.txt'));
    assert.equal(r.ok(['stats']), expected(commit, 'stats.txt'));
    const fu = r.ok(['followup', 'list', '--all']);
    if (commit === '979c870') assert.equal(fu, 'no follow-ups\n');
    else assert.match(fu, /002-build-job #1 \(builder, build\)\n {2}Ünïcode follow-up\n/);
    // Active jobs keep their worktree and branch, and carry on.
    for (const id of ['002-build-job', '003-ship-job']) {
      const shown = r.ok(['status', id]);
      assert.match(shown, new RegExp(`worktree: ${join(r.fdir, 'worktrees', id)}\\n`));
      assert.match(shown, new RegExp(`branch: {3}factory/${id} `));
    }
    r.commitIn('002-build-job');
    r.write('002-build-job', 'build.md', '# built\n');
    r.ok(['built', '2']);
    assert.equal(r.job('002-build-job').stage, 'proof');
  }));

  test(`a second --apply on a dir from ${commit} has nothing to do and changes no file`, withRepo((r) => {
    fromFixture(r, commit);
    json(r, ['--apply']);
    const before = snapshot(r.tmp);
    const rep = json(r, ['--apply']);
    assert.equal(rep.nothing_to_do, true);
    assert.equal(rep.backup, null);
    assert.deepEqual(snapshot(r.tmp), before);
    assert.equal(json(r, []).nothing_to_do, true);
  }));
}

test('a current factory dir that only lacks .gitignore gets one, with nothing to back up', withRepo((r) => {
  claudeDir(r);
  r.newJob();
  rmSync(join(r.fdir, '.gitignore'));
  const rep = json(r, ['--apply'], { from: TO });
  assert.ok(changesOf(rep).some((c) => c.startsWith('create .gitignore')));
  assert.equal(rep.backup, null);
  assert.equal(readdirSync(r.fdir).some((n) => n.startsWith('upgrade-backup-')), false);
  assert.ok(existsSync(join(r.fdir, '.gitignore')));
  assert.equal(json(r, [], { from: TO }).nothing_to_do, true);
}));

test('the d7923b8 fixture keeps factory.json with specs_dir, which the current CLI accepts', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  json(r, ['--apply'], { from: '0.2.0' });
  assert.match(r.ok(['config']), /"specs_dir": "docs\/specs"/);
}));

test('a job.json that does not parse is refused and nothing is changed', withRepo((r) => {
  fromFixture(r, '979c870');
  writeFileSync(join(r.jobDir('001-intake-job'), 'job.json'), '{ not json');
  const before = snapshot(r.tmp);
  assert.match(migrate(r, ['--apply'], 1), /^refused: .*001-intake-job\/job\.json is not valid JSON/);
  assert.deepEqual(snapshot(r.tmp), before);
}));

test('refuses while a live process holds the factory lock', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  writeFileSync(join(r.fdir, '.lock.pid'), `${process.pid}\n`);
  const before = snapshot(r.tmp);
  assert.match(migrate(r, ['--apply'], 1), new RegExp(`^refused: the factory lock .* is held by process ${process.pid}`));
  assert.match(migrate(r, ['--apply'], 1, { from: TO, to: '0.4.0' }), new RegExp(`is held by process ${process.pid}`), 'a downgrade waits too');
  assert.deepEqual(snapshot(r.tmp), before);
  // A lock left by a process that is gone is not a reason to stop.
  writeFileSync(join(r.fdir, '.lock.pid'), '999999999\n');
  json(r, ['--apply']);
}));

const canFlock = spawnSync('flock', ['--version']).status === 0 && existsSync('/proc/locks');

test('refuses while the old CLI holds its flock on .lock', { skip: !canFlock && 'needs flock(1) and /proc/locks' }, withRepo(async (r) => {
  fromFixture(r, '979c870');
  const holder = spawn('flock', [join(r.fdir, '.lock'), '-c', 'echo locked; sleep 30'], { detached: true });
  try {
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    const before = snapshot(r.tmp);
    assert.match(migrate(r, ['--apply'], 1), /^refused: .*\.lock is locked by a running factory command/);
    assert.deepEqual(snapshot(r.tmp), before);
  } finally {
    process.kill(-(holder.pid as number), 'SIGTERM'); // flock and the sleep holding its lock
  }
  await new Promise((resolve) => holder.once('close', resolve));
  json(r, ['--apply']);
}));

// ---------------------------------------------------------------- settings

const PROJECT = (): Record<string, unknown> => ({
  permissions: { allow: ['Bash(git status)'] },
  enabledPlugins: { 'base-setup@kwcantrell-plugins': true, [OLD_KEY]: true, 'other@elsewhere': false },
  extraKnownMarketplaces: {
    'kwcantrell-plugins': { source: { source: 'github', repo: 'kwcantrell/kwcantrell-plugins' } },
  },
  theme: 'dark',
});

test('project scope: the old key becomes factory@software-factory in place; other keys stay', withRepo((r) => {
  claudeDir(r);
  const path = join(r.repo, '.claude', 'settings.json');
  writeJson(path, PROJECT());
  const before = readFileSync(path, 'utf8');
  const dry = json(r, []);
  assert.equal(readFileSync(path, 'utf8'), before, 'the dry run wrote the settings');
  assert.ok(dry.found.includes(`project settings (${path}): ${OLD_KEY} enabled - the original plugin, from kwcantrell/kwcantrell-plugins`), dry.found.join('\n'));
  assert.deepEqual(dry.settings.find((s: { scope: string }) => s.scope === 'project'), {
    scope: 'project',
    file: path,
    selected: true,
    changes: [
      'enabledPlugins: "factory@kwcantrell-plugins": true -> "factory@software-factory": true',
      'extraKnownMarketplaces: add "software-factory" (github kwcantrell/software-factory)',
    ],
  });

  json(r, ['--apply']);
  const text = readFileSync(path, 'utf8');
  assert.equal(
    text,
    `${JSON.stringify(
      {
        permissions: { allow: ['Bash(git status)'] },
        enabledPlugins: { 'base-setup@kwcantrell-plugins': true, [NEW_KEY]: true, 'other@elsewhere': false },
        extraKnownMarketplaces: {
          'kwcantrell-plugins': { source: { source: 'github', repo: 'kwcantrell/kwcantrell-plugins' } },
          'software-factory': { source: { source: 'github', repo: 'kwcantrell/software-factory' } },
        },
        theme: 'dark',
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(json(r, ['--apply']).nothing_to_do, true);
  assert.equal(readFileSync(path, 'utf8'), text);
}));

test('local scope: a false value stays false, another marketplace counts as old, and a tab indent is kept', withRepo((r) => {
  claudeDir(r);
  const path = join(r.repo, '.claude', 'settings.local.json');
  mkdirSync(join(r.repo, '.claude'));
  writeFileSync(path, `${JSON.stringify({ enabledPlugins: { 'factory@my-fork': false, 'x@y': true } }, null, '\t')}\n`);
  const dry = json(r, []);
  assert.ok(dry.found.some((f: string) => /local settings .*: factory@my-fork disabled - marketplace 'my-fork', not software-factory/.test(f)));
  json(r, ['--apply']);
  assert.equal(readFileSync(path, 'utf8'), `{\n\t"enabledPlugins": {\n\t\t"factory@software-factory": false,\n\t\t"x@y": true\n\t}\n}\n`);
}));

test('a scope that already enables factory@software-factory drops the old key and keeps the new value', withRepo((r) => {
  claudeDir(r);
  const path = join(r.repo, '.claude', 'settings.json');
  writeJson(path, { enabledPlugins: { [OLD_KEY]: true, [NEW_KEY]: false } });
  json(r, ['--apply']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabledPlugins: { [NEW_KEY]: false } });
}));

test('user scope changes only with --scope user; otherwise it is a manual step naming the flag', withRepo((r) => {
  const dir = claudeDir(r);
  const path = join(dir, 'settings.json');
  writeJson(path, PROJECT());
  const before = readFileSync(path, 'utf8');
  const rep = json(r, ['--apply']);
  assert.equal(readFileSync(path, 'utf8'), before, 'user settings changed without --scope user');
  assert.ok(rep.manual.some((m: string) => /^user settings \(.*\) still enable the old plugin; to switch them run `factory-doctor migrate --apply --scope user`, which will: enabledPlugins: "factory@kwcantrell-plugins": true -> "factory@software-factory": true; extraKnownMarketplaces: add "software-factory"/.test(m)), rep.manual.join('\n'));
  assert.equal(rep.nothing_to_do, true);

  const applied = json(r, ['--apply', '--scope', 'user']);
  assert.deepEqual(applied.settings.filter((s: { selected: boolean; changes: string[] }) => s.selected && s.changes.length > 0).map((s: { scope: string }) => s.scope), ['user']);
  const now = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(now.enabledPlugins, { 'base-setup@kwcantrell-plugins': true, [NEW_KEY]: true, 'other@elsewhere': false });
  assert.ok(now.extraKnownMarketplaces['software-factory']);
  assert.equal(json(r, []).manual.some((m: string) => m.includes('migrate --apply --scope user')), false);
}));

test('--scope picks the scopes to change; the others become manual steps', withRepo((r) => {
  claudeDir(r);
  const project = join(r.repo, '.claude', 'settings.json');
  const local = join(r.repo, '.claude', 'settings.local.json');
  writeJson(project, { enabledPlugins: { [OLD_KEY]: true } });
  writeJson(local, { enabledPlugins: { [OLD_KEY]: true } });
  const rep = json(r, ['--apply', '--scope', 'local']);
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')).enabledPlugins, { [NEW_KEY]: true });
  assert.deepEqual(JSON.parse(readFileSync(project, 'utf8')).enabledPlugins, { [OLD_KEY]: true });
  assert.ok(rep.manual.some((m: string) => m.includes('run `factory-doctor migrate --apply --scope project`')));
  json(r, ['--apply', '--scope', 'project', '--scope', 'local']);
  assert.deepEqual(JSON.parse(readFileSync(project, 'utf8')).enabledPlugins, { [NEW_KEY]: true });
}));

for (const scope of ['project', 'local', 'user'] as const) {
  test(`a ${scope} settings file that does not parse is refused and never rewritten`, withRepo((r) => {
    const dir = claudeDir(r);
    const path = scope === 'user' ? join(dir, 'settings.json') : join(r.repo, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `{"enabledPlugins": {"${OLD_KEY}": true},}\n`);
    const before = snapshot(r.tmp);
    for (const args of [[], ['--apply'], ['--apply', '--scope', scope]]) {
      assert.match(migrate(r, args, 1), new RegExp(`^refused: ${path} is not valid JSON`));
    }
    assert.deepEqual(snapshot(r.tmp), before);
  }));
}

test('settings are backed up in a private dir under the git dir, never under factory/', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  const path = join(r.repo, '.claude', 'settings.json');
  writeJson(path, { enabledPlugins: { [OLD_KEY]: true } });
  const before = readFileSync(path, 'utf8');
  const rep = json(r, ['--apply']);
  const runtime = rep.backup as string;
  const backup = rep.settings_backup as string;
  assert.ok(runtime.startsWith(join(r.fdir, 'upgrade-backup-')), runtime);
  assert.equal(existsSync(join(runtime, 'settings')), false, 'settings copied into the dir the dashboard serves');
  assert.ok(backup.startsWith(join(r.repo, '.git', 'factory-upgrade-backup-')), backup);
  assert.equal(readFileSync(join(backup, 'project', 'settings.json'), 'utf8'), before);
  assert.equal(statSync(backup).mode & 0o777, 0o700);
  assert.equal(r.git(['status', '--porcelain', '--', '.claude']), '?? .claude/', 'only the settings dir itself is new');
  assert.equal(json(r, ['--apply']).settings_backup, null, 'a second --apply backed up again');
}));

test('a 0600 settings file stays 0600, and so does its backup', withRepo((r) => {
  const dir = claudeDir(r);
  const user = join(dir, 'settings.json');
  const local = join(r.repo, '.claude', 'settings.local.json');
  for (const path of [user, local]) {
    writeJson(path, { env: { TOKEN: 'secret' }, enabledPlugins: { [OLD_KEY]: true } });
    chmodSync(path, 0o600);
  }
  const report = json(r, ['--apply', '--scope', 'user', '--scope', 'local']);
  assert.equal(report.changes, 2);
  for (const path of [user, local]) {
    assert.equal(statSync(path).mode & 0o777, 0o600, path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).enabledPlugins, { [NEW_KEY]: true });
  }
  assert.equal(statSync(join(report.settings_backup, 'user', 'settings.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(report.settings_backup, 'local', 'settings.local.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['settings.json'], 'a temp file was left behind');
}));

test('a symlinked settings file keeps its link; a file at the old temp name is not followed', withRepo((r) => {
  const dir = claudeDir(r);
  const real = join(r.tmp, 'dotfiles', 'settings.json');
  writeJson(real, { enabledPlugins: { [OLD_KEY]: true } });
  const link = join(dir, 'settings.json');
  symlinkSync(real, link);
  const decoy = join(r.tmp, 'decoy.txt');
  writeFileSync(decoy, 'untouched\n');
  symlinkSync(decoy, `${link}.upgrade.tmp`);
  json(r, ['--apply', '--scope', 'user']);
  assert.ok(lstatSync(link).isSymbolicLink(), 'the symlink was replaced by a file');
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')).enabledPlugins, { [NEW_KEY]: true });
  assert.equal(readFileSync(decoy, 'utf8'), 'untouched\n');
}));

test('a --repo path in a suggested command is single-quoted for the shell', withRepo((r) => {
  const repo = join(r.tmp, 'it\'s $(x)');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  writeJson(join(repo, '.claude', 'settings.json'), { enabledPlugins: { [OLD_KEY]: true } });
  claudeDir(r);
  r.env = { ...r.env, FACTORY_DIR: join(repo, 'factory') };
  const rep = json(r, ['--repo', repo, '--scope', 'local']);
  assert.ok(rep.manual.some((m: string) => m.includes(`--scope project --repo '${r.tmp}/it'\\''s $(x)'\``)), rep.manual.join('\n'));
}));

// ---------------------------------------------------------------- manual steps

test('factory.json keys the current CLI refuses are reported by name, not fixed', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  const cfg = join(r.repo, 'factory.json');
  writeFileSync(cfg, '{"specs_dir": "docs/specs", "old_option": 1, "max_review_rounds": 0}\n');
  const rep = json(r, ['--apply']);
  assert.ok(rep.manual.some((m: string) => /factory\.json: unknown key 'old_option' \(known: reviewers, .*\) - the current CLI refuses this factory\.json/.test(m)), rep.manual.join('\n'));
  assert.ok(rep.manual.some((m: string) => /factory\.json: 'max_review_rounds' must be a whole number of at least 1 - /.test(m)));
  assert.equal(readFileSync(cfg, 'utf8'), '{"specs_dir": "docs/specs", "old_option": 1, "max_review_rounds": 0}\n');
}));

test('tracked files that still name the old plugin or CLI are listed with file:line', withRepo((r) => {
  claudeDir(r);
  const cli = 'bin/' + 'factory';
  writeFileSync(join(r.repo, 'NOTES.md'), `intro\nrun python3 -I ${cli} status\nsee kwcantrell-plugins for base-setup\ninstall ${OLD_KEY}\n`);
  writeFileSync(join(r.repo, 'untracked.md'), `${cli}\n`);
  writeJson(join(r.repo, '.claude', 'settings.json'), { enabledPlugins: { [OLD_KEY]: true } });
  r.git(['add', 'NOTES.md', '.claude/settings.json']);
  r.git(['commit', '-q', '-m', 'notes']);
  const manual = json(r, []).manual.join('\n---\n');
  assert.match(manual, new RegExp(`NOTES\\.md:2: run python3 -I ${cli} status\\n {4}names the old plugin or CLI`));
  assert.match(manual, new RegExp(`NOTES\\.md:4: install ${OLD_KEY}\\n`));
  assert.doesNotMatch(manual, /NOTES\.md:3/, 'kwcantrell-plugins without factory is not the old plugin');
  assert.doesNotMatch(manual, /untracked\.md/);
  assert.doesNotMatch(manual, /\.claude\/settings\.json:/, 'settings are switched, not listed as a manual edit');
}));

test('the claude plugin commands are listed per scope until the registry shows them done', withRepo((r) => {
  const dir = claudeDir(r);
  writeJson(join(r.repo, '.claude', 'settings.json'), PROJECT());
  const registry = join(dir, 'plugins', 'installed_plugins.json');
  const entry = (scope: string) => ({ scope, projectPath: r.repo, version: '0.1.0', installPath: '/x' });
  writeJson(registry, { version: 2, plugins: { [OLD_KEY]: [entry('project')] } });

  let rep = json(r, ['--apply']);
  assert.ok(rep.found.includes('installed: factory@kwcantrell-plugins 0.1.0 (project scope)'));
  const manual = rep.manual as string[];
  assert.ok(manual.includes('run in a terminal: claude plugin install factory@software-factory --scope project'), manual.join('\n'));
  assert.ok(manual.includes('run in a terminal: claude plugin uninstall factory@kwcantrell-plugins --scope project'));
  assert.ok(manual.some((m) => m.startsWith('then run /reload-plugins in Claude Code')));
  assert.equal(manual.some((m) => m.includes('marketplace add')), false, 'the project settings now declare software-factory');
  assert.ok(manual.findIndex((m) => m.includes('plugin install')) < manual.findIndex((m) => m.includes('plugin uninstall')));

  // The user ran them: nothing is left.
  writeJson(registry, { version: 2, plugins: { [NEW_KEY]: [entry('project')] } });
  rep = json(r, []);
  assert.deepEqual(rep.manual, []);
  assert.equal(rep.nothing_to_do, true);
}));

test('the marketplace is added first when no scope or registry knows software-factory', withRepo((r) => {
  claudeDir(r);
  writeJson(join(r.repo, '.claude', 'settings.json'), { enabledPlugins: { [OLD_KEY]: true } });
  const manual = json(r, []).manual as string[];
  const add = manual.indexOf('run in a terminal: claude plugin marketplace add kwcantrell/software-factory');
  assert.ok(add >= 0 && add < manual.indexOf('run in a terminal: claude plugin install factory@software-factory --scope project'), manual.join('\n'));
}));

test('--repo works from an unrelated directory, and the report is one JSON value', withRepo((r) => {
  fromFixture(r, '979c870');
  const elsewhere = join(r.tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const p = r.factory(['migrate-repo', '--from', FROM, '--to', TO, '--repo', r.repo], { cwd: elsewhere });
  assert.equal(p.status, 0, p.stderr);
  const report = JSON.parse(p.stdout);
  assert.equal(report.repo, r.repo);
  assert.equal(report.from, FROM);
  assert.equal(report.to, TO);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.nothing_to_do, false);
  assert.ok(report.runtime.changes.length >= 7);
  const applied = json(r, ['--apply']);
  assert.equal(applied.mode, 'apply');
  assert.match(applied.backup, /upgrade-backup-/);
  assert.equal(json(r, []).nothing_to_do, true);
  rmSync(elsewhere, { recursive: true });
}));

// ---------------------------------------------------------------- downgrades

/** A factory dir written by this CLI: two jobs (one with a follow-up), and factory.json with advisor. */
function currentFactory(r: Repo, config: Record<string, unknown> = { max_review_rounds: 2, advisor: { share: false } }): void {
  claudeDir(r);
  writeJson(join(r.repo, 'factory.json'), config);
  r.newJob('First');
  r.newJob('Second');
  r.ok(['followup', 'add', '1', '--by', 'builder', 'later']);
}

test('downgrade to 0.4.0: factory.json loses the keys 0.4.0 refuses, backed up privately; jobs stay', withRepo((r) => {
  currentFactory(r);
  const jobs = readFileSync(join(r.jobDir('001-first'), 'job.json'), 'utf8');
  const before = snapshot(r.tmp);
  const dry = json(r, [], { from: TO, to: '0.4.0' });
  assert.deepEqual(snapshot(r.tmp), before, 'the dry run wrote something');
  assert.equal(dry.direction, 'downgrade');
  assert.deepEqual(dry.config.changes, ['factory.json: remove "advisor": {"share":false} (0.4.0 refuses the key)']);
  assert.deepEqual(dry.runtime.changes, []);
  assert.deepEqual(dry.settings, []);
  const rep = json(r, ['--apply'], { from: TO, to: '0.4.0' });
  assert.deepEqual(JSON.parse(readFileSync(join(r.repo, 'factory.json'), 'utf8')), { max_review_rounds: 2 });
  assert.ok(rep.settings_backup.startsWith(join(r.repo, '.git', 'factory-upgrade-backup-')));
  assert.deepEqual(JSON.parse(readFileSync(join(rep.settings_backup, 'config', 'factory.json'), 'utf8')), { max_review_rounds: 2, advisor: { share: false } });
  assert.equal(readFileSync(join(r.jobDir('001-first'), 'job.json'), 'utf8'), jobs);
  assert.equal(json(r, [], { from: TO, to: '0.4.0' }).nothing_to_do, true);
}));

test('downgrade: a job field the target does not know is removed, the original backed up; finished jobs may keep head', withRepo((r) => {
  currentFactory(r, {});
  const path = join(r.jobDir('001-first'), 'job.json');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  job.owner = { name: 'Test', email: 'test@example.invalid' };
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`);
  const done = join(r.jobDir('002-second'), 'job.json');
  const second = JSON.parse(readFileSync(done, 'utf8'));
  Object.assign(second, { stage: 'done', status: 'merged', head: 'a'.repeat(40) });
  writeFileSync(done, `${JSON.stringify(second, null, 2)}\n`);
  const rep = json(r, ['--apply'], { from: TO, to: '0.4.0' });
  assert.deepEqual(changesOf(rep), ['jobs/001-first/job.json: remove owner (0.4.0 does not know it)', 'jobs/002-second/job.json: remove head (0.4.0 does not know it)']);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')), 'owner'), false);
  assert.equal(JSON.parse(readFileSync(join(rep.backup, 'jobs', '001-first', 'job.json'), 'utf8')).owner.name, 'Test');
  assert.ok(rep.backup.startsWith(join(r.fdir, 'upgrade-backup-')));
}));

test('downgrade refused: a remote factory, with the reason and the manual choice; nothing changes', withRepo((r) => {
  claudeDir(r);
  writeJson(join(r.repo, 'factory.json'), { remote: { url: '../state.git', branch: 'factory-state', allowed_signers: '.github/allowed_signers' }, advisor: { share: true } });
  const before = snapshot(r.tmp);
  const err = migrate(r, ['--apply'], 1, { from: TO, to: '0.4.0' });
  assert.match(err, /^refused: cannot move this repo back to 0\.4\.0:\n {2}- .*factory\.json sets 'remote': 0\.4\.0 has no remote factory\. .*signed history \(remote\.allowed_signers\).*Stay on this version, or stop using the remote factory first/);
  assert.deepEqual(snapshot(r.tmp), before);
}));

test('downgrade refused: an unfinished job whose recorded commit protects its merge', withRepo((r) => {
  currentFactory(r, {});
  const path = join(r.jobDir('002-second'), 'job.json');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(job, { stage: 'ship', head: 'b'.repeat(40) });
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`);
  const before = snapshot(r.tmp);
  const err = migrate(r, ['--apply'], 1, { from: TO, to: '0.4.0' });
  assert.match(err, /jobs\/002-second\/job\.json records the commit proof and review passed \('head'\), which merge checks; 0\.4\.0 would merge whatever the branch holds\. Finish the job first/);
  assert.deepEqual(snapshot(r.tmp), before);
}));

test('refused: any move to a version before 0.3.0 (the Python CLI)', withRepo((r) => {
  currentFactory(r, {});
  for (const to of ['0.2.0', 'kwcantrell']) {
    assert.match(migrate(r, ['--apply'], 1, { from: TO, to }), new RegExp(`^refused: cannot move this repo to ${to}: it ran the Python CLI, which is retired; 0\\.3\\.0 is the oldest`));
  }
}));

// ---------------------------------------------------------------- snapshot helper and git maintenance

test('helper-made repos have git background maintenance and auto-gc off', withRepo((r) => {
  assert.equal(r.git(['config', 'maintenance.auto']), 'false');
  assert.equal(r.git(['config', 'gc.auto']), '0');
}));

test('snapshot ignores git lock files and internals but reports a file planted under .git', withRepo((r) => {
  const before = snapshot(r.tmp);
  writeFileSync(join(r.repo, '.git', 'objects', 'maintenance.lock'), '');
  writeFileSync(join(r.repo, '.git', 'index.lock'), '');
  mkdirSync(join(r.repo, '.git', 'objects', 'zz'), { recursive: true });
  writeFileSync(join(r.repo, '.git', 'objects', 'zz', 'obj'), 'x');
  writeFileSync(join(r.repo, '.git', 'logs', 'HEAD'), 'changed');
  assert.deepEqual(snapshot(r.tmp), before, 'git internals must not show');
  mkdirSync(join(r.repo, '.git', 'factory-upgrade-backup-1'));
  writeFileSync(join(r.repo, '.git', 'factory-upgrade-backup-1', 'settings.json'), '{}');
  assert.notDeepEqual(snapshot(r.tmp), before, 'a backup dir under .git must show');
  rmSync(join(r.repo, '.git', 'factory-upgrade-backup-1'), { recursive: true });
  writeFileSync(join(r.repo, '.git', 'planted.txt'), 'x');
  assert.notDeepEqual(snapshot(r.tmp), before, 'a planted file under .git must show');
}));

test('a git maintenance lock appearing and vanishing between snapshots does not fail a refusal test', withRepo((r) => {
  const dir = claudeDir(r);
  const path = join(dir, 'settings.json');
  writeFileSync(path, `{"enabledPlugins": {"${OLD_KEY}": true},}\n`);
  const lock = join(r.repo, '.git', 'objects', 'maintenance.lock');
  writeFileSync(lock, '');
  const before = snapshot(r.tmp);
  migrate(r, ['--apply'], 1);
  rmSync(lock);
  assert.deepEqual(snapshot(r.tmp), before);
}));
