import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CLI_NAME, EXIT } from '../src/run.ts';
import { configDir } from '../src/store.ts';
import { sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox;
afterEach(() => box?.cleanup());

const REC = ['record', '--plugin', 'factory-docs', '--kind', 'workaround'];

function json(r: { code: number; stdout: string; stderr: string }): any {
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout);
}

test('--help prints usage on stdout', () => {
  box = sandbox();
  const { code, stdout } = box.call(['--help']);
  assert.equal(code, EXIT.ok);
  assert.match(stdout, new RegExp(`^Usage: ${CLI_NAME} `));
  for (const c of ['record', 'list', 'show', 'suggest', 'dismiss', 'file', 'hook', '--json']) assert.match(stdout, new RegExp(c));
});

test('--version prints the package version', () => {
  box = sandbox();
  assert.match(box.call(['--version']).stdout, /^\d+\.\d+\.\d+\n$/);
});

for (const argv of [
  ['nope'],
  [],
  ['list', '--bogus'],
  ['list', 'extra'],
  ['list', '--min', '0'],
  ['list', '--confirm'],
  ['show'],
  ['suggest', '--threshold', 'x'],
  ['record', '--plugin', 'factory-docs', '--kind', 'workaround'],
  ['record', '--plugin', 'Not A Name', '--kind', 'workaround', '--summary', 's'],
  ['record', '--plugin', 'factory-docs', '--kind', 'oops', '--summary', 's'],
  ['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', '   '],
  ['record', '--stdin', '--plugin', 'x'],
  ['show', 'not-hex'],
  ['file', 'abcd', '--repo', 'no slash'],
]) {
  test(`usage error for ${JSON.stringify(argv)}: exit 2, message on stderr only`, () => {
    box = sandbox();
    const { code, stdout, stderr } = box.call(argv);
    assert.equal(code, EXIT.usage, stderr);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^${CLI_NAME}: .+\\nRun '${CLI_NAME} --help' for usage\\.\\n$`));
  });
}

test('record stores a redacted occurrence in an owner-only log', () => {
  box = sandbox();
  const r = json(box.call([...REC, '--summary', 'login loop with Bearer abcdefghij1234567890', '--detail', 'cookie sid=s3cr3tvalue; and ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345', '--json']));
  assert.deepEqual(Object.keys(r).sort(), ['count', 'kind', 'plugin', 'redacted', 'signature', 'summary']);
  assert.equal(r.count, 1);
  assert.equal(r.redacted, true);
  assert.equal(r.summary, 'login loop with Bearer [redacted]');
  assert.equal(statSync(box.config).mode & 0o777, 0o700);
  const log = join(box.config, 'occurrences.jsonl');
  assert.equal(statSync(log).mode & 0o777, 0o600);
  const text = readFileSync(log, 'utf8');
  for (const secret of ['abcdefghij1234567890', 's3cr3tvalue', 'ghp_']) assert.ok(!text.includes(secret), secret);
  const stored = JSON.parse(text.trim());
  assert.equal(stored.plugin, 'factory-docs');
  assert.equal(stored.kind, 'workaround');
  assert.equal(stored.detail, 'cookie sid=[redacted]; and [redacted]');
  assert.equal(stored.at, '2026-11-01T10:01:00.000Z');
  assert.equal(stored.source, 'record');
});

test('record reads stdin JSON with --stdin, and accepts none or a proposed new plugin name', () => {
  box = sandbox();
  const a = json(box.call(['record', '--stdin', '--json'], { stdin: JSON.stringify({ plugin: 'none', kind: 'manual-step', summary: 'Copied the dev CA by hand' }) }));
  assert.equal(a.plugin, 'none');
  const b = json(box.call(['record', '--stdin', '--json'], { stdin: JSON.stringify({ plugin: 'factory-made-up-plugin', kind: 'missing-guidance', summary: 'No skill says how to screenshot', detail: 'd' }) }));
  assert.equal(b.plugin, 'factory-made-up-plugin');
  assert.equal(box.call(['record', '--stdin'], { stdin: '{"plugin":"x","kind":"workaround"}' }).code, EXIT.usage);
  assert.equal(box.call(['record', '--stdin'], { stdin: 'not json' }).code, EXIT.usage);
  assert.equal(box.call(['record', '--stdin'], { stdin: '{"plugin":"x","kind":"workaround","summary":"s","command":"rm"}' }).code, EXIT.usage);
});

test('the same issue worded differently counts once; list groups by signature', () => {
  box = sandbox();
  const a = json(box.call([...REC, '--summary', 'Call docs_map failed for session 98', '--json']));
  const b = json(box.call([...REC, '--summary', 'call docs_map failed for session 7.', '--json']));
  json(box.call(['record', '--plugin', 'factory-dev', '--kind', 'manual-step', '--summary', 'ran make dev-ca by hand', '--json']));
  assert.equal(a.signature, b.signature);
  assert.equal(b.count, 2);
  const { issues } = json(box.call(['list', '--json']));
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], {
    signature: a.signature,
    plugin: 'factory-docs',
    kind: 'workaround',
    summary: 'call docs_map failed for session 7.',
    count: 2,
    firstSeen: '2026-11-01T10:01:00.000Z',
    lastSeen: '2026-11-01T10:02:00.000Z',
    status: 'open',
  });
  assert.equal(json(box.call(['list', '--min', '2', '--json'])).issues.length, 1);
  assert.deepEqual(json(box.call(['list', '--plugin', 'factory-dev', '--json'])).issues.map((i: any) => i.plugin), ['factory-dev']);
  const text = box.call(['list']);
  assert.match(text.stdout, new RegExp(`^${a.signature} +2x {2}factory-docs {2}workaround {2}2026-11-01\\.\\.2026-11-01 {2}open {2}call docs_map`));
  assert.equal(sandbox().call(['list']).stdout, 'No issues recorded.\n');
});

test('show gives one issue with its redacted occurrences, by signature or prefix', () => {
  box = sandbox();
  const a = json(box.call([...REC, '--summary', 'token=abc123 rejected', '--detail', 'first', '--json']));
  json(box.call([...REC, '--summary', 'token=zzz999 rejected', '--json']));
  const d = json(box.call(['show', a.signature, '--json']));
  assert.equal(d.count, 2);
  assert.deepEqual(d.occurrences.map((o: any) => o.summary), ['token=[redacted] rejected', 'token=[redacted] rejected']);
  assert.equal(d.occurrences[0].detail, 'first');
  assert.equal(json(box.call(['show', a.signature.slice(0, 5), '--json'])).signature, a.signature);
  const missing = box.call(['show', 'ffffffffffff']);
  assert.equal(missing.code, EXIT.failure);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^factory-plugin-advisor: no recorded issue has signature ffffffffffff/);
});

function recordTimes(n: number, summary = 'call docs_map failed for session 1'): string {
  let sig = '';
  for (let i = 0; i < n; i++) sig = json(box.call([...REC, '--summary', summary, '--json'])).signature;
  return sig;
}

test('suggest returns only issues at or over the threshold and writes a draft for each', () => {
  box = sandbox();
  recordTimes(2);
  assert.deepEqual(json(box.call(['suggest', '--json'])), { threshold: 3, suggestions: [] });
  assert.match(box.call(['suggest']).stdout, /^No new suggestions/);
  const sig = recordTimes(1);
  const { suggestions } = json(box.call(['suggest', '--json']));
  assert.equal(suggestions.length, 1);
  const s = suggestions[0];
  assert.equal(s.signature, sig);
  assert.equal(s.count, 3);
  assert.deepEqual(s.target, { kind: 'existing', plugin: 'factory-docs', text: 'existing marketplace plugin `factory-docs`' });
  assert.equal(s.draft, join(box.config, 'drafts', `${sig}.md`));
  assert.equal(statSync(join(box.config, 'drafts')).mode & 0o777, 0o700);
  assert.equal(statSync(s.draft).mode & 0o777, 0o600);
  const draft = readFileSync(s.draft, 'utf8');
  assert.match(draft, /^# factory-plugin-advisor: factory-docs: call docs_map failed for session 1\n/);
  for (const section of ['## Target', '## Problem', '## Evidence', '## Proposed change', '## Factory request']) assert.ok(draft.includes(section), section);
  assert.match(draft, /Seen 3 times, first 2026-11-01T10:01:00.000Z, last 2026-11-01T10:05:00.000Z/);
  assert.match(draft, /Existing marketplace plugin `factory-docs`/);
  const runLines = draft.split('\n').filter((l) => l.startsWith('/factory:run '));
  assert.equal(runLines.length, 1, 'exactly one single-line /factory:run request');
  assert.equal(runLines[0], s.factoryRun);
  assert.match(s.factoryRun, /^\/factory:run factory-docs: Fix the bug or gap in `factory-docs`.*seen 3 times.*signature [0-9a-f]{12}\.$/);
  // Text output.
  recordTimes(3, 'another issue entirely');
  const text = box.call(['suggest']);
  assert.match(text.stdout, /^[0-9a-f]{12} {2}3x {2}factory-docs: another issue entirely\n {2}draft: .*\.md\n {2}\/factory:run /);
});

test('suggest --threshold, and the re-suggest rule: only after the count grows by the threshold again', () => {
  box = sandbox();
  const sig = recordTimes(2);
  assert.equal(json(box.call(['suggest', '--threshold', '2', '--json'])).suggestions.length, 1);
  assert.equal(json(box.call(['suggest', '--threshold', '2', '--json'])).suggestions.length, 0, 'not re-suggested at the same count');
  recordTimes(1);
  assert.equal(json(box.call(['suggest', '--threshold', '2', '--json'])).suggestions.length, 0, 'count 3 < 2 + 2');
  recordTimes(1);
  const again = json(box.call(['suggest', '--threshold', '2', '--json'])).suggestions;
  assert.equal(again.length, 1, 'count 4 >= 2 + 2');
  assert.equal(again[0].signature, sig);
  assert.match(readFileSync(again[0].draft, 'utf8'), /Seen 4 times/);
  assert.equal(json(box.call(['list', '--json'])).issues[0].status, 'suggested');
});

test('dismiss stops further suggestions for an issue', () => {
  box = sandbox();
  const sig = recordTimes(3);
  assert.deepEqual(json(box.call(['dismiss', sig, '--json'])), { signature: sig, dismissed: true });
  recordTimes(10);
  assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 0);
  assert.equal(json(box.call(['list', '--json'])).issues[0].status, 'dismissed');
  assert.equal(box.call(['dismiss', 'abcdef123456']).code, EXIT.failure);
});

test('a plugin outside the marketplace is targeted as a new plugin', () => {
  box = sandbox();
  for (let i = 0; i < 3; i++) json(box.call(['record', '--plugin', 'example-new-plugin', '--kind', 'manual-step', '--summary', 'took a screenshot by hand', '--json']));
  for (let i = 0; i < 3; i++) json(box.call(['record', '--plugin', 'none', '--kind', 'manual-step', '--summary', 'rotated logs by hand', '--json']));
  const { suggestions } = json(box.call(['suggest', '--json']));
  const byPlugin = Object.fromEntries(suggestions.map((s: any) => [s.plugin, s]));
  assert.deepEqual(byPlugin['example-new-plugin'].target, { kind: 'new', plugin: 'example-new-plugin', text: 'new plugin: `example-new-plugin`' });
  assert.equal(byPlugin.none.target.kind, 'new');
  assert.match(readFileSync(byPlugin['example-new-plugin'].draft, 'utf8'), /New plugin: `example-new-plugin`/);
  assert.match(byPlugin['example-new-plugin'].factoryRun, /^\/factory:run new plugin: Create a new marketplace plugin `example-new-plugin`/);
});

test('the log is never kept inside a git checkout', () => {
  box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  box.env.FACTORY_PLUGIN_ADVISOR_CONFIG_DIR = join(repo, 'state');
  const r = box.call([...REC, '--summary', 's']);
  assert.equal(r.code, EXIT.failure);
  assert.match(r.stderr, /inside the git checkout/);
  assert.equal(existsSync(join(repo, 'state')), false);
});

test('the log never shares a location with another marketplace\'s plugin-advisor', () => {
  box = sandbox();
  const home = box.env.HOME ?? '';
  for (const [dir, extra] of [
    [join(home, '.config', 'plugin-advisor'), {}],
    [join(home, '.config', 'plugin-advisor', 'nested'), {}],
    [join(home, '.config'), {}],
    [join(box.dir, 'xdg', 'plugin-advisor'), { XDG_CONFIG_HOME: join(box.dir, 'xdg') }],
    [join(box.dir, 'other'), { PLUGIN_ADVISOR_CONFIG_DIR: join(box.dir, 'other') }],
  ] as const) {
    const b = sandbox({ ...extra, HOME: home, FACTORY_PLUGIN_ADVISOR_CONFIG_DIR: dir });
    try {
      const r = b.call([...REC, '--summary', 's']);
      assert.equal(r.code, EXIT.failure, dir);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /where another plugin-advisor keeps its log/);
      assert.equal(existsSync(dir), false, `${dir} was not created`);
    } finally {
      b.cleanup();
    }
  }
  // The default location sits next to plugin-advisor's, not in it.
  const d = sandbox({ HOME: home, FACTORY_PLUGIN_ADVISOR_CONFIG_DIR: '' });
  try {
    assert.equal(d.call([...REC, '--summary', 's']).code, EXIT.ok);
    assert.equal(existsSync(join(home, '.config', 'factory-plugin-advisor', 'occurrences.jsonl')), true);
    assert.equal(existsSync(join(home, '.config', 'plugin-advisor')), false);
  } finally {
    d.cleanup();
  }
});

test('configDir defaults to XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(configDir({ FACTORY_PLUGIN_ADVISOR_CONFIG_DIR: '/x/y' }), '/x/y');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }), '/xdg/factory-plugin-advisor');
  assert.equal(configDir({ HOME: '/h' }), '/h/.config/factory-plugin-advisor');
});
