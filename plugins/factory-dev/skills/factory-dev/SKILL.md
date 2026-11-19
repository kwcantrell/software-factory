---
name: factory-dev
description: Runs the software-factory repository's own dev checks - every CI gate in one command, and the release tag/version check. Use when developing software-factory itself (changing its plugins, template, docs, manifests or workflows): before finishing any change, and before tagging a release.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev check:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev release:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev --help:*)
---

# Developing software-factory

This plugin is for working on the software-factory checkout itself, not for using the factory on
another project. Run its commands exactly as written, from anywhere inside the checkout (or add
`--repo <path>`), with no install or build step first. Run `npm ci` in the checkout once, so the
typecheck has its dev tooling. These commands only read the checkout and run its checks.

**Before finishing any change**, run every check CI runs:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev check
```

It runs, in order and all of them: every JSON file parses, `claude plugin validate` on the
marketplace, each plugin and the template, `npm run typecheck`, `npm test`, the release check
(below, without a tag) and `factory-plugin-builder check --all`. Each step's output streams on
stderr, then one `PASS`, `FAIL` or `SKIP` line per step. Exit 0 means green. Exit 1 ends with
`factory-dev: check failed: <steps>`: fix those steps and run it again; do not call the change done
while it fails. `SKIP` appears only when `claude` is not on the PATH: tell the user those steps did
not run (CI adds `--require-claude`, which fails them instead).

**Before tagging a release**, after setting the new version in every plugin's
`.claude-plugin/plugin.json` and `package.json` and moving the `Unreleased` entries in
`CHANGELOG.md` under `## [<version>]`, check the tag:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev release <tag>
```

`<tag>` is `v` + the version, e.g. `v0.3.0`. Exit 0 prints that version's release notes. Exit 1
says why the tag would be refused (a version that differs between plugins or between a plugin's
`plugin.json` and `package.json`, a tag that is not `v<version>`, or no `CHANGELOG.md` section):
fix it before tagging. The release workflow runs the same check on the pushed tag.

Exit codes: 0 success, 1 a check failed or the release check refused, 2 a usage error or not inside
a software-factory checkout; the reason is on stderr. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev --help
```
