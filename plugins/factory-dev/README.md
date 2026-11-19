# factory-dev

The tooling for developing software-factory itself, as opposed to using the factory on another
project. Its TypeScript CLI has two commands: `check` runs every check CI runs, in one command, and
`release` checks a release tag against the repo's version and prints that version's release notes.
CI (`.github/workflows/ci.yml`) and the release workflow (`release.yml`) run the same commands. Its
`factory-dev` skill tells an agent working on the repo to run `check` before finishing any change
and `release <tag>` before tagging.

Install it from the marketplace (it needs Node.js 22.18+):

```text
/plugin install factory-dev --marketplace kwcantrell/software-factory
```

## Running it

The CLI works on the `software-factory` checkout containing the current directory (the nearest
ancestor whose `.claude-plugin/marketplace.json` is named `software-factory`), or on `--repo
<path>`; outside one it exits 2. The skill calls it as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev <command> [args]
```

From a checkout, run it directly (`npm ci` first, for the typecheck's dev tooling):

```sh
node plugins/factory-dev/src/cli.ts check
node plugins/factory-dev/src/cli.ts release v0.3.1
```

CI runs it from the checkout through npx, with no install step for the plugin:
`npx --yes --offline --loglevel=error --package=./plugins/factory-dev -- factory-dev check --require-claude`.

Exit codes: 0 success, 1 a check failed or the release check refused, 2 a usage error or not inside
a software-factory checkout. On a non-zero exit stdout is empty and the reason is on stderr. Every
command takes `--json` (one JSON value on stdout), `--repo <path>`, `--help` and `--version`.

## `check [--require-claude]`

Runs every check CI needs, in order, from the checkout root. Every step runs even after one fails.

| Step | What it runs | Fails when |
| --- | --- | --- |
| `json` | `git ls-files --cached --others --exclude-standard -- '*.json'`, then parses each file | a tracked or untracked-but-not-ignored JSON file does not parse, or the checkout is not a git repo |
| `validate <target>` | `claude plugin validate <target>` for `.` (the marketplace), each plugin the marketplace lists, and `templates/plugin` | `claude` rejects it. Without `claude` on the PATH the step is **skipped** (reported `SKIP`, not passed); with `--require-claude` it fails instead |
| `typecheck` | `npm run typecheck` | `tsc` reports an error |
| `test` | `npm test` | a test fails |
| `release` | `release` below, without a tag | the plugins' versions differ, or the version has no `CHANGELOG.md` section |
| `plugin-convention` | `node plugins/factory-plugin-builder/src/cli.ts check --all` (the checkout's own convention checker) | any plugin breaks the convention, or the checker is missing |
| `docs` | `node plugins/factory-docs/src/cli.ts gate --base <ref>` (the doc map's lint, then the docs this change left stale), with `<ref>` the first of `origin/main` and `main` that resolves with a merge-base; when neither does, `factory-docs lint` alone | the map or a plugin README's command coverage has a problem, a doc is stale, or factory-docs is missing |

Each step's own output streams on stderr, with a `PASS`, `FAIL` or `SKIP` line as it finishes. On
success stdout gets one line per step and `all checks passed` (naming any skipped steps); `--json`
prints `{"ok": true, "steps": [{"name", "command", "status", "exitCode", "reason"?}]}`. On failure
it exits 1, stdout is empty, and stderr ends with `factory-dev: check failed: <step>, <step>`.

```console
$ node plugins/factory-dev/src/cli.ts check
...
PASS  json                             git ls-files -z --cached --others --exclude-standard -- *.json
PASS  validate .                       claude plugin validate .
PASS  validate plugins/factory         claude plugin validate plugins/factory
...
PASS  plugin-convention                node plugins/factory-plugin-builder/src/cli.ts check --all --repo .
PASS  docs                             node plugins/factory-docs/src/cli.ts gate --base main --repo .
all checks passed
```

## `release [<tag>] [--notes-out <file>]`

One changelog, one repo version: every plugin in the marketplace carries the same `version` in its
`.claude-plugin/plugin.json` and its `package.json`. `release`:

1. reads every marketplace entry's `source` (a `./` path inside the checkout) and its
   `plugin.json` `version` (must be `X.Y.Z`);
2. refuses a plugin whose `package.json` `version` differs from its `plugin.json`, naming both
   files, and a marketplace entry that lists a different `version`;
3. refuses versions that differ between plugins;
4. with a `<tag>`, refuses it unless it is `v` + that version;
5. refuses unless `CHANGELOG.md` has a non-empty `## [X.Y.Z]` section; its body, up to the next
   `## ` heading or the `[x.y.z]: <url>` link list, is the release notes.

It prints the notes on stdout, or writes them to `--notes-out <file>` (relative to the current
directory) and prints nothing; `--json` prints `{"version", "tag", "plugins", "notes"}`. A refusal
exits 1 with `factory-dev: release check failed: <why>` on stderr.

```console
$ node plugins/factory-dev/src/cli.ts release v0.3.1
### Upgrading ...

$ node plugins/factory-dev/src/cli.ts release v0.1.0
factory-dev: release check failed: tag 'v0.1.0' does not match plugin.json version 0.3.1 (expected 'v0.3.1')

$ node plugins/factory-dev/src/cli.ts release v0.3.1 --notes-out "$RUNNER_TEMP/notes.md"   # the release workflow
```

Without a tag, `release` checks that the current version is releasable; `check` runs it that way.

## Tests

`test/release.test.ts` has a counterpart for every test of the Python release script it replaced,
plus the all-plugins and `package.json` version checks. `test/check.test.ts` makes each step fail in
a temp-dir fixture checkout (stub `typecheck`, `test`, convention checker and factory-docs, a fake `claude`, and
no `claude` at all) and checks the exit code and the named step. `test/run.test.ts` covers argument
parsing and exit codes, and `test/cli.test.ts` runs every skill command line through npx from a
fresh copy of the plugin. No test writes to the real repo.
