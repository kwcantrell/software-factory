---
name: ship
description: Human merge gate for the software factory. Shows an approved job's ship summary and merges or rejects it.
argument-hint: <job id> [reject <reason>]
disable-model-invocation: true
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory path:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory followup list:*)
---

# Ship a factory job

Arguments: $ARGUMENTS

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

The user invoked this themselves; it is the factory's human gate. If no job id was given, run `factory status`, list the jobs in stage `ship`, and ask which one.

If the arguments say `reject`, run `factory close <id> <reason>` and report that the branch was kept. Otherwise:

1. Run `factory status <id>`. If the job is not in stage `ship`, say where it is and stop.
2. Show the user what they are approving, briefly: the summary and risks from `ship.md` in the job dir, and `git -C <worktree> diff --stat <base>...HEAD`. Point out anything `ship.md` flags for a manual look, and the open follow-ups (`factory followup list <id>`); they stay open after the merge. Do not pad it.
3. Run `factory merge <id>`. Claude Code will ask the user to confirm this command; that prompt is the gate, so do not try to avoid it.
4. Report the result (`factory merge --help` lists its options). If the merge was refused (dirty checkout, wrong branch) relay the reason and what to do. If it conflicted, the job is flagged needs-human and nothing was merged; offer to send it back through `/factory:run <id>` after a `factory resume <id>` so a builder can rebase.

This merges locally into the branch the job was cut from. If the user would rather open a pull request, push `factory/<id>` and open one with `gh pr create` using `ship.md` as the body, and leave the job in `ship` until the PR merges; then `factory close <id> merged via PR`.
