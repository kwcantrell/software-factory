# Changelog

All notable changes to the Software Factory plugin are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the plugin follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Remote factory: signed state commits, verified at the merge gate. Every state commit the CLI makes
  in remote mode is signed with the person's own SSH key (`git commit -S` with `gpg.format ssh` and
  `user.signingkey`); a command that would change state refuses before changing anything, naming
  the git settings to set, when signing is not set up. `factory merge` walks the state branch
  history of the job's directory and refuses (naming the commit and why) unless every commit is
  signed by a key in the allowed-signers file named by the new `remote.allowed_signers` key, read
  as committed at HEAD of the project checkout, never from the state branch; it also refuses a
  `job.json` edited in the state checkout but not committed. Without `allowed_signers` merge
  refuses and says how to set it up; the new `remote.unsigned_ok: true` turns signing and the check
  off, which the README warns against. SSH signing only: merge refuses a state commit with an
  OpenPGP or X.509 signature, and state commits replayed after a lost push race are re-signed.
- factory-plugin-advisor: opt-in team sharing. With `factory.json` `"advisor": {"share": true}` and a
  remote factory, `record` and the hook also append each occurrence (already redacted and masked) to
  `advisor/occurrences.jsonl` on the state branch, and the issue state moves to
  `advisor/state.json` there, so one person's dismiss applies to the team. `list`, `show` and
  `suggest` read local and shared occurrences together, counting each once, and group one issue
  across people. Shared occurrences carry no identity unless the user sets
  `FACTORY_PLUGIN_ADVISOR_SHARE_AS`; commits use a fixed author. Writes pull, append, commit and push
  with retry on a race; offline, occurrences queue locally and the hook stays silent. `record` and
  `suggest` warn once per session when the remote is or may be public. Local is still the default.
  The `factory` CLI validates the new `advisor` key and accepts the `advisor/` directory on the state
  branch.
- Remote factory: an optional `remote` key in `factory.json`, `{"url": "<git url or path>",
  "branch": "<name>"}`, shares the job state through a git branch (a separate repo or an orphan
  branch of the project repo) so a team runs one line and the history survives. `factory/jobs/`
  becomes a checkout of that branch; worktrees stay local and are never stored. `factory init`
  creates the branch (an orphan) or clones it. Every state-changing command pulls first, commits
  only its job's directory as `factory: <command> <job id>` and pushes, retrying a lost push race;
  the same job changed on both sides is refused, never merged, and two people creating jobs at once
  get distinct ids. With no network a state-changing command refuses and changes nothing; read
  commands (`status`, `followup list`, `stats`, `path`, `config`, `dashboard`) take `--offline` and
  fall back to the last-pulled state. `start` records the job's `owner` (shown on the dashboard and
  by `factory status <id>`); commands on a job someone else owns are refused except `approve`,
  `merge`, `rework` and `close`, and the new human-gated `factory claim <id> --take-over` moves the
  claim, recreating the worktree from the code remote. `factory remote status` and `factory remote
  push` (publish an existing local factory) round it off. Without `remote`, nothing changes. Station
  agents now say to stop and report when a remote factory refuses them, and never to run `claim`.
  The state branch is not trusted blindly: symbolic links and submodules on it are refused, and a
  `job.json` whose `id`, `branch` or `base` is not what the CLI writes is refused. The dashboard escapes
  every `job.json` value it shows and is served with a Content-Security-Policy that lets it load and
  send nothing beyond its own server (so images linked from job markdown to other sites no longer
  load).
- `factory-plugin-advisor` watches a repository's factory station agents. `stations [--repo
  <path>] [--json]` reads the line's history (`factory/jobs/*/job.json`, `proof.md` and the review
  files, old job.json files included) and reports, per station as `factory agents` resolves it
  (project agent or shipped fallback): jobs handled, first-pass proof rate and proof failures, each
  reviewer's approve and changes counts and how often its changes were followed by a rework it
  approved, escalations and follow-ups. `stations suggest [--min <n>]` applies four documented,
  deterministic rules (a theme no configured reviewer covers, the same proof failure reason, a
  reviewer whose lens others keep catching or repeating, proofs that behavior then sends back for an
  unmet criterion) and writes a redacted, masked draft per suggestion to the advisor's log dir: a
  complete agent from the factory's template, or a unified diff against the current agent, plus a
  paste-ready `/factory:run` line. Every drafted agent passes `factory agents check`. `stations
  apply <id>` is a dry run; with `--confirm` it writes only `.claude/agents/factory-*.md` (and, for
  a new reviewer, `factory.json` `reviewers`), backs up what it overwrites outside `factory/`, runs
  `factory agents check` and rolls back on failure, refuses a stale, applied or dismissed draft, and
  never commits. `stations dismiss <id>` drops a suggestion. The skill runs `stations` and
  `stations suggest` (the only pre-approved ones) after a job ships or when asked how the line is
  doing, and applies a draft only after a yes for that draft. These suggestions are never filed on
  GitHub.

### Changed

- `factory config` prints the new `remote` key (`null` by default), and the dashboard server no
  longer serves anything under a `.git` directory.
- `factory close` is a human gate: the `PreToolUse` hook makes it a permission prompt like `merge`,
  `approve`, `rework` and `claim`, and `factory agents check` fails a station agent that
  pre-approves or runs it. `/factory:ship <id> reject` still closes the job, after the person
  confirms the prompt.

### Fixed

- One `job.json` that is not valid JSON or not the shape the CLI writes (say, pushed to a remote
  factory's state branch) no longer makes `status`, `stats` and `followup list` fail for every job:
  they skip it with one stderr warning naming its directory and why, and exit 0; the dashboard
  skips it too, warning once in the browser console. A command that acts on that job by id refuses
  it with the reason instead of crashing.
- factory-plugin-advisor: with sharing on, an occurrence could be lost when two `record` or hook
  processes of the same user ran at once for the first time: both set up the bare clone in the config
  dir, one failed (`could not lock config file`) before writing the occurrence to the queue, and it
  never reached the shared log. The occurrence is now queued before any git runs, and every git step
  on the clone runs under a lock file; a process that cannot take it within 5 seconds leaves its
  occurrence queued for the next command and exits 0 silently.

## [0.4.0] - 2026-11-19

Station agents tailored to your repository are new in this release: run `/factory:agents` to
make them. The shipped agents stay the fallback for any station without one.

### Added

- Station agents a project owns. The `factory` plugin ships a template per station kind in
  `templates/agents/` (`builder.md`, `verifier.md`, and `reviewer.md` for any lens), with the line's
  non-negotiables marked as fixed sections and the project-specific ones (stack, checks,
  conventions, the lens) to fill in. `factory agents new <station> [--force]` writes one to
  `.claude/agents/factory-<station>.md`; `factory agents check [--json]` validates every
  `.claude/agents/factory-*.md` (name, fixed sections, the npx form, recording its own result, no
  pre-approved `merge`, `approve` or `rework`) with one line per problem; and `factory agents
  [--json]` prints, per station, the agent `/factory:run` launches: the project's own when it
  passes `check`, else the shipped `factory:<station>`, or `missing` for a configured reviewer with
  neither. `/factory:run` now takes each station's agent from `factory agents` and gives every
  station the factory plugin root, and the new `/factory:agents` skill walks Claude through
  making a repository's agents. With no project agents the line runs on the shipped agents as
  before; each of them now also says never to edit `job.json`, the one fixed section they lacked.
  A lens agent kept under the old name `.claude/agents/reviewer-<name>.md` is no longer launched:
  `factory agents` shows the reviewer as `missing` and names the file to move.
- `factory-plugin-advisor` treats `agents`, the new `factory` subcommand, as a word it writes
  itself, so it is not masked for a user named `agents`.

### Fixed

- `factory-plugin-advisor` no longer masks the current username as a word when it is one of
  `factory followup`'s subcommands (`add`, `list`, `done`, `drop`, in any case), so "factory
  followup list printed nothing" is stored unchanged for a user named `list`. Home paths, emails
  and mentions are still masked for such a user.
- `factory built`, `factory proof` and `factory verdict` refuse (exit 1) while an untracked copy of
  their own handoff file (`build.md`, `proof.md`, `review-<round>-<reviewer>.md`) sits at the root
  of the main checkout or of the job's worktree, and name the stray file to move or delete, so a
  station's stray copy can no longer be swept into a commit by `git add -A`. The refusal says
  whether the stray file is byte-identical to the job dir's copy. A tracked file of the same name
  is ignored. The builder, verifier and reviewer prompts now say to write handoff files only to the
  absolute job dir, and on that refusal to delete the stray copy and retry only if they wrote it in
  this job (it matches their own copy in the job dir); otherwise they stop and report it.

## [0.3.0] - 2026-11-19

### Upgrading

0.3.0 is a minor bump that carries breaking changes, as semver allows before 1.0:

- The `factory` CLI is now TypeScript and needs Node.js 22.18+. Python is no longer used.
- `factory human` now exits 2 (escalated to a human) instead of 0.
- The plugin now lives in `plugins/factory/`, next to the other plugins in this marketplace.
- A repository on the old version (the original `factory@kwcantrell-plugins` plugin, or
  `factory@software-factory` 0.2.0 with the Python CLI) can run `/factory:upgrade` to move over.

### Added

- The `factory-plugin-discover` plugin makes Claude use the right plugin for software-factory work.
  Its skill (and a `UserPromptSubmit` hook that hints once per session when the prompt or the
  working directory is about software-factory) has Claude run `match` with a one-line task summary
  first. `catalog` lists the installed plugins (project and local scope respected, disabled ones
  marked), their skills, the user's own skills, and the software-factory marketplace plugins that
  are not installed, all read from Claude Code's own records. `match` ranks them deterministically
  (software-factory terms and name terms count double, adjacent phrases add a bonus, threshold 3),
  and when nothing fits gives the `factory-plugin-advisor` commands that record the gap. A fitting
  plugin that is not installed is handled by the mode (`settings set mode ask|notify|auto-install|off`):
  `install` runs `claude plugin install <name>@software-factory` only in `auto-install` mode or
  with `--confirmed` after the user says yes.
- The `factory-plugin-advisor` plugin makes the software-factory plugins improve from use. Its skill
  has Claude `record` each friction with one of them (a workaround, a step done by hand, missing or
  wrong guidance, a user correction), and an async `PostToolUseFailure` hook records every failed
  run of a marketplace plugin's CLI (through the npx prefix or `node .../src/cli.ts`, also from the
  plugin cache), except `factory`'s exit 2, an escalation to a human. Occurrences are redacted
  (credentials, secret-looking keys and flags, JWTs, URL credentials, private keys, provider
  tokens, long random strings), capped, and kept in an owner-only log in the user's config dir,
  never inside a git checkout. `list` and `show` group them by a signature that ignores URLs,
  paths, numbers, ids and factory job ids; `suggest` writes a draft fix (target plugin, evidence,
  proposed change and a `/factory:run` request) once an issue is seen 3 times; `dismiss` silences
  one; `file` shows the GitHub issue it would open on `kwcantrell/software-factory` (public) and
  files it with `gh` only with `--confirm`, once, after re-checking it for secrets.
- The `factory-docs` plugin keeps this repository's docs in sync with its code. A checked-in map,
  `docs/docs-map.json`, declares the code each doc describes (the root README, `CLAUDE.md`,
  `CONTRIBUTING.md`, `CHANGELOG.md`, each plugin's README, and each skill and agent prompt).
  `factory-docs which <path>` names the docs covering a file, `stale` lists the docs a change left
  unchanged although code they cover changed (exit 1), `lint` checks the map and that each plugin's
  README mentions every command its CLI lists, and `gate` runs both. `factory-dev check` runs the
  gate as its `docs` step, CI runs it on every pull request against the base branch, and the
  `factory-docs` skill tells agents changing the repo to run it before finishing.
- `factory-plugin-builder new` (and `npm run new-plugin`) starts a new plugin at the version the
  marketplace's plugins share, so it passes `factory-dev check` without hand edits.

- `factory upgrade` and the `/factory:upgrade` skill move a repository from an older factory (the
  original `factory@kwcantrell-plugins` plugin, or `factory@software-factory` 0.2.0 with the
  Python CLI) to this version: Claude Code settings switch to `factory@software-factory` (user
  settings only with `--scope user`), the `factory/` dir gets the job fields, dashboard and
  `.gitignore` the current CLI writes (originals backed up first), and what it cannot change
  safely is listed as manual steps, including the `claude plugin` commands to run. It is a dry run
  unless `--apply` is given, and the skill asks before applying.

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
- `factory-dev` plugin (`/plugin install factory-dev@software-factory`), the tooling for developing
  software-factory itself, as a TypeScript CLI run through npx: `check` runs every check CI runs in
  one command (JSON parse, `claude plugin validate`, typecheck, tests, the release check and
  `factory-plugin-builder check --all`) and lists the failed steps; `release [<tag>] [--notes-out
  <file>]` checks that every plugin has the same version in `plugin.json` and `package.json`, that
  the tag is `v` + that version and that `CHANGELOG.md` has its section, and prints the notes. Its
  `factory-dev` skill tells agents to run `check` before finishing a change and `release <tag>`
  before tagging. It replaces the Python and shell dev scripts (`scripts/check.sh`,
  `scripts/release.py` and its `tests/`): the repository has no Python or shell left, and CI and
  the release workflow run `factory-dev`.
- GitHub Actions: CI on pull requests and pushes to `main`, and a release workflow for `v*` tags
  that checks the tag against the plugin version and publishes this changelog's notes.
- `CLAUDE.md`, `CONTRIBUTING.md`, pull request and issue templates.

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

### Fixed

- `factory merge` no longer blames every failed merge on a conflict. Only a merge that leaves
  unmerged paths is reported as "conflicts - the branch needs a rebase"; any other failure (a
  missing git identity, a hook, a lock) escalates with git's own error text as the reason in
  `job.json` and on the dashboard.
- `factory-plugin-advisor` no longer masks the current username as a word when it is also a word
  the advisor writes itself: a marketplace plugin or CLI bin name (such as `factory` or
  `factory-dev`) or a `factory` subcommand (such as `proof` or `merge`), compared ignoring case.
  For a user named `factory`, `factory proof exited 1` used to be stored as `[user] proof exited 1`,
  with a different signature than on any other machine. Home paths, `$HOME`, emails and mentions
  are still masked, and `file` still refuses a draft that holds one. Only the CLI itself reads the
  OS user now; the library functions default to no identity.

### Security

- `factory-plugin-advisor` masks personal details before it stores anything, because its drafts
  are filed on a public repo: the home part of a path (`/home/<user>`, `/Users/<user>`, `/root`,
  `C:\Users\<user>`, and the current `$HOME`) becomes `~`, the current username `[user]` (as a
  whole word, unless shorter than 3 characters or a common word such as `runner`), emails
  `[email]`, and GitHub `@mentions`, which would notify that user, `@[user]`. This covers `record`
  (flags and `--stdin`) and the hook's error line. Drafts mask their quoted text again, so logs
  written before this change give clean drafts, and `file` refuses (exit 1, naming the line) a
  draft that still holds a home-dir path, an email or a linkable mention.

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

[Unreleased]: https://github.com/kwcantrell/software-factory/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/kwcantrell/software-factory/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kwcantrell/software-factory/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kwcantrell/software-factory/releases/tag/v0.2.0
