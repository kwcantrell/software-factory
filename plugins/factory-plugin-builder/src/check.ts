// check: a plugin against the statically checkable parts of the root CLAUDE.md's "Plugin layout" and
// "CLI convention". Every finding names the file (and line), the rule, and how to fix it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError, MARKETPLACE_PATH, TEMPLATE_PATH, marketplaceEntries } from './repo.ts';

export const PREFIX = 'npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" --';
export const SHEBANG = '#!/usr/bin/env node';

/** Every rule `check` applies, with the one-line description the README's rules table repeats. */
export const RULES = {
  'plugin-manifest': '.claude-plugin/plugin.json exists, is JSON, and its name is the folder name',
  'marketplace-entry': 'marketplace.json lists the plugin with source ./plugins/<name> (with --all, also no entry without a folder)',
  'package-json': 'package.json exists and is a JSON object',
  'package-private': 'package.json has "private": true',
  'package-type-module': 'package.json has "type": "module"',
  'package-bin': 'package.json "bin" maps the plugin name to a .ts file that exists',
  'bin-shebang': `the bin file starts with ${SHEBANG}`,
  'no-dependencies': 'package.json declares no dependencies of any kind',
  'no-python-or-shell': 'the plugin has no *.py or *.sh files: its logic is TypeScript run by Node',
  'skills-present': 'skills/<skill>/SKILL.md exists for at least one skill',
  'skill-name': "a skill's frontmatter name is its folder name",
  'skill-command-lines': 'every SKILL.md has at least one npx line in a ```sh block',
  'npx-outside-sh': 'every npx line of a SKILL.md is in a ```sh block (the e2e test runs only those)',
  'npx-offline': 'every skill npx line has --offline',
  'npx-quoted-root': 'every skill npx line passes --package="${CLAUDE_PLUGIN_ROOT}" in double quotes',
  'npx-bin-name': "every skill npx line runs the plugin's own bin",
  'npx-prefix': 'every skill npx line starts with the exact required prefix',
  'allowed-tools': 'the skill frontmatter allowed-tools has Bash(<prefix> <bin>:*), or Bash(<prefix> <bin> <command>:*) rules',
  'tests-present': 'test/ has at least one *.test.ts',
  'e2e-test': 'a test runs the SKILL.md command lines through npx',
  'relative-imports': 'relative imports in src/ and test/ use the .ts extension',
  'hooks-cli': 'hooks/hooks.json, if present, is valid hooks JSON and every command hook runs plugin TypeScript with node in exec form, or the npx prefix',
} as const;

export type Rule = keyof typeof RULES;

export interface Finding {
  plugin: string;
  /** Path relative to the checkout root. */
  file: string;
  line?: number;
  rule: Rule;
  message: string;
  fix: string;
}

export interface CheckResult {
  plugins: string[];
  findings: Finding[];
}

export function formatFinding(f: Finding): string {
  return `${f.file}${f.line === undefined ? '' : `:${f.line}`}: [${f.rule}] ${f.message}\n  fix: ${f.fix}`;
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Files under `dir` (recursive, skipping node_modules), as paths relative to `dir`. */
function walk(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name)).map((p) => `${entry.name}/${p}`));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(entry.name);
  }
  return out.sort();
}

/** The plugin folders under plugins/ (directories only, sorted). */
export function pluginNames(root: string): string[] {
  const dir = join(root, 'plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

type Add = (file: string, rule: Rule, message: string, fix: string, line?: number) => void;

/** Checks one plugin folder, plugins/<name>. */
export function checkPlugin(root: string, name: string): Finding[] {
  const dir = join(root, 'plugins', name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CommandError(`plugins/${name} does not exist`);
  const rel = `plugins/${name}`;
  const findings: Finding[] = [];
  const add: Add = (file, rule, message, fix, line) =>
    findings.push({ plugin: name, file, ...(line === undefined ? {} : { line }), rule, message, fix });

  // .claude-plugin/plugin.json
  const manifestFile = `${rel}/.claude-plugin/plugin.json`;
  const manifestPath = join(root, manifestFile);
  if (!existsSync(manifestPath)) {
    add(manifestFile, 'plugin-manifest', 'missing', `create it with "name": "${name}", "version" and "description" (see ${TEMPLATE_PATH})`);
  } else {
    const manifest = readJson(manifestPath);
    if (!manifest.ok || !isObject(manifest.value)) {
      add(manifestFile, 'plugin-manifest', `not a JSON object${manifest.ok ? '' : `: ${manifest.error}`}`, 'make it a JSON object with name, version and description');
    } else if (manifest.value.name !== name) {
      add(manifestFile, 'plugin-manifest', `name is ${JSON.stringify(manifest.value.name) ?? 'missing'}, but the folder is plugins/${name}`, `set "name": "${name}" (or rename the folder to match)`);
    }
  }

  // marketplace.json entry
  const entries = marketplaceEntries(root).filter((e) => e.name === name);
  if (entries.length === 0) {
    add(MARKETPLACE_PATH, 'marketplace-entry', `no plugin entry named '${name}', so the plugin never loads`, `add {"name": "${name}", "source": "./plugins/${name}", "description": "..."} to "plugins"`);
  } else {
    for (const entry of entries) {
      if (entry.source !== `./plugins/${name}`) {
        add(MARKETPLACE_PATH, 'marketplace-entry', `the '${name}' entry has source ${JSON.stringify(entry.source) ?? 'missing'}`, `set "source": "./plugins/${name}"`);
      }
    }
  }

  // package.json
  const pkgFile = `${rel}/package.json`;
  const pkgRead = existsSync(join(root, pkgFile)) ? readJson(join(root, pkgFile)) : null;
  let bin = name;
  if (pkgRead === null || !pkgRead.ok || !isObject(pkgRead.value)) {
    add(
      pkgFile,
      'package-json',
      pkgRead === null ? 'missing' : `not a JSON object${pkgRead.ok ? '' : `: ${pkgRead.error}`}`,
      `create it like ${TEMPLATE_PATH}/package.json: private, "type": "module", "bin": {"${name}": "src/cli.ts"}`,
    );
  } else {
    const pkg = pkgRead.value;
    if (pkg.private !== true) add(pkgFile, 'package-private', `"private" is ${JSON.stringify(pkg.private) ?? 'missing'}`, 'set "private": true; plugins are never published to npm');
    if (pkg.type !== 'module') add(pkgFile, 'package-type-module', `"type" is ${JSON.stringify(pkg.type) ?? 'missing'}`, 'set "type": "module" so Node runs the .ts source as ES modules');
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      const deps = pkg[key];
      const names = isObject(deps) ? Object.keys(deps) : Array.isArray(deps) ? deps.map(String) : deps === undefined ? [] : [String(deps)];
      if (names.length === 0) continue;
      add(
        pkgFile,
        'no-dependencies',
        `"${key}" declares ${names.join(', ')}; a plugin's npx run is --offline from a fresh copy with no node_modules, so it cannot install them`,
        key === 'devDependencies'
          ? 'move type-only dev dependencies to the root package.json (pinned exactly) and remove this field'
          : `remove "${key}" and use Node's standard library instead ("No runtime dependencies" in CLAUDE.md)`,
      );
    }
    const binField = pkg.bin;
    const target = isObject(binField) ? binField[name] : undefined;
    if (!isObject(binField) || typeof target !== 'string') {
      const keys = isObject(binField) ? Object.keys(binField) : [];
      if (keys.length === 1 && keys[0] !== undefined) bin = keys[0];
      add(pkgFile, 'package-bin', `"bin" has no entry named '${name}' (got ${JSON.stringify(binField) ?? 'nothing'})`, `set "bin": {"${name}": "src/cli.ts"}`);
    } else if (!target.endsWith('.ts')) {
      add(pkgFile, 'package-bin', `bin '${name}' points at ${target}, not a .ts file`, 'point it at the TypeScript entry, "src/cli.ts"; nothing compiled is committed');
    } else if (target.split(/[\\/]/).includes('..') || !existsSync(join(dir, target)) || !statSync(join(dir, target)).isFile()) {
      add(pkgFile, 'package-bin', `bin '${name}' points at ${target}, which does not exist in the plugin`, `create ${rel}/${target} or point "bin" at the plugin's src/cli.ts`);
    } else {
      const first = readFileSync(join(dir, target), 'utf8').split('\n', 1)[0] ?? '';
      if (first.trim() !== SHEBANG) {
        add(`${rel}/${target.replace(/^\.\//, '')}`, 'bin-shebang', `first line is ${JSON.stringify(first)}; npx runs the bin as an executable script`, `make the first line exactly ${SHEBANG}`, 1);
      }
    }
  }

  // no Python or shell
  for (const f of walk(dir).filter((p) => /\.(py|sh)$/.test(p))) {
    add(
      `${rel}/${f}`,
      'no-python-or-shell',
      `${f.endsWith('.py') ? 'a Python' : 'a shell'} file; every plugin's logic is TypeScript that Node runs from the installed plugin`,
      'port it to TypeScript under src/ and run it through the CLI (a skill through the npx prefix, a hook with "command": "node" in exec form)',
    );
  }

  checkSkills(root, rel, bin, add);
  checkHooks(root, rel, dir, bin, add);

  // tests
  const testFiles = walk(join(dir, 'test')).filter((f) => f.endsWith('.test.ts'));
  if (testFiles.length === 0) {
    add(`${rel}/test`, 'tests-present', 'no test/*.test.ts, so the root npm test runs nothing for this plugin', `add unit tests that call run() with a fake Io, like ${TEMPLATE_PATH}/test/run.test.ts`);
  }
  const e2e = testFiles.some((f) => {
    const text = readFileSync(join(dir, 'test', f), 'utf8');
    // Spawning means importing node:child_process (a bare "exec" would also match RegExp#exec).
    return (
      text.includes('SKILL.md') &&
      text.includes('CLAUDE_PLUGIN_ROOT') &&
      text.includes('npx') &&
      /\bfrom\s*['"](node:)?child_process['"]/.test(text) &&
      /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(text)
    );
  });
  if (!e2e) {
    add(
      `${rel}/test`,
      'e2e-test',
      'no test reads the SKILL.md command lines and runs them through npx with CLAUDE_PLUGIN_ROOT set',
      `start from ${TEMPLATE_PATH}/test/cli.test.ts: copy the plugin to a temp dir and run every \`\`\`sh npx line of every skill from an unrelated cwd, offline`,
    );
  }

  // relative imports
  for (const sub of ['src', 'test']) {
    for (const f of walk(join(dir, sub)).filter((p) => /\.(ts|mts|cts)$/.test(p))) {
      const file = `${rel}/${sub}/${f}`;
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .forEach((text, index) => {
          const trimmed = text.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          for (const spec of relativeSpecifiers(text)) {
            if (spec.endsWith('.ts') || spec.endsWith('.json')) continue;
            const js = /\.(m|c)?js$/.test(spec);
            add(
              file,
              'relative-imports',
              js ? `imports '${spec}': there is no compiled .js, Node runs the .ts source` : `imports '${spec}' without an extension, which Node's ES module loader cannot resolve`,
              `import '${js ? spec.replace(/\.(m|c)?js$/, '.ts') : `${spec}.ts`}' instead`,
              index + 1,
            );
          }
        });
    }
  }
  return findings;
}

const IMPORT_PATTERNS = [
  /\bfrom\s*(['"])(\.{1,2}\/[^'"]*)\1/g,
  /^\s*import\s*(['"])(\.{1,2}\/[^'"]*)\1/g,
  /\bimport\s*\(\s*(['"])(\.{1,2}\/[^'"]*)\1/g,
];

/** Relative module specifiers (`./x`, `../x`) imported or re-exported on one source line. */
export function relativeSpecifiers(line: string): string[] {
  return IMPORT_PATTERNS.flatMap((re) => [...line.matchAll(re)].map((m) => m[2] ?? ''));
}

export interface SkillLine {
  line: number;
  text: string;
  inSh: boolean;
}

/** Trimmed lines starting with `npx `, and whether each is inside a ```sh fence. */
export function npxLines(text: string): SkillLine[] {
  const out: SkillLine[] = [];
  let fence: string | null = null;
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    const open = /^```\s*(\S*)/.exec(trimmed);
    if (open) {
      fence = fence === null ? (open[1] ?? '') : null;
      return;
    }
    if (trimmed.startsWith('npx ')) out.push({ line: index + 1, text: trimmed, inSh: fence === 'sh' });
  });
  return out;
}

function frontmatter(text: string): { body: string; fields: Map<string, string> } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const body = m[1] ?? '';
  const fields = new Map<string, string>();
  for (const line of body.split('\n')) {
    const f = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (f && f[1] !== undefined) fields.set(f[1], (f[2] ?? '').trim());
  }
  return { body, fields };
}

/**
 * Whether a skill frontmatter pre-approves the CLI: the whole CLI (`Bash(<prefix> <bin>:*)`), or one
 * or more of its commands (`Bash(<prefix> <bin> <command>:*)`), so commands that act on the machine
 * or need a person (a scaffold, a merge) can be left to a permission prompt.
 */
function allowsCli(frontmatterBody: string, exact: string): boolean {
  if (frontmatterBody.includes(`Bash(${exact}:*)`)) return true;
  const escaped = exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Bash\\(${escaped} [^)\\s][^)]*:\\*\\)`).test(frontmatterBody);
}

function checkSkills(root: string, rel: string, bin: string, add: Add): void {
  const skillsDir = join(root, rel, 'skills');
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md'))).map((e) => e.name).sort()
    : [];
  if (skills.length === 0) {
    add(`${rel}/skills`, 'skills-present', "no skills/<skill>/SKILL.md; a plugin's skills are how Claude reaches its CLI", `add skills/${bin}/SKILL.md like ${TEMPLATE_PATH}/skills/plugin-template/SKILL.md`);
    return;
  }
  const exact = `${PREFIX} ${bin}`;
  const allowed = `Bash(${exact}:*)`;
  for (const skill of skills) {
    const file = `${rel}/skills/${skill}/SKILL.md`;
    const text = readFileSync(join(root, file), 'utf8');
    const fm = frontmatter(text);
    const fmName = fm?.fields.get('name');
    if (fmName !== skill) {
      add(file, 'skill-name', fm === null ? 'no --- frontmatter block' : `frontmatter name is ${JSON.stringify(fmName ?? null)}, but the folder is ${skill}`, `start the file with ---, name: ${skill}, description: ..., allowed-tools: ..., ---`, 1);
    }
    if (fm === null || !fm.fields.has('allowed-tools') || !allowsCli(fm.body, exact)) {
      add(file, 'allowed-tools', 'allowed-tools does not allow the CLI prefix, so every command line prompts for permission', `set allowed-tools: ${allowed} (or one Bash(${exact} <command>:*) rule per command that may run unprompted)`, 1);
    }
    const lines = npxLines(text);
    if (!lines.some((l) => l.inSh)) {
      add(file, 'skill-command-lines', 'no npx command line in a ```sh block; skills must call the CLI', `add a \`\`\`sh block with a line starting "${exact} "`);
    }
    for (const l of lines) {
      if (!l.inSh) {
        add(file, 'npx-outside-sh', 'npx line outside a ```sh block; the e2e test runs only ```sh lines, so this one is untested', 'put it in a ```sh fenced block', l.line);
      }
      if (l.text === exact || l.text.startsWith(`${exact} `)) continue;
      if (l.text.startsWith(`${PREFIX} `)) {
        const called = l.text.slice(PREFIX.length + 1).split(/\s+/, 1)[0] ?? '';
        add(file, 'npx-bin-name', `runs '${called}', but this plugin's bin is '${bin}'`, `use "${exact} ..."`, l.line);
        continue;
      }
      let specific = false;
      if (!/(^|\s)--offline(\s|$)/.test(l.text)) {
        specific = true;
        add(file, 'npx-offline', 'missing --offline: with an empty CLAUDE_PLUGIN_ROOT, npx would fetch and run the registry package "undefined"', `use the exact prefix "${exact}"`, l.line);
      }
      if (!l.text.includes('--package="${CLAUDE_PLUGIN_ROOT}"')) {
        specific = true;
        add(file, 'npx-quoted-root', '--package is not "${CLAUDE_PLUGIN_ROOT}" in double quotes; the plugin path may contain spaces', `use --package="\${CLAUDE_PLUGIN_ROOT}" exactly, in the prefix "${exact}"`, l.line);
      }
      if (!specific) {
        add(file, 'npx-prefix', `does not start with the required prefix "${exact}"`, `rewrite it as "${exact} <command> [args]" (the flags, their order and the -- are part of the convention)`, l.line);
      }
    }
  }
}

/** Claude Code's hook event names (the keys of "hooks" in hooks/hooks.json). */
export const HOOK_EVENTS: readonly string[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit', 'UserPromptExpansion',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
  'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated',
  'TaskCompleted', 'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay',
];

/** Claude Code's hook handler types. Only `command` hooks run a program, so only they are held to the CLI rule. */
export const HOOK_TYPES: readonly string[] = ['command', 'prompt', 'agent', 'http', 'mcp_tool'];

const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}/';

/**
 * hooks/hooks.json: `{"description"?, "hooks": {<Event>: [{"matcher"?, "hooks": [<hook>...]}]}}`.
 * A command hook runs the plugin's own TypeScript: in exec form, `"command": "node"` with
 * `"args": ["${CLAUDE_PLUGIN_ROOT}/src/<file>.ts", ...]` naming a file that exists under src/ (the CLI
 * entry src/cli.ts, or a dedicated hook entry such as factory's src/human-gate.ts), so the path never
 * reaches a shell; or the convention's npx prefix with the plugin's bin (shell or exec form).
 */
function checkHooks(root: string, rel: string, dir: string, bin: string, add: Add): void {
  const file = `${rel}/hooks/hooks.json`;
  const path = join(root, file);
  if (!existsSync(path)) return;
  const exact = `${PREFIX} ${bin}`;
  const execForm = `{"type": "command", "command": "node", "args": ["${ROOT_VAR}src/cli.ts", "<command>"]}`;
  const finding = (message: string, fix: string, line?: number) => add(file, 'hooks-cli', message, fix, line);
  const read = readJson(path);
  if (!read.ok) {
    const line = /line (\d+)/.exec(read.error)?.[1];
    finding(`not valid JSON: ${read.error}`, 'fix the JSON syntax; Claude Code does not load a plugin hooks file it cannot parse', line === undefined ? undefined : Number(line));
    return;
  }
  const doc = read.value;
  if (!isObject(doc) || !isObject(doc.hooks)) {
    finding('has no "hooks" object', `make it {"description": "...", "hooks": {"<Event>": [{"hooks": [${execForm}]}]}}`);
    return;
  }
  if (doc.description !== undefined && typeof doc.description !== 'string') finding('"description" is not a string', 'make "description" one sentence of text, or remove it');
  const isPluginTs = (arg: string | undefined): boolean => {
    if (arg === undefined || !arg.startsWith(`${ROOT_VAR}src/`) || !arg.endsWith('.ts')) return false;
    const sub = arg.slice(ROOT_VAR.length);
    if (sub.split('/').includes('..')) return false;
    const target = join(dir, sub);
    return existsSync(target) && statSync(target).isFile();
  };
  for (const [event, groups] of Object.entries(doc.hooks)) {
    const at = `hooks.${event}`;
    if (!HOOK_EVENTS.includes(event)) {
      finding(`${at}: '${event}' is not a Claude Code hook event`, `use one of ${HOOK_EVENTS.join(', ')} (names are case-sensitive)`);
      continue;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      finding(`${at} is not a non-empty array of matcher groups`, `make it [{"matcher": "<tool pattern, optional>", "hooks": [${execForm}]}]`);
      continue;
    }
    groups.forEach((group: unknown, g) => {
      const gat = `${at}[${g}]`;
      if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.length === 0) {
        finding(`${gat} has no non-empty "hooks" array`, `make it {"matcher": "<optional>", "hooks": [${execForm}]}`);
        return;
      }
      if (group.matcher !== undefined && typeof group.matcher !== 'string') finding(`${gat}.matcher is not a string`, 'make "matcher" a string (a tool name or pattern), or remove it to match everything');
      group.hooks.forEach((hook: unknown, h) => {
        const hat = `${gat}.hooks[${h}]`;
        if (!isObject(hook) || typeof hook.type !== 'string' || !HOOK_TYPES.includes(hook.type)) {
          const type = isObject(hook) ? (JSON.stringify(hook.type) ?? 'missing') : 'not an object';
          finding(`${hat}: "type" is ${type}`, `use a hook object with "type" one of ${HOOK_TYPES.join(', ')}; a command hook looks like ${execForm}`);
          return;
        }
        if (hook.timeout !== undefined && !(typeof hook.timeout === 'number' && hook.timeout > 0)) finding(`${hat}.timeout is ${JSON.stringify(hook.timeout)}`, 'make "timeout" a positive number of seconds, or remove it');
        for (const key of ['async', 'once'] as const) {
          if (hook[key] !== undefined && typeof hook[key] !== 'boolean') finding(`${hat}.${key} is ${JSON.stringify(hook[key])}`, `make "${key}" true or false, or remove it`);
        }
        if (hook.type !== 'command') return;
        const command = hook.command;
        const args = hook.args;
        if (typeof command !== 'string' || command.trim() === '') {
          finding(`${hat}: a command hook with no "command" string`, `make it ${execForm}`);
          return;
        }
        if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) {
          finding(`${hat}.args is not an array of strings`, `make it ${execForm}`);
          return;
        }
        const argv = (args ?? []) as string[];
        const prefixWords = [...PREFIX.split(' ').slice(1).map((w) => w.replace(/"/g, '')), bin];
        const runsCli =
          args !== undefined
            ? (command === 'node' && isPluginTs(argv[0])) || (command === 'npx' && prefixWords.every((w, i) => argv[i] === w))
            : command === exact || command.startsWith(`${exact} `);
        if (runsCli) return;
        const shown = args === undefined ? JSON.stringify(command) : JSON.stringify([command, ...argv]);
        finding(
          `${hat} runs ${shown}, not the plugin's own TypeScript (a file under src/ run by node, or the npx prefix); hook logic belongs in tested code`,
          args === undefined && /^node\s/.test(command)
            ? `use exec form so the plugin path never reaches a shell: ${execForm}`
            : `add a CLI command for it and run it as ${execForm} (or "command": "${exact} <command>")`,
        );
      });
    });
  }
}

/** Checks the named plugins, or every plugin folder plus every marketplace entry when `names` is null. */
export function check(root: string, names: readonly string[] | null): CheckResult {
  const plugins = names === null ? pluginNames(root) : [...names];
  const findings = plugins.flatMap((name) => checkPlugin(root, name));
  if (names === null) {
    for (const entry of marketplaceEntries(root)) {
      const listed = typeof entry.name === 'string' ? entry.name : JSON.stringify(entry.name);
      if (!plugins.includes(listed)) {
        findings.push({
          plugin: listed,
          file: MARKETPLACE_PATH,
          rule: 'marketplace-entry',
          message: `lists '${listed}', but there is no plugins/${listed} folder`,
          fix: `remove the entry, or create the plugin with factory-plugin-builder new ${listed}`,
        });
      }
    }
  }
  return { plugins, findings };
}
