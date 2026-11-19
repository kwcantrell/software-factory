import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeDir, findManifest, frontmatter, readCatalog, readSkills, skillCommands } from '../src/catalog.ts';
import { FIXTURES, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

test('catalog lists installed plugins with their skills and descriptions, from installed_plugins.json', () => {
  const { code, stdout, stderr } = s.call(['catalog', '--json']);
  assert.equal(code, 0, stderr);
  const c = JSON.parse(stdout);
  assert.equal(c.claudeDir, s.claudeDir);
  assert.deepEqual(
    c.installed.map((p: { id: string }) => p.id),
    ['factory-dev@software-factory', 'factory-plugin-advisor@software-factory', 'factory-plugin-discover@software-factory', 'factory@software-factory', 'other-tools@other-market'],
  );
  const factory = c.installed.find((p: { name: string }) => p.name === 'factory');
  assert.match(factory.description, /^A multi-agent assembly line/);
  assert.deepEqual(factory.skills.map((k: { name: string }) => k.name), ['approve', 'dashboard', 'run', 'ship', 'upgrade']);
  const run = factory.skills.find((k: { name: string }) => k.name === 'run');
  assert.match(run.description, /^Run a request through the software factory/);
  assert.ok(run.commands.includes('followup') && run.commands.includes('status'), run.commands.join(','));
  assert.equal(factory.version, '0.1.0');
  assert.equal(factory.marketplace, 'software-factory');
  // A folded (>) description from another marketplace.
  const other = c.installed.find((p: { name: string }) => p.name === 'other-tools');
  assert.deepEqual(other.skills, [{ name: 'pdf-tools', description: 'Reads, merges and splits PDF files. Use when the user asks to combine or extract pages from a PDF.', commands: [] }]);
});

test('skillCommands reads the CLI commands a SKILL.md runs through npx', () => {
  const prefix = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" --';
  assert.deepEqual(skillCommands(`${prefix} factory-dev release <tag>\n${prefix} factory-dev check\n${prefix} factory-dev check --json\n${prefix} factory-dev --help\n${prefix} factory <command>`), ['check', 'release']);
  assert.deepEqual(skillCommands("allowed-tools: Bash(npx --package='/a b' -- tool list:*)"), ['list']);
  assert.deepEqual(skillCommands('no commands here'), []);
});

test('a plugin set to false in enabledPlugins is marked disabled', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  const enabled = Object.fromEntries(c.installed.map((p: { name: string; enabled: boolean }) => [p.name, p.enabled]));
  assert.deepEqual(enabled, { factory: true, 'factory-dev': false, 'factory-plugin-advisor': true, 'factory-plugin-discover': true, 'other-tools': true });
  assert.match(s.call(['catalog']).stdout, /factory-dev@software-factory 0\.1\.0 \(disabled\)/);
});

test('a project settings file in the cwd overrides the user setting', () => {
  const project = join(s.dir, 'project');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'factory-dev@software-factory': true, 'factory@software-factory': false } }));
  const c = JSON.parse(s.call(['catalog', '--json'], { cwd: project }).stdout);
  const enabled = Object.fromEntries(c.installed.map((p: { name: string; enabled: boolean }) => [p.name, p.enabled]));
  assert.equal(enabled['factory-dev'], true);
  assert.equal(enabled.factory, false);
});

test('user skills come from <config>/skills, named by frontmatter or else by folder', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  assert.deepEqual(
    c.userSkills.map((k: { name: string; description: string }) => [k.name, k.description.slice(0, 30)]),
    [
      ['notes', 'Keeps a running notes file for'],
      ['web-browse', 'Browser automation for website'],
    ],
  );
});

test('marketplace plugins not installed are listed as available, with skills and the install command', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  assert.equal(c.manifest, join(s.marketplace, '.claude-plugin', 'marketplace.json'));
  // factory-plugin-builder is installed for another project: not available (see the next test).
  assert.deepEqual(c.available.map((p: { name: string }) => p.name), ['factory-docs']);
  const docs = c.available[0];
  assert.match(docs.description, /^Keeps software-factory docs in sync with code/);
  assert.deepEqual(docs.skills.map((k: { name: string }) => k.name), ['factory-docs']);
  assert.deepEqual(docs.skills[0].commands, ['gate', 'lint', 'stale', 'which']);
  assert.equal(docs.installCommand, 'claude plugin install factory-docs@software-factory');
  assert.match(s.call(['catalog']).stdout, /Available in the software-factory marketplace, not installed:\n {2}factory-docs: [^\n]*\n {4}install: claude plugin install factory-docs@software-factory/);
});

test('a plugin installed only for another project is reported as installed elsewhere, not as missing', () => {
  const c = JSON.parse(s.call(['catalog', '--json']).stdout);
  assert.ok(!c.installed.some((p: { name: string }) => p.name === 'factory-plugin-builder'));
  assert.ok(!c.available.some((p: { name: string }) => p.name === 'factory-plugin-builder'));
  assert.equal(c.installedElsewhere.length, 1);
  const [builder] = c.installedElsewhere;
  assert.deepEqual(
    [builder.id, builder.name, builder.marketplace, builder.scope, builder.projectPath],
    ['factory-plugin-builder@software-factory', 'factory-plugin-builder', 'software-factory', 'project', join(s.dir, 'some-other-project')],
  );
  assert.match(builder.description, /convention/);
  assert.deepEqual(builder.skills.map((k: { name: string }) => k.name), ['build-plugin']);
  assert.match(s.call(['catalog']).stdout, /Installed for another project only:\n {2}factory-plugin-builder@software-factory \(project scope, [^)]*some-other-project\)/);
});

test('a local-scoped install for another project is installed elsewhere too', () => {
  const t = sandbox({ elsewhere: [] });
  try {
    const records = join(t.claudeDir, 'plugins', 'installed_plugins.json');
    const data = JSON.parse(readFileSync(records, 'utf8'));
    data.plugins['factory-docs@software-factory'] = [{ scope: 'local', projectPath: join(t.dir, 'elsewhere'), installPath: join(t.dir, 'nowhere'), version: '0.1.0' }];
    writeFileSync(records, JSON.stringify(data));
    const c = JSON.parse(t.call(['catalog', '--json']).stdout);
    assert.deepEqual(c.installedElsewhere.map((p: { id: string; scope: string }) => [p.id, p.scope]), [['factory-docs@software-factory', 'local']]);
    assert.deepEqual(c.available.map((p: { name: string }) => p.name), ['factory-plugin-builder']);
  } finally {
    t.cleanup();
  }
});

test('a project-scoped install counts inside its project', () => {
  const inside = join(s.dir, 'some-other-project', 'src');
  mkdirSync(inside, { recursive: true });
  const c = JSON.parse(s.call(['catalog', '--json'], { cwd: inside }).stdout);
  assert.ok(c.installed.some((p: { name: string; scope: string }) => p.name === 'factory-plugin-builder' && p.scope === 'project'));
  assert.deepEqual(c.installedElsewhere, []);
  assert.deepEqual(c.available.map((p: { name: string }) => p.name), ['factory-docs']);
});

test('a plugin from another marketplace with a software-factory name does not hide the marketplace one', () => {
  const t = sandbox({ installed: [] });
  try {
    const records = join(t.claudeDir, 'plugins', 'installed_plugins.json');
    const data = JSON.parse(readFileSync(records, 'utf8'));
    data.plugins['factory-docs@other-market'] = [{ scope: 'user', installPath: join(t.dir, 'nowhere'), version: '9.9.9' }];
    writeFileSync(records, JSON.stringify(data));
    const c = JSON.parse(t.call(['catalog', '--json']).stdout);
    assert.ok(c.available.some((p: { name: string }) => p.name === 'factory-docs'));
  } finally {
    t.cleanup();
  }
});

test('without a known marketplace, available is empty and the manifest is null', () => {
  const t = sandbox({ knownMarketplace: false });
  try {
    const c = JSON.parse(t.call(['catalog', '--json']).stdout);
    assert.equal(c.manifest, null);
    assert.deepEqual(c.available, []);
    assert.match(t.call(['catalog']).stdout, /marketplace manifest not found/);
  } finally {
    t.cleanup();
  }
});

test('findManifest prefers the checkout next to the plugin, and only a software-factory manifest', () => {
  const root = join(s.marketplace, 'plugins', 'factory-plugin-discover');
  assert.equal(findManifest(root, join(s.dir, 'no-claude')), join(s.marketplace, '.claude-plugin', 'marketplace.json'));
  assert.equal(findManifest(join(s.dir, 'a', 'b'), join(s.dir, 'no-claude')), null);
  const other = join(s.dir, 'other-checkout');
  mkdirSync(join(other, '.claude-plugin'), { recursive: true });
  writeFileSync(join(other, '.claude-plugin', 'marketplace.json'), '{"name": "other-market", "plugins": []}');
  assert.equal(findManifest(join(other, 'plugins', 'x'), join(s.dir, 'no-claude')), null);
});

test('CLAUDE_CONFIG_DIR is honoured, else ~/.claude under HOME', () => {
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: '/x/claude', HOME: '/h' }), '/x/claude');
  assert.equal(claudeDir({ CLAUDE_CONFIG_DIR: '', HOME: '/h' }), '/h/.claude');
  assert.deepEqual(readCatalog({ HOME: join(s.dir, 'empty-home') }, { pluginRoot: join(s.dir, 'x', 'y'), cwd: s.cwd }), {
    claudeDir: join(s.dir, 'empty-home', '.claude'),
    manifest: null,
    installed: [],
    installedElsewhere: [],
    userSkills: [],
    available: [],
  });
});

test('frontmatter reads plain, quoted and block scalars', () => {
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "say \\"hi\\""\nother: x\n---\nbody'), { name: 'a', description: 'say "hi"', other: 'x' });
  assert.deepEqual(frontmatter("---\ndescription: 'it''s'\n---\n"), { description: "it's" });
  assert.deepEqual(frontmatter('---\ndescription: |\n  one\n  two\nname: b\n---\n'), { description: 'one\ntwo', name: 'b' });
  assert.deepEqual(frontmatter('no frontmatter'), {});
});

test('frontmatter reads multi-line block descriptions in full, blank lines included', () => {
  assert.deepEqual(readSkills(join(FIXTURES, 'block-scalars')), [
    {
      name: 'folded-skill',
      description: 'Reads the first paragraph of a folded description, which spans two lines.\nThe second paragraph comes after a blank line and mentions the worktree and the merge gate.',
      commands: [],
    },
    { name: 'literal-skill', description: 'First line of a literal description.\n\nThird line, after a blank line: follow-up notes.\nLast line.', commands: [] },
  ]);
  // Folded: lines join with a space, a blank line is a newline; the block ends at the next key.
  assert.deepEqual(frontmatter('---\ndescription: >\n  one\n  two\n\n  three\n\n\n  four\n\nname: b\n---\n'), { description: 'one two\nthree\n\nfour', name: 'b' });
  // Literal: lines kept, blank lines inside kept, trailing blank lines dropped, deeper indent kept.
  assert.deepEqual(frontmatter('---\ndescription: |-\n  one\n\n    two\n  three\n\nname: c\n---\n'), { description: 'one\n\n  two\nthree', name: 'c' });
  // CRLF and whitespace-only blank lines.
  assert.deepEqual(frontmatter('---\r\ndescription: >\r\n  a\r\n   \r\n  b\r\n---\r\n'), { description: 'a\nb' });
});
