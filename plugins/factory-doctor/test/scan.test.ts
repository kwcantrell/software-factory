// scan: a fixture repository (written into a temp dir) with every source scan reads. Each source
// has its own test; scan is read-only, never prints a dotenv value, and leaves out recorded ones.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commandWords, findAll, toConstraint } from '../src/scan.ts';
import { doc, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

const REAL_SECRET = 'pk_live_REALVALUE_7f3a9c';
const EXAMPLE_VALUE = 'example-placeholder-value';

s.write('.env.example', `# copy to .env\nDATABASE_URL=${EXAMPLE_VALUE}\nexport API_KEY=\n`);
s.write('.env.sample', 'SAMPLE_ONLY=\n');
s.write('.env.stage.example', `STAGE_ONLY=${EXAMPLE_VALUE}\n`);
s.write('.env', `REAL_ONE=${REAL_SECRET}\nREAL_TWO="${REAL_SECRET}"\n`);
s.write('.env.production', `PROD_KEY=${REAL_SECRET}\n`);
s.write('.env.local', `LOCAL_KEY=${REAL_SECRET}\n`);
s.write('src/server.ts', [
  "const url = process.env.JS_DOT;",
  "const key = process.env['JS_BRACKET'];",
  'const port = process.env["JS_PORT"] ?? 3000;',
  'const home = process.env.HOME;',
].join('\n'));
s.write('app/main.py', [
  'import os',
  "a = os.environ['PY_ENVIRON']",
  "b = os.getenv('PY_GETENV')",
  "c = os.getenv('PY_GETENV_DEFAULT', 'x')",
  "d = os.environ.get('PY_GET')",
].join('\n'));
s.write('docker-compose.yml', [
  'services:',
  '  app:',
  '    environment:',
  '      - COMPOSE_VAR=${COMPOSE_VAR}',
  '      - WITH_DEFAULT=${WITH_DEFAULT:-5}',
  '      - APP_ENV=staging',
].join('\n'));
s.writeJson('package.json', { name: 'app', engines: { node: '>=22.18.0', npm: '^10.2' }, packageManager: 'pnpm@9.1.0+sha512.abc', scripts: { start: 'NODE_ENV=production node .' } });
s.write('.nvmrc', 'v22.18.0\n');
s.write('.node-version', '22\n');
s.write('.tool-versions', 'nodejs 22.18.0\npython 3.12.1\nunknowntool 1.0\n');
s.write('.python-version', '3.12.1\n');
s.write('Dockerfile', 'FROM node:22-alpine AS build\nRUN npm ci\nFROM build\nFROM python:3.12-slim\nENV NODE_ENV=production\n');
s.write('.github/workflows/ci.yml', [
  'jobs:',
  '  test:',
  '    steps:',
  '      - run: npm ci && npm test',
  '      - name: db',
  '        run: |',
  '          sudo psql -c "select 1"',
  '          FOO=1 terraform plan',
  '          echo done',
  '      - run: "docker build ."',
].join('\n'));
s.write('node_modules/dep/index.js', 'process.env.FROM_NODE_MODULES');

interface P { n: number; kind: string; name: string; profile: string; source: string; why: string; version?: string; optional?: boolean }

async function scanAll(): Promise<{ proposals: P[]; recorded: number; stdout: string; stderr: string }> {
  const r = await s.call(['scan', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return { ...JSON.parse(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

const find = (ps: P[], kind: string, name: string, profile?: string): P | undefined =>
  ps.find((p) => p.kind === kind && p.name === name && (profile === undefined || p.profile === profile));

test('env names from .env.example, .env.sample and .env.<profile>.example, with file:line', async () => {
  const { proposals } = await scanAll();
  assert.deepEqual(find(proposals, 'env', 'DATABASE_URL'), { n: find(proposals, 'env', 'DATABASE_URL')?.n, kind: 'env', name: 'DATABASE_URL', profile: 'dev', source: '.env.example:2', why: 'listed in .env.example' });
  assert.equal(find(proposals, 'env', 'API_KEY')?.source, '.env.example:3');
  assert.equal(find(proposals, 'env', 'SAMPLE_ONLY')?.source, '.env.sample:1');
  assert.equal(find(proposals, 'env', 'STAGE_ONLY')?.profile, 'stage');
});

test('env reads in code: process.env.X, process.env[\'X\'], os.environ[...], os.getenv(...)', async () => {
  const { proposals } = await scanAll();
  assert.equal(find(proposals, 'env', 'JS_DOT')?.source, 'src/server.ts:1');
  assert.equal(find(proposals, 'env', 'JS_BRACKET')?.source, 'src/server.ts:2');
  assert.equal(find(proposals, 'env', 'JS_PORT')?.optional, true, 'a ?? fallback makes it optional');
  assert.equal(find(proposals, 'env', 'PY_ENVIRON')?.source, 'app/main.py:2');
  assert.equal(find(proposals, 'env', 'PY_GETENV')?.source, 'app/main.py:3');
  assert.equal(find(proposals, 'env', 'PY_GETENV_DEFAULT')?.optional, true);
  assert.equal(find(proposals, 'env', 'PY_GET')?.source, 'app/main.py:5');
  assert.equal(find(proposals, 'env', 'HOME'), undefined, 'system variables are not proposed');
  assert.equal(find(proposals, 'env', 'FROM_NODE_MODULES'), undefined, 'node_modules is not scanned');
});

test('${X} in compose files', async () => {
  const { proposals } = await scanAll();
  assert.equal(find(proposals, 'env', 'COMPOSE_VAR')?.source, 'docker-compose.yml:4');
  assert.equal(find(proposals, 'env', 'COMPOSE_VAR')?.optional, undefined);
  assert.equal(find(proposals, 'env', 'WITH_DEFAULT')?.optional, true);
});

test('tools from package.json engines and packageManager', async () => {
  const { proposals } = await scanAll();
  // node also comes from version files earlier in scan order; the first source wins the proposal.
  assert.deepEqual(findAll(s.repo).filter((p) => p.file === 'package.json' && p.name === 'node').map((p) => [p.line, p.version, p.why]), [[4, '>=22.18.0', 'package.json engines.node is ">=22.18.0"']]);
  assert.equal(find(proposals, 'tool', 'npm', 'dev')?.version, '^10.2');
  assert.deepEqual([find(proposals, 'tool', 'pnpm')?.version, find(proposals, 'tool', 'pnpm')?.source], ['^9.1.0', 'package.json:7']);
});

test('tools from .nvmrc, .node-version, .tool-versions and .python-version', async () => {
  const { proposals } = await scanAll();
  // node is proposed once per profile (the first source in scan order); every source is found:
  assert.deepEqual([find(proposals, 'tool', 'node')?.version, find(proposals, 'tool', 'node')?.source], ['^22', '.node-version:1']);
  const pieces = findAll(s.repo);
  assert.deepEqual(pieces.filter((p) => p.name === 'node').map((p) => [p.file, p.line, p.version]), [
    ['.node-version', 1, '^22'],
    ['.nvmrc', 1, '^22.18.0'],
    ['.tool-versions', 1, '^22.18.0'],
    ['Dockerfile', 1, '^22'],
    ['package.json', 4, '>=22.18.0'],
  ]);
  assert.deepEqual(pieces.filter((p) => p.name === 'python3').map((p) => [p.file, p.line, p.version]), [
    ['.python-version', 1, '^3.12.1'],
    ['.tool-versions', 2, '^3.12.1'],
    ['Dockerfile', 4, '^3.12'],
  ]);
  assert.equal(pieces.some((p) => p.name === 'unknowntool'), false);
  assert.ok(find(proposals, 'tool', 'python3'));
});

test('tools from Dockerfile FROM: docker itself and the runtime image, not a stage name', async () => {
  const { proposals } = await scanAll();
  assert.deepEqual([find(proposals, 'tool', 'docker', 'dev')?.source, find(proposals, 'tool', 'docker', 'dev')?.why], ['Dockerfile:1', 'Dockerfile builds an image (FROM node)']);
  assert.equal(findAll(s.repo).filter((p) => p.file === 'Dockerfile' && p.kind === 'tool').length, 3);
});

test('tools from run: steps in .github/workflows that call well-known CLIs, for the test profile', async () => {
  const { proposals } = await scanAll();
  assert.equal(find(proposals, 'tool', 'npm', 'test')?.source, '.github/workflows/ci.yml:4');
  assert.equal(find(proposals, 'tool', 'psql', 'test')?.source, '.github/workflows/ci.yml:7');
  assert.equal(find(proposals, 'tool', 'terraform', 'test')?.source, '.github/workflows/ci.yml:8');
  assert.equal(find(proposals, 'tool', 'docker', 'test')?.source, '.github/workflows/ci.yml:10');
  assert.equal(find(proposals, 'tool', 'echo'), undefined);
  assert.equal(find(proposals, 'tool', 'sudo'), undefined);
  assert.deepEqual(commandWords('FOO=1 sudo env BAR=2 make test | tee x && ./run.sh; $(git rev-parse HEAD)'), ['make', 'tee', './run.sh', 'git']);
});

test('profiles from .env.<name> and .env.<name>.example names and NODE_ENV/APP_ENV-style values', async () => {
  const { proposals } = await scanAll();
  assert.equal(find(proposals, 'profile', 'stage')?.source, '.env.stage.example:1');
  assert.equal(find(proposals, 'profile', 'production')?.source, '.env.production:1');
  assert.equal(find(proposals, 'profile', 'staging')?.source, 'docker-compose.yml:6');
  assert.equal(find(proposals, 'profile', 'local'), undefined, '.env.local is not a profile');
  assert.equal(find(proposals, 'profile', 'example'), undefined);
  assert.match(find(proposals, 'profile', 'production')?.why ?? '', /dotenv file/);
  assert.ok(findAll(s.repo).some((p) => p.kind === 'profile' && p.name === 'production' && p.file === 'package.json'));
});

test('real .env files: key names are read, values never printed (text or JSON)', async () => {
  const json = await scanAll();
  assert.equal(find(json.proposals, 'env', 'REAL_ONE')?.source, '.env:1');
  assert.equal(find(json.proposals, 'env', 'PROD_KEY', 'production')?.why, 'set in .env.production (name only)');
  assert.equal(find(json.proposals, 'env', 'LOCAL_KEY')?.profile, 'dev');
  const text = await s.call(['scan']);
  for (const out of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    assert.ok(!out.includes(REAL_SECRET), 'a real .env value was printed');
    assert.ok(!out.includes('REALVALUE'));
    assert.ok(!out.includes(EXAMPLE_VALUE), 'scan prints no dotenv value at all');
  }
});

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      const st = statSync(p);
      out.push(`${p} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

test('scan is read-only: nothing in the repository or HOME changes', async () => {
  const before = [...snapshot(s.repo), ...snapshot(s.home)];
  await s.call(['scan', '--json']);
  await s.call(['scan']);
  assert.deepEqual([...snapshot(s.repo), ...snapshot(s.home)], before);
});

test('recorded requirements and profiles are left out; numbers stay the same', async () => {
  const first = await scanAll();
  const db = find(first.proposals, 'env', 'DATABASE_URL') as P;
  const jsDot = find(first.proposals, 'env', 'JS_DOT') as P;
  s.writeJson('.factory/doctor.json', doc({ base: { requires: [{ kind: 'env', name: 'DATABASE_URL', why: 'x' }] }, dev: { extends: 'base' }, stage: {} }, { default_profile: 'dev' }));
  const second = await scanAll();
  assert.equal(find(second.proposals, 'env', 'DATABASE_URL'), undefined, 'recorded through extends');
  assert.equal(find(second.proposals, 'profile', 'stage'), undefined);
  assert.equal(second.recorded, 2);
  assert.equal(find(second.proposals, 'env', 'JS_DOT')?.n, jsDot.n);
  assert.ok(db.n > 0);
  const text = await s.call(['scan']);
  assert.match(text.stdout, /already recorded/);
  assert.match(text.stdout, new RegExp(`#${jsDot.n} {2}env JS_DOT {2}-> profile dev {2}\\[src/server\\.ts:1\\]`));
  assert.match(text.stdout, /Nothing was written/);
});

test('engine specs become constraints factory-doctor reads, or none', () => {
  assert.equal(toConstraint('>=22.18.0', false), '>=22.18.0');
  assert.equal(toConstraint('22', true), '^22');
  assert.equal(toConstraint('v22.1.0', true), '^22.1.0');
  assert.equal(toConstraint('~1.2.3', false), '>=1.2.3');
  assert.equal(toConstraint('>=18 <21', false), '>=18');
  assert.equal(toConstraint('lts/*', true), undefined);
  assert.equal(toConstraint('^18 || ^20', false), undefined);
});
