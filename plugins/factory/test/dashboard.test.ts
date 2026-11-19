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

/** dashboard/index.html's loadJobs() and jobProblem(), run as the page runs them, over `files` (dir -> job.json text). */
function pageLoadJobs(files: Record<string, string | null>): { load: () => Promise<any[]>; warnings: string[] } {
  const page = readFileSync(join(PLUGIN, 'dashboard', 'index.html'), 'utf8');
  const parts = [
    /^const STAGES = .*$/m,
    /^const SHA = .*$/m,
    /^function jobProblem\(j, dir\) \{[\s\S]*?^\}$/m,
    /^const warnedJobs = .*$/m,
    /^async function loadJobs\(\) \{[\s\S]*?^\}$/m,
  ].map((re) => re.exec(page)?.[0]);
  assert.ok(parts.every(Boolean), 'loadJobs, jobProblem, warnedJobs or STAGES not found in dashboard/index.html');
  const warnings: string[] = [];
  const ctx = {
    warnings,
    out: null as unknown,
    console: { warn: (m: string) => warnings.push(m) },
    listDir: async () => Object.keys(files).map((d) => `${encodeURIComponent(d)}/`),
    get: async (url: string) => {
      const dir = decodeURIComponent(url.split('/')[1] as string);
      const text = files[dir];
      if (text === null || text === undefined) throw new Error(`${url} 404`);
      return { json: async () => JSON.parse(text) };
    },
  };
  runInNewContext(`${parts.join('\n')}\nout = loadJobs;`, ctx);
  return { load: ctx.out as () => Promise<any[]>, warnings };
}

test('the dashboard skips a job whose job.json fails validation, warning once per bad job', async () => {
  const job = (id: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ id, title: 't', stage: 'build', status: 'active', created: '2026-01-01T00:00:00Z', rounds: [], history: [], ...extra });
  const { load, warnings } = pageLoadJobs({
    '001-good': job('001-good'),
    '002-broken': '{"id": ',
    '003-odd': job('003-odd', { stage: 'nowhere' }),
    '004-other': job('999-elsewhere'),
    '005-old': job('005-old'), // an older job.json without followups or owner still shows
    '006-rounds': job('006-rounds', { rounds: 'r1' }),
    advisor: null,
  });
  const ids = [...(await load())].map((j) => j.id);
  assert.deepEqual(ids, ['001-good', '005-old']);
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.match(warnings[0] as string, /skipping jobs\/002-broken\/: job\.json cannot be read as JSON/);
  assert.match(warnings[1] as string, /skipping jobs\/003-odd\/: 'stage' is "nowhere"/);
  assert.match(warnings[2] as string, /skipping jobs\/004-other\/: its id is "999-elsewhere"/);
  assert.match(warnings[3] as string, /skipping jobs\/006-rounds\/: 'rounds'/);
  // The next poll shows the same jobs and does not warn again.
  assert.deepEqual([...(await load())].map((j) => j.id), ids);
  assert.equal(warnings.length, 4);
});

test('a job card shows the built commit (job.head) short, and older job.json files without it still render', () => {
  const page = readFileSync(join(PLUGIN, 'dashboard', 'index.html'), 'utf8');
  const parts = [
    /^const SHA = .*$/m,
    /^const esc = .*$/m,
    /^const view = .*$/m,
    /^const ago = [\s\S]*?^\};$/m,
    /^const isHuman = .*$/m,
    /^const followups = .*$/m,
    /^const openFu = .*$/m,
    /^const ownerName = .*$/m,
    /^const headHtml = [\s\S]*?: '';$/m,
    /^function roundsHtml\(j\) \{[\s\S]*?^\}$/m,
    /^function cardHtml\(j\) \{[\s\S]*?^\}$/m,
  ].map((re) => re.exec(page)?.[0]);
  assert.ok(parts.every(Boolean), `not found in dashboard/index.html: part ${parts.findIndex((x) => !x)}`);
  const ctx = { firstLoad: true, seenVerdicts: new Set(), out: null as unknown };
  runInNewContext(`${parts.join('\n')}\nout = cardHtml;`, ctx);
  const cardHtml = ctx.out as (job: unknown) => string;
  const base = { id: '001-x', title: 't', stage: 'proof', status: 'active', activity: 'a', updated: '2026-01-01T00:00:00Z', rounds: [], history: [] };
  const sha = 'a'.repeat(28) + '0123456789ab';
  const html = cardHtml({ ...base, head: sha });
  assert.match(html, new RegExp(`<span class="sha" title="Built commit ${sha}">${sha.slice(0, 12)}</span>`));
  // An older job.json without head renders, with no sha.
  const old = cardHtml(base);
  assert.match(old, /<div class="title">t<\/div>/);
  assert.doesNotMatch(old, /class="sha"/);
  // jobProblem accepts a 40- or 64-hex head or none, and skips anything else.
  const job = (id: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ id, title: 't', stage: 'proof', status: 'active', created: '2026-01-01T00:00:00Z', rounds: [], history: [], ...extra });
  const { load, warnings } = pageLoadJobs({
    '001-sha1': job('001-sha1', { head: 'b'.repeat(40) }),
    '002-sha256': job('002-sha256', { head: 'c'.repeat(64) }),
    '003-none': job('003-none'),
    '004-bad': job('004-bad', { head: 'main' }),
  });
  return load().then((jobs) => {
    assert.deepEqual([...jobs].map((j) => j.id), ['001-sha1', '002-sha256', '003-none']);
    assert.match(warnings.join('\n'), /skipping jobs\/004-bad\/: 'head' is not a commit hash/);
  });
});
