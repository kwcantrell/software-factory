# Changelog

All notable changes to the Software Factory plugin are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the plugin follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The `factory` CLI is now TypeScript, run through `npx` from the installed plugin
  (`npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>`),
  with no build step and no runtime dependencies. It needs **Node.js 22.18+** and no longer
  Python. Commands, options, gates, exit codes, `factory.json` and the `job.json` format are
  unchanged, so existing `factory/` directories keep working.
- The plugin moved to `plugins/factory/`; the marketplace lists it from there. Install as before:
  `/plugin install factory@software-factory`.
- Skills and agents call the CLI through `npx`; the "use `bin/factory` if `factory` is not on
  PATH" fallback is gone. The skills pre-approve their read-only and station commands
  (`allowed-tools`), never `merge`, `approve` or `rework`.
- The human-gate hook is TypeScript run by `node`, and reads the Bash command from the hook
  payload instead of matching the raw input; it still asks before `factory merge`, `approve` and
  `rework`, also in the npx form.
- `factory dashboard` serves the dashboard itself on 127.0.0.1, refusing any path outside the
  factory directory, instead of starting Python's `http.server`.
- Moved to its own repository, `kwcantrell/software-factory`, out of the plugin monorepo it
  started in. The repository root is now both the plugin and a marketplace named
  `software-factory`: install with `/plugin marketplace add kwcantrell/software-factory`, then
  `/plugin install factory@software-factory`.
- The build-vs-buy research (report and notes) now lives under `docs/research/`.
- `factory human` now exits 2 (escalated to a human), like every other escalation, instead of 0.

### Added

- `factory-plugin-builder` plugin (`/plugin install factory-plugin-builder@software-factory`): a
  TypeScript CLI run through npx with `new <name>` (scaffold `plugins/<name>/` from the new
  `templates/plugin/` and list it in the marketplace; also `npm run new-plugin -- <name>`),
  `check <name>... | --all` (the "Plugin layout" and "CLI convention" now written down in
  `CLAUDE.md`, rule by rule, with a fix for every finding) and `verify <name>` (check, `claude
  plugin validate`, typecheck and the plugin's tests). Its `build-plugin` skill walks an agent from
  an idea to a passing plugin.
- The `factory` skills name themselves in their frontmatter, and a test runs every skill command
  line through npx, so `factory` passes the convention check.
- MIT license.
- `scripts/check.sh`, one command for every check CI runs, and a `unittest` suite for the CLI and
  the release script under `tests/`.
- GitHub Actions: CI on pull requests and pushes to `main`, and a release workflow for `v*` tags
  that checks the tag against the plugin version and publishes this changelog's notes.
- `CLAUDE.md`, `CONTRIBUTING.md`, pull request and issue templates.

### Fixed

- `factory merge` no longer blames every failed merge on a conflict. Only a merge that leaves
  unmerged paths is reported as "conflicts - the branch needs a rebase"; any other failure (a
  missing git identity, a hook, a lock) escalates with git's own error text as the reason in
  `job.json` and on the dashboard.

## [0.2.0] - 2026-11-14

The first versioned release of the plugin: a multi-agent line that runs work through
intake -> build -> proof -> review -> ship -> done.

### Added

- `bin/factory`, a stdlib-only Python CLI that is the line's state machine and the only writer of
  `job.json`. Gates live in the CLI (exit 1 = refused, 2 = escalated to a human): `start` needs a
  `task.md` with acceptance criteria, `built` needs `build.md` and clean commits, `verdict` needs
  the reviewer's written review, and failed proofs or review rounds past their limits escalate.
- Skills: `/factory:run` (the supervisor), `/factory:dashboard`, and the human-only
  `/factory:approve` (spec gate) and `/factory:ship` (merge gate).
- Agents: `builder` (works in its own git worktree and branch), `verifier`, and the
  `reviewer-security`, `reviewer-standards` and `reviewer-behavior` reviewers.
- A `PreToolUse` hook (`scripts/human-gate.sh`) that turns `factory merge`, `factory approve` and
  `factory rework` into permission prompts.
- `factory rework`, a human-gated way to send an approved job back to build.
- Follow-ups recorded in `job.json` (`factory followup add|list|done|drop`) and shown on the
  dashboard.
- Optional per-project `factory.json` (`reviewers`, `max_review_rounds`, `max_proof_attempts`,
  `spec_gate`, `specs_dir`); unknown keys and bad values are refused.
- A dependency-free live dashboard (`dashboard/index.html`) and `factory stats` line metrics.
- Per-job builder model choice; the verifier runs on Sonnet.

[Unreleased]: https://github.com/kwcantrell/software-factory/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kwcantrell/software-factory/releases/tag/v0.2.0
