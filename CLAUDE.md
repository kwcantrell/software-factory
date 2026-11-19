# CLAUDE.md

Guidance for Claude Code (and people) working in this repository.

## What this is

Software Factory: a Claude Code plugin (`factory`) that runs work through a multi-agent line,
intake -> build -> proof -> review -> ship -> done. `README.md` explains the pipeline and why it is
built this way; read it before changing a station.

The repository root is a marketplace named `software-factory` whose plugins live in
`plugins/<name>/` (`.claude-plugin/marketplace.json` lists `factory` with
`"source": "./plugins/factory"`). The root itself is not a plugin. Each plugin defines a
**TypeScript CLI run via `npx`**, and its skills, agents and hooks call that CLI instead of
embedding logic in prompts. Everything ships as source: Node runs the `.ts` files directly, with no
build step and no runtime dependency.

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | Marketplace `software-factory`; one entry: `factory` from `./plugins/factory` |
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
| `package.json`, `package-lock.json`, `tsconfig.json` | Dev tooling only (typecheck, tests). Plugins never import from the root |
| `scripts/check.sh` | Every check CI runs, in one command |
| `scripts/release.py`, `tests/test_release.py` | Release tag/version check and release notes from `CHANGELOG.md`, and its tests (Python until job 006 ports them) |
| `.github/workflows/` | `ci.yml` (PRs, pushes to `main`) and `release.yml` (tags `v*`) |
| `docs/research/` | Build-vs-buy research behind the design; reference material, not maintained code |

## Commands

```sh
npm ci                                             # dev tooling: typescript, @types/node (pinned exactly)
scripts/check.sh                                   # everything CI runs; exit 0 = green
npm run typecheck                                  # strict tsc over plugins/*/**/*.ts
npm test                                           # every plugin's node:test suites
node --test plugins/factory/test/cli.test.ts       # one suite
claude plugin validate .                           # marketplace manifest
claude plugin validate plugins/factory             # the plugin
scripts/release.py v0.2.0                          # would this tag release? prints its notes
node plugins/factory/src/cli.ts --help             # every CLI command
```

`scripts/check.sh` needs `git`, Node.js 22.18+ with `npm ci` done, `python3` (release script only)
and the `claude` CLI; it runs `shellcheck` when installed and says it skipped it otherwise (CI
installs it).

## Conventions

- **Skills, agents and docs run the CLI through npx**, always with exactly this prefix, from any
  directory: `npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory
  <command>`. `--package` resolves the plugin's own folder (the plugin cache has no
  `node_modules`); `--offline` stops an empty `${CLAUDE_PLUGIN_ROOT}` from fetching a registry
  package named `undefined`. A skill or agent may define `factory` once as that invocation.
  `allowed-tools` may pre-approve read-only and station commands only, never `merge`, `approve` or
  `rework`. Hooks run TS with `node` directly (`"command": "node", "args": [...]`).
- **TypeScript that Node runs as-is**: Node >= 22.18 strips types, so only erasable syntax (no
  `enum`, `namespace` or parameter properties; `erasableSyntaxOnly` enforces it), relative imports
  with the `.ts` extension, `import type` for types. The root `tsconfig.json` is strict and covers
  every plugin.
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
  `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog). A release moves those entries under the
  new version and bumps `version` in `plugins/factory/.claude-plugin/plugin.json` and
  `plugins/factory/package.json` (and in the marketplace entry, if one is ever added there);
  `scripts/release.py` refuses a tag that does not match.
- Every change to the CLI's behaviour comes with a test in `plugins/factory/test/` that drives the
  CLI as a subprocess.
- The remaining Python (`scripts/release.py`, `tests/test_release.py`) is stdlib only and run
  isolated, as `scripts/check.sh` and the release workflow do.
- Keep stations short: each skill and agent is one prompt file. See CONTRIBUTING.md for branch,
  commit and PR conventions.
