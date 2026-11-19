// `factory upgrade`, driven as a subprocess. fixtures/upgrade-<commit>/ are factory dirs written by the
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
export function isGitVolatile(rel: string): boolean {
  const parts = rel.split('/');
  const at = parts.lastIndexOf('.git');
  if (at < 0) return false;
  const inside = parts.slice(at + 1);
  const name = inside[inside.length - 1] ?? '';
  return name.endsWith('.lock') || name === 'index' || inside[0] === 'objects' || inside[0] === 'logs' ||
    (inside[0] === 'worktrees' && (inside[2] === 'logs' || inside[2] === 'index'));
}

/** Every file under dir (worktrees' .git pointers included) and its content, minus git's own volatile files. */
export function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) {
        if (!isGitVolatile(`${rel}/x`) || rel.split('/').pop() === '.git') walk(p);
      } else if (!isGitVolatile(rel)) out.set(rel, readFileSync(p, 'latin1'));
    }
  };
  walk(dir);
  return out;
}

function upgrade(r: Repo, args: string[], status = 0, opts: { cwd?: string } = {}): string {
  const p = r.factory(['upgrade', ...args], opts);
  assert.equal(p.status, status, p.stdout + p.stderr);
  if (status !== 0) assert.equal(p.stdout, '', 'a refusal prints nothing on stdout');
  return status === 0 ? p.stdout : p.stderr;
}

const json = (r: Repo, args: string[]): Record<string, any> => JSON.parse(upgrade(r, [...args, '--json']));
const expected = (commit: string, name: string): string =>
  readFileSync(join(FIXTURES, `upgrade-${commit}`, 'expected', name), 'utf8');

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- command

test('--help lists upgrade, and upgrade --help its options', withRepo((r) => {
  assert.match(r.ok(['--help']), /^ {2}upgrade +move this repo/m);
  const help = r.ok(['upgrade', '--help']);
  assert.match(help, /^usage: factory upgrade \[-h\] \[--repo REPO\] \[--apply\] \[--scope \{project,local,user\}\] \[--json\]/);
}));

test('a usage error or a path that is not a git checkout exits 2', withRepo((r) => {
  claudeDir(r);
  let err = upgrade(r, ['--scope', 'everywhere'], 2);
  assert.match(err, /invalid choice: 'everywhere'/);
  const outside = join(r.tmp, 'not-a-repo');
  mkdirSync(outside);
  err = upgrade(r, ['--repo', outside], 2);
  assert.match(err, /not-a-repo is not inside a git checkout/);
  err = upgrade(r, [], 2, { cwd: outside });
  assert.match(err, /is not inside a git checkout/);
  upgrade(r, ['--repo', join(r.tmp, 'missing')], 2);
}));

test('a repo that never used the factory has nothing to do, and the dry run creates no factory dir', withRepo((r) => {
  claudeDir(r);
  const out = upgrade(r, []);
  assert.match(out, /^factory upgrade: dry run for .* - nothing was written\n/);
  assert.match(out, /nothing to do: the settings and runtime dir are current\n$/);
  assert.equal(existsSync(r.fdir), false);
  upgrade(r, ['--apply']);
  assert.equal(existsSync(r.fdir), false);
}));

// ---------------------------------------------------------------- runtime dir

for (const commit of COMMITS) {
  test(`dry run on a factory dir from ${commit} lists the changes and writes nothing`, withRepo((r) => {
    fromFixture(r, commit);
    const before = snapshot(r.tmp);
    const out = upgrade(r, []);
    assert.deepEqual(snapshot(r.tmp), before, 'the dry run changed a file');
    assert.match(out, /\nfound:\n.*\.lock, the lock file of the Python CLI/s);
    const label = commit === '979c870' ? 'before follow-ups' : 'with follow-ups';
    assert.match(out, new RegExp(`dashboard \\(index\\.html\\) from the (original )?Python CLI.*${label}`));
    assert.match(out, /\nsettings \(would change\):\n {2}\(no changes\)\n/);
    assert.match(out, /\nruntime dir \(would change\) \(.*\/factory\):\n/);
    assert.match(out, /- remove \.lock /);
    assert.match(out, /- replace index\.html with the current dashboard/);
    assert.match(out, /- create \.gitignore/);
    assert.match(out, /\nmanual steps \(this command does not do these\):\n/);
    if (commit === '979c870') {
      for (const id of ['001-intake-job', '002-build-job', '003-ship-job', '004-done-job']) {
        assert.match(out, new RegExp(`- jobs/${id}/job\\.json: add followups \\(\\[\\]\\)\\n`));
      }
      assert.match(out, /4 job\(s\) written by an older CLI \(missing followups\)/);
    } else {
      assert.doesNotMatch(out, /job\.json: add/);
    }
    assert.match(out, /\d+ change\(s\) to make; run again with --apply to make them\n$/);
  }));

  test(`--apply migrates a factory dir from ${commit}; status, followup list and stats work after`, withRepo((r) => {
    fromFixture(r, commit);
    const jobsBefore = Object.fromEntries(
      readdirSync(join(r.fdir, 'jobs')).map((id) => [id, readFileSync(join(r.jobDir(id), 'job.json'), 'utf8')]),
    );
    const indexBefore = readFileSync(join(r.fdir, 'index.html'));
    const out = upgrade(r, ['--apply']);
    assert.match(out, /^factory upgrade: \//);
    const backup = /^backup of the originals: (.*)$/m.exec(out)?.[1] as string;
    assert.ok(backup && backup.startsWith(join(r.fdir, 'upgrade-backup-')), out);
    assert.match(out, /\d+ change\(s\) made\n$/);

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
    upgrade(r, ['--apply']);
    const before = snapshot(r.tmp);
    const out = upgrade(r, ['--apply']);
    assert.match(out, /nothing to do: the settings and runtime dir are current/);
    assert.doesNotMatch(out, /backup of the originals/);
    assert.deepEqual(snapshot(r.tmp), before);
    assert.match(upgrade(r, []), /nothing to do/);
  }));
}

test('a current factory dir that only lacks .gitignore gets one, with nothing to back up', withRepo((r) => {
  claudeDir(r);
  r.newJob();
  rmSync(join(r.fdir, '.gitignore'));
  const out = upgrade(r, ['--apply']);
  assert.match(out, /- create \.gitignore/);
  assert.doesNotMatch(out, /backup of the originals/);
  assert.equal(readdirSync(r.fdir).some((n) => n.startsWith('upgrade-backup-')), false);
  assert.ok(existsSync(join(r.fdir, '.gitignore')));
  assert.match(upgrade(r, []), /nothing to do/);
}));

test('the d7923b8 fixture keeps factory.json with specs_dir, which the current CLI accepts', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  upgrade(r, ['--apply']);
  assert.match(r.ok(['config']), /"specs_dir": "docs\/specs"/);
}));

test('a job.json that does not parse is refused and nothing is changed', withRepo((r) => {
  fromFixture(r, '979c870');
  writeFileSync(join(r.jobDir('001-intake-job'), 'job.json'), '{ not json');
  const before = snapshot(r.tmp);
  assert.match(upgrade(r, ['--apply'], 1), /^refused: .*001-intake-job\/job\.json is not valid JSON/);
  assert.deepEqual(snapshot(r.tmp), before);
}));

test('refuses while a live process holds the factory lock', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  writeFileSync(join(r.fdir, '.lock.pid'), `${process.pid}\n`);
  const before = snapshot(r.tmp);
  assert.match(upgrade(r, ['--apply'], 1), new RegExp(`^refused: the factory lock .* is held by process ${process.pid}`));
  assert.deepEqual(snapshot(r.tmp), before);
  // A lock left by a process that is gone is not a reason to stop.
  writeFileSync(join(r.fdir, '.lock.pid'), '999999999\n');
  upgrade(r, ['--apply']);
}));

const canFlock = spawnSync('flock', ['--version']).status === 0 && existsSync('/proc/locks');

test('refuses while the old CLI holds its flock on .lock', { skip: !canFlock && 'needs flock(1) and /proc/locks' }, withRepo(async (r) => {
  fromFixture(r, '979c870');
  const holder = spawn('flock', [join(r.fdir, '.lock'), '-c', 'echo locked; sleep 30'], { detached: true });
  try {
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    const before = snapshot(r.tmp);
    assert.match(upgrade(r, ['--apply'], 1), /^refused: .*\.lock is locked by a running factory command/);
    assert.deepEqual(snapshot(r.tmp), before);
  } finally {
    process.kill(-(holder.pid as number), 'SIGTERM'); // flock and the sleep holding its lock
  }
  await new Promise((resolve) => holder.once('close', resolve));
  upgrade(r, ['--apply']);
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
  const dry = upgrade(r, []);
  assert.equal(readFileSync(path, 'utf8'), before, 'the dry run wrote the settings');
  assert.match(dry, new RegExp(`project settings \\(${path}\\): ${OLD_KEY} enabled - the original plugin, from kwcantrell/kwcantrell-plugins`));
  assert.match(dry, /settings \(would change\):\n {2}project \(.*\):\n {4}- enabledPlugins: "factory@kwcantrell-plugins": true -> "factory@software-factory": true\n {4}- extraKnownMarketplaces: add "software-factory" \(github kwcantrell\/software-factory\)\n/);

  upgrade(r, ['--apply']);
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
  const again = upgrade(r, ['--apply']);
  assert.match(again, /nothing to do/);
  assert.equal(readFileSync(path, 'utf8'), text);
}));

test('local scope: a false value stays false, another marketplace counts as old, and a tab indent is kept', withRepo((r) => {
  claudeDir(r);
  const path = join(r.repo, '.claude', 'settings.local.json');
  mkdirSync(join(r.repo, '.claude'));
  writeFileSync(path, `${JSON.stringify({ enabledPlugins: { 'factory@my-fork': false, 'x@y': true } }, null, '\t')}\n`);
  const dry = upgrade(r, []);
  assert.match(dry, /local settings .*: factory@my-fork disabled - marketplace 'my-fork', not software-factory/);
  upgrade(r, ['--apply']);
  assert.equal(readFileSync(path, 'utf8'), `{\n\t"enabledPlugins": {\n\t\t"factory@software-factory": false,\n\t\t"x@y": true\n\t}\n}\n`);
}));

test('a scope that already enables factory@software-factory drops the old key and keeps the new value', withRepo((r) => {
  claudeDir(r);
  const path = join(r.repo, '.claude', 'settings.json');
  writeJson(path, { enabledPlugins: { [OLD_KEY]: true, [NEW_KEY]: false } });
  upgrade(r, ['--apply']);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabledPlugins: { [NEW_KEY]: false } });
}));

test('user scope changes only with --scope user; otherwise it is a manual step naming the flag', withRepo((r) => {
  const dir = claudeDir(r);
  const path = join(dir, 'settings.json');
  writeJson(path, PROJECT());
  const before = readFileSync(path, 'utf8');
  const out = upgrade(r, ['--apply']);
  assert.equal(readFileSync(path, 'utf8'), before, 'user settings changed without --scope user');
  assert.match(out, /- user settings \(.*\) still enable the old plugin; to switch them run `factory upgrade --apply --scope user`, which will: enabledPlugins: "factory@kwcantrell-plugins": true -> "factory@software-factory": true; extraKnownMarketplaces: add "software-factory"/);
  assert.match(out, /nothing to do/);

  const applied = upgrade(r, ['--apply', '--scope', 'user']);
  assert.match(applied, /settings:\n {2}user \(/);
  const now = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(now.enabledPlugins, { 'base-setup@kwcantrell-plugins': true, [NEW_KEY]: true, 'other@elsewhere': false });
  assert.ok(now.extraKnownMarketplaces['software-factory']);
  assert.doesNotMatch(upgrade(r, []), /upgrade --apply --scope user/);
}));

test('--scope picks the scopes to change; the others become manual steps', withRepo((r) => {
  claudeDir(r);
  const project = join(r.repo, '.claude', 'settings.json');
  const local = join(r.repo, '.claude', 'settings.local.json');
  writeJson(project, { enabledPlugins: { [OLD_KEY]: true } });
  writeJson(local, { enabledPlugins: { [OLD_KEY]: true } });
  const out = upgrade(r, ['--apply', '--scope', 'local']);
  assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')).enabledPlugins, { [NEW_KEY]: true });
  assert.deepEqual(JSON.parse(readFileSync(project, 'utf8')).enabledPlugins, { [OLD_KEY]: true });
  assert.match(out, /run `factory upgrade --apply --scope project`/);
  upgrade(r, ['--apply', '--scope', 'project', '--scope', 'local']);
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
      assert.match(upgrade(r, args, 1), new RegExp(`^refused: ${path} is not valid JSON`));
    }
    assert.deepEqual(snapshot(r.tmp), before);
  }));
}

test('settings are backed up in a private dir under the git dir, never under factory/', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  const path = join(r.repo, '.claude', 'settings.json');
  writeJson(path, { enabledPlugins: { [OLD_KEY]: true } });
  const before = readFileSync(path, 'utf8');
  const out = upgrade(r, ['--apply']);
  const runtime = /^backup of the originals: (.*)$/m.exec(out)?.[1] as string;
  const backup = /^backup of the settings files: (.*)$/m.exec(out)?.[1] as string;
  assert.ok(runtime.startsWith(join(r.fdir, 'upgrade-backup-')), out);
  assert.equal(existsSync(join(runtime, 'settings')), false, 'settings copied into the dir the dashboard serves');
  assert.ok(backup.startsWith(join(r.repo, '.git', 'factory-upgrade-backup-')), out);
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
  upgrade(r, ['--apply', '--scope', 'user']);
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
  const out = upgrade(r, ['--repo', repo, '--scope', 'local']);
  assert.ok(out.includes(`--scope project --repo '${r.tmp}/it'\\''s $(x)'\``), out);
}));

// ---------------------------------------------------------------- manual steps

test('factory.json keys the current CLI refuses are reported by name, not fixed', withRepo((r) => {
  fromFixture(r, 'd7923b8');
  const cfg = join(r.repo, 'factory.json');
  writeFileSync(cfg, '{"specs_dir": "docs/specs", "old_option": 1, "max_review_rounds": 0}\n');
  const out = upgrade(r, ['--apply']);
  assert.match(out, /- .*factory\.json: unknown key 'old_option' \(known: reviewers, .*\) - the current CLI refuses this factory\.json/);
  assert.match(out, /- .*factory\.json: 'max_review_rounds' must be a whole number of at least 1 - /);
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
  const out = upgrade(r, []);
  assert.match(out, new RegExp(`- NOTES\\.md:2: run python3 -I ${cli} status\\n {4}names the old plugin or CLI`));
  assert.match(out, new RegExp(`- NOTES\\.md:4: install ${OLD_KEY}\\n`));
  assert.doesNotMatch(out, /NOTES\.md:3/, 'kwcantrell-plugins without factory is not the old plugin');
  assert.doesNotMatch(out, /untracked\.md/);
  assert.doesNotMatch(out, /- \.claude\/settings\.json:/, 'settings are switched, not listed as a manual edit');
}));

test('the claude plugin commands are listed per scope until the registry shows them done', withRepo((r) => {
  const dir = claudeDir(r);
  writeJson(join(r.repo, '.claude', 'settings.json'), PROJECT());
  const registry = join(dir, 'plugins', 'installed_plugins.json');
  const entry = (scope: string) => ({ scope, projectPath: r.repo, version: '0.1.0', installPath: '/x' });
  writeJson(registry, { version: 2, plugins: { [OLD_KEY]: [entry('project')] } });

  let out = upgrade(r, ['--apply']);
  assert.match(out, /installed: factory@kwcantrell-plugins 0\.1\.0 \(project scope\)/);
  assert.match(out, /- run in a terminal: claude plugin install factory@software-factory --scope project\n/);
  assert.match(out, /- run in a terminal: claude plugin uninstall factory@kwcantrell-plugins --scope project\n/);
  assert.match(out, /- then run \/reload-plugins in Claude Code/);
  assert.doesNotMatch(out, /marketplace add/, 'the project settings now declare software-factory');
  assert.ok(out.indexOf('plugin install') < out.indexOf('plugin uninstall'));

  // The user ran them: nothing is left.
  writeJson(registry, { version: 2, plugins: { [NEW_KEY]: [entry('project')] } });
  out = upgrade(r, []);
  assert.doesNotMatch(out, /claude plugin|reload-plugins/);
  assert.match(out, /manual steps \(this command does not do these\):\n {2}\(none\)\n/);
  assert.match(out, /nothing to do: the settings and runtime dir are current\n$/);
}));

test('the marketplace is added first when no scope or registry knows software-factory', withRepo((r) => {
  claudeDir(r);
  writeJson(join(r.repo, '.claude', 'settings.json'), { enabledPlugins: { [OLD_KEY]: true } });
  const out = upgrade(r, []);
  const add = out.indexOf('claude plugin marketplace add kwcantrell/software-factory');
  assert.ok(add > 0 && add < out.indexOf('claude plugin install factory@software-factory --scope project'), out);
}));

test('--repo works from an unrelated directory, and --json prints one JSON value', withRepo((r) => {
  fromFixture(r, '979c870');
  const elsewhere = join(r.tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const p = r.factory(['upgrade', '--repo', r.repo, '--json'], { cwd: elsewhere });
  assert.equal(p.status, 0, p.stderr);
  const report = JSON.parse(p.stdout);
  assert.equal(report.repo, r.repo);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.nothing_to_do, false);
  assert.ok(report.runtime.changes.length >= 7);
  const applied = json(r, ['--apply']);
  assert.equal(applied.mode, 'apply');
  assert.match(applied.backup, /upgrade-backup-/);
  assert.equal(json(r, []).nothing_to_do, true);
  rmSync(elsewhere, { recursive: true });
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
  const before = snapshot(r.tmp);
  const lock = join(r.repo, '.git', 'objects', 'maintenance.lock');
  writeFileSync(lock, '');
  upgrade(r, ['--apply'], 1);
  rmSync(lock);
  assert.deepEqual(snapshot(r.tmp), before);
}));
