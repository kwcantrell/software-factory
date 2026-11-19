# factory-docs

Keeps the software-factory repository's docs in sync with its code. A checked-in map,
`docs/docs-map.json`, says which code each doc describes (`README.md`, `CLAUDE.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, each plugin's README, and each skill and agent prompt as a doc of
its plugin's CLI). Its TypeScript CLI answers "which docs cover this file" (`which`), "which docs did
this change leave stale" (`stale`), checks the map and each CLI's command coverage (`lint`), and runs
both checks as one gate (`gate`). `factory-dev check` and CI run the gate. Its `factory-docs` skill
tells an agent changing the repo to run `stale`, update the docs it lists, and run `gate` before
finishing.

Install it from the marketplace (it needs Node.js 22.18+ and git):

```text
/plugin install factory-docs --marketplace kwcantrell/software-factory
```

## Running it

The CLI works on the git checkout containing the current directory (its top level), or on `--repo
<path>`; the checkout must have `docs/docs-map.json`, otherwise it exits 2. The skill calls it as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs <command> [args]
```

From a checkout, run it directly: `node plugins/factory-docs/src/cli.ts <command>`.

Exit codes: 0 success, 1 stale docs, lint problems or a command that could not run (a git failure,
an unreadable map), 2 a usage error (including a `--base` that is not a commit) or not inside a git
checkout with a map. On a non-zero exit stdout is empty and the reason is on stderr. Every command
takes `--json` (one JSON value on stdout), `--repo <path>`, `--help` and `--version`.

## The map: `docs/docs-map.json`

```json
{
  "$comment": "optional, ignored",
  "docs": {
    "README.md": ["plugins/factory/src/**", ".claude-plugin/marketplace.json"],
    "CHANGELOG.md": ["plugins/*/src/**", "plugins/*/skills/**"],
    "plugins/factory/skills/run/SKILL.md": ["plugins/factory/src/run.ts"]
  },
  "changelog": "CHANGELOG.md",
  "ignore": [".github/ISSUE_TEMPLATE/*.md", "plugins/factory/test/fixtures/**"],
  "cli_docs": { "factory": "README.md" }
}
```

| Key | Meaning |
| --- | --- |
| `docs` | Required. Each doc (a repo-relative path) and a non-empty list of the globs of the code it describes |
| `changelog` | Optional. The doc for which changed docs also count (see `stale`); must be a key of `docs` |
| `ignore` | Optional. Globs of `*.md` files that are not docs (templates, test fixtures), so `lint` does not ask for them to be mapped |
| `cli_docs` | Optional. Plugin name -> the doc that documents its CLI's commands, for a plugin whose CLI is not documented in `plugins/<name>/README.md` (`factory` is documented in the root `README.md`) |

Any other key is refused (exit 1), as is a doc path that is absolute or has `..`. Globs are
git-style and match whole repo-relative paths: `**/` spans any number of directories (or none), `**`
anything, `*` and `?` stay within one path segment, everything else is literal. When a doc's code
moves, or a new doc or plugin is added, update the map in the same change; `lint` says what is
missing. In this repo each plugin's README covers its `src/**`, `package.json` and
`.claude-plugin/plugin.json`, plus its `hooks/**` when it has hooks (`factory-plugin-advisor`; the
`factory` plugin's hooks are covered by the root `README.md`), and each SKILL.md covers the CLI
code it calls. The `factory` station templates (`plugins/factory/templates/agents/*.md`) are docs
too: each covers `src/agents.ts`, which checks agents against it, and the shipped agent that must
keep its fixed sections. This repo's own station agents (`.claude/agents/factory-*.md`, made with
`/factory:agents`) are docs as well: each covers the station templates it was made from, whose
fixed sections it must keep, and the root `package.json`, whose scripts it names.

## `which <path>...`

Prints, for each path (relative to the current directory; it need not exist), its repo-relative form
and the docs whose globs cover it, in map order. `--json` prints `{"<path>": ["<doc>", ...]}`.

```console
$ node plugins/factory-docs/src/cli.ts which plugins/factory-dev/src/check.ts LICENSE
plugins/factory-dev/src/check.ts: CONTRIBUTING.md, CHANGELOG.md, plugins/factory-dev/README.md, plugins/factory-dev/skills/factory-dev/SKILL.md
LICENSE: (no docs)
```

## `stale [--base <ref>]`

The changed files are those that differ between the working tree (or index) and the merge-base of
`HEAD` with the base, plus untracked files git does not ignore: committed, staged, unstaged and new
files alike. The base is `--base <ref>`, or else the first of `origin/main` and `main` that
resolves; with neither, only the uncommitted changes against `HEAD` count. A `--base` that is not a
commit exits 2.

A doc is **stale** when it did not change but a changed file matches one of its globs. A changed
file that is itself a doc in the map does not count, so a doc-only change never leaves another doc
stale; the one exception is the `changelog` doc, for which skill and agent prompts count like code
(they ship to users). In this repo that makes `CHANGELOG.md` stale whenever any plugin's `src/`,
`skills/`, `agents/`, `hooks/`, `dashboard/` or manifest (`plugin.json`, `package.json`) changed and
`CHANGELOG.md` did not.

Exit 1 lists each stale doc and the files it covers, one line each, on stderr; exit 0 prints how many
files changed against which base. `--json` prints `{"base", "baseRef", "changed": [...], "stale": []}`.

```console
$ node plugins/factory-docs/src/cli.ts stale --base main
factory-docs: 1 doc(s) not updated for the code they cover, against main (merge-base 631b1fc28495):
plugins/factory-dev/README.md: not changed, but it covers changed file(s): plugins/factory-dev/src/check.ts - fix: update plugins/factory-dev/README.md for them (or check it still holds and touch what is now wrong)
```

If a doc really is still right after a change it covers, say so in the change (and fix anything it
gets wrong); do not narrow its globs only to silence `stale`.

## `lint`

Checks, and reports one line per problem as `<file>: <what> - fix: <fix>` (exit 1):

| Rule | Problem |
| --- | --- |
| docs exist | a doc in `docs` is not a tracked (or new, not ignored) file |
| globs match | a glob in `docs` or `ignore` matches no tracked (or new, not ignored) file |
| every `*.md` is mapped | a tracked `*.md` outside `docs/research/` and `factory/` is neither in `docs` nor matched by `ignore` |
| CLI commands documented | for each plugin `.claude-plugin/marketplace.json` lists, `node <its bin> --help` (run from the checkout root) must exit 0 and list its commands under a `Commands:` heading (each indented two spaces), and the plugin's doc (`cli_docs`, else `plugins/<name>/README.md`) must exist and mention every command, as `<bin> <command>` (also `<bin>/src/cli.ts <command>`) or in a code span that starts with the command (`` `check` ``, `` `release <tag>` ``) |
| `cli_docs` | names a plugin the marketplace does not list |

On success it prints the doc count and how many commands were checked; `--json` prints
`{"docs", "clis": {"<plugin>": ["<command>", ...]}, "problems": []}`. Lint runs each plugin's CLI,
so only run it on a checkout you trust.

## `gate [--base <ref>]`

`lint`, then `stale`, with one exit code: 0 when both pass, 1 when either fails (both reports on
stderr, ending with `factory-docs: gate failed`). `--json` prints `{"lint": {...}, "stale": {...}}`.

`factory-dev check` runs it as its `docs` step: `gate --base <ref>` when `origin/main` or `main`
resolves (with a merge-base), `lint` alone otherwise. CI also runs `gate --base origin/<base
branch>` on every pull request, with the full history fetched for the merge-base.

## Tests

`test/glob.test.ts` covers the matcher; `test/docs.test.ts` drives `which`, `stale` (committed,
staged, unstaged and untracked changes, doc-only changes, the changelog rule, base resolution) and
each `lint` rule in temporary git repos; `test/run.test.ts` covers arguments, output and exit codes;
`test/cli.test.ts` runs every skill command line through npx from a fresh copy of the plugin; and
`test/repo.test.ts` checks that this repository's own map passes `lint`. No test writes to the real
repo.

## Versioning

Every plugin in this marketplace carries the same version, the repository's. `CHANGELOG.md` lists what changed in each release. A patch release carries fixes only.
