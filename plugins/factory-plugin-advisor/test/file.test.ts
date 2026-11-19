// file: dry run, the redaction re-check, and filing through a fake gh on PATH (never the real one).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { draftFields, issues, KINDS, MARKETPLACE_REPO, renderDraft, targetOf, type Issue } from '../src/advisor.ts';
import { draftSecrets, secretLines, withoutFields, withoutPluginName } from '../src/file.ts';
import { EXIT } from '../src/run.ts';
import { fakeGh, sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
afterEach(() => box?.cleanup());

const R = '[redacted]';
const ISSUE_URL = 'https://github.com/kwcantrell/software-factory/issues/42';

function json(r: { code: number; stdout: string; stderr: string }): any {
  assert.equal(r.code, EXIT.ok, r.stderr);
  return JSON.parse(r.stdout);
}

/** A sandbox whose PATH has only a fake gh (plus node's own dir, for the fake's shebang). */
function withGh(script: string): Sandbox {
  const b = sandbox();
  const bin = fakeGh(b.dir, script);
  b.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  return b;
}

function suggested(b: Sandbox): string {
  let sig = '';
  for (let i = 0; i < 3; i++) sig = json(b.call(['record', '--plugin', 'factory-docs', '--kind', 'cli-failure', '--summary', 'call docs_map exited 1: not signed in', '--detail', 'after token=abc123 expired', '--json'])).signature;
  assert.equal(json(b.call(['suggest', '--json'])).suggestions.length, 1);
  return sig;
}

function ghCalls(b: Sandbox): Array<{ argv: string[]; stdin: string }> {
  const path = join(b.dir, 'gh-calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('without --confirm, file prints exactly what would be filed and does not run gh', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const r = json(box.call(['file', sig, '--json']));
  const draft = readFileSync(join(box.config, 'drafts', `${sig}.md`), 'utf8');
  assert.equal(r.dryRun, true);
  assert.equal(r.filed, false);
  assert.equal(r.repo, MARKETPLACE_REPO);
  assert.equal(r.knownPublic, true);
  assert.equal(`# ${r.title}\n\n${r.body}`, draft);
  assert.match(r.title, /^factory-plugin-advisor: factory-docs: call docs_map exited 1: not signed in$/);
  assert.ok(r.body.includes('after token=[redacted] expired'));
  assert.deepEqual(ghCalls(box), []);
  const text = box.call(['file', sig]);
  assert.equal(text.code, EXIT.ok);
  assert.match(text.stdout, /^Dry run: nothing was filed\.\nRepository: kwcantrell\/software-factory \(public: anyone can read what is filed\)\nTitle: factory-plugin-advisor: /);
  assert.match(text.stdout, /Run file again with --confirm to file exactly this\.\n$/);
  assert.equal(json(box.call(['file', sig, '--repo', 'someone/fork', '--json'])).repo, 'someone/fork');
  assert.deepEqual(ghCalls(box), []);
});

test('--confirm files through gh with the body on stdin, records the URL, and never files twice', () => {
  box = withGh(`console.log('Creating issue in kwcantrell/software-factory\\n\\n' + ${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const dry = json(box.call(['file', sig, '--json']));
  const r = json(box.call(['file', sig, '--confirm', '--json']));
  assert.equal(r.filed, true);
  assert.equal(r.dryRun, false);
  assert.equal(r.url, ISSUE_URL);
  const calls = ghCalls(box);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.argv, ['issue', 'create', '--repo', MARKETPLACE_REPO, '--title', dry.title, '--body-file', '-']);
  assert.equal(calls[0]?.stdin, dry.body, 'the body gh receives is exactly the dry-run body');
  const issue = json(box.call(['show', sig, '--json']));
  assert.equal(issue.status, 'filed');
  assert.equal(issue.issueUrl, ISSUE_URL);
  const again = box.call(['file', sig, '--confirm']);
  assert.equal(again.code, EXIT.failure);
  assert.match(again.stderr, /already filed as https:\/\/github\.com\/kwcantrell\/software-factory\/issues\/42/);
  assert.equal(ghCalls(box).length, 1);
});

test('--repo overrides the target repo', () => {
  box = withGh(`console.log('https://github.com/someone/fork/issues/7');`);
  const sig = suggested(box);
  assert.equal(json(box.call(['file', sig, '--repo', 'someone/fork', '--confirm', '--json'])).url, 'https://github.com/someone/fork/issues/7');
  assert.deepEqual(ghCalls(box)[0]?.argv.slice(0, 4), ['issue', 'create', '--repo', 'someone/fork']);
});

test('a title with shell metacharacters reaches gh as one argument, unexpanded', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  let sig = '';
  for (let i = 0; i < 3; i++) sig = json(box.call(['record', '--plugin', 'factory-dev', '--kind', 'workaround', '--summary', 'ran $(touch pwned) `id` ; echo "x" > y by hand', '--json'])).signature;
  json(box.call(['suggest', '--json']));
  json(box.call(['file', sig, '--confirm', '--json']));
  const title = ghCalls(box)[0]?.argv[5] ?? '';
  assert.ok(title.includes('$(touch pwned)'), title);
  assert.equal(existsSync(join(box.dir, 'pwned')), false);
});

test('file refuses (exit 1) when the draft holds secret-looking text, without running gh', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const path = join(box.config, 'drafts', `${sig}.md`);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nAlso: Authorization: Bearer abcdefghijklmnop0123456789\n`);
  for (const argv of [['file', sig], ['file', sig, '--confirm']]) {
    const r = box.call(argv);
    assert.equal(r.code, EXIT.failure);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^factory-plugin-advisor: refusing to file [0-9a-f]{12}: the draft at .* still has secret-looking text on line \d+/);
  }
  assert.deepEqual(ghCalls(box), []);
});

// Follow-up 012 #5: capping a ~190-character summary after redaction cut 'token=[redacted]' to
// 'token=[r…', which redact rewrites, so file refused a draft that held no secret.
test('summaries capped next to a redacted value still file (dry run)', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  let sig = '';
  for (let i = 1; i <= 3; i++) {
    const summary = `${'x'.repeat(190)} token=abc${i}`;
    sig = json(box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', summary, '--json'])).signature;
  }
  assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
  const r = box.call(['file', sig, '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).filed, false);
  assert.deepEqual(ghCalls(box), []);
});

// Review 1: renderDraft appends text after a redacted header on the same line, and file re-checks the
// draft with redact, which used to rewrite `Authorization: [redacted]". factory-plugin-advisor ...` and refuse.
for (const summary of [
  'mcp call fails with Authorization: Token abc123xyz',
  'login fails, Cookie: session=ab1',
  'curl failed\nAuthorization: Token abc123xyz\nstatus 401',
]) {
  test(`a summary with a header still files (dry run): ${JSON.stringify(summary)}`, () => {
    box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
    let sig = '';
    for (let i = 1; i <= 3; i++) {
      sig = json(box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', summary, '--json'])).signature;
    }
    assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
    const r = box.call(['file', sig, '--json']);
    assert.equal(r.code, EXIT.ok, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.filed, false);
    assert.ok(!/abc123xyz|session=ab1/.test(r.stdout), r.stdout);
    assert.deepEqual(ghCalls(box), []);
  });
}

/** Records `summary` (and `detail`) three times, suggests, and runs file as a dry run. */
function fileDryRun(b: Sandbox, summary: string, detail?: string): { code: number; stdout: string; stderr: string } {
  let sig = '';
  for (let i = 1; i <= 3; i++) {
    const extra = detail === undefined ? [] : ['--detail', detail];
    sig = json(b.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', summary, ...extra, '--json'])).signature;
  }
  assert.equal(json(b.call(['suggest', '--json'])).suggestions.length, 1);
  return b.call(['file', sig, '--json']);
}

// Review 2: file re-ran redact over each rendered line, where the draft's own text follows a stored
// value (`". factory-plugin-advisor signature ...`, ` (exit 2, recorded by the hook)`, the next joined line),
// and refused clean drafts. It now checks each stored field on its own and the text around it apart.
// The last rows are a typed `[redacted]` followed by a real secret, which must still be redacted.
for (const [summary, secrets] of [
  ['login fails, Cookie: session=ab1;', ['ab1']],
  ['Cookie: a=b;\nthen 403', ['a=b']],
  ['Set-Cookie: a=b; Path=/;\nthen 403', ['a=b']],
  ['Cookie: a=b\n; x', ['a=b']],
  [`${'x'.repeat(177)} "api_key": "k1" more`, ['"k1"']],
  [`${'x'.repeat(178)} token="abc1" more`, ['abc1']],
  ['Cookie: a=[redacted] x; b=realsecret', ['realsecret']],
  ['Authorization: [redacted] abc123', ['abc123']],
  ['retry with token=[redacted]realsecret', ['realsecret']],
] as const) {
  test(`a draft with stored text next to its own text files (dry run): ${JSON.stringify(summary.slice(-40))}`, () => {
    box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
    const r = fileDryRun(box, summary, summary);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.equal(JSON.parse(r.stdout).filed, false);
    for (const secret of secrets) assert.ok(!r.stdout.includes(secret), `${secret} in ${r.stdout}`);
    assert.deepEqual(ghCalls(box), []);
  });
}

test('every line of a rendered draft that quotes a stored field is recognised (FIELD_LINES matches renderDraft)', () => {
  const summary = `a ${'y'.repeat(150)} Cookie: s=${R}; ${R}`;
  for (const [plugin, known] of [['factory-docs', ['factory-docs']], ['made-up-plugin', []], ['none', []]] as const) {
    const occ = [1, 2, 3].map((k) => ({
      signature: 'abcdef012345', plugin, kind: 'cli-failure', summary, detail: `one\nCookie: s=${R}; ${R}`, at: `2026-11-0${k}T10:00:00.000Z`,
      source: k === 1 ? ('hook' as const) : ('record' as const), ...(k === 1 ? { subcommand: 'call', exitCode: 2 } : {}),
    }));
    const [issue] = issues(occ, { version: 1, issues: {} });
    const { text } = renderDraft(issue as Issue, occ, targetOf(plugin, known));
    const rest = withoutFields(text, draftFields(plugin, occ));
    assert.ok(!rest.includes(`s=${R}`), rest);
    assert.ok(!rest.includes('yyyyy'), rest);
    assert.deepEqual(secretLines(rest), []);
  }
});

test('summaries of every length from 170 to 200 ending in a quoted secret file (dry run)', () => {
  for (const tail of [' "api_key": "k1" more', ' token="abc1" more', ' Cookie: session=ab1; then']) {
    for (let length = 170; length <= 200; length++) {
      const b = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
      try {
        const summary = `${'x'.repeat(length - tail.length)}${tail}`;
        const r = fileDryRun(b, summary);
        assert.equal(r.code, EXIT.ok, `${length} ${tail}: ${r.stderr}`);
        assert.deepEqual(ghCalls(b), []);
      } finally {
        b.cleanup();
      }
    }
  }
});

// Follow-up 017 #4: a hook summary ending in `-p` gets ` (exit 2, recorded by the hook)` after it on
// its evidence line, and the -p rule read `(exit` as the password.
test('a hook-recorded failure whose message ends in -p files (dry run)', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npx --yes --offline --loglevel=error --package="/x" -- factory-docs call docs_map --json' },
    error: 'Exit code 2\nfactory-docs: usage: mkdir -p',
    is_interrupt: false,
  });
  for (let i = 0; i < 3; i++) assert.equal(box.call(['hook'], { stdin: payload }).code, EXIT.ok);
  const [s] = json(box.call(['suggest', '--json'])).suggestions;
  assert.equal(s.summary, 'factory-docs call exited 2: factory-docs: usage: mkdir -p');
  const draft = readFileSync(s.draft, 'utf8');
  assert.ok(draft.includes('usage: mkdir -p (command `call`, exit 2, recorded by the hook)'), draft);
  const r = box.call(['file', s.signature, '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(ghCalls(box), []);
});

test('text edited into a draft is checked as it is: a typed [redacted] or a stored value shields nothing', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  const sig = suggested(box);
  const path = join(box.config, 'drafts', `${sig}.md`);
  const original = readFileSync(path, 'utf8');
  const summary = 'call docs_map exited 1: not signed in';
  for (const edit of [
    `${original}\nCookie: a=[redacted] x; b=realsecret\n`,
    `${original}\nAuthorization: [redacted] abc123\n`,
    // A stored summary with a secret appended on its own evidence line.
    original.replace(`: ${summary}\n`, `: ${summary} token=abc123\n`),
    // The Problem line with a secret put in front of the stored summary.
    original.replace(`failed: ${summary}`, `failed: password=hunter2 ${summary}`),
  ]) {
    assert.notEqual(edit, original);
    writeFileSync(path, edit);
    const r = box.call(['file', sig, '--confirm']);
    assert.equal(r.code, EXIT.failure, edit);
    assert.match(r.stderr, /still has secret-looking text on line \d+/);
  }
  assert.deepEqual(ghCalls(box), []);
});

// Review 1 (behavior): a plugin name with a secret-like word in it, followed by the title's `: `, read
// as a `key: value` pair, so every draft for that plugin was refused with no line named.
const SECRET_LIKE_NAMES = ['token-helper', 'secret-store', 'api-token-store', 'session-id-tools', 'password-vault'];

for (const plugin of SECRET_LIKE_NAMES) {
  test(`a draft for new plugin ${plugin} files (dry run, then --confirm)`, () => {
    box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
    let sig = '';
    for (let i = 0; i < 3; i++) {
      sig = json(box.call(['record', '--plugin', plugin, '--kind', 'manual-step', '--summary', `had to copy session ids by hand (run ${i})`, '--json'])).signature;
    }
    assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
    const dry = box.call(['file', sig, '--json']);
    assert.equal(dry.code, EXIT.ok, dry.stderr);
    assert.match(JSON.parse(dry.stdout).title, new RegExp(`^factory-plugin-advisor: new plugin ${plugin}: had to copy session ids by hand`));
    const r = json(box.call(['file', sig, '--confirm', '--json']));
    assert.equal(r.filed, true);
    assert.equal(ghCalls(box).length, 1);
  });
}

test('a draft for an existing plugin with a secret-like name passes the check, for every kind', () => {
  for (const plugin of SECRET_LIKE_NAMES) {
    for (const kind of Object.keys(KINDS)) {
      const occ = [1, 2, 3].map((k) => ({
        signature: 'abcdef012345', plugin, kind, summary: 'the sync step fails again', at: `2026-11-0${k}T10:00:00.000Z`,
        source: k === 1 ? ('hook' as const) : ('record' as const), ...(k === 1 ? { subcommand: 'sync', exitCode: 1 } : {}),
      }));
      const [issue] = issues(occ, { version: 1, issues: {} });
      const { text } = renderDraft(issue as Issue, occ, targetOf(plugin, [plugin]));
      assert.deepEqual(draftSecrets(text, plugin, occ), [], `${plugin} ${kind}:\n${text}`);
    }
  }
});

test('the plugin name is neutralised only where the draft template puts it', () => {
  const plugin = 'token-helper';
  assert.equal(withoutPluginName('# factory-plugin-advisor: token-helper: ', plugin), '# factory-plugin-advisor: plugin: ');
  assert.equal(withoutPluginName('# factory-plugin-advisor: new plugin token-helper: ', plugin), '# factory-plugin-advisor: new plugin plugin: ');
  assert.equal(withoutPluginName('/factory:run token-helper: Fix `token-helper sync` now', plugin), '/factory:run plugin: Fix `plugin sync` now');
  for (const typed of ['token-helper: hunter2xyz', 'token-helper=hunter2xyz', 'x `token-helper=hunter2xyz`', '"token-helper": "hunter2xyz"']) {
    assert.equal(withoutPluginName(typed, plugin), typed);
  }
  // A name that is secret-looking on its own is never replaced.
  const random = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
  assert.equal(withoutPluginName(`/factory:run ${random}: x`, random), `/factory:run ${random}: x`);
});

test('a secret typed next to a secret-like plugin name is still refused, naming its line', () => {
  box = withGh(`console.log(${JSON.stringify(ISSUE_URL)});`);
  let sig = '';
  for (let i = 0; i < 3; i++) sig = json(box.call(['record', '--plugin', 'token-helper', '--kind', 'workaround', '--summary', 'had to retry by hand', '--json'])).signature;
  json(box.call(['suggest', '--json']));
  const path = join(box.config, 'drafts', `${sig}.md`);
  const original = readFileSync(path, 'utf8');
  for (const edit of [`${original}\ntoken-helper: hunter2xyz\n`, `${original}\nUse \`token-helper=hunter2xyz\` here\n`]) {
    writeFileSync(path, edit);
    const r = box.call(['file', sig, '--confirm']);
    assert.equal(r.code, EXIT.failure, edit);
    assert.match(r.stderr, /still has secret-looking text on line \d+/);
  }
  writeFileSync(path, `${original}\npassword:\n  hunter2xyz\n`);
  const spanning = box.call(['file', sig, '--confirm']);
  assert.equal(spanning.code, EXIT.failure);
  assert.match(spanning.stderr, /still has secret-looking text/);
  assert.deepEqual(ghCalls(box), []);
});

test('file needs a draft, refuses dismissed issues, and reports gh failures', () => {
  box = withGh(`process.stderr.write('HTTP 401: Bad credentials (token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345)\\n'); process.exit(1);`);
  let sig = '';
  for (let i = 0; i < 2; i++) sig = json(box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', 'x', '--json'])).signature;
  const noDraft = box.call(['file', sig]);
  assert.equal(noDraft.code, EXIT.failure);
  assert.match(noDraft.stderr, /has no draft yet; run suggest first/);
  json(box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', 'x', '--json']));
  json(box.call(['suggest', '--json']));
  const failed = box.call(['file', sig, '--confirm']);
  assert.equal(failed.code, EXIT.failure);
  assert.match(failed.stderr, /^factory-plugin-advisor: gh issue create exited 1: HTTP 401: Bad credentials \(token \[redacted\]\)\n$/);
  assert.equal(json(box.call(['show', sig, '--json'])).status, 'suggested', 'a failed filing records nothing');
  json(box.call(['dismiss', sig, '--json']));
  assert.match(box.call(['file', sig]).stderr, /is dismissed; not filing it/);
});

test('file reports a missing gh clearly', () => {
  box = sandbox({ PATH: '/nonexistent' });
  const sig = suggested(box);
  const r = box.call(['file', sig, '--confirm']);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /gh is not on PATH/);
});

// Personal details: masked before storing, again when rendering, and file refuses a draft that still
// has one. The identity is made up.
const PERSONAL = [
  'build failed at /home/jdoe-test/proj for jdoe-test, mailed jdoe-test@example.com, @octocat said retry',
  'C:\\Users\\jdoe-test\\proj broke, ask @octo-cat or (@someone), see `@kept` and @types/node',
];

function personalBox(): Sandbox {
  const b = sandbox({ HOME: '/srv/people/jdoe-test', USER: 'jdoe-test' });
  b.env.PATH = `${fakeGh(b.dir, `console.log(${JSON.stringify(ISSUE_URL)});`)}:${process.env.PATH ?? ''}`;
  return b;
}

/** Mentions GitHub would link: outside inline code, not after a word character, / or . */
function linkable(markdown: string): string[] {
  return [...markdown.replace(/`[^`\n]*`/g, '').matchAll(/(?<![\w/.])@[A-Za-z0-9-]{1,39}(?![A-Za-z0-9/-])/g)].map((m) => m[0]);
}

test('record (flags and --stdin) stores no username, email or mention; the draft has no linkable mention', () => {
  box = personalBox();
  let sig = '';
  for (let i = 0; i < 2; i++) {
    sig = json(box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', PERSONAL[0] ?? '', '--detail', `${PERSONAL[1] ?? ''}\nby /srv/people/jdoe-test/x`, '--json'])).signature;
  }
  const viaStdin = json(box.call(['record', '--stdin', '--json'], { stdin: JSON.stringify({ plugin: 'factory-docs', kind: 'workaround', summary: PERSONAL[0], detail: PERSONAL[1] }) }));
  assert.equal(viaStdin.signature, sig);
  const stored = readFileSync(join(box.config, 'occurrences.jsonl'), 'utf8');
  for (const leak of ['jdoe-test', 'example.com', 'octocat', 'octo-cat', 'someone', '/home/', 'Users']) assert.ok(!stored.includes(leak), `stored ${leak}:\n${stored}`);
  assert.ok(stored.includes('`@kept`') && stored.includes('@types/node'), 'code spans and npm scopes are kept');
  assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
  const draft = readFileSync(join(box.config, 'drafts', `${sig}.md`), 'utf8');
  assert.deepEqual(linkable(draft), [], draft);
  assert.ok(!draft.includes('jdoe-test') && !draft.includes('@kept'), draft);
  assert.equal(box.call(['file', sig, '--json']).code, EXIT.ok);
});

test('a draft made from a log written before masking existed is clean, and files', () => {
  box = personalBox();
  // A pre-masking log: summaries and details stored as typed (only redacted).
  const at = (n: number): string => `2026-10-0${n}T10:00:00.000Z`;
  const lines = [1, 2, 3].map((n) =>
    JSON.stringify({ signature: 'abcdef012345', plugin: 'factory-docs', kind: 'workaround', summary: PERSONAL[0], detail: PERSONAL[1], at: at(n), source: 'record' }),
  );
  mkdirSync(box.config, { recursive: true, mode: 0o700 });
  writeFileSync(join(box.config, 'occurrences.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });
  assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
  const draft = readFileSync(join(box.config, 'drafts', 'abcdef012345.md'), 'utf8');
  for (const leak of ['jdoe-test', 'example.com', 'octocat', 'octo-cat', 'someone', '/home/', 'Users']) assert.ok(!draft.includes(leak), `draft has ${leak}:\n${draft}`);
  assert.deepEqual(linkable(draft), [], draft);
  const r = json(box.call(['file', 'abcdef012345', '--confirm', '--json']));
  assert.equal(r.filed, true);
  assert.ok(!ghCalls(box)[0]?.stdin.includes('jdoe-test'));
});

for (const [what, added] of [
  ['an email', 'Contact: jdoe-test@example.com'],
  ['a home-dir username', 'Seen in /home/jdoe-test/proj'],
  ["the current user's home", 'Seen in /srv/people/jdoe-test/proj'],
  ['a linkable mention', 'Thanks @octocat'],
] as const) {
  test(`file refuses (exit 1, naming the line) a draft edited to hold ${what}, without running gh`, () => {
    box = personalBox();
    const sig = suggested(box);
    const path = join(box.config, 'drafts', `${sig}.md`);
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, `${text}${added}\n`);
    const line = text.split('\n').length;
    for (const argv of [['file', sig], ['file', sig, '--confirm']]) {
      const r = box.call(argv);
      assert.equal(r.code, EXIT.failure, r.stdout);
      assert.equal(r.stdout, '');
      assert.equal(
        r.stderr,
        `factory-plugin-advisor: refusing to file ${sig}: the draft at ${path} still has a home-dir username, email address or @mention on line ${line}; edit it out or dismiss the issue\n`,
      );
    }
    assert.deepEqual(ghCalls(box), []);
  });
}
