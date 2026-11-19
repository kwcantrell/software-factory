# CLAUDE.md

Guidance for Claude Code (and people) working in this repository.

## What this is

Software Factory: a Claude Code plugin (`factory`) that runs work through a multi-agent line,
intake -> build -> proof -> review -> ship -> done. `README.md` explains the pipeline and why it is
built this way; read it before changing a station.

The repository root is both the plugin and a marketplace named `software-factory`
(`.claude-plugin/marketplace.json` lists the plugin with `"source": "./"`). Everything ships as
source: there is no package.json, build step or third-party dependency.

## Layout

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest: name `factory`, `version`, `license` |
| `.claude-plugin/marketplace.json` | Marketplace `software-factory`, one entry: `factory` from `./` |
| `bin/factory` | The CLI: a single stdlib-only Python file, the line's state machine and gates |
| `skills/run/SKILL.md` | The supervisor (`/factory:run`) |
| `skills/approve`, `skills/ship` | Human-only gates (`disable-model-invocation: true`) |
| `skills/dashboard` | Starts the dashboard server |
| `agents/*.md` | `builder`, `verifier`, `reviewer-security`, `reviewer-standards`, `reviewer-behavior` |
| `hooks/hooks.json` -> `scripts/human-gate.sh` | `PreToolUse` Bash hook that turns human-only commands into permission prompts |
| `dashboard/index.html` | Dependency-free dashboard; polls `jobs/*/job.json` through a directory-listing server |
| `scripts/check.sh` | Every check CI runs, in one command |
| `scripts/release.py` | Release tag/version check and release notes from `CHANGELOG.md` |
| `tests/` | `unittest` suites: `test_cli.py` drives `bin/factory`, `test_release.py` drives `release.py` |
| `.github/workflows/` | `ci.yml` (PRs, pushes to `main`) and `release.yml` (tags `v*`) |
| `docs/research/` | Build-vs-buy research behind the design; reference material, not maintained code |

## Commands

```sh
scripts/check.sh                                   # everything CI runs; exit 0 = green
python3 -I -B -m unittest discover -s tests        # just the tests
python3 -I -B -m unittest discover -s tests -p test_cli.py   # one suite
claude plugin validate .                           # plugin + marketplace manifests
python3 -I scripts/release.py v0.2.0               # would this tag release? prints its notes
python3 -I bin/factory --help                      # every CLI command
```

`scripts/check.sh` needs `git`, `python3` and the `claude` CLI; it runs `shellcheck` when installed
and says it skipped it otherwise (CI installs it).

## Conventions

- **Python is stdlib only and always run isolated**: `python3 -I <script>`. No third-party imports,
  in `bin/factory`, `scripts/` or `tests/`.
- **`bin/factory` is the only writer of `job.json`** and the only way a job changes stage. Agents
  and skills call the CLI; they never edit `job.json`.
- **Gates live in the CLI, not in prompts.** A rule that must hold is enforced in `bin/factory`
  (exit 1 = refused, 2 = escalated to a human); prompts may describe it but never replace it.
- **Human-only commands** (today `factory merge`, `factory approve`, `factory rework`) are made
  permission prompts by `scripts/human-gate.sh`. A new command only a person may run must be added
  there too, and its skill marked `disable-model-invocation: true`.
- **New `job.json` fields need dashboard handling** in `dashboard/index.html`, which must also keep
  working on older `job.json` files that lack the field.
- **New `factory.json` keys go in `DEFAULTS` and in `load_config`'s validation** in `bin/factory`
  (unknown keys are refused, so a key that is only documented does not work), and in the README's
  Configure section.
- **Runtime state is not source.** The CLI keeps jobs and worktrees in `<main checkout>/factory/`
  (or `FACTORY_DIR`) and reads `factory.json` from that dir's parent. Running the factory on this
  repo creates `/factory/`, which `.gitignore` excludes. Tests use temporary repos with
  `FACTORY_DIR` set; never point them at a real `factory/`.
- **Every user-visible change gets a semver bump and a changelog entry.** Add it under
  `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog). A release moves those entries under the
  new version and bumps `version` in `.claude-plugin/plugin.json` (and in the marketplace entry, if
  one is ever added there); `scripts/release.py` refuses a tag that does not match.
- Every change to `bin/factory` behaviour comes with a test in `tests/test_cli.py` that drives the
  CLI as a subprocess.
- Keep stations short: each skill and agent is one prompt file. See CONTRIBUTING.md for branch,
  commit and PR conventions.
