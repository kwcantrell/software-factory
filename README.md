# Software Factory

A Claude Code plugin that runs work through a multi-agent assembly line instead of a single assistant answering prompts. Agents build, prove and review code; a human designs the line and decides what merges.

```
intake ──▶ build ──▶ proof ──▶ review ──▶ ship ──▶ done
 triage    builder   verifier  3 reviewers  human
           (own      (runs it  (security,   merge
           worktree)  itself)   standards,  gate
              ▲          │      behavior)
              └──────────┴─── fail / changes requested (max 3 rounds, then a human)
```

| Stage | Who | Hands off |
|---|---|---|
| **Intake** | supervisor (your session) | `task.md` with checkable acceptance criteria (optionally approved by you) |
| **Build** | `builder` agent in its own git worktree and branch | commits + `build.md` |
| **Proof** | `verifier` agent, independent of the builder | `proof.md` + `evidence/`, records pass/fail |
| **Review** | `reviewer-security`, `reviewer-standards`, `reviewer-behavior` in parallel | `review-<round>-<name>.md`, each records its own verdict |
| **Ship** | you | `ship.md` summary, then `/factory:ship` |

## Use

```
claude --plugin-dir /path/to/software-factory      # or install from a marketplace

/factory:run add cursor pagination to GET /orders   # one request, one or more jobs
/factory:run                                        # continue jobs in progress
/factory:dashboard                                  # live board
/factory:approve 3                                  # approve job 3's spec (only with the spec gate on)
/factory:ship 2                                     # merge job 2 (asks you to confirm)
/factory:ship 2 reject not needed after all
```

Requires git and Python 3.8+ (macOS or Linux). The target repository needs at least one commit.

## Configure

Optional. Put a `factory.json` at the repository root and commit it; anything you leave out keeps its default:

```json
{
  "reviewers": ["security", "standards", "behavior"],
  "max_review_rounds": 3,
  "max_proof_attempts": 3,
  "spec_gate": false
}
```

- **`reviewers`** - who reviews each round. The plugin ships the three above. To add a lens (say `"performance"`), add the name here and define a `reviewer-performance` agent in the project's `.claude/agents/`; copy one of the plugin's `agents/reviewer-*.md` as a start.
- **`max_review_rounds`**, **`max_proof_attempts`** - how many tries before a job is flagged needs-human.
- **`spec_gate`** - when true, every job stops after intake until you approve its `task.md` with `/factory:approve <id>`. Off by default; you can also ask for it per request ("...and let me review the spec first").

`factory config` prints the effective settings. Unknown keys and bad values are refused, so a typo cannot silently change the line.

## Dashboard

One self-contained HTML file, no build step and no dependencies. `factory dashboard` copies it into the project's `factory/` directory and serves that directory, which is the same as:

```
cd factory && python3 -m http.server
```

Jobs are cards that move across the stage columns. Each review round is a row of reviewer chips that fill in as verdicts land. Jobs that need a human are highlighted and counted in the header and the tab title. Click a card to read its markdown files and history. The header shows three line metrics once there is data: first-pass proof rate, review rounds to approval, and time to approval. The page reads `jobs/*/job.json` through the server's directory listing every two seconds, so the files are the only source of truth.

## How it is enforced

Prompts ask; the `factory` CLI (`bin/factory`, on Claude's PATH while the plugin is enabled) decides. It is the only writer of `job.json` and the only way a job changes stage:

- `start` refuses without a `task.md` that has acceptance criteria, then creates the worktree. With the spec gate, it also refuses until a human has approved `task.md`, and again if `task.md` changed after approval.
- `built` refuses with uncommitted changes, no commits, or no `build.md`.
- `proof pass|fail` is recorded by the verifier, not the builder or supervisor.
- `verdict` refuses without the reviewer's written review; a round with any `changes` sends the job back to build, then through proof again.
- Three failed proofs or three review rounds without approval (configurable) flag the job **needs-human** and stop it.
- `rework` (human) sends a job in `ship` back to `build` with a request saved as `rework-<round>.md`; the builder does what it asks, and the job is proven and reviewed again in a new round.
- `merge` only works from `ship`. A `PreToolUse` hook turns any `factory merge`, `factory approve` or `factory rework` command into a permission prompt, so an agent cannot merge a job, approve a spec or reopen an approved job without a person saying yes.

Run `factory --help` for every command. `factory status` is the text version of the dashboard, and `factory stats` prints the line metrics (add `--json` to track them over time).

Runtime state lives in `<project>/factory/` (`jobs/`, `worktrees/`, `index.html`) and ignores itself in git.

## Layout

```
.claude-plugin/plugin.json   manifest (plugin name: factory)
skills/run                   the line: intake -> ship
skills/approve               human spec gate (user-invoked only)
skills/ship                  human merge gate (user-invoked only)
skills/dashboard             start the dashboard server
agents/                      builder, verifier, reviewer-{security,standards,behavior}
bin/factory                  state machine and gates
hooks/, scripts/             human-gate hook (merge and spec approval)
dashboard/index.html         the dashboard
```

## Why it is built this way

Design choices and the published practice each one follows:

- **The agent that builds never grades its own work.** Anthropic found a separate, deliberately skeptical evaluator far more effective than asking a generator to critique itself, and that evaluators approve flawed work unless tuned against it. Hence an independent verifier and reviewers who record their own verdicts. ([Anthropic: Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps))
- **A contract before code, handed off in files.** The same post has generator and evaluator agree on testable criteria up front and communicate through files. Here that is `task.md` and the per-stage markdown files.
- **Proof judged against the task, not the builder's tests.** StrongDM validates against scenarios the coding agents cannot tune to; Simon Willison calls proving agent-written code works "the most consequential question" in this approach. The verifier checks each criterion first-hand and confirms tests can fail. ([Simon Willison on StrongDM's software factory](https://simonwillison.net/2026/Feb/7/software-factory/))
- **Deterministic gates between agent steps, and a cap on retries.** Stripe's Minions interleave fixed steps with agent steps and limit CI rounds because extra rounds have diminishing returns. Hence a CLI state machine and the three-round cap. ([Stripe: Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents))
- **Isolation per task, humans at the merge.** Stripe runs each agent in its own devbox and keeps human review on every PR; OpenAI's harness-engineering write-up describes engineers moving from writing code to designing the system and its constraints. ([OpenAI: Harness engineering](https://openai.com/index/harness-engineering/))
- **Optional human review of the spec, and the line defined in a checked-in file.** Warp's factories stop for a human at the spec as well as the code, and are configured by a `factory.yaml` in the repo. Here that is `spec_gate` and `factory.json`. ([Warp Factories](https://www.warp.dev/factories))
- **Measure the line, not just the jobs.** Warp's Factories page puts it as "Measurement > Vibes": score every run and tune the factory against numbers. `factory stats` and the dashboard header report first-pass proof rate, rounds to approval, time to approval and escalation rate, so a prompt or model change to a station can be judged by what it does to them. ([Warp Factories](https://www.warp.dev/factories))
- **Keep the harness small.** Anthropic's closing advice: every harness component encodes an assumption about what the model cannot do alone, and those go stale. Each station here is one short prompt file; remove or merge stations as models improve.
