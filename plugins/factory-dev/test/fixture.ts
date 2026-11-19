// Throwaway software-factory checkouts in a temp dir for factory-dev's tests: a marketplace listing one
// plugin, a CHANGELOG.md, a root package.json whose typecheck and test scripts are stubs, stub
// factory-plugin-builder and factory-docs CLIs, and a fake `claude`. Every stub's exit status is set per fixture. Tests
// never write to the real repo.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOnPath } from '../src/check.ts';

/** The real checkout this plugin lives in (read only). */
export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
/** This plugin's own folder (read only). */
export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));

export const CHANGELOG = `# Changelog

## [Unreleased]

- Something new.

## [1.2.0] - 2026-01-02

### Added

- The 1.2 feature.

## [1.1.0] - 2026-01-01

- Older.

[1.2.0]: https://example.invalid/v1.2.0
[1.1.0]: https://example.invalid/v1.1.0
`;

export interface FixtureOptions {
  typecheckExit?: number;
  testExit?: number;
  conventionExit?: number;
  docsExit?: number;
}

export interface Fixture {
  root: string;
  /** A directory holding a fake `claude`: it logs its arguments to `claudeLog`, and exits 1 when its
   * last argument equals $FAKE_CLAUDE_FAIL, 0 otherwise. */
  fakeBin: string;
  claudeLog: string;
  cleanup: () => void;
}

export function writeJson(root: string, rel: string, value: unknown): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes plugins/<name> with plugin.json and package.json at `version` (package.json at `pkgVersion` if given). */
export function writePlugin(root: string, name: string, version: string, pkgVersion: string | null = version): void {
  writeJson(root, `plugins/${name}/.claude-plugin/plugin.json`, { name, version });
  if (pkgVersion !== null) writeJson(root, `plugins/${name}/package.json`, { name, version: pkgVersion, private: true, type: 'module' });
}

export function writeMarketplace(root: string, entries: Record<string, unknown>[]): void {
  writeJson(root, '.claude-plugin/marketplace.json', { name: 'software-factory', owner: { name: 'Test' }, plugins: entries });
}

export function fixture(options: FixtureOptions = {}): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-dev-fixture-')));
  const root = join(base, 'checkout');
  mkdirSync(root);
  writeMarketplace(root, [{ name: 'demo', source: './plugins/demo' }]);
  writePlugin(root, 'demo', '1.2.0');
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  const exit = (code: number | undefined) => `node -e "process.exit(${code ?? 0})"`;
  writeJson(root, 'package.json', { name: 'fixture', private: true, type: 'module', scripts: { typecheck: exit(options.typecheckExit), test: exit(options.testExit) } });
  mkdirSync(join(root, 'plugins', 'factory-plugin-builder', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'plugins', 'factory-plugin-builder', 'src', 'cli.ts'),
    `console.log('stub factory-plugin-builder', process.argv.slice(2).join(' '));\nprocess.exit(${options.conventionExit ?? 0});\n`,
  );
  mkdirSync(join(root, 'plugins', 'factory-docs', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'plugins', 'factory-docs', 'src', 'cli.ts'),
    `console.log('stub factory-docs', process.argv.slice(2).join(' '));\nprocess.exit(${options.docsExit ?? 0});\n`,
  );
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);

  const fakeBin = join(base, 'bin');
  const claudeLog = join(base, 'claude.log');
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, 'claude'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(claudeLog)}, args.join(' ') + '\\n');
process.exit(args[args.length - 1] === process.env.FAKE_CLAUDE_FAIL ? 1 : 0);
`,
  );
  chmodSync(join(fakeBin, 'claude'), 0o755);
  // The fake is CommonJS; keep it out of the fixture's "type": "module" scope.
  writeJson(base, 'bin/package.json', { type: 'commonjs' });
  return { root, fakeBin, claudeLog, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** The environment without npm's run-script variables and without node --test's child marker. */
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_') && key !== 'NODE_TEST_CONTEXT'),
  );
}

/** `env` with the fake `claude` first on the PATH. */
export function withFakeClaude(env: NodeJS.ProcessEnv, f: Fixture): NodeJS.ProcessEnv {
  return { ...env, PATH: `${f.fakeBin}${delimiter}${env.PATH ?? ''}` };
}

/**
 * `env` with every PATH directory that has a `claude` removed. node, npm, npx and git stay reachable
 * through links in a directory of the fixture's own, since `npm install -g` puts claude next to them.
 */
export function withoutClaude(env: NodeJS.ProcessEnv, f: Fixture): NodeJS.ProcessEnv {
  const tools = join(f.fakeBin, '..', 'tools');
  mkdirSync(tools, { recursive: true });
  for (const name of ['node', 'npm', 'npx', 'git']) {
    const found = findOnPath(name, env);
    if (found !== null && !existsSync(join(tools, name))) symlinkSync(found, join(tools, name));
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && findOnPath('claude', { PATH: dir }) === null);
  return { ...env, PATH: [tools, ...dirs].join(delimiter) };
}
