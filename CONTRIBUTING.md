# Contributing

Thanks for helping improve Software Factory. This guide covers setting up a checkout, running the
checks, how changes are proposed, and how releases are cut. `CLAUDE.md` lists the code conventions;
read it too.

## Dev setup

You need git, Node.js 22.18+ with npm, and the Claude Code CLI. There is no Python or shell in the
repository: the dev tooling is the `factory-dev` plugin's TypeScript CLI.

```sh
git clone https://github.com/kwcantrell/software-factory
cd software-factory
npm ci                                     # dev tooling: typescript and @types/node, pinned exactly
npm install -g @anthropic-ai/claude-code   # provides `claude plugin validate`
```

The plugin itself has no dependencies and no build step: Node runs `plugins/factory/src/*.ts`
directly (type stripping), so code there uses erasable TypeScript only (no `enum`, `namespace` or
parameter properties) and imports with the `.ts` extension. The root `package.json` is dev tooling
only; plugins never import from it.

Load your checkout into Claude Code in one of two ways:

- **For one session, no install:** `claude --plugin-dir /path/to/software-factory/plugins/factory`.
  Edits to skills, agents and `plugins/factory/src` are picked up the next time you start a
  session.
- **As a marketplace, like users do:** in Claude Code run
  `/plugin marketplace add /path/to/software-factory`, then `/plugin install factory@software-factory`.
  From a shell: `claude plugin marketplace add /path/to/software-factory` and
  `claude plugin install factory@software-factory`. After changes, run
  `claude plugin marketplace update software-factory` (and `claude plugin update factory@software-factory`
  when the version changed) to refresh the installed copy.

To try the line on a scratch project, make a git repo with one commit and run `/factory:run` in it.
The CLI keeps its runtime state in that repo's `factory/` directory.

## Running the checks

One command runs everything CI runs, from anywhere in the checkout:

```sh
node plugins/factory-dev/src/cli.ts check
```

(With the `factory-dev` plugin installed, its skill runs the same command through npx.) It parses
every tracked or untracked-but-not-ignored JSON file, validates the marketplace, every plugin and
the template (`claude plugin validate`), typechecks (`npm run typecheck`), runs the tests
(`npm test`), checks that every plugin has the same version and that it has a `CHANGELOG.md`
section (`factory-dev release`), and checks every plugin against the convention
(`factory-plugin-builder check --all`). Every step runs; it exits 1 and lists the failed steps if
any fails. Without `claude` on the PATH the validate steps are reported as skipped, not passed; CI
runs it with `--require-claude`, which fails them instead. See
[plugins/factory-dev/README.md](plugins/factory-dev/README.md).

The tests alone:

```sh
npm test                                                   # every plugin's node:test suites
node --test plugins/factory/test/cli.test.ts               # one file
```

`plugins/factory/test/` drives the real CLI as a subprocess (`node src/cli.ts`, and through `npx`
from a fresh copy of the plugin) against temporary git repos with `FACTORY_DIR` pointing into them,
so it never touches your own `factory/` directory. A change to the CLI's behaviour needs a test
there. Tests use `node:test` only. `test/fixtures/` holds job records written by the original
CLI; `compat.test.ts` keeps the format compatible with them.

## Branches and commits

- Branch from `main`; name branches `<type>/<short-description>`, e.g. `fix/merge-gate-quoting`,
  `feat/reviewer-performance`, `docs/contributing`. (Jobs built by the factory itself use
  `factory/<job id>`.)
- Write commit subjects in the imperative mood, at most about 72 characters, describing the change
  (e.g. `Refuse built when build.md is empty`). Use the body to explain why when it is not obvious.
- Keep commits focused; unrelated changes go in separate commits or PRs.

## Pull requests

Every PR should:

- **Be green**: `factory-dev check` passes locally, and the CI workflow passes on the PR.
- **Have a changelog entry** under `## [Unreleased]` in `CHANGELOG.md` for any user-visible change
  (behaviour of the CLI, skills, agents, hooks, dashboard or config), in the right Keep a Changelog
  group (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). Internal-only changes
  (tests, CI, refactors with no visible effect) may skip it.
- **Say what kind of version bump it implies** (the PR template asks), following
  [semver](https://semver.org/):
  - **major**: breaks existing users, e.g. renaming or removing a CLI command, skill or agent,
    changing `job.json` or `factory.json` incompatibly, or changing an exit-code contract.
  - **minor**: new capability that is backwards compatible, e.g. a new command, config key or
    reviewer.
  - **patch**: bug fixes and wording changes to prompts that do not change the contract.
  PRs do not bump `version` themselves; the release does.
- Follow the conventions in `CLAUDE.md` (TypeScript run via npx with no runtime dependencies, gates
  in the CLI, human-only commands in the hook's `plugins/factory/src/gate.ts`, new `job.json` fields
  handled by the dashboard, new `factory.json` keys in `DEFAULTS` and validation).

## Releasing

Releases are cut by the maintainer from `main`:

1. Pick the next version from the `Unreleased` entries (see the bump rules above).
2. Set `"version"` to it in **every** plugin's `.claude-plugin/plugin.json` and `package.json`
   (`plugins/*/`; and in a marketplace entry, if one carries a version). There is one changelog and
   one repo version, so all plugins move together.
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add a fresh empty
   `## [Unreleased]` above it, and update the compare links at the bottom.
4. Check it: `node plugins/factory-dev/src/cli.ts check` and
   `node plugins/factory-dev/src/cli.ts release vX.Y.Z` (prints the release notes).
5. Commit (`Release vX.Y.Z`), merge to `main`, then tag and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

The `Release` workflow (`.github/workflows/release.yml`) then refuses the tag (`factory-dev
release`) if it does not equal `v` + every plugin's version, runs the same checks as CI, and creates
the GitHub release with that version's `CHANGELOG.md` section as its notes. Users get it with
`/plugin marketplace update` or `claude plugin update factory@software-factory`.

## Recommended repository settings (maintainer)

These live in GitHub settings, not in the repo:

- **Branch protection on `main`** (Settings -> Branches, or a ruleset): require a pull request
  before merging, require the `factory-dev check` status check (the CI workflow's job) to pass and the branch to be up
  to date, block force pushes and deletions.
- **Tag protection** for `v*` (a ruleset on tags) so only maintainers can create release tags.
- **Actions** (Settings -> Actions -> General): allow GitHub-authored actions; leave the default
  `GITHUB_TOKEN` permission read-only (the release job asks for `contents: write` itself).
- Enable Dependabot alerts and private vulnerability reporting.

## Reporting bugs and requesting features

Use the issue templates (bug report, feature request). For a bug, include the plugin version
(`claude plugin list` shows it), the command you ran, its exit code and output, and
`factory status <job>` if a job is involved.
