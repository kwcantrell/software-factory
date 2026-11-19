// Throwaway git checkouts for factory-docs' tests: a doc map, docs, code, and a marketplace listing
// one plugin whose CLI prints a Commands: section. Everything is committed on `main`, and HEAD is on a
// `work` branch, so `stale` measures from main. Tests never write to the real repo.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/run.ts';

/** The real checkout this plugin lives in (read only). */
export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
/** This plugin's own folder (read only). */
export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));

export const MAP = {
  docs: {
    'README.md': ['src/**'],
    'guide.md': ['src/b.ts', 'lib/**'],
    'CHANGELOG.md': ['plugins/*/src/**', 'plugins/*/skills/**'],
    'plugins/demo/README.md': ['plugins/demo/src/**'],
    'plugins/demo/skills/demo/SKILL.md': ['plugins/demo/src/run.ts'],
  },
  changelog: 'CHANGELOG.md',
  ignore: ['notes/*.md'],
};

/** The demo plugin's CLI: prints a usage text with two commands, like the marketplace's CLIs. */
export const DEMO_CLI = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: demo <command>\\n\\nCommands:\\n  hello [name]   Greet\\n  bye            Leave;\\n                 continued line\\n\\nOptions:\\n  --json   JSON\\n');
} else process.exit(2);
`;

export interface Fixture {
  root: string;
  write: (rel: string, text: string) => void;
  remove: (rel: string) => void;
  git: (...args: string[]) => string;
  commit: (message: string) => void;
  cleanup: () => void;
}

const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

export function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'factory-docs-fixture-')));
  const root = join(base, 'repo');
  mkdirSync(root);
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  write('docs/docs-map.json', `${JSON.stringify(MAP, null, 2)}\n`);
  write('README.md', '# Demo\n');
  write('guide.md', '# Guide\n');
  write('CHANGELOG.md', '# Changelog\n');
  write('notes/todo.md', 'not a doc\n');
  write('docs/research/report.md', 'reference material\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
  write('lib/c.ts', 'export const c = 1;\n');
  write('.gitignore', 'ignored/\n');
  write('.claude-plugin/marketplace.json', `${JSON.stringify({ name: 'demo-market', plugins: [{ name: 'demo', source: './plugins/demo' }] }, null, 2)}\n`);
  write('plugins/demo/package.json', `${JSON.stringify({ name: 'demo', private: true, type: 'module', bin: { demo: 'src/cli.ts' } }, null, 2)}\n`);
  write('plugins/demo/src/cli.ts', DEMO_CLI);
  write('plugins/demo/src/run.ts', 'export const run = 1;\n');
  write('plugins/demo/README.md', '# demo\n\n`demo hello` greets; `bye` leaves.\n');
  write('plugins/demo/skills/demo/SKILL.md', '---\nname: demo\n---\n');
  commit('initial');
  git('checkout', '-q', '-b', 'work');
  return { root, write, remove: (rel) => rmSync(join(root, rel), { recursive: true, force: true }), git, commit, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface Call {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process with a fake Io. */
export function call(cwd: string, argv: string[]): Call {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd });
  return { code, stdout, stderr };
}

/** The environment without npm's run-script variables and without node --test's child marker. */
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_') && key !== 'NODE_TEST_CONTEXT'));
}
