---
name: factory-docs
description: Keeps the software-factory repository's docs (README, CLAUDE.md, CONTRIBUTING.md, CHANGELOG.md, plugin READMEs, skill and agent prompts) in sync with its code. Use when changing software-factory itself, before finishing a change, committing or opening a PR, and when asked which docs describe a file.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs which:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs stale:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs lint:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs gate:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs --help:*)
---

# Keep software-factory's docs in sync

The checkout's `docs/docs-map.json` maps each doc to the globs of the code it describes. These
commands only read the checkout. Run them exactly as written, from anywhere inside it (or add
`--repo <path>`), with no install or build step first.

## Before finishing a change

1. List the docs your change left stale (files changed since the merge-base with `origin/main`, or
   `main`, plus staged, unstaged and untracked files):

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs stale
   ```

   Exit 0: nothing is stale. Exit 1: stderr has one line per stale doc, naming the changed files
   it covers.

2. Open each listed doc and update what the change made wrong or incomplete: commands, options,
   exit codes, file names, behaviour. For `CHANGELOG.md`, add an entry under `## [Unreleased]`. If
   a doc truly still holds, tell the user so rather than editing it for nothing; never narrow the
   map's globs just to silence `stale`. If you added a doc, a plugin or moved code, update
   `docs/docs-map.json` too.

3. Run the gate (lint, then stale; exit 0 means docs are in sync):

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs gate
   ```

   Fix every line it prints and run it again. Then run `factory-dev check` (the `factory-dev`
   skill), which runs this gate along with every other CI check.

## Which docs describe a file

Before changing a file, read the docs that describe it (paths relative to the current directory;
several may be given):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs which <path>
```

To check the map alone (docs exist, globs match, every markdown file is mapped or ignored, and each
plugin's README mentions every command its CLI's `--help` lists):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs lint
```

Exit codes: 0 success, 1 stale docs or lint problems (or the command could not run), 2 a usage
error or not inside a git checkout with `docs/docs-map.json`; the reason is on stderr. Add `--json`
for machine-readable output. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs --help
```
