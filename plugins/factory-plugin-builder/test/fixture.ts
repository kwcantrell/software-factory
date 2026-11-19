// Throwaway software-factory checkouts in a temp dir: the parts of the real repo that
// factory-plugin-builder reads (the template and the marketplace manifest) and a root package.json
// whose typecheck script is a stub. Tests never write to the real repo.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from '../src/scaffold.ts';
import { findOnPath } from '../src/verify.ts';

/** The real checkout this plugin lives in (read only). */
export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
/** This plugin's own folder (read only). */
export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));

export interface Fixture {
  root: string;
  /** A directory holding a fake `claude` that logs its arguments to `claudeLog` and exits 0. */
  fakeBin: string;
  claudeLog: string;
  cleanup: () => void;
}

export function fixture(options: { typecheckExit?: number } = {}): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-plugin-builder-fixture-')));
  const root = join(base, 'checkout');
  cpSync(join(REPO, 'templates', 'plugin'), join(root, 'templates', 'plugin'), {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  });
  mkdirSync(join(root, 'plugins'));
  mkdirSync(join(root, '.claude-plugin'));
  const manifest = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({ ...manifest, plugins: [] }, null, 2)}\n`);
  const exit = options.typecheckExit ?? 0;
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { typecheck: `node -e "process.exit(${exit})"` } }, null, 2)}\n`,
  );

  const fakeBin = join(base, 'bin');
  const claudeLog = join(base, 'claude.log');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\necho "$@" >> '${claudeLog}'\nexit 0\n`);
  chmodSync(join(fakeBin, 'claude'), 0o755);
  return { root, fakeBin, claudeLog, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Adds a template-made plugin to the fixture. */
export function scaffoldInto(f: Fixture, name: string): string {
  scaffold(f.root, name);
  return join(f.root, 'plugins', name);
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
 * `env` with every PATH directory that has a `claude` removed. node, npm and npx stay reachable
 * through links in a directory of the fixture's own, since `npm install -g` puts claude next to them.
 */
export function withoutClaude(env: NodeJS.ProcessEnv, f: Fixture): NodeJS.ProcessEnv {
  const tools = join(f.fakeBin, '..', 'tools');
  mkdirSync(tools, { recursive: true });
  for (const name of ['node', 'npm', 'npx']) {
    const found = findOnPath(name, env);
    if (found !== null && !existsSync(join(tools, name))) symlinkSync(found, join(tools, name));
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && findOnPath('claude', { PATH: dir }) === null);
  return { ...env, PATH: [tools, ...dirs].join(delimiter) };
}
