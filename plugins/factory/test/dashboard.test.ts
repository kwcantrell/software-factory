// `factory dashboard`: the CLI serving a factory dir (a copy of the compatibility fixture) on
// 127.0.0.1, read the way dashboard/index.html reads it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLI, cleanEnv, PLUGIN } from './helpers.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-dashboard-')));
const root = join(scratch, 'factory');
let server: ChildProcess;
let port = 0;
let banner = '';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port: p } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

before(async () => {
  cpSync(fileURLToPath(new URL('fixtures/factory-py/factory', import.meta.url)), root, { recursive: true });
  writeFileSync(join(scratch, 'secret.txt'), 'outside the factory dir\n');
  symlinkSync(join(scratch, 'secret.txt'), join(root, 'jobs', 'escape.md'));
  port = await freePort();
  server = spawn(process.execPath, [CLI, 'dashboard', '--port', String(port)], {
    cwd: scratch,
    env: cleanEnv(scratch, { FACTORY_DIR: root }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    server.stdout?.on('data', (chunk: Buffer) => {
      banner += chunk.toString();
      if (banner.includes('\n')) resolve();
    });
    server.on('exit', (code) => reject(new Error(`dashboard exited ${code}`)));
  });
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(scratch, { recursive: true, force: true });
});

/** A raw GET: the path is sent exactly as given (fetch() would normalise "/../"). */
function get(path: string, host = '127.0.0.1'): Promise<{ status: number; type: string; body: string; location?: string; csp?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers['content-type']),
          body,
          location: res.headers.location,
          csp: res.headers['content-security-policy'] as string | undefined,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** dashboard/index.html's listDir(): every <a href>, minus the ones its own filter drops. */
function listDir(html: string): string[] {
  const page = readFileSync(join(PLUGIN, 'dashboard', 'index.html'), 'utf8');
  const filter = /\.filter\(h => h && !\/(.+?)\/i\.test\(h\)\)/.exec(page);
  assert.ok(filter, 'listDir filter not found in dashboard/index.html');
  const drop = new RegExp(filter[1] as string, 'i');
  return [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1] as string).filter((h) => h && !drop.test(h));
}

test('prints where it serves, on 127.0.0.1 only', async () => {
  assert.equal(banner, `dashboard: http://127.0.0.1:${port}/  (serving ${root}, Ctrl-C to stop)\n`);
  const other = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (other) await assert.rejects(get('/', other.address), 'not reachable on another interface');
});

test('GET / serves the dashboard page, which init installed', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/html/);
  assert.equal(r.body, readFileSync(join(PLUGIN, 'dashboard', 'index.html'), 'utf8'));
  assert.doesNotMatch(r.body, /python/i);
});

test('GET /jobs/ lists every job in the form the dashboard parses, and their files load', async () => {
  const r = await get('/jobs/');
  assert.equal(r.status, 200);
  const dirs = listDir(r.body).filter((h) => h.endsWith('/'));
  const ids = readdirSync(join(root, 'jobs')).filter((n) => !n.endsWith('.md')).sort();
  assert.deepEqual(dirs, ids.map((id) => `${id}/`));
  for (const d of dirs) {
    const job = await get(`/jobs/${d}job.json`);
    assert.equal(job.status, 200);
    assert.match(job.type, /^application\/json/);
    assert.equal(JSON.parse(job.body).id, d.slice(0, -1));
  }
  const files = listDir((await get('/jobs/004-shipped-after-two-rounds/')).body).filter((h) => h.endsWith('.md'));
  assert.ok(files.includes('task.md') && files.includes('review-2-standards.md'), files.join(' '));
  const task = await get('/jobs/004-shipped-after-two-rounds/task.md');
  assert.equal(task.status, 200);
  assert.match(task.body, /Acceptance criteria/);
});

test('a directory without its slash redirects, a missing file is 404', async () => {
  const r = await get('/jobs');
  assert.equal(r.status, 301);
  assert.equal(r.location, '/jobs/');
  assert.equal((await get('/jobs/nope.json')).status, 404);
});

test('paths that escape the factory dir are refused', async () => {
  for (const path of [
    '/../secret.txt',
    '/jobs/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/jobs/%2E%2E/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/jobs/escape.md',
    '/%00',
    '/..\\secret.txt',
    '/%E0%A4%A',
  ]) {
    const r = await get(path);
    assert.ok(r.status >= 400 && r.status < 500, `${path}: ${r.status}`);
    assert.doesNotMatch(r.body, /outside the factory dir/, path);
  }
});

test('the page and job files are served with a CSP that keeps the page from sending data elsewhere', async () => {
  for (const path of ['/', '/jobs/']) {
    const csp = (await get(path)).csp ?? '';
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /connect-src 'self'/, path);
    assert.match(csp, /img-src 'self' data:(;|$)/, path);
    assert.doesNotMatch(csp, /\*|https?:/, path);
  }
});

/** dashboard/index.html's esc() and roundsHtml(), run as the page runs them. */
function pageRounds(): (job: unknown) => string {
  const page = readFileSync(join(PLUGIN, 'dashboard', 'index.html'), 'utf8');
  const esc = /^const esc = .*$/m.exec(page);
  const rounds = /^function roundsHtml\(j\) \{[\s\S]*?^\}$/m.exec(page);
  assert.ok(esc && rounds, 'esc or roundsHtml not found in dashboard/index.html');
  const ctx = { firstLoad: false, seenVerdicts: new Set(), out: null as unknown };
  runInNewContext(`${esc[0]}\n${rounds[0]}\nout = roundsHtml;`, ctx);
  return ctx.out as (job: unknown) => string;
}

test('round numbers and verdicts from a shared job.json are escaped, never rendered as markup', () => {
  const roundsHtml = pageRounds();
  const html = roundsHtml({
    id: '001-x',
    rounds: [{ n: '<img src=x onerror=alert(1)>', reviewers: { security: { verdict: '"><img src=x onerror=fetch(1)>' }, '<b>x</b>': {} } }],
  });
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /R&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<span class="chip " title="security: pending">security<\/span>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  // The known verdicts still style their chips; old files without rounds still render.
  const ok = roundsHtml({ id: '002-y', rounds: [{ n: 1, reviewers: { behavior: { verdict: 'approve' }, standards: { verdict: 'changes' } } }] });
  assert.match(ok, /<span class="n">R1<\/span>/);
  assert.match(ok, /class="chip approve landed"/);
  assert.match(ok, /class="chip changes landed"/);
  assert.equal(roundsHtml({ id: '003-z' }), '');
});
