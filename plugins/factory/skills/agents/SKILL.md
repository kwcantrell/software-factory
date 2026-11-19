---
name: agents
description: Create or refresh this repository's own software factory station agents (builder, verifier, reviewers) from the factory plugin's templates, tailored to the repo's stack, checks and conventions, in .claude/agents/. Use when the user asks to set up, tailor, customize or refresh the factory's agents, or to add a new reviewer lens.
argument-hint: [station ...]
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory agents), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory agents --json), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory agents check:*)
---

# Make this repository's station agents

Stations requested (optional; default: the builder, the verifier and every reviewer in `factory.json`): $ARGUMENTS

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

The factory plugin ships one template per station kind (builder, verifier, reviewer) and a working agent for each station as a fallback. A project agent is `.claude/agents/factory-<station>.md` in the main checkout, where station is `builder`, `verifier` or `reviewer-<name>`; `/factory:run` launches it instead of the shipped `factory:<station>` once it passes `factory agents check`. It is committed with the repo.

Each template has two kinds of sections:

- **Fixed** (between `<!-- fixed:<id> -->` and `<!-- /fixed -->`): the line's non-negotiables - the npx form of the CLI, handoff files only in the absolute job dir (and deleting a stray copy only if it is the station's own), recording its own result and follow-ups, never editing `job.json`, a reviewer's single lens. Never reword, shorten or drop them, and never weaken them elsewhere in the file (a rule that contradicts one is a weakening too). `factory agents check` compares them to the template, ignoring only whitespace and the marker comments; an agent that fails is not used.
- **Fill** (between `<!-- fill:<id> ... -->` and `<!-- /fill -->`, each holding a `TODO:` line): what this repository needs - its stack, how to run its checks, its conventions and, for a reviewer, what the lens looks for here. These are the only sections you write.

Outside both, each template also says what a station does when a remote factory refuses it (a job claimed by someone else, a remote it cannot reach): stop and report. Leave that as written.

## Steps

1. Run `factory agents` to see which stations use a project agent and which the shipped fallback.
2. Read the repository before writing anything: its languages and layout; its test, typecheck, lint and build commands (package scripts, Makefile, CI workflows) and any single check script; the conventions in CLAUDE.md, AGENTS.md and CONTRIBUTING; and, if `factory config` shows a `specs_dir`, the specs kept there. Write down only what you confirmed, with exact commands.
3. For each station wanted, run `factory agents new <station>`. It refuses to overwrite an existing file: to refresh one, read it first, keep what still holds, then run `factory agents new <station> --force` and put that content back into the fill sections. Claude Code asks before `new` runs, since it writes a file.
4. In each new file, replace every `TODO:` line with what this repository needs, following the comment above it. Keep it short and specific: exact commands, file paths, rules with where they are written. Leave everything else as the template wrote it.
5. Run `factory agents check` and fix each problem it names (one line per problem: the file, what is wrong, how to fix it) until it exits 0. Then run `factory agents` again: each station you made should say `project`.
6. Show the user what you made (the stations, and the fill sections you wrote) and ask whether to commit `.claude/agents/`. Commit only after a yes. Tell them Claude Code loads `.claude/agents/` when a session starts, so a new agent is used from their next session; until then `/factory:run` escalates rather than stand in for it.

## A new reviewer lens

A lens is a reviewer the plugin does not ship (say `performance`). Make it from the reviewer template with `factory agents new reviewer-<name>` and fill in its lens section: the one question the lens answers, then what it checks in this repository. A lens only reviews once `factory.json`'s `reviewers` lists it: `new` says so and prints the line to set. Propose that change to the user and make it only after they confirm; it changes every future review round. `factory agents` shows `missing` for a listed reviewer that has no agent that passes the check, and `/factory:run` then escalates the job instead of skipping the lens.
