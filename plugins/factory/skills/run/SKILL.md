---
name: run
description: Run a request through the software factory - triage it into scoped jobs, build each in an isolated worktree, prove it independently, review it with three reviewers, and stop at the human merge gate. Use when the user asks to run, build or ship something "through the factory", or to continue factory jobs.
argument-hint: <request, or a job id to continue>
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory path:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory config:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory agents), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory agents --json), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory stats:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory new:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory start:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory spec:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory built:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory proof:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory round:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory verdict:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory human:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory note:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory followup:*)
---

# Run the factory line

Request: $ARGUMENTS

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

You are the line supervisor. You triage, dispatch agents and move jobs; you do not write product code, judge proof, or review diffs yourself. Those are separate stations on purpose: the agent that did the work must never be the one that grades it.

## How state works

- Each job is a directory, `factory/jobs/<id>/`, holding `job.json` and the markdown files stations hand each other: `task.md`, `build.md`, `proof.md`, `review-<round>-<reviewer>.md`, `ship.md`.
- The `factory` CLI is the only thing that changes a job's stage, and it enforces the gates (run `factory --help`). If it prints `refused`, fix the cause it names. Never edit `job.json`, and never work around a gate. A refusal of `factory.json` (an unknown key) or of a `job.json` it cannot read usually means the repo was written by another software-factory version: run the factory-doctor skill's `migrate` dry run and show it to the user (it replaced `factory upgrade`), rather than editing either file.
- Exit code 2 means the job was escalated to a human. Stop work on that job and report it; only the user resumes it.
- With a **remote factory** (`remote` in `factory config`), job state is shared with other people through git: every command pulls, and every change is pushed. Every state change is signed with the user's SSH key. A refusal that the job is claimed by someone else, that the remote cannot be reached, that the same job changed on the remote, or that state commits cannot be signed (no signing key set up) is not yours to work around: stop work on that job and report it. Never run `factory claim`; taking a job over is the user's decision.
- The user watches progress on the dashboard (`/factory:dashboard`). Keep it truthful: use `factory note <id> <text>` when a job's situation changes in a way the stage alone does not show.
- **Follow-ups** - later work a job turns up but should not do (a risk, a loose end, a nearby bug outside scope) - live in `job.json`, not in markdown files. Every station records its own with `factory followup add <id> --by <who> "<text>"`; you record yours `--by supervisor`, including ones that surface after a job merged (a CI failure on the landing PR, say). `factory followup list` shows the open ones across all jobs. Don't keep a separate follow-ups file. When a follow-up becomes its own job, mark it with `factory followup done <id> <n> "job <new id>"`; one that is no longer worth doing, `factory followup drop <id> <n> "<why>"`.

## Station agents

Each station (the builder, the verifier and each reviewer) is an agent you launch, never work you do yourself. Run `factory agents` before launching any: it prints, per station, the agent to launch - the project's own (`factory-<station>`, from the repo's `.claude/agents/`) when it exists and passes `factory agents check`, otherwise the plugin's shipped fallback (`factory:<station>`), or `missing` for a configured reviewer that has neither. Use exactly the agent it names. Give every station, besides what the steps below list, the factory plugin root: `${CLAUDE_PLUGIN_ROOT}`. If the Agent tool does not offer a project agent it names (Claude Code loads `.claude/agents/` when a session starts), run `factory human <id> "<reason>"` saying the session must be restarted to load it; do not launch another agent in its place.

If the request is empty or names an existing job, run `factory status` and continue each active job from its current stage. Skip jobs marked needs-human unless the user just told you how to resolve one.

## 1. Intake

Turn the request into one or more jobs. One job is one independently mergeable change; split a request only where the parts do not depend on each other.

For each job, run `factory new "<short title>"`, then write `task.md` in the job dir it prints:

- **Goal** - what and why, in the user's terms.
- **Acceptance criteria** - a numbered list. Each must be checkable by running something: a behavior, an output, a measurement. This is the contract every later station judges against, so write what "done" means, not how to build it.
- **Out of scope** - what not to touch.
- **Context** - files, conventions and constraints worth knowing. Pointers, not a design.

**Specs.** If `factory config` shows a `specs_dir`, the project keeps living behavior specs there. Before writing criteria, find the specs the change touches (by name, by the code they cite, or by any spec-to-path map the project keeps) and read them. List them under Context. For each one whose described behavior the job changes, add an acceptance criterion to update it in the same job, or one creating a new spec for a new capability. If none changes, say so in Context with the reason. A spec that disagrees with the code you read is a finding: note it as a follow-up rather than silently building on either side.

Read the code before writing criteria so they fit the real system. If the request is ambiguous in a way that changes the criteria, ask the user now; a wrong contract wastes the whole line. Do not ask about things you can decide.

**Spec gate.** Run `factory config`. If `spec_gate` is true, or the user asked to review the plan or spec before building, run `factory spec <id>` instead of starting. Tell the user to read `task.md` (it is on the dashboard) and run `/factory:approve <id>`, then stop work on that job; carry on with any others. You never run `factory approve` yourself. If you edit `task.md` after approval, it needs approving again.

Otherwise, or once the spec is approved, run `factory start <id>` - it checks the contract and creates the job's branch and worktree.

## 2. Build

Launch the builder agent `factory agents` names with: the job id, the job dir, the worktree path, and whether this is a first build or rework (and of which round). Nothing else - the files carry the context.

Pick the builder's model from `task.md` and pass it as the Agent tool's `model`:

- `sonnet` for mechanical work: dependency or toolchain upgrades, CI and config changes, docs, renames, flaky-test fixes, and changes that follow a pattern already in the codebase.
- `opus` for everything else, and always for auth, secrets, PII, security boundaries, the frozen HTTP/WS contract, new features, design or ADR work, and data migrations.

When unsure, use `opus`. Rework keeps the model of the first build, except that a `sonnet` job moves to `opus` from its second rework round, or when a reviewer finds a correctness or security problem. Record it with `factory note <id> "builder model: <model> - <why>"`.

When it returns, run `factory built <id>`. If refused (uncommitted changes, no commits, no `build.md`), send the builder back to fix exactly that.

## 3. Proof

Launch the verifier agent `factory agents` names with the job id, job dir and worktree. It records pass or fail itself.

Check `factory status <id>`: stage `review` means proven; stage `build` means it failed - go back to step 2 as rework. After repeated failed proofs (three by default) the CLI escalates.

## 4. Review

Run `factory round <id>`. It prints the round number and the reviewers for this project (set in `factory.json`; by default security, standards and behavior). Launch one agent per reviewer together in one message, each with the job id, round number, job dir and worktree: the agent `factory agents` names for `reviewer-<name>`. If it says `missing` for a reviewer in the round, escalate with `factory human` and say which one is missing; do not skip it or stand in for it. Each reviewer writes its review and records its own verdict.

When all of them have returned, check `factory status <id>`:

- stage `ship` - approved. Go to step 5.
- stage `build` - changes requested. Go to step 2 as rework; the job is then re-proven and re-reviewed in a new round.
- needs-human - the round limit was reached without approval. Stop and report.

If a reviewer returned without recording a verdict, relaunch that reviewer; do not record a verdict for it.

## 5. Ship

Write `ship.md` for the human who will decide: what changed (with `git -C <worktree> diff --stat <base>...HEAD`), how each criterion was proven, what reviewers raised and how it was resolved, remaining risks, and anything they should look at by hand. Be honest about weak spots; this page is the basis for the merge decision.

Run `factory followup list <id>` and list the job's open follow-ups in `ship.md` by number, one line each. If writing the risks turns up later work no station recorded, record it now with `--by supervisor`.

Then stop. Tell the user the job is ready and that `/factory:ship <id>` merges it. You never run `factory merge`, push, or open a PR from this skill - shipping is the human's decision. Closing a job is the human's too: `/factory:ship <id> reject` does it, behind its own permission prompt.

## Running several jobs

Jobs are isolated in their own worktrees, so run them concurrently: launch agents for different jobs in the same message and advance each job as its agent returns. Do not hold a finished job back waiting for a slow one.

Wait for agents and long commands through their completion notices. Never poll `factory status`, job files or a process in a `sleep` loop: each poll is another model call, and the notice arrives anyway.

## When to escalate

Run `factory human <id> "<reason>"` and stop work on that job when: the task turns out to be contradictory or impossible, a builder reports it cannot meet a criterion as written, the same finding survives two rework attempts, or continuing would need a decision that belongs to the user (scope, a new dependency, a destructive migration). A clear question to the human beats a fourth attempt.

End with a short report per job: id, stage, open follow-ups (count), and what the user needs to do, if anything.
