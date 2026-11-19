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
| `factory-docs` | Keeps this repository's docs in sync with its code: `docs/docs-map.json` maps each doc to the code it describes; `which <path>` (the docs covering a file), `stale` (docs a change left stale), `lint` (the map, and every CLI command mentioned in its README), `gate` (lint + stale; run by `factory-dev check` and CI). Its `factory-docs` skill is the before-finishing workflow. See its `README.md` |
| `factory-plugin-advisor` | Makes these plugins improve from use: `record` (one friction: a workaround, manual step, missing guidance, user correction or CLI failure), `list`, `show`, `suggest` (a draft fix with a `/factory:run` request once an issue recurs), `dismiss`, `file` (dry run; `--confirm` files the draft on GitHub with `gh`), and a `PostToolUseFailure` hook that records failed plugin CLI calls (not `factory`'s exit 2); `stations` (how a repository's factory station agents perform), `stations suggest` (deterministic rules: draft new or changed station agents), `stations apply <id>` (dry run; `--confirm` writes `.claude/agents/` and `factory.json` with backup, check and rollback) and `stations dismiss`. Its log is in the user's config dir, redacted; with `factory.json` `"advisor": {"share": true}` and a remote factory it is also shared in `advisor/` on the state branch, but only once the user has acknowledged that remote with `share allow` (`share list`, `share revoke`; kept in the config dir, never the repo). See its `README.md` |
| `factory-plugin-discover` | Makes Claude use the right plugin for software-factory work: `catalog` (installed plugins and skills, user skills, marketplace plugins not installed, from Claude Code's own records), `match "<task>"` (deterministic shortlist with scores; the `factory-plugin-advisor` record/suggest lines when nothing fits), `settings` and `settings set mode <mode>` (`ask`, `notify`, `auto-install` or `off`), `install <name> [--confirmed]` (the only command that runs `claude`), and a `UserPromptSubmit` hook that hints to run `match` once per session in software-factory work. See its `README.md` |

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | Marketplace `software-factory`; entries `factory`, `factory-plugin-builder`, `factory-dev`, `factory-docs`, `factory-plugin-advisor` and `factory-plugin-discover`, each from `./plugins/<name>` |
| `plugins/factory/.claude-plugin/plugin.json` | Plugin manifest: name `factory`, `version`, `license` |
| `plugins/factory/package.json` | `"bin": {"factory": "src/cli.ts"}`, `type: module`, private, no `dependencies` |
| `plugins/factory/src/cli.ts`, `run.ts` | CLI entry, and argument parsing, usage text and exit codes |
| `plugins/factory/src/factory.ts` | The line's state machine and gates: the only writer of `job.json` |
| `plugins/factory/src/remote.ts` | The remote factory's git side: `remote` validation, attaching `jobs/` as a checkout of the state branch, pull, publish (commit, push, retry, conflict refusal), `remote status` and `remote push`; the state branch holds job directories, its README and factory-plugin-advisor's `advisor/` directory, nothing else |
| `plugins/factory/src/signing.ts` | Signed state commits in remote mode: the signer's git settings (`gpg.format ssh`, `user.signingkey`) read before any state change, the `commit -S` arguments, and `merge`'s check of a job's state history against the allowed-signers file committed in the project checkout |
| `plugins/factory/src/errors.ts` | `Refused`, `Escalated` and `now()`, shared by `factory.ts`, `remote.ts` and `signing.ts` without an import cycle |
| `plugins/factory/src/agents.ts` | `factory agents`: station agent resolution (project or shipped fallback), `new` (a template as a project agent) and `check` (the rules a project agent must pass) |
| `plugins/factory/src/upgrade.ts` | `factory upgrade`: moves a repo from an older factory (settings, `factory/` dir, manual steps); dry run unless `--apply` |
| `plugins/factory/src/dashboard.ts` | `factory dashboard`: serves the factory dir on 127.0.0.1 |
| `plugins/factory/src/pyfmt.ts` | Output formatting kept byte-identical to the original CLI (JSON, rounding) |
| `plugins/factory/src/human-gate.ts`, `gate.ts` | `PreToolUse` Bash hook that turns human-only commands into permission prompts |
| `plugins/factory/hooks/hooks.json` | Runs the hook with `node` (no shell script) |
| `plugins/factory/skills/run/SKILL.md` | The supervisor (`/factory:run`) |
| `plugins/factory/skills/approve`, `skills/ship` | Human-only gates (`disable-model-invocation: true`) |
| `plugins/factory/skills/dashboard` | Starts the dashboard server |
| `plugins/factory/skills/upgrade` | `/factory:upgrade`: runs the `factory upgrade` dry run, asks before `--apply` (and again before `--scope user`) |
| `plugins/factory/skills/agents` | `/factory:agents`: makes a project's own station agents from the templates; pre-approves only `factory agents` and `factory agents check` |
| `plugins/factory/agents/*.md` | `builder`, `verifier`, `reviewer-security`, `reviewer-standards`, `reviewer-behavior`: the shipped fallback station agents |
| `plugins/factory/templates/agents/*.md` | `builder`, `verifier`, `reviewer` (a generic lens): station templates, with `fixed` sections (the line's non-negotiables) and `fill` sections (the project's) |
| `plugins/factory/dashboard/index.html` | Dependency-free dashboard; polls `jobs/*/job.json` through the server's directory listing |
| `plugins/factory/test/*.test.ts` | `node:test` suites; `test/fixtures/` holds job records written by the original CLI |
| `plugins/factory-plugin-builder/src/` | `cli.ts`, `run.ts`; `check.ts` (the convention's rules), `scaffold.ts` (`new`), `verify.ts`, `repo.ts` (finds the checkout) |
| `plugins/factory-plugin-builder/skills/build-plugin/SKILL.md` | The plugin-building workflow: new, implement, check, verify |
| `plugins/factory-dev/src/` | `cli.ts`, `run.ts`; `check.ts` (the CI gates, run in order), `release.ts` (versions and release notes), `repo.ts` (finds the checkout) |
| `plugins/factory-dev/skills/factory-dev/SKILL.md` | When to run `check` (before finishing any change) and `release <tag>` (before tagging) |
| `plugins/factory-docs/src/` | `cli.ts`, `run.ts`; `docs.ts` (`which`, `stale`, `lint`), `glob.ts` (git-style globs), `repo.ts` (finds the checkout, reads the map) |
| `plugins/factory-docs/skills/factory-docs/SKILL.md` | Before finishing a change: `stale`, update the listed docs, `gate`; `which` to find a file's docs |
| `plugins/factory-plugin-advisor/src/` | `cli.ts`, `run.ts`; `advisor.ts` (record, list, show, suggest, dismiss, drafts), `file.ts` (`gh issue create`), `hook.ts`, `hook-filter.ts` (the hook), `redact.ts` (redaction, caps, signatures), `store.ts` (the log), `plugins.ts` (the marketplace's plugins and bins), `stations.ts` (the line's history, the station report and rules), `station-drafts.ts` (station drafts, `stations apply`, running the factory CLI), `shared.ts` (opt-in sharing of the log and state in `advisor/` on a remote factory's state branch, the user's per-remote acknowledgement, the public-remote warning) |
| `plugins/factory-plugin-advisor/hooks/hooks.json` | Async `PostToolUseFailure` hook on `Bash`: `node src/cli.ts hook` |
| `plugins/factory-plugin-advisor/skills/factory-plugin-advisor/SKILL.md` | When to `record` and `suggest`; the `file` dry run, then `--confirm` only after an explicit yes; `stations` and `stations suggest` after a job ships, `stations apply <id> --confirm` only after a yes for that draft; `share allow` only after the user's yes for that remote |
| `plugins/factory-plugin-discover/src/` | `cli.ts`, `run.ts`; `catalog.ts` (installed, elsewhere, user skills, available), `match.ts` (scoring, domain terms, advisor lines), `install.ts` (guarded `claude plugin install`), `hook.ts` (the prompt hook), `config.ts` (mode and hinted sessions) |
| `plugins/factory-plugin-discover/hooks/hooks.json` | `UserPromptSubmit` hook (5 s): `node src/cli.ts hook` |
| `plugins/factory-plugin-discover/skills/factory-plugin-discover/SKILL.md` | Run `match` before software-factory work; act on each mode; `install --confirmed` only after a yes |
| `docs/docs-map.json` | The doc map: each doc and the globs of the code it describes, the changelog doc, `*.md` files that are not docs, and where a plugin's CLI is documented |
| `templates/plugin/` | The plugin template, itself a valid plugin (`plugin-template`), not listed in the marketplace |
| `package.json`, `package-lock.json`, `tsconfig.json` | Dev tooling only (typecheck, tests, `new-plugin`). Plugins never import from the root |
| `.github/workflows/` | `ci.yml` (PRs, pushes to `main`: full history, `npm ci`, `factory-dev check --require-claude`, and on PRs `factory-docs gate --base origin/<base branch>`) and `release.yml` (tags `v*`: `factory-dev release <tag>`) |
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
node plugins/factory-dev/src/cli.ts release v0.4.0 # would this tag release? prints its notes
node plugins/factory-docs/src/cli.ts stale         # docs this change left stale (vs origin/main or main)
node plugins/factory-docs/src/cli.ts which <path>  # the docs that describe a file
node plugins/factory-docs/src/cli.ts gate          # lint the doc map + stale; factory-dev check runs it
node plugins/factory/src/cli.ts --help             # every CLI command
node plugins/factory/src/cli.ts upgrade            # dry run: what moving this repo from an older factory would change
```

`factory-dev check` needs `git`, Node.js 22.18+ with `npm ci` done, and the `claude` CLI; without
`claude` it reports the validate steps as skipped (not passed), and `--require-claude` fails them
instead. Agents with the `factory-dev` plugin installed run the same commands through npx
(`npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev check`), from
anywhere in the checkout. The repository holds no Python or shell scripts: dev tooling is TypeScript
in `plugins/factory-dev`.

**Before finishing any change to this repository**, keep the docs in sync and run the checks: use
the `factory-docs` skill (or the commands above) to run `stale`, update every doc it lists (and
`docs/docs-map.json` when you add a doc or a plugin, or move code), and run `gate`; then run
`factory-dev check`, which runs the same gate with every other CI check. Use `which <path>` to find
the docs that describe a file before changing it. Do not narrow the map's globs to silence `stale`.

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
  may run unprompted [allowed-tools]. `factory` never pre-approves `merge`, `approve`, `rework`, `claim` or `close`;
  `factory-plugin-builder` pre-approves `check`, `verify` and `--help`, not `new`; `factory-dev`
  pre-approves `check`, `release` and `--help`; `factory-docs` pre-approves `which`, `stale`,
  `lint`, `gate` and `--help` (all read-only); `factory-plugin-advisor` pre-approves `record`, `list`,
  `show`, `suggest`, `--help`, `stations --json`, `stations suggest` and `share list`, never `file`,
  `dismiss`, `stations apply`, `share allow` or `share revoke`; `factory-plugin-discover` pre-approves
  `match`, `catalog` and `--help`, never `install` or `settings`.
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
  `allowed-tools` may pre-approve read-only and station commands only, never `merge`, `approve`,
  `rework`, `claim` or `close`. Hooks run TS with `node` directly (`"command": "node", "args": [...]`).
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
  For example, `built`, `proof` and `verdict` refuse while an untracked copy of their handoff file
  (`build.md`, `proof.md`, `review-<round>-<reviewer>.md`) sits at the root of the main checkout or
  the job's worktree: stations write handoff files only to the job dir.
- **Human-only commands** (today `factory merge`, `factory approve`, `factory rework`,
  `factory claim`, `factory close`) are made permission prompts by the TS hook (`plugins/factory/src/gate.ts`, run by
  `hooks/hooks.json`). A new command only a person may run must be added there too, and its skill
  marked `disable-model-invocation: true` (`claim` has no skill; the README and the station agents
  say it is a human's).
- **Station agents.** `/factory:run` launches, per station, the agent `factory agents` names: the
  project's `.claude/agents/factory-<station>.md` when it passes `factory agents check`, else the
  shipped `factory:<station>`. A non-negotiable of a station goes in a `fixed` section of its
  template in `plugins/factory/templates/agents/`, and the shipped agent keeps the same text:
  `agents.test.ts` runs `check` on every shipped agent. A change to a fixed section changes it in
  both, and makes existing project agents fail `check` until they are refreshed.
- **New `job.json` fields need dashboard handling** in `plugins/factory/dashboard/index.html`, which
  must also keep working on older `job.json` files that lack the field.
- **New `factory.json` keys go in `DEFAULTS` and in `loadConfig`'s validation** in
  `plugins/factory/src/factory.ts` (unknown keys are refused, so a key that is only documented does
  not work), and in the README's Configure section.
- **Runtime state is not source.** The CLI keeps jobs and worktrees in `<main checkout>/factory/`
  (or `FACTORY_DIR`) and reads `factory.json` from that dir's parent. Running the factory on this
  repo creates `/factory/`, which `.gitignore` excludes. Tests use temporary repos with
  `FACTORY_DIR` set; never point them at a real `factory/`.
- **Remote factory.** With `remote` in `factory.json`, `factory/jobs/` is a git checkout of the state
  branch, never holding worktrees. Every state-changing command goes through `editing()` (or `new`'s
  allocation loop), which pulls, applies, saves and publishes one commit of the job's directory;
  a new state-changing command must do the same, and declare a command name for the commit message
  and the owner check (`ANYONE` lists the commands anyone may run on a claimed job). Every state
  commit goes through `remote.ts`'s `commit()`, which signs it (`src/signing.ts`): a command that
  changes state calls `signFor(remote, true)` before anything changes, so a missing signing setup
  is refused up front; `merge` verifies the job's state history against `remote.allowed_signers`
  as committed at the project checkout's HEAD, and only `remote.unsigned_ok` turns both off. Read
  commands set `read: true` in `run.ts` and take `--offline`. Local mode (no `remote`) must behave exactly as
  before. the `remote*.test.ts` suites (shared setup in `remote-helpers.ts`; keep each file under 60 s, the per-test timeout is 120 s per file) use a bare repo in a temp dir as the remote and two clones as two people,
  each signing with a throwaway SSH key from `ssh-keygen` in the temp dir (never the user's keys).
- **Every user-visible change gets a semver bump and a changelog entry.** Add it under
  `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog). **One changelog, one repo version:** every
  marketplace plugin's `.claude-plugin/plugin.json` and `package.json` carry the same `version`
  (and so does a marketplace entry, if one ever lists a version), and they all move together. A
  release moves the `Unreleased` entries under the new version and bumps every plugin's `version`;
  `factory-dev release <tag>` refuses a tag that is not `v` + that version, and `factory-dev check`
  refuses versions that differ at any time. A new plugin starts at the repo's current version
  (`factory-plugin-builder new` sets it).
- Every change to the CLI's behaviour comes with a test in `plugins/factory/test/` that drives the
  CLI as a subprocess.
- Keep stations short: each skill and agent is one prompt file. See CONTRIBUTING.md for branch,
  commit and PR conventions.
