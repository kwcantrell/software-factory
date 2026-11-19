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

## Install

This repository is both the plugin and a marketplace named `software-factory`. In Claude Code:

```
/plugin marketplace add kwcantrell/software-factory
/plugin install factory@software-factory
```

From a local checkout instead (for development, or to pin a version you have reviewed):

```
git clone https://github.com/kwcantrell/software-factory
/plugin marketplace add ./software-factory        # then: /plugin install factory@software-factory
claude --plugin-dir ./software-factory/plugins/factory   # or load it for one session without installing
```

### Upgrading from an older version

Repositories that used the original plugin (`factory@kwcantrell-plugins`, from the
`kwcantrell/kwcantrell-plugins` marketplace) or `factory@software-factory` 0.2.0 (both ran a Python
CLI) switch over with one skill, run from the repository:

```
/factory:upgrade
```

It runs `factory upgrade`, a dry run that writes nothing, and shows the plan in three groups:

- **settings**: in `.claude/settings.json` (project) and `.claude/settings.local.json` (local), an
  `enabledPlugins` key `factory@<any marketplace but software-factory>` becomes
  `factory@software-factory`, keeping its true/false value, and `extraKnownMarketplaces` gains
  `software-factory` where it declared the old marketplace. Other plugins and marketplaces
  (`base-setup@kwcantrell-plugins`, say) stay. User settings (`$CLAUDE_CONFIG_DIR/settings.json`,
  else `~/.claude/settings.json`) change only with `--scope user`, which the skill asks about
  separately. The originals of the settings files it changes are copied first to a private
  `factory-upgrade-backup-<time>/` (mode 0700) in the repo's git dir, not under `factory/`, which
  the dashboard serves, since settings can hold secrets; rewritten files keep their mode and
  symlinks;
- **runtime dir**: in `factory/`, each `job.json` gains the fields the current CLI writes that it
  lacks (`followups: []` for the oldest jobs; existing values never change), `index.html` becomes
  the current dashboard, `.gitignore` is ensured and the old `.lock` file goes. The originals are
  copied to `factory/upgrade-backup-<time>/` first. Jobs in progress keep their worktree and branch;
- **manual steps**, never done for you: `factory.json` keys the current CLI refuses, tracked files
  that still name the old plugin or CLI (file:line), and the `claude plugin install` /
  `claude plugin uninstall` commands to run per scope, then `/reload-plugins`.

The skill asks before running `factory upgrade --apply`, and checks the result with a last dry run
that should report `nothing to do`. By hand: `factory upgrade [--repo <path>] [--apply] [--scope
project|local|user ...] [--json]`; it exits 0 when current or applied, 1 when it refuses (a file
that does not parse, a factory command still holding the lock) and 2 on a usage error or outside a
git checkout.

## Use

```
/factory:run add cursor pagination to GET /orders   # one request, one or more jobs
/factory:run                                        # continue jobs in progress
/factory:dashboard                                  # live board
/factory:approve 3                                  # approve job 3's spec (only with the spec gate on)
/factory:ship 2                                     # merge job 2 (asks you to confirm)
/factory:ship 2 reject not needed after all
```

Requires git and Node.js 22.18+ (macOS or Linux); nothing else, not even an `npm install`. The target repository needs at least one commit.

### Running the CLI by hand

Skills, agents and the hook all run the plugin's TypeScript CLI through `npx`, straight from the installed plugin folder (Node runs the `.ts` files itself; there is no build step and no runtime dependency). You can run it the same way from any directory in your project:

```sh
PLUGIN=~/.claude/plugins/cache/software-factory/factory/<version>   # or a checkout's plugins/factory
npx --yes --offline --loglevel=error --package="$PLUGIN" -- factory status
```

or, equivalently, `node "$PLUGIN/src/cli.ts" status`. The examples below write it as plain `factory`.

| Command | What it does |
| --- | --- |
| `factory init` | create `./factory` and install the dashboard |
| `factory new` | intake: open a job |
| `factory start` | intake -> build: needs `task.md`; creates the worktree |
| `factory spec` | ask a human to approve `task.md` before building |
| `factory approve` | human gate: approve a job's spec |
| `factory built` | build -> proof: needs `build.md` and clean commits |
| `factory proof` | the verifier's result: pass -> review, fail -> build |
| `factory round` | open a review round |
| `factory verdict` | a reviewer's verdict; needs `review-<round>-<reviewer>.md` |
| `factory human` | flag a job as needing a human |
| `factory resume` | human: clear needs-human and continue |
| `factory merge` | human gate: merge an approved job and clean up |
| `factory rework` | human: send an approved job back to build |
| `factory close` | human: abandon a job without merging |
| `factory config` | print the effective configuration (`factory.json` over defaults) |
| `factory note` | set the job's activity line |
| `factory followup` | record, list and resolve follow-ups (see below) |
| `factory path` | print the job dir (or `--worktree`) |
| `factory status` | list jobs, or show one |
| `factory stats` | line metrics: proof and review pass rates, rounds, time, escalations |
| `factory upgrade` | move a repo from an older factory to this version (dry run unless `--apply`) |
| `factory dashboard` | serve the dashboard |

`factory <command> --help` gives a command's arguments.

## Configure

Optional. Put a `factory.json` at the repository root and commit it; anything you leave out keeps its default:

```json
{
  "reviewers": ["security", "standards", "behavior"],
  "max_review_rounds": 3,
  "max_proof_attempts": 3,
  "spec_gate": false,
  "specs_dir": null
}
```

- **`reviewers`** - who reviews each round. The plugin ships the three above. To add a lens (say `"performance"`), add the name here and define a `reviewer-performance` agent in the project's `.claude/agents/`; copy one of the plugin's `agents/reviewer-*.md` as a start.
- **`max_review_rounds`**, **`max_proof_attempts`** - how many tries before a job is flagged needs-human.
- **`spec_gate`** - when true, every job stops after intake until you approve its `task.md` with `/factory:approve <id>`. Off by default; you can also ask for it per request ("...and let me review the spec first").
- **`specs_dir`** - the repo-relative directory where the project keeps living behavior specs (say `"docs/specs"`), or `null` if it keeps none. When set, intake reads the specs a change touches, lists them in `task.md`, and gives each one whose behavior changes an acceptance criterion to update it in the same job. Unset by default.

`factory config` prints the effective settings. Unknown keys and bad values are refused, so a typo cannot silently change the line.

## Dashboard

One self-contained HTML file, no build step and no dependencies. `factory dashboard [--port 8787]` copies it into the project's `factory/` directory and serves that directory on 127.0.0.1 only, listing directories the way the page expects and refusing any path outside `factory/`.

Jobs are cards that move across the stage columns. Each review round is a row of reviewer chips that fill in as verdicts land. Jobs that need a human are highlighted and counted in the header and the tab title. Click a card to read its markdown files, follow-ups and history. The **Follow-ups** view in the header lists every job's follow-ups in one place (open by default, or all), and cards show their open count. The header shows three line metrics once there is data: first-pass proof rate, review rounds to approval, and time to approval. The page reads `jobs/*/job.json` through the server's directory listing every two seconds, so the files are the only source of truth.

## How it is enforced

Prompts ask; the `factory` CLI (`plugins/factory/src/`, run through `npx` as above) decides. It is the only writer of `job.json` and the only way a job changes stage:

- `start` refuses without a `task.md` that has acceptance criteria, then creates the worktree. With the spec gate, it also refuses until a human has approved `task.md`, and again if `task.md` changed after approval.
- `built` refuses with uncommitted changes, no commits, or no `build.md`.
- `proof pass|fail` is recorded by the verifier, not the builder or supervisor.
- `verdict` refuses without the reviewer's written review; a round with any `changes` sends the job back to build, then through proof again.
- Three failed proofs or three review rounds without approval (configurable) flag the job **needs-human** and stop it. So does `factory human <job> <reason>`, which any station runs when it needs a person.
- Exit codes: 0 ok, 1 refused (a gate was not met), 2 escalated to a human.
- `rework` (human) sends a job in `ship` back to `build` with a request saved as `rework-<round>.md`; the builder does what it asks, and the job is proven and reviewed again in a new round.
- `merge` only works from `ship`. A `PreToolUse` hook turns any `factory merge`, `factory approve` or `factory rework` command into a permission prompt, so an agent cannot merge a job, approve a spec or reopen an approved job without a person saying yes.

Run `factory --help` for every command. `factory status` is the text version of the dashboard, and `factory stats` prints the line metrics (add `--json` to track them over time).

Runtime state lives in `<project>/factory/` (`jobs/`, `worktrees/`, `index.html`) and ignores itself in git.

## Follow-ups

A job often turns up work it should not do itself: a risk, a loose end, a bug nearby. Each station records these as it goes with `factory followup add <job> --by <who> "<text>"` (builder, verifier, each reviewer, the supervisor, or you), and they are stored in the job's `job.json` with who raised them, in which stage and when. They can be added in any stage, including after a merge.

```
factory followup list               # open follow-ups across all jobs (--all, --json)
factory followup list 12            # one job's
factory followup done 12 2 job 047  # it became job 047
factory followup drop 12 3 not worth it
```

`ship.md` lists the job's open follow-ups, and the dashboard shows them per job and across the line.

## Layout

```
.claude-plugin/marketplace.json            marketplace "software-factory", listing the plugins below
plugins/factory/                           the plugin
  .claude-plugin/plugin.json               manifest (plugin name: factory)
  package.json                             "bin": {"factory": "src/cli.ts"}; no dependencies
  skills/run                               the line: intake -> ship
  skills/approve                           human spec gate (user-invoked only)
  skills/ship                              human merge gate (user-invoked only)
  skills/dashboard                         start the dashboard server
  skills/upgrade                           move a repo from an older factory plugin (factory upgrade)
  agents/                                  builder, verifier, reviewer-{security,standards,behavior}
  src/                                     the CLI: state machine, gates, dashboard server
  hooks/hooks.json, src/human-gate.ts      human-gate hook (merge, spec approval, rework)
  dashboard/index.html                     the dashboard
  test/                                    node:test suites (CLI, npx, hook, dashboard, compatibility, upgrade)
plugins/factory-plugin-builder/            builds plugins for this marketplace: new, check (the CLI convention), verify
plugins/factory-dev/                       develops this repo: check (every CI gate), release (tag/version check, notes)
plugins/factory-docs/                      keeps this repo's docs in sync with its code: which, stale, lint, gate
docs/docs-map.json                         factory-docs' map: each doc and the globs of the code it describes
templates/plugin/                          the template `npm run new-plugin -- <name>` copies (not in the marketplace)
package.json, tsconfig.json                dev tooling only: typecheck, tests, new-plugin
docs/research/                             the build-vs-buy research behind the design
```

## Developing

To work on software-factory itself, install the `factory-dev` plugin
(`/plugin install factory-dev@software-factory`) or run it from the checkout. After `npm ci`,
`node plugins/factory-dev/src/cli.ts check` runs every check CI runs, and
`node plugins/factory-dev/src/cli.ts release vX.Y.Z` says whether a tag would release; see
[plugins/factory-dev/README.md](plugins/factory-dev/README.md).

Docs are kept in sync with code by the `factory-docs` plugin: `docs/docs-map.json` maps each doc to
the code it describes, `node plugins/factory-docs/src/cli.ts stale` lists the docs a change left
stale, and `gate` (lint + stale) runs in `factory-dev check` and on every pull request; see
[plugins/factory-docs/README.md](plugins/factory-docs/README.md).

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md). MIT licensed ([LICENSE](LICENSE)).

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
