---
name: approve
description: Human spec gate for the software factory. Approves a job's task.md so it can be built, or sends it back with changes.
argument-hint: <job id> [changes <what to change>]
disable-model-invocation: true
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory path:*)
---

# Approve a factory job's spec

Arguments: $ARGUMENTS

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

The user invoked this themselves; it is the factory's spec gate. If no job id was given, run `factory status`, list the jobs in stage `intake` that are waiting for spec approval, and ask which one.

If the arguments ask for changes: revise `task.md` in the job dir (`factory path <id>`) as asked, keeping the acceptance criteria checkable, then summarize what changed in a few lines and leave the job waiting. Do not approve in the same turn; the user approves the revised version with another `/factory:approve <id>`.

Otherwise:

1. Run `factory status <id>`. If the job is not waiting for spec approval, say where it is and stop.
2. Show the user the goal, the acceptance criteria and the out-of-scope list from `task.md`, verbatim and without commentary. These are what they are approving.
3. Run `factory approve <id>`. Claude Code will ask the user to confirm this command (the hook asks the same for merge, rework, claim and close); that prompt is the gate, so do not try to avoid it. In a remote factory any person may approve, whoever claimed the job.
4. Tell the user it is approved and that `/factory:run <id>` continues the job (`factory agents` shows the builder, verifier and reviewers it will launch). Do not start building from this skill.
