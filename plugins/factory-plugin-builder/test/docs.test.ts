// The docs name exactly the rules the checker defines: the README's rules table, and the root
// CLAUDE.md's "Plugin layout" and "CLI convention" sections (read only).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { RULES } from '../src/check.ts';
import { PLUGIN, REPO } from './fixture.ts';

const ruleIds = Object.keys(RULES).sort();

/** The text of `## <title>` up to the next `## ` heading. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  assert.notEqual(start, -1, `no "## ${title}" section`);
  const rest = text.slice(start + title.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

test("the README's rules table lists exactly the checker's rules, in order", () => {
  const table = section(readFileSync(join(PLUGIN, 'README.md'), 'utf8'), 'Rules `check` applies');
  const rows = [...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows, Object.keys(RULES));
});

test('the root CLAUDE.md "Plugin layout" and "CLI convention" name every rule, and no other', () => {
  const text = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');
  const both = `${section(text, 'Plugin layout')}\n${section(text, 'CLI convention')}`;
  const named = new Set([...both.matchAll(/\[([a-z0-9]+-[a-z0-9-]+(?:,\s*[a-z0-9-]+)*)\]/g)].flatMap((m) => (m[1] ?? '').split(/,\s*/)));
  assert.deepEqual([...named].sort(), ruleIds);
});

test('the root CLAUDE.md lists the plugin and its commands', () => {
  const text = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');
  assert.match(section(text, 'Plugins'), /^\| `factory-plugin-builder` \|/m);
  const commands = section(text, 'Commands');
  for (const c of ['npm run new-plugin -- <name>', 'factory-plugin-builder/src/cli.ts check', 'factory-plugin-builder/src/cli.ts verify']) {
    assert.ok(commands.includes(c), c);
  }
});

test('nothing specific to the marketplace this plugin was ported from remains in it or the template', () => {
  const word = ['auto', 'logger'].join('');
  for (const dir of [PLUGIN, join(REPO, 'templates')]) {
    const hits = readdirRecursive(dir).filter((file) => `${file}\n${readFileSync(file, 'utf8')}`.toLowerCase().includes(word));
    assert.deepEqual(hits, []);
  }
});

/** Every file under `dir`, skipping node_modules. */
function readdirRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    return e.isDirectory() ? readdirRecursive(join(dir, e.name)) : [join(dir, e.name)];
  });
}
