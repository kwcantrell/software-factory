// add, remove, init and profiles: dry runs unless --confirm, the file created when missing, key order
// and two-space indent kept, value-bearing flags refused, add --from-scan.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { type Sandbox, sandbox } from './helpers.ts';

let s: Sandbox;
const fresh = (): Sandbox => (s = sandbox());
afterEach(() => s.cleanup());

const file = (): string => join(s.repo, '.factory', 'doctor.json');
const read = (): string => readFileSync(file(), 'utf8');

test('init is a dry run without --confirm; with it, writes dev and test profiles', async () => {
  fresh();
  const dry = await s.call(['init']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /^Would write \.factory\/doctor\.json with the profiles dev and test:\n/);
  assert.match(dry.stdout, /Dry run: nothing was written\. Run it again with --confirm to write it\.\n$/);
  assert.equal(existsSync(file()), false);
  const r = await s.call(['init', '--confirm', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout).written, true);
  assert.deepEqual(JSON.parse(read()), {
    version: 1,
    default_profile: 'dev',
    profiles: {
      dev: { description: 'Running the app locally for development', dotenv: ['.env'], requires: [] },
      test: { description: 'Running the test suite', extends: 'dev', requires: [] },
    },
  });
  const again = await s.call(['init', '--confirm']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test('add creates the file when missing; a dry run first, then --confirm', async () => {
  fresh();
  const argv = ['add', 'env', 'DATABASE_URL', '--profile', 'dev', '--why', 'the app stores data', '--format', 'url', '--description', 'Postgres URL', '--source', '.env.example:2'];
  const dry = await s.call(argv);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.stdout, [
    'Would add in .factory/doctor.json, profile dev (a new profile):',
    '  + {"kind":"env","name":"DATABASE_URL","description":"Postgres URL","format":"url","why":"the app stores data","source":".env.example:2"}',
    'Would create .factory/doctor.json.',
    'Dry run: nothing was written. Run it again with --confirm to write it.',
    '',
  ].join('\n'));
  assert.equal(existsSync(file()), false);
  const r = await s.call([...argv, '--confirm']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Added in \.factory\/doctor\.json, profile dev/);
  assert.equal(read(), `${JSON.stringify({ version: 1, default_profile: 'dev', profiles: { dev: { requires: [{ kind: 'env', name: 'DATABASE_URL', description: 'Postgres URL', format: 'url', why: 'the app stores data', source: '.env.example:2' }] } } }, null, 2)}\n`);
});

test('add and remove keep the key order and two-space indent of an existing file', async () => {
  fresh();
  const original = {
    profiles: { test: { requires: [], extends: 'dev' }, dev: { requires: [{ why: 'runs it', kind: 'tool', name: 'node' }], description: 'local' } },
    default_profile: 'dev',
    version: 1,
  };
  s.writeJson('.factory/doctor.json', original);
  const before = read();
  assert.equal((await s.call(['add', 'tool', 'pnpm', '--profile', 'test', '--why', 'installs', '--tool-version', '^9', '--version-command', 'pnpm --version', '--confirm'])).code, 0);
  const after = JSON.parse(read());
  assert.deepEqual(Object.keys(after), ['profiles', 'default_profile', 'version']);
  assert.deepEqual(Object.keys(after.profiles), ['test', 'dev']);
  assert.deepEqual(Object.keys(after.profiles.test), ['requires', 'extends']);
  assert.deepEqual(Object.keys(after.profiles.dev.requires[0]), ['why', 'kind', 'name']);
  assert.deepEqual(after.profiles.test.requires, [{ kind: 'tool', name: 'pnpm', version: '^9', version_command: ['pnpm', '--version'], why: 'installs' }]);
  assert.match(read(), /^\{\n {2}"profiles": \{\n {4}"test": \{\n {6}"requires": \[\n {8}\{\n {10}"kind": "tool"/);
  assert.equal((await s.call(['remove', 'tool', 'pnpm', '--profile', 'test', '--confirm'])).code, 0);
  assert.equal(read(), before);
});

test('remove is a dry run without --confirm', async () => {
  fresh();
  s.writeJson('.factory/doctor.json', { version: 1, profiles: { dev: { requires: [{ kind: 'file', path: 'certs/dev.pem', why: 'tls' }] } } });
  const before = read();
  const dry = await s.call(['remove', 'file', 'certs/dev.pem', '--profile', 'dev']);
  assert.equal(dry.code, 0);
  assert.equal(dry.stdout, 'Would remove in .factory/doctor.json, profile dev:\n  - {"kind":"file","path":"certs/dev.pem","why":"tls"}\nDry run: nothing was written. Run it again with --confirm to write it.\n');
  assert.equal(read(), before);
  const r = await s.call(['remove', 'file', 'certs/dev.pem', '--profile', 'dev', '--confirm', '--json']);
  assert.equal(JSON.parse(r.stdout).written, true);
  assert.deepEqual(JSON.parse(read()).profiles.dev.requires, []);
});

test('every kind can be added; a service is <host>:<port>', async () => {
  fresh();
  for (const argv of [
    ['tool', 'node', '--tool-version', '>=22.18'],
    ['env', 'PORT', '--format', 'integer', '--optional'],
    ['env', 'REGION', '--format', 'regex:^[a-z]+-\\d$'],
    ['file', '~/.config/app/cert.pem'],
    ['claude-plugin', 'factory-docs@software-factory'],
    ['claude-skill', 'factory-docs:factory-docs'],
    ['service', 'localhost:5432'],
  ]) {
    const r = await s.call(['add', ...argv, '--profile', 'dev', '--why', 'needed', '--confirm']);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
  }
  const reqs = JSON.parse(read()).profiles.dev.requires;
  assert.deepEqual(reqs[1], { kind: 'env', name: 'PORT', format: 'integer', optional: true, why: 'needed' });
  assert.deepEqual(reqs[2].format, { regex: '^[a-z]+-\\d$' });
  assert.deepEqual(reqs[6], { kind: 'service', host: 'localhost', port: 5432, why: 'needed' });
  const profiles = await s.call(['profiles']);
  assert.equal(profiles.stdout, 'dev (default): 7 requirement(s)\n');
});

test('add and remove refusals', async () => {
  fresh();
  s.writeJson('.factory/doctor.json', { version: 1, profiles: { dev: { requires: [{ kind: 'tool', name: 'node', why: 'x' }] }, test: { extends: 'dev', requires: [] } } });
  const before = read();
  const cases: [string[], number, RegExp][] = [
    [['add', 'tool', 'node', '--profile', 'dev', '--why', 'x'], 1, /profile 'dev' already has tool node; remove it first/],
    [['add', 'tool', 'node', '--profile', 'test', '--why', 'x'], 1, /profile 'test' already gets tool node from profile 'dev'/],
    [['add', 'tool', 'go', '--profile', 'dev'], 2, /add needs --why/],
    [['add', 'tool', 'go', '--why', 'x'], 2, /add needs --profile/],
    [['add', 'database', 'pg', '--profile', 'dev', '--why', 'x'], 2, /unknown kind 'database'/],
    [['add', 'tool', 'go', '--profile', 'dev', '--why', 'x', '--format', 'url'], 2, /--format does not apply to a tool requirement/],
    [['add', 'tool', 'go', '--profile', 'dev', '--why', 'x', '--tool-version', 'latest'], 1, /is not a version constraint/],
    [['add', 'tool', 'go', '--profile', 'dev', '--why', 'x', '--tool-version', '>=1', '--version-command', 'go -e x', '--confirm'], 1, /version_command: must be the tool and at most one argument/],
    [['add', 'tool', 'go', '--profile', 'dev', '--why', 'x', '--tool-version', '>=1', '--version-command', 'go -r', '--confirm'], 1, /version_command\[1\]: must be a version probe/],
    [['add', 'service', 'localhost', '--profile', 'dev', '--why', 'x'], 2, /a service is named <host>:<port>/],
    [['remove', 'tool', 'node', '--profile', 'test'], 1, /profile 'test' gets tool node from profile 'dev'; remove it there/],
    [['remove', 'tool', 'go', '--profile', 'dev'], 1, /profile 'dev' has no tool go/],
    [['remove', 'tool', 'node'], 2, /remove needs --profile/],
    [['remove', 'profile', 'dev'], 1, /profile 'dev' is extended by test/],
    [['check', '--confirm'], 2, /check does not take --confirm/],
  ];
  for (const [argv, code, re] of cases) {
    const r = await s.call(argv);
    assert.equal(r.code, code, `${argv.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, re, argv.join(' '));
  }
  assert.equal(read(), before);
});

test('value-bearing flags and NAME=value are refused, and the value is never echoed', async () => {
  fresh();
  const secret = 'hunter2-very-secret';
  for (const argv of [
    ['add', 'env', 'TOKEN', '--profile', 'dev', '--why', 'x', '--value', secret],
    ['add', 'env', 'TOKEN', '--profile', 'dev', '--why', 'x', `--value=${secret}`],
    ['add', 'env', 'TOKEN', '--profile', 'dev', '--why', 'x', '--default', secret],
    ['add', 'env', 'TOKEN', '--profile', 'dev', '--why', 'x', `--secret=${secret}`],
    ['add', 'env', `TOKEN=${secret}`, '--profile', 'dev', '--why', 'x', '--confirm'],
  ]) {
    const r = await s.call(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /never (stores )?values|records names, never values/);
    assert.ok(!r.stderr.includes(secret), r.stderr);
  }
  assert.equal(existsSync(file()), false);
});

test('add profile and remove profile', async () => {
  fresh();
  assert.equal((await s.call(['init', '--confirm'])).code, 0);
  const r = await s.call(['add', 'profile', 'stage', '--description', 'the stage environment', '--extends', 'dev', '--confirm']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(read()).profiles.stage, { description: 'the stage environment', extends: 'dev', requires: [] });
  const list = await s.call(['profiles', '--json']);
  assert.deepEqual(JSON.parse(list.stdout).profiles.map((p: { name: string; extends: string[] }) => [p.name, p.extends]), [['dev', []], ['test', ['dev']], ['stage', ['dev']]]);
  assert.equal((await s.call(['remove', 'profile', 'stage', '--confirm'])).code, 0);
  assert.equal(JSON.parse(read()).profiles.stage, undefined);
});

test('add --from-scan <n> adds proposal n from scan, keeping its source', async () => {
  fresh();
  s.write('.env.example', 'DATABASE_URL=\nAPI_KEY=\n');
  s.write('.env.stage.example', 'STAGE_KEY=\n');
  const scanned = JSON.parse((await s.call(['scan', '--json'])).stdout);
  const api = scanned.proposals.find((p: { name: string }) => p.name === 'API_KEY');
  const dry = await s.call(['add', '--from-scan', String(api.n)]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /\+ \{"kind":"env","name":"API_KEY","why":"listed in \.env\.example","source":"\.env\.example:2"\}/);
  assert.equal(existsSync(file()), false);
  assert.equal((await s.call(['add', '--from-scan', String(api.n), '--confirm'])).code, 0);
  assert.deepEqual(JSON.parse(read()).profiles.dev.requires, [{ kind: 'env', name: 'API_KEY', why: 'listed in .env.example', source: '.env.example:2' }]);
  // Numbers hold after an add: the next proposal keeps its number.
  const again = JSON.parse((await s.call(['scan', '--json'])).stdout);
  const db = scanned.proposals.find((p: { name: string }) => p.name === 'DATABASE_URL');
  assert.equal(again.proposals.find((p: { name: string }) => p.name === 'DATABASE_URL').n, db.n);
  // A profile proposal creates the profile; a recorded one is refused.
  const stage = scanned.proposals.find((p: { kind: string; name: string }) => p.kind === 'profile' && p.name === 'stage');
  assert.equal((await s.call(['add', '--from-scan', String(stage.n), '--confirm'])).code, 0);
  assert.ok(JSON.parse(read()).profiles.stage);
  const dup = await s.call(['add', '--from-scan', String(api.n), '--confirm']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already has env API_KEY/);
  const none = await s.call(['add', '--from-scan', '999']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /scan has no proposal 999/);
  rmSync(file());
});

test('--file overrides .factory/doctor.json', async () => {
  fresh();
  const r = await s.call(['add', 'tool', 'go', '--profile', 'dev', '--why', 'x', '--file', 'ops/needs.json', '--confirm']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(s.repo, 'ops', 'needs.json')));
  assert.equal(existsSync(file()), false);
  assert.equal((await s.call(['profiles', '--file', 'ops/needs.json'])).stdout, 'dev (default): 1 requirement(s)\n');
});
