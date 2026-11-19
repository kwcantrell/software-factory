---
name: upgrade
description: Points to factory-doctor migrate, which replaced factory upgrade. Use only when the user runs /factory:upgrade; for moving a repo between releases, use the factory-doctor skill.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory upgrade --help:*)
---

# Upgrade moved to factory-doctor migrate

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

`factory upgrade` no longer changes anything: it prints that the command moved to
`factory-doctor migrate`, with the command to run, and exits 2. This skill does the same.

1. Tell the user that upgrading (or downgrading) a repo between software-factory versions is now
   `factory-doctor migrate`, run by the **factory-doctor** skill: it shows a dry run first, asks
   before `--apply`, asks again before `--scope user`, and asks separately before it updates the
   plugins.
2. If the factory-doctor skill is available, follow it for the migration. If it is not, tell the
   user to install the plugin themselves, in a terminal (or with `!` in Claude Code), then restart
   Claude Code: `claude plugin install factory-doctor@software-factory`. Do not run `claude`
   yourself.

Its help says where it moved (`factory upgrade` itself exits 2 with the pointer):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory upgrade --help
```
