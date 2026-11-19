// which, stale, lint and gate against fixture git checkouts in a temp dir (see fixture.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { helpCommands, mentions } from '../src/docs.ts';
import { EXIT } from '../src/run.ts';
import { MAP, call, fixture } from './fixture.ts';
import type { Fixture } from './fixture.ts';

const fixtures: Fixture[] = [];
after(() => fixtures.forEach((f) => f.cleanup()));

function repo(): Fixture {
  const f = fixture();
  fixtures.push(f);
  return f;
}

function staleDocs(f: Fixture, argv: string[] = []): { code: number; docs: string[]; stderr: string; stdout: string } {
  const r = call(f.root, ['stale', ...argv]);
  const docs = [...r.stderr.matchAll(/^(\S+): not changed, but it covers/gm)].map((m) => m[1] ?? '');
  return { ...r, docs };
}

function writeMap(f: Fixture, map: unknown): void {
  f.write('docs/docs-map.json', `${JSON.stringify(map, null, 2)}\n`);
}

// ---------------------------------------------------------------- which

test('which: paths covered by no doc, one doc and several docs', () => {
  const f = repo();
  const r = call(f.root, ['which', 'LICENSE', 'src/a.ts', 'src/b.ts', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { LICENSE: [], 'src/a.ts': ['README.md'], 'src/b.ts': ['README.md', 'guide.md'] });
  const text = call(f.root, ['which', 'LICENSE', 'src/a.ts', 'src/b.ts']);
  assert.equal(text.stdout, 'LICENSE: (no docs)\nsrc/a.ts: README.md\nsrc/b.ts: README.md, guide.md\n');
});

test('which: paths are relative to the current directory; the map is found from a subdirectory', () => {
  const f = repo();
  const r = call(join(f.root, 'plugins', 'demo'), ['which', 'src/run.ts', '../../lib/c.ts', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    'plugins/demo/src/run.ts': ['CHANGELOG.md', 'plugins/demo/README.md', 'plugins/demo/skills/demo/SKILL.md'],
    'lib/c.ts': ['guide.md'],
  });
});

test('which: a path outside the checkout, or no path, is a usage error', () => {
  const f = repo();
  const outside = call(f.root, ['which', '../elsewhere.ts']);
  assert.equal(outside.code, EXIT.usage);
  assert.equal(outside.stdout, '');
  assert.match(outside.stderr, /is not inside the checkout/);
  assert.equal(call(f.root, ['which']).code, EXIT.usage);
});

test('--repo selects the checkout; outside a git checkout, or in one without a map, exit 2', () => {
  const f = repo();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'factory-docs-nomap-')));
  try {
    const r = call(scratch, ['which', 'src/a.ts', '--repo', f.root, '--json']);
    assert.equal(r.code, EXIT.ok, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { 'src/a.ts': ['README.md'] });
    const outside = call(scratch, ['lint']);
    assert.equal(outside.code, EXIT.usage);
    assert.equal(outside.stdout, '');
    assert.match(outside.stderr, /^factory-docs: not inside a git checkout/);
    const g = fixture();
    fixtures.push(g);
    g.remove('docs/docs-map.json');
    const nomap = call(g.root, ['stale']);
    assert.equal(nomap.code, EXIT.usage);
    assert.match(nomap.stderr, /no doc map: .* has no docs\/docs-map\.json/);
    assert.equal(call(scratch, ['lint', '--repo', join(scratch, 'missing')]).code, EXIT.usage);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- stale

test('stale: nothing changed exits 0', () => {
  const f = repo();
  const r = call(f.root, ['stale', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.baseRef, 'main');
  assert.deepEqual([json.changed, json.stale], [[], []]);
  assert.match(call(f.root, ['stale']).stdout, /^no stale docs: 0 changed file\(s\) against main \(merge-base [0-9a-f]{12}\)\n$/);
});

test('stale: a committed change since the merge-base leaves the covering docs stale, naming the files', () => {
  const f = repo();
  f.write('src/b.ts', 'export const b = 2;\n');
  f.write('src/a.ts', 'export const a = 2;\n');
  f.commit('change b');
  const r = staleDocs(f);
  assert.equal(r.code, EXIT.failure);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.docs, ['README.md', 'guide.md']);
  assert.match(r.stderr, /^factory-docs: 2 doc\(s\) not updated for the code they cover, against main /);
  assert.match(r.stderr, /^README\.md: not changed, but it covers changed file\(s\): src\/a\.ts, src\/b\.ts - fix: update README\.md/m);
  assert.match(r.stderr, /^guide\.md: not changed, but it covers changed file\(s\): src\/b\.ts - fix: /m);
  // updating the docs clears it, committed or not
  f.write('README.md', '# Demo\n\nNow 2.\n');
  f.write('guide.md', '# Guide\n\nNow 2.\n');
  assert.equal(staleDocs(f).code, EXIT.ok);
});

test('stale: staged, unstaged and untracked changes all count; ignored files do not', () => {
  for (const kind of ['staged', 'unstaged', 'untracked', 'deleted']) {
    const f = repo();
    if (kind === 'untracked') f.write('lib/new.ts', 'x\n');
    else if (kind === 'deleted') f.remove('lib/c.ts');
    else f.write('lib/c.ts', 'export const c = 2;\n');
    if (kind === 'staged') f.git('add', 'lib/c.ts');
    const r = staleDocs(f);
    assert.equal(r.code, EXIT.failure, kind);
    assert.deepEqual(r.docs, ['guide.md'], kind);
  }
  const f = repo();
  f.write('ignored/src/x.ts', 'x\n');
  f.write('ignored/lib/y.ts', 'x\n');
  assert.equal(staleDocs(f).code, EXIT.ok);
});

test('stale: a doc-only change is never stale', () => {
  const f = repo();
  f.write('README.md', '# Demo\n\nmore\n');
  f.write('guide.md', '# Guide\n\nmore\n');
  f.write('plugins/demo/README.md', '# demo\n\n`demo hello` greets; `bye` leaves. More.\n');
  f.commit('docs');
  f.write('CHANGELOG.md', '# Changelog\n\n- docs\n');
  const r = staleDocs(f);
  assert.equal(r.code, EXIT.ok, r.stderr);
});

test('stale: a doc covered by another doc\'s globs does not make that doc stale', () => {
  const f = repo();
  writeMap(f, { ...MAP, docs: { ...MAP.docs, 'README.md': ['src/**', 'guide.md'] } });
  f.commit('map');
  f.git('branch', '-f', 'main', 'HEAD');
  f.write('guide.md', '# Guide\n\nchanged\n');
  assert.equal(staleDocs(f).code, EXIT.ok);
});

test('stale: CHANGELOG.md is stale when a plugin\'s src or skills changed and it did not', () => {
  const f = repo();
  // src changed, with its README and skill updated: only the changelog is left
  f.write('plugins/demo/src/run.ts', 'export const run = 2;\n');
  f.write('plugins/demo/README.md', '# demo\n\n`demo hello` greets; `bye` leaves. Run 2.\n');
  f.write('plugins/demo/skills/demo/SKILL.md', '---\nname: demo\n---\n\nRun 2.\n');
  const r = staleDocs(f);
  assert.equal(r.code, EXIT.failure);
  assert.deepEqual(r.docs, ['CHANGELOG.md']);
  assert.match(r.stderr, /^CHANGELOG\.md: not changed, but it covers changed file\(s\): plugins\/demo\/skills\/demo\/SKILL\.md, plugins\/demo\/src\/run\.ts /m);
  f.write('CHANGELOG.md', '# Changelog\n\n- run 2\n');
  assert.equal(staleDocs(f).code, EXIT.ok);

  // a skill prompt alone ships to users: the changelog counts it, no other doc does
  const g = repo();
  g.write('plugins/demo/skills/demo/SKILL.md', '---\nname: demo\n---\n\nReworded.\n');
  assert.deepEqual(staleDocs(g).docs, ['CHANGELOG.md']);
});

test('stale: the base is origin/main before main; --base overrides; a bad --base exits 2', () => {
  const f = repo();
  f.write('src/a.ts', 'export const a = 2;\n');
  f.commit('a2');
  assert.deepEqual(staleDocs(f).docs, ['README.md']);
  // origin/main at HEAD: the merge-base is HEAD, so nothing has changed
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const r = call(f.root, ['stale', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.equal(JSON.parse(r.stdout).baseRef, 'origin/main');
  // --base main measures from main again
  assert.deepEqual(staleDocs(f, ['--base', 'main']).docs, ['README.md']);
  const bad = call(f.root, ['stale', '--base', 'no-such-ref']);
  assert.equal(bad.code, EXIT.usage);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /--base no-such-ref: not a commit/);
  assert.equal(call(f.root, ['stale', '--base', '--json']).code, EXIT.usage);
});

test('stale: with no base that resolves, only uncommitted changes count', () => {
  const f = repo();
  f.write('src/a.ts', 'export const a = 2;\n');
  f.commit('a2');
  f.git('branch', '-D', 'main');
  const clean = call(f.root, ['stale', '--json']);
  assert.equal(clean.code, EXIT.ok, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout), { base: null, baseRef: null, changed: [], stale: [] });
  assert.match(call(f.root, ['stale']).stdout, /against uncommitted changes \(no base: origin\/main and main do not resolve\)/);
  f.write('lib/c.ts', 'x\n');
  assert.deepEqual(staleDocs(f).docs, ['guide.md']);
});

// ---------------------------------------------------------------- lint

function lintLines(f: Fixture): { code: number; lines: string[]; stdout: string } {
  const r = call(f.root, ['lint']);
  return { code: r.code, stdout: r.stdout, lines: r.stderr.split('\n').slice(1).filter(Boolean) };
}

test('lint: the fixture map is clean', () => {
  const f = repo();
  const r = call(f.root, ['lint', '--json']);
  assert.equal(r.code, EXIT.ok, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { docs: 5, clis: { demo: ['hello', 'bye'] }, problems: [] });
  assert.equal(call(f.root, ['lint']).stdout, 'doc map ok: 5 doc(s); 2 command(s) of 1 plugin CLI(s) documented\n');
});

test('lint: a doc in the map that does not exist', () => {
  const f = repo();
  f.remove('guide.md');
  const r = lintLines(f);
  assert.equal(r.code, EXIT.failure);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.lines, ['docs/docs-map.json: doc guide.md does not exist (or is ignored by git) - fix: create guide.md, or remove its entry from "docs"']);
});

test('lint: a glob, or an ignore glob, that matches no file', () => {
  const f = repo();
  writeMap(f, { ...MAP, docs: { ...MAP.docs, 'guide.md': ['src/b.ts', 'lib/**', 'nowhere/*.ts'] }, ignore: ['notes/*.md', 'gone/*.md'] });
  assert.deepEqual(lintLines(f).lines, [
    'docs/docs-map.json: glob nowhere/*.ts of guide.md matches no file - fix: correct the glob to the code the doc describes, or remove it',
    'docs/docs-map.json: ignore glob gone/*.md matches no file - fix: correct the glob, or remove it from "ignore"',
  ]);
  // an untracked (not ignored) file counts as existing; a git-ignored one does not
  f.write('gone/x.md', 'x\n');
  f.write('ignored/nowhere/x.ts', 'x\n');
  assert.equal(lintLines(f).lines.length, 1);
});

test('lint: every markdown file outside docs/research/ and factory/ must be mapped or ignored', () => {
  const f = repo();
  f.write('extra/new.md', '# new\n');
  f.write('docs/research/more.md', 'fine\n');
  f.write('notes/also.md', 'ignored by the map\n');
  f.write('factory/jobs/1/task.md', 'runtime state\n');
  f.write('ignored/x.md', 'git-ignored\n');
  f.commit('md files');
  assert.deepEqual(lintLines(f).lines, [
    'extra/new.md: markdown file is not in docs/docs-map.json - fix: add it under "docs" with the globs of the code it describes, or to "ignore" if it describes no code',
  ]);
});

test('lint: every command a plugin CLI lists in --help must be mentioned in its README', () => {
  const f = repo();
  f.write('plugins/demo/README.md', '# demo\n\n`demo hello` greets. Goodbye.\n');
  assert.deepEqual(lintLines(f).lines, [
    'plugins/demo/README.md: does not mention the demo command bye (its --help lists it) - fix: document `demo bye` in plugins/demo/README.md',
  ]);
  // the forms that count: <bin> <command>, <bin>/src/cli.ts <command>, and a code span starting with it
  for (const text of ['run demo bye', 'node plugins/demo/src/cli.ts bye --json', '## `bye [--all]`', 'use `bye`.']) {
    f.write('plugins/demo/README.md', `# demo\n\n\`demo hello\`; ${text}\n`);
    assert.equal(lintLines(f).code, EXIT.ok, text);
  }
});

test('lint: cli_docs points a plugin at another doc; a README that is missing, or names an unknown plugin, is a problem', () => {
  const f = repo();
  f.remove('plugins/demo/README.md');
  writeMap(f, { ...MAP, docs: { ...MAP.docs, 'plugins/demo/README.md': undefined } });
  assert.deepEqual(lintLines(f).lines, [
    'plugins/demo/README.md: plugin demo has no README documenting its CLI - fix: write plugins/demo/README.md, or point "cli_docs" in docs/docs-map.json at the doc that documents it',
  ]);
  f.write('README.md', '# Demo\n\n`demo hello` and `demo bye`.\n');
  writeMap(f, { ...MAP, docs: { ...MAP.docs, 'plugins/demo/README.md': undefined }, cli_docs: { demo: 'README.md' } });
  assert.equal(lintLines(f).code, EXIT.ok);
  writeMap(f, { ...MAP, docs: { ...MAP.docs, 'plugins/demo/README.md': undefined }, cli_docs: { demo: 'README.md', ghost: 'README.md' } });
  assert.deepEqual(lintLines(f).lines, ['docs/docs-map.json: cli_docs names ghost, which is not a marketplace plugin with a bin - fix: remove the entry or correct the plugin name']);
});

test('lint: a plugin CLI whose --help fails, or lists no commands, is a problem', () => {
  const f = repo();
  f.write('plugins/demo/src/cli.ts', 'process.exit(3);\n');
  assert.match(lintLines(f).lines.join('\n'), /^plugins\/demo\/src\/cli\.ts: demo --help failed \(exit 3/);
  f.write('plugins/demo/src/cli.ts', "console.log('Usage: demo');\n");
  assert.match(lintLines(f).lines.join('\n'), /^plugins\/demo\/src\/cli\.ts: demo --help lists no commands under a "Commands:" heading/);
});

test('lint: a broken map exits 1 naming what is wrong', () => {
  const f = repo();
  for (const [text, message] of [
    ['{', /not valid JSON/],
    ['[]', /the top level must be an object/],
    ['{"docs": {}, "extra": 1}', /unknown key\(s\) extra/],
    ['{"docs": {"../x.md": ["a"]}}', /doc "\.\.\/x\.md" is not a repo-relative path/],
    ['{"docs": {"a.md": []}}', /lists no globs/],
    ['{"docs": {"a.md": ["x"]}, "changelog": "b.md"}', /"changelog" must name a doc/],
  ] as const) {
    f.write('docs/docs-map.json', text);
    const r = call(f.root, ['lint']);
    assert.equal(r.code, EXIT.failure, text);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, message);
  }
});

// ---------------------------------------------------------------- gate

test('gate: lint and stale with one exit code', () => {
  const f = repo();
  const ok = call(f.root, ['gate', '--json']);
  assert.equal(ok.code, EXIT.ok, ok.stderr);
  assert.deepEqual(Object.keys(JSON.parse(ok.stdout)), ['lint', 'stale']);
  assert.match(call(f.root, ['gate']).stdout, /\ngate passed\n$/);

  f.write('src/a.ts', 'export const a = 2;\n'); // stale README
  const staleOnly = call(f.root, ['gate']);
  assert.equal(staleOnly.code, EXIT.failure);
  assert.equal(staleOnly.stdout, '');
  assert.match(staleOnly.stderr, /^doc map ok: /);
  assert.match(staleOnly.stderr, /^README\.md: not changed/m);
  assert.match(staleOnly.stderr, /factory-docs: gate failed\n$/);

  f.write('README.md', '# Demo\n\nupdated\n');
  f.write('extra.md', 'unmapped\n'); // lint problem only
  const lintOnly = call(f.root, ['gate', '--base', 'main']);
  assert.equal(lintOnly.code, EXIT.failure);
  assert.match(lintOnly.stderr, /^extra\.md: markdown file is not in docs\/docs-map\.json/m);
  assert.match(lintOnly.stderr, /^no stale docs: /m);
});

// ---------------------------------------------------------------- help parsing

test('helpCommands reads both usage styles in this marketplace', () => {
  assert.deepEqual(helpCommands('Usage: x\n\nCommands:\n  new <name>\n                    desc\n  check <name>...   desc\n\nOptions:\n  --json  x\n'), ['new', 'check']);
  assert.deepEqual(helpCommands('usage: factory [-h]\n\ncommands:\n  init                create\n  followup {add,list}\n                      record\n\noptions:\n'), ['init', 'followup']);
  assert.equal(helpCommands('Usage: x\n'), null);
});

test('mentions does not count a command inside another word or bin', () => {
  assert.equal(mentions('software-factory check', 'factory', 'check'), false);
  assert.equal(mentions('factory checks', 'factory', 'check'), false);
  assert.equal(mentions('`checkout`', 'factory', 'check'), false);
  assert.equal(mentions('factory  check', 'factory', 'check'), true);
});
