---
name: upgrade
description: Upgrade a repository from an older Software Factory (the original factory@kwcantrell-plugins plugin, or factory@software-factory 0.2.0 with the Python CLI) to this version - switch the plugin in Claude Code settings, migrate the factory/ runtime dir, and list what the user must do by hand. Use when the user asks to upgrade, migrate or move a repo to the current factory plugin.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory upgrade), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory upgrade --json), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory upgrade --help), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory --help:*)
---

# Upgrade a repo to the current factory

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

`factory upgrade` does the work and decides what is safe; this skill shows its plan and asks before it changes anything. Run it from the repository being upgraded (its git checkout). Without `--apply` it is a dry run and writes nothing.

1. Run `factory upgrade`. Exit 2 means this is not a git checkout: say so and stop. Exit 1 means it refused (a settings or job file that does not parse, a factory command still running): show the reason, say what to fix, and stop.
2. Show the user its output as printed: what it found, the settings and runtime dir changes, and the manual steps. Don't summarize the plan away; it is what they are agreeing to.
3. If it says `nothing to do` and lists no manual steps, tell the user the repo is already current and stop.
4. If there are changes, ask the user whether to apply them. Only after a clear yes, run `factory upgrade --apply`. Claude Code will also ask for permission, since only the dry run is pre-approved. Give the user the backup path it prints.
5. If a manual step says user settings still enable the old plugin, ask separately: this changes `~/.claude/settings.json` (every project on the machine). Only after a yes for that, run `factory upgrade --apply --scope user`.
6. Tell the user to run each `claude plugin ...` command it lists, in a terminal (or with `!` in Claude Code), in the order listed, then `/reload-plugins`. Do not run `claude` yourself.
7. Pass on the remaining manual steps: `factory.json` keys the current CLI refuses, and tracked files that still name the old plugin or CLI (file:line). Offer to make those edits; make them only if the user asks.
8. When the user has run the commands, run `factory upgrade` again. It should say `nothing to do` with no `claude plugin` commands or `/reload-plugins` left. Report what is still listed, if anything.
