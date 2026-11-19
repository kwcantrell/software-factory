# factory-plugin-builder

Helps Claude agents build plugins for the software-factory marketplace right the first time. Its
TypeScript CLI scaffolds a plugin from the template, checks plugins against the repo's CLI
convention with a fix for every finding, and runs one plugin's full verification gate. Its
`build-plugin` skill walks an agent from an idea to a passing plugin. The `factory-` prefix keeps
its name apart from other marketplaces' plugin builders, so both can be installed.

The convention itself lives in the repo's [CLAUDE.md](../../CLAUDE.md) ("Plugin layout" and "CLI
convention"); this plugin applies it, it does not redefine it.

Install it from the marketplace (it needs Node.js 22.18+):

```text
/plugin install factory-plugin-builder --marketplace kwcantrell/software-factory
```

## Commands

The CLI works on the `software-factory` checkout containing the current directory (the nearest
ancestor whose `.claude-plugin/marketplace.json` is named `software-factory`), or on `--repo
<path>`. Outside one it exits 2. Skills call it as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder <command> [args] --json
```

and from a checkout you can run it directly with `node plugins/factory-plugin-builder/src/cli.ts
<command>`.

| Command | What it does |
| --- | --- |
| `new <name> [--description <text>]` | Copies `templates/plugin/` to `plugins/<name>/`, replaces the token `plugin-template` in every file and path, sets the description in `plugin.json`, sets `version` in `plugin.json` and `package.json` to the version the marketplace's plugins share (one repo version; the highest if they differ, the template's own when the marketplace lists none), so the new plugin passes `factory-dev check` without hand edits, and appends `{"name","source","description"}` to `marketplace.json`. The name must be kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 64 characters): exit 2 otherwise; exit 1 if the folder or the marketplace entry already exists. Nothing is written in either case. `--json` prints `{"name","path","marketplace","description"}`. The root `npm run new-plugin -- <name>` runs this same command. |
| `check <name>... \| --all` | Checks plugins against the convention (below). Exit 1 on any finding, with each finding on stderr as `<file>:<line>: [<rule>] <problem>` and a `fix:` line; exit 0 and `{"plugins":[...],"findings":[]}` when clean. `--all` checks every folder in `plugins/` and every marketplace entry. |
| `verify <name>` | From the checkout root: `check <name>`, `claude plugin validate plugins/<name>`, `claude plugin validate .`, `npm run typecheck`, and `node --test plugins/<name>/test/**/*.test.ts` (the root `npm test`, limited to this plugin). Every step runs; their output streams on stderr. Prints each step as pass, fail or skipped (skipped only when `claude` is not on the PATH) and exits 1 if any failed. `--json` prints `{"plugin","ok","steps"}`. |

Exit codes: 0 success, 1 the command failed (findings, a failing step, a taken name), 2 a usage error
or not inside a software-factory checkout. On a non-zero exit stdout is empty and the reason is on
stderr.

## Rules `check` applies

| Rule | Checks |
| --- | --- |
| `plugin-manifest` | `.claude-plugin/plugin.json` exists, is JSON, and its `name` is the folder name |
| `marketplace-entry` | `marketplace.json` lists the plugin with `source: ./plugins/<name>` (with `--all`, also: no entry without a folder) |
| `package-json` | `package.json` exists and is a JSON object |
| `package-private` | `"private": true` |
| `package-type-module` | `"type": "module"` |
| `package-bin` | `"bin"` maps the plugin name to a `.ts` file that exists in the plugin |
| `bin-shebang` | the bin file starts with `#!/usr/bin/env node` |
| `no-dependencies` | no `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` or bundled ones |
| `no-python-or-shell` | no `*.py` or `*.sh` file anywhere in the plugin (outside `node_modules`) |
| `skills-present` | at least one `skills/<skill>/SKILL.md` |
| `skill-name` | the skill's frontmatter `name` is its folder name |
| `skill-command-lines` | every SKILL.md has at least one `npx` line in a ` ```sh ` block |
| `npx-outside-sh` | no `npx` line outside a ` ```sh ` block (the e2e test would not run it) |
| `npx-offline` | every skill `npx` line has `--offline` |
| `npx-quoted-root` | every skill `npx` line has `--package="${CLAUDE_PLUGIN_ROOT}"`, double-quoted |
| `npx-bin-name` | every skill `npx` line runs the plugin's own bin |
| `npx-prefix` | every skill `npx` line starts with the exact prefix (flags and their order) |
| `allowed-tools` | the frontmatter `allowed-tools` has `Bash(<prefix> <bin>:*)`, or per-command `Bash(<prefix> <bin> <command>:*)` rules |
| `tests-present` | `test/` has at least one `*.test.ts` |
| `e2e-test` | a test reads `SKILL.md` and runs its lines through `npx` (imports `node:child_process`) with `CLAUDE_PLUGIN_ROOT` set |
| `relative-imports` | relative imports in `src/` and `test/` end in `.ts` (or `.json`) |
| `hooks-cli` | if `hooks/hooks.json` exists: it is JSON in Claude Code's hooks format (`{"hooks": {<Event>: [{"matcher"?, "hooks": [...]}]}}`, known event names and hook types, a positive `timeout`, boolean `async`/`once`), and every `command` hook runs the plugin's own TypeScript: exec form `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/<file>.ts", ...]` naming a file that exists under `src/` (normally `src/cli.ts`), or the skill `npx` prefix with the plugin's bin |

`<placeholder>` arguments in skill lines are accepted; filling them is the plugin's e2e test's job.
Whether a command passes an exit status through, prints exactly one JSON value, or keeps stdout
empty on errors cannot be checked statically: the unit and e2e tests cover those.

`hooks-cli` accepts any existing `src/*.ts` entry, not only `src/cli.ts`, because the `factory`
plugin's human-gate hook runs its own entry, `src/human-gate.ts`, in exec form; that keeps the hook
off the CLI's argument parsing and is still tested TypeScript with no shell in between.

## Tests

`test/check.test.ts` has a deliberately broken fixture plugin for every rule, and checks that the
real repo's plugins and the template pass. `test/run.test.ts` covers `new` (also through
`npm run new-plugin`), `check` and `verify` in temp-dir fixture checkouts (a fake `claude` on the
PATH, none, and the real one when installed; a real strict typecheck when `npm ci` has run).
`test/cli.test.ts` runs every skill command line through npx from a fresh copy of the plugin.
`test/docs.test.ts` checks that this README's rules table and the root CLAUDE.md name exactly the
rules the checker defines. No test writes to the real repo.

## Versioning

Every plugin in this marketplace carries the same version, the repository's. `CHANGELOG.md` lists what changed in each release.
