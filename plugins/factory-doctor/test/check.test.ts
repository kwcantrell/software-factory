// check: profile selection, every requirement kind on a sandboxed machine (temp HOME,
// CLAUDE_CONFIG_DIR and PATH), the output and exit codes, and that no env value is ever printed.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { doc, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

const SECRET = 'sk-live-9f8e7d6c5b4a-SUPERSECRET';

let server: Server;
let openPort = 0;
let closedPort = 0;
before(async () => {
  server = createServer((socket) => socket.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  openPort = (server.address() as AddressInfo).port;
  // A port nothing listens on: open a server, note its port, close it.
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  closedPort = (tmp.address() as AddressInfo).port;
  await new Promise<void>((r) => tmp.close(() => r()));
});
after(() => server.close());

function writePlugins(): void {
  const install = (name: string): string => {
    const p = join(s.claudeDir, 'plugins', 'cache', 'mk', name, '1.0.0');
    mkdirSync(join(p, 'skills', `${name}-skill`), { recursive: true });
    writeFileSync(join(p, 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: x\n---\n`);
    return p;
  };
  const records = {
    version: 2,
    plugins: {
      'good@mk': [{ scope: 'user', installPath: install('good'), version: '1.0.0' }],
      'off@mk': [{ scope: 'user', installPath: install('off'), version: '1.0.0' }],
      'away@mk': [{ scope: 'project', projectPath: join(s.dir, 'elsewhere'), installPath: install('away'), version: '1.0.0' }],
    },
  };
  mkdirSync(join(s.claudeDir, 'plugins'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify(records));
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@mk': false } }));
  mkdirSync(join(s.claudeDir, 'skills', 'mine'), { recursive: true });
  writeFileSync(join(s.claudeDir, 'skills', 'mine', 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\n');
}

test('setup', () => {
  writePlugins();
  s.tool('fakedb', 'fakedb version 14.2.1');
  s.tool('oldtool', 'oldtool 1.9.0');
  s.tool('quiet', 'no version here');
  s.tool('javaish', 'openjdk version "21.0.2" 2024-01-16', 'stderr');
  s.write('.env', `FROM_DOTENV=${SECRET}\nexport ALSO_DOTENV="${SECRET}"\n`);
  s.write('config/app.toml', 'x = 1\n');
  s.writeJson(
    '.factory/doctor.json',
    doc(
      {
        base: {
          description: 'shared',
          requires: [
            { kind: 'tool', name: 'fakedb', version: '^14', why: 'the database CLI', source: 'Makefile:3' },
            { kind: 'tool', name: 'oldtool', version: '>=2', why: 'migrations' },
            { kind: 'tool', name: 'nowhere', why: 'not installed' },
            { kind: 'tool', name: 'quiet', version: '>=1', why: 'prints no version' },
            { kind: 'tool', name: 'javaish', version: '^21', version_command: ['javaish', '-version'], version_pattern: 'version "([\\d.]+)"', why: 'JVM' },
          ],
        },
        dev: {
          extends: 'base',
          dotenv: ['.env', '.env.missing'],
          requires: [
            { kind: 'env', name: 'DATABASE_URL', format: 'url', why: 'db' },
            { kind: 'env', name: 'API_TOKEN', format: 'non-empty', why: 'api' },
            { kind: 'env', name: 'PORT', format: 'integer', why: 'port' },
            { kind: 'env', name: 'REGION', format: { regex: '^[a-z]+-[a-z]+-\\d$' }, why: 'region' },
            { kind: 'env', name: 'FROM_DOTENV', format: 'url', why: 'from .env' },
            { kind: 'env', name: 'ALSO_DOTENV', why: 'from .env' },
            { kind: 'env', name: 'UNSET_VAR', description: 'the thing', why: 'needed' },
            { kind: 'env', name: 'MAYBE', optional: true, why: 'nice to have' },
            { kind: 'file', path: 'config/app.toml', why: 'config' },
            { kind: 'file', path: 'certs/dev.pem', why: 'tls' },
            { kind: 'file', path: '~/.dev-cert', optional: true, why: 'home file' },
            { kind: 'claude-plugin', name: 'good@mk', why: 'g' },
            { kind: 'claude-plugin', name: 'off@mk', why: 'o' },
            { kind: 'claude-plugin', name: 'away@mk', why: 'a' },
            { kind: 'claude-plugin', name: 'none@mk', why: 'n' },
            { kind: 'claude-skill', name: 'good:good-skill', why: 'g' },
            { kind: 'claude-skill', name: 'good-skill', why: 'g' },
            { kind: 'claude-skill', name: 'off-skill', why: 'o' },
            { kind: 'claude-skill', name: 'my-skill', why: 'u' },
            { kind: 'claude-skill', name: 'project-skill', why: 'p' },
            { kind: 'claude-skill', name: 'other:good-skill', why: 'wrong plugin' },
          ],
        },
        ok: { requires: [{ kind: 'tool', name: 'fakedb', why: 'db' }, { kind: 'env', name: 'MAYBE', optional: true, why: 'x' }] },
      },
      { default_profile: 'ok' },
    ),
  );
  s.write('.claude/skills/proj/SKILL.md', '---\nname: project-skill\ndescription: x\n---\n');
});

const devEnv = { DATABASE_URL: SECRET, API_TOKEN: SECRET, PORT: SECRET, REGION: 'us-east-1' };

test('check text: one line per requirement with ok, missing or wrong, a fix per problem, exit 1 on stderr', async () => {
  const r = await s.call(['check', 'dev'], devEnv);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  const out = r.stderr;
  assert.match(out, /^profile dev \(extends base\) from \.factory\/doctor\.json\n/);
  const line = (re: RegExp): void => assert.match(out, re);
  line(/^ok {6}tool fakedb: 14\.2\.1 matches \^14$/m);
  line(/^wrong {3}tool oldtool: 1\.9\.0 does not match >=2\n {8}fix: install oldtool >=2 \(found 1\.9\.0\)$/m);
  line(/^missing tool nowhere: not found on PATH\n {8}fix: install nowhere and put it on PATH$/m);
  line(/^wrong {3}tool quiet: found, but 'quiet --version' printed no version$/m);
  line(/^ok {6}tool javaish: 21\.0\.2 matches \^21$/m);
  line(/^wrong {3}env DATABASE_URL: set in the environment, but not a URL\n {8}fix: set DATABASE_URL to a URL yourself in your environment or in \.env, \.env\.missing/m);
  line(/^ok {6}env API_TOKEN: set in the environment, non-empty$/m);
  line(/^wrong {3}env PORT: set in the environment, but not an integer$/m);
  line(/^ok {6}env REGION: set in the environment, the pattern/m);
  line(/^ok {6}env FROM_DOTENV: set in \.env \(format not checked: dotenv values are never read\)$/m);
  line(/^ok {6}env ALSO_DOTENV: set in \.env$/m);
  line(/^missing env UNSET_VAR: not set, and not in \.env, \.env\.missing\n {8}fix: set UNSET_VAR yourself in your environment or in \.env, \.env\.missing \(the thing\); factory-doctor never sets values$/m);
  line(/^missing env MAYBE \(optional\): not set/m);
  line(/^ok {6}file config\/app\.toml: exists$/m);
  line(/^missing file certs\/dev\.pem: does not exist\n {8}fix: create certs\/dev\.pem/m);
  line(/^ok {6}claude-plugin good@mk: installed and enabled$/m);
  line(/^wrong {3}claude-plugin off@mk: installed, but disabled\n {8}fix: enable off@mk with \/plugin$/m);
  line(/^missing claude-plugin away@mk: installed only for another project/m);
  line(/^missing claude-plugin none@mk: not installed\n {8}fix: claude plugin install none@mk$/m);
  line(/^ok {6}claude-skill good:good-skill: provided by good@mk$/m);
  line(/^ok {6}claude-skill good-skill: provided by good@mk$/m);
  line(/^wrong {3}claude-skill off-skill: provided by off@mk, which is disabled$/m);
  line(/^ok {6}claude-skill my-skill: a user or project skill$/m);
  line(/^ok {6}claude-skill project-skill: a user or project skill$/m);
  line(/^missing claude-skill other:good-skill: no installed plugin or skill provides it\n {8}fix: install the other plugin/m);
  line(/required problems\nfactory-doctor: profile dev: \d+ required requirements are missing or wrong\n$/);
});

test('no env value is ever printed: text and --json, stdout and stderr, failing a format or not', async () => {
  for (const argv of [['check', 'dev'], ['check', 'dev', '--json'], ['check'], ['check', '--json']]) {
    const r = await s.call(argv, { ...devEnv, MAYBE: SECRET });
    // A real report (not a refusal), naming the variables whose values it must not show.
    assert.match(r.stdout + r.stderr, /env MAYBE|"name":"MAYBE"/);
    if (argv.includes('dev')) assert.match(r.stdout + r.stderr, /env DATABASE_URL.*not a URL|"name":"DATABASE_URL","status":"wrong"/);
    for (const part of [SECRET, 'SUPERSECRET', 'sk-live']) {
      assert.ok(!r.stdout.includes(part), `${argv.join(' ')} stdout has ${part}`);
      assert.ok(!r.stderr.includes(part), `${argv.join(' ')} stderr has ${part}`);
    }
  }
});

test('check --json: one JSON report; on failure it is on stderr and stdout is empty', async () => {
  const r = await s.call(['check', 'dev', '--json'], devEnv);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  const report = JSON.parse(r.stderr);
  assert.equal(report.profile, 'dev');
  assert.deepEqual(report.chain, ['base', 'dev']);
  assert.equal(report.ok, false);
  const byName = new Map(report.results.map((x: { name: string }) => [x.name, x]));
  assert.deepEqual(byName.get('fakedb'), { kind: 'tool', name: 'fakedb', status: 'ok', optional: false, profile: 'base', why: 'the database CLI', source: 'Makefile:3', detail: '14.2.1 matches ^14' });
  assert.equal((byName.get('MAYBE') as { status: string; optional: boolean }).optional, true);
  assert.equal(report.summary.required_problems, report.results.filter((x: { status: string; optional: boolean }) => x.status !== 'ok' && !x.optional).length);
});

test('exit 0 when everything required passes, even with an optional item missing; output on stdout', async () => {
  const r = await s.call(['check']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^profile ok from \.factory\/doctor\.json\nok {6}tool fakedb: found at .*\nmissing env MAYBE \(optional\): not set\n {8}fix: .*\n1 ok, 1 missing, 0 wrong; everything required is in place\n$/);
  const j = await s.call(['check', '--json']);
  assert.equal(j.code, 0);
  assert.equal(JSON.parse(j.stdout).ok, true);
});

test('profile selection: the argument, else FACTORY_DOCTOR_PROFILE, else default_profile', async () => {
  assert.equal(JSON.parse((await s.call(['check', '--json'])).stdout).profile, 'ok');
  const fromEnv = await s.call(['check', '--json'], { FACTORY_DOCTOR_PROFILE: 'base' });
  assert.equal(JSON.parse(fromEnv.stderr).profile, 'base');
  const arg = await s.call(['check', 'ok', '--json'], { FACTORY_DOCTOR_PROFILE: 'base' });
  assert.equal(JSON.parse(arg.stdout).profile, 'ok');
});

test('an unknown profile is a usage error (exit 2) that lists the profiles', async () => {
  for (const [argv, extra] of [[['check', 'stage'], {}], [['check'], { FACTORY_DOCTOR_PROFILE: 'stage' }]] as const) {
    const r = await s.call([...argv], extra);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^factory-doctor: no profile 'stage'.* in \.factory\/doctor\.json; profiles: base, dev, ok\n/);
  }
});

test('no profile named and no default_profile: usage error listing the profiles', async () => {
  s.writeJson('other.json', doc({ a: {}, b: {} }));
  const r = await s.call(['check', '--file', 'other.json']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /name a profile .*; profiles: a, b/);
});

test('a missing file: exit 1 pointing at scan and init', async () => {
  const r = await s.call(['check', '--file', 'nope.json']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nope\.json does not exist: run 'factory-doctor scan'.*'factory-doctor init'/);
});

test('service: a listening port is ok, a closed one is missing within the timeout', async () => {
  s.writeJson('svc.json', doc({ svc: { requires: [
    { kind: 'service', host: '127.0.0.1', port: openPort, why: 'up' },
    { kind: 'service', host: '127.0.0.1', port: closedPort, why: 'down' },
  ] } }));
  const started = Date.now();
  const r = await s.call(['check', 'svc', '--file', 'svc.json']);
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^ok {6}service 127\\.0\\.0\\.1:${openPort}: accepts connections$`, 'm'));
  assert.match(r.stderr, new RegExp(`^missing service 127\\.0\\.0\\.1:${closedPort}: nothing accepted a connection within 1 s\\n {8}fix: start the service on 127\\.0\\.0\\.1:${closedPort}`, 'm'));
});

test('the claude records come from CLAUDE_CONFIG_DIR, never the real ~/.claude', async () => {
  s.writeJson('p.json', doc({ p: { requires: [{ kind: 'claude-plugin', name: 'good@mk', why: 'g' }] } }));
  assert.equal((await s.call(['check', 'p', '--file', 'p.json'])).code, 0);
  const elsewhere = join(s.dir, 'empty-claude');
  const r = await s.call(['check', 'p', '--file', 'p.json'], { CLAUDE_CONFIG_DIR: elsewhere });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing claude-plugin good@mk: not installed/);
});
