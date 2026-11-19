# CLAUDE.md

Guidance for Claude Code (and people) working in this repository.

## What this is

Software Factory: a Claude Code plugin (`factory`) that runs work through a multi-agent line,
intake -> build -> proof -> review -> ship -> done. `README.md` explains the pipeline and why it is
built this way; read it before changing a station.

The repository root is a marketplace named `software-factory` whose plugins live in
`plugins/<name>/` (`.claude-plugin/marketplace.json` lists each with
`"source": "./plugins/<name>"`). The root itself is not a plugin. Each plugin defines a
**TypeScript CLI run via `npx`**, and its skills, agents and hooks call that CLI instead of
embedding logic in prompts. Everything ships as source: Node runs the `.ts` files directly, with no
build step and no runtime dependency.

## Plugins

| Plugin | What it does |
| --- | --- |
| `factory` | The line itself: the `factory` CLI (state machine and gates), the supervisor and gate skills, the station agents, the human-gate hook and the dashboard |
| `factory-plugin-builder` | Builds plugins for this marketplace: `new` (scaffold from `templates/plugin`), `check` (the "Plugin layout" and "CLI convention" below, statically, with a fix per finding), `verify` (the full gate for one plugin). Its `build-plugin` skill is the workflow. See its `README.md` |
| `factory-dev` | Develops this repository: `check` (every CI gate in one command) and `release [<tag>]` (the tag/version check and release notes). Its `factory-dev` skill says when to run which. CI and the release workflow run it too. See its `README.md` |

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | Marketplace `software-factory`; entries `factory`, `factory-plugin-builder` and `factory-dev`, each from `./plugins/<name>` |
| `plugins/factory/.claude-plugin/plugin.json` | Plugin manifest: name `factory`, `version`, `license` |
| `plugins/factory/package.json` | `"bin": {"factory": "src/cli.ts"}`, `type: module`, private, no `dependencies` |
| `plugins/factory/src/cli.ts`, `run.ts` | CLI entry, and argument parsing, usage text and exit codes |
| `plugins/factory/src/factory.ts` | The line's state machine and gates: the only writer of `job.json` |
| `plugins/factory/src/dashboard.ts` | `factory dashboard`: serves the factory dir on 127.0.0.1 |
| `plugins/factory/src/pyfmt.ts` | Output formatting kept byte-identical to the original CLI (JSON, rounding) |
| `plugins/factory/src/human-gate.ts`, `gate.ts` | `PreToolUse` Bash hook that turns human-only commands into permission prompts |
| `plugins/factory/hooks/hooks.json` | Runs the hook with `node` (no shell script) |
| `plugins/factory/skills/run/SKILL.md` | The supervisor (`/factory:run`) |
| `plugins/factory/skills/approve`, `skills/ship` | Human-only gates (`disable-model-invocation: true`) |
| `plugins/factory/skills/dashboard` | Starts the dashboard server |
| `plugins/factory/agents/*.md` | `builder`, `verifier`, `reviewer-security`, `reviewer-standards`, `reviewer-behavior` |
| `plugins/factory/dashboard/index.html` | Dependency-free dashboard; polls `jobs/*/job.json` through the server's directory listing |
| `plugins/factory/test/*.test.ts` | `node:test` suites; `test/fixtures/` holds job records written by the original CLI |
| `plugins/factory-plugin-builder/src/` | `cli.ts`, `run.ts`; `check.ts` (the convention's rules), `scaffold.ts` (`new`), `verify.ts`, `repo.ts` (finds the checkout) |
| `plugins/factory-plugin-builder/skills/build-plugin/SKILL.md` | The plugin-building workflow: new, implement, check, verify |
| `plugins/factory-dev/src/` | `cli.ts`, `run.ts`; `check.ts` (the CI gates, run in order), `release.ts` (versions and release notes), `repo.ts` (finds the checkout) |
| `plugins/factory-dev/skills/factory-dev/SKILL.md` | When to run `check` (before finishing any change) and `release <tag>` (before tagging) |
| `templates/plugin/` | The plugin template, itself a valid plugin (`plugin-template`), not listed in the marketplace |
| `package.json`, `package-lock.json`, `tsconfig.json` | Dev tooling only (typecheck, tests, `new-plugin`). Plugins never import from the root |
| `.github/workflows/` | `ci.yml` (PRs, pushes to `main`: `npm ci`, then `factory-dev check --require-claude`) and `release.yml` (tags `v*`: `factory-dev release <tag>`) |
| `docs/research/` | Build-vs-buy research behind the design; reference material, not maintained code |

## Commands

```sh
npm ci                                             # dev tooling: typescript, @types/node (pinned exactly)
node plugins/factory-dev/src/cli.ts check          # everything CI runs; exit 0 = green (CI adds --require-claude)
npm run typecheck                                  # strict tsc over plugins/*/**/*.ts and templates/*/**/*.ts
npm test                                           # every plugin's and the template's node:test suites
npm run new-plugin -- <name> [--description "<text>"]   # scaffold plugins/<name> from templates/plugin
node plugins/factory-plugin-builder/src/cli.ts check <name>|--all   # the convention below, checked statically
node plugins/factory-plugin-builder/src/cli.ts verify <name>        # check + validate + typecheck + the plugin's tests
node --test plugins/factory/test/cli.test.ts       # one suite
claude plugin validate .                           # marketplace manifest
claude plugin validate plugins/<name>              # one plugin (also templates/plugin)
node plugins/factory-dev/src/cli.ts release v0.2.0 # would this tag release? prints its notes
node plugins/factory/src/cli.ts --help             # every CLI command
```

`factory-dev check` needs `git`, Node.js 22.18+ with `npm ci` done, and the `claude` CLI; without
`claude` it reports the validate steps as skipped (not passed), and `--require-claude` fails them
instead. Agents with the `factory-dev` plugin installed run the same commands through npx
(`npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev check`), from
anywhere in the checkout. The repository holds no Python or shell scripts: dev tooling is TypeScript
in `plugins/factory-dev`.

## Plugin layout

```
plugins/<name>/
  .claude-plugin/plugin.json      name (= folder), version, description         [plugin-manifest]
  package.json                    "bin": {"<name>": "src/cli.ts"}, "type": "module", "private": true,
                                  engines node >=22.18.0, no dependencies of any kind
                                  [package-json, package-private, package-type-module, package-bin, no-dependencies]
  skills/<skill>/SKILL.md         frontmatter name = folder; calls the CLI      [skills-present, skill-name]
  hooks/hooks.json                optional; runs the plugin's TS with node      [hooks-cli]
  src/cli.ts                      entry, first line #!/usr/bin/env node         [bin-shebang]
  src/run.ts                      argument parsing, commands, usage text, exit codes
  src/<logic>.ts                  command logic as plain functions
  test/*.test.ts                  node:test: unit tests + the e2e skill-line test   [tests-present, e2e-test]
```

The marketplace lists every plugin as `{"name": "<name>", "source": "./plugins/<name>", ...}`, and
lists nothing that has no folder [marketplace-entry]. A plugin holds no `*.py` or `*.sh` file: its
logic is TypeScript [no-python-or-shell]. Create one with `npm run new-plugin -- <name>` (or
`factory-plugin-builder new`), which copies `templates/plugin/`; the template is itself a valid
plugin, kept out of the marketplace. `factory-plugin-builder check` enforces this section and the
next one, rule by rule (the bracketed ids are its rule names).

## CLI convention

- **Skills call the CLI through npx with exactly this prefix**, from any directory, with no `cd`,
  install or build step: `npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" --
  <name> <command> [args]` [npx-prefix, npx-bin-name]. `--package` resolves the bin from the
  plugin's own installed folder (the plugin cache has no `node_modules`); keep the double quotes,
  the path may hold spaces [npx-quoted-root]. `--offline` is required: an empty
  `${CLAUDE_PLUGIN_ROOT}` would otherwise make npx fetch and run the registry package `undefined`
  [npx-offline].
- **Every command line of a SKILL.md is in a ` ```sh ` block** and starts with `npx `
  [skill-command-lines, npx-outside-sh]; each skill has at least one. Arguments are named as
  `<placeholder>`s. The plugin's e2e test copies the plugin to a temp dir and runs every such line
  through npx from an unrelated cwd, offline with an empty npm cache [e2e-test].
- **`allowed-tools`** allows the prefix: `Bash(<prefix> <name>:*)`, or, when some commands write,
  act on the machine or need a person, one `Bash(<prefix> <name> <command>:*)` rule per command that
  may run unprompted [allowed-tools]. `factory` never pre-approves `merge`, `approve` or `rework`;
  `factory-plugin-builder` pre-approves `check`, `verify` and `--help`, not `new`; `factory-dev`
  pre-approves `check`, `release` and `--help`.
- **Hooks** run the plugin's own TypeScript in exec form, `"command": "node", "args":
  ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "<command>"]` (or a dedicated entry under `src/`, as
  `factory`'s `src/human-gate.ts`), or a shell command starting with the npx prefix [hooks-cli].
- **TypeScript Node runs as-is**: relative imports end in `.ts` [relative-imports]; see Conventions
  below for erasable syntax and the root `tsconfig.json`.
- **Output and exit codes**: `--help` prints usage on stdout and exits 0; `--json` prints one JSON
  value; `0` success, `1` the command failed, `2` usage error. On a non-zero exit stdout is empty and
  the reason is on stderr (`<name>: <message>`). These are covered by each plugin's tests, not by
  `check`.

## Conventions

- **Skills, agents and docs run the CLI through npx** ("CLI convention" above), always with exactly
  this prefix, from any directory: `npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory
  <command>`. `--package` resolves the plugin's own folder (the plugin cache has no
  `node_modules`); `--offline` stops an empty `${CLAUDE_PLUGIN_ROOT}` from fetching a registry
  package named `undefined`. A skill or agent may define `factory` once as that invocation.
  `allowed-tools` may pre-approve read-only and station commands only, never `merge`, `approve` or
  `rework`. Hooks run TS with `node` directly (`"command": "node", "args": [...]`).
- **TypeScript that Node runs as-is**: Node >= 22.18 strips types, so only erasable syntax (no
  `enum`, `namespace` or parameter properties; `erasableSyntaxOnly` enforces it), relative imports
  with the `.ts` extension, `import type` for types. The root `tsconfig.json` is strict and covers
  every plugin and the template.
- **No runtime dependencies.** Node's standard library only, in `plugins/*/src` and `test/`. A
  runtime dependency would need the network on first run, which `--offline` forbids. Type-only dev
  dependencies go in the root `package.json`, pinned exactly.
- **`plugins/factory/src` is the only writer of `job.json`** and the only way a job changes stage.
  Agents and skills call the CLI; they never edit `job.json`. Its format (keys, order, indent 2,
  non-ASCII escaped) stays compatible with existing `factory/` dirs; `compat.test.ts` checks it.
- **Gates live in the CLI, not in prompts.** A rule that must hold is enforced in
  `plugins/factory/src/factory.ts` (exit 1 = refused, 2 = escalated to a human; usage errors also
  exit 2); prompts may describe it but never replace it.
- **Human-only commands** (today `factory merge`, `factory approve`, `factory rework`) are made
  permission prompts by the TS hook (`plugins/factory/src/gate.ts`, run by `hooks/hooks.json`). A new
  command only a person may run must be added there too, and its skill marked
  `disable-model-invocation: true`.
- **New `job.json` fields need dashboard handling** in `plugins/factory/dashboard/index.html`, which
  must also keep working on older `job.json` files that lack the field.
- **New `factory.json` keys go in `DEFAULTS` and in `loadConfig`'s validation** in
  `plugins/factory/src/factory.ts` (unknown keys are refused, so a key that is only documented does
  not work), and in the README's Configure section.
- **Runtime state is not source.** The CLI keeps jobs and worktrees in `<main checkout>/factory/`
  (or `FACTORY_DIR`) and reads `factory.json` from that dir's parent. Running the factory on this
  repo creates `/factory/`, which `.gitignore` excludes. Tests use temporary repos with
  `FACTORY_DIR` set; never point them at a real `factory/`.
- **Every user-visible change gets a semver bump and a changelog entry.** Add it under
  `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog). **One changelog, one repo version:** every
  marketplace plugin's `.claude-plugin/plugin.json` and `package.json` carry the same `version`
  (and so does a marketplace entry, if one ever lists a version), and they all move together. A
  release moves the `Unreleased` entries under the new version and bumps every plugin's `version`;
  `factory-dev release <tag>` refuses a tag that is not `v` + that version, and `factory-dev check`
  refuses versions that differ at any time. A new plugin starts at the repo's current version.
- Every change to the CLI's behaviour comes with a test in `plugins/factory/test/` that drives the
  CLI as a subprocess.
- Keep stations short: each skill and agent is one prompt file. See CONTRIBUTING.md for branch,
  commit and PR conventions.
