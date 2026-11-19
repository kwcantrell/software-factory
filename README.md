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
/factory:agents                                     # make this repo's own station agents
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
| `factory init` | create `./factory` and install the dashboard; with a `remote`, create or clone the shared state branch |
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
| `factory close` | human gate: abandon a job without merging |
| `factory claim` | human gate: take over a job someone else claimed (`--take-over`; [remote factory](#remote-factory)) |
| `factory remote status` | the remote, branch, ahead/behind counts and last sync |
| `factory remote push` | publish the local `factory/jobs/` to the configured remote |
| `factory config` | print the effective configuration (`factory.json` over defaults) |
| `factory note` | set the job's activity line |
| `factory followup` | record, list and resolve follow-ups (see below) |
| `factory agents` | the agent `/factory:run` launches for each station: the project's own or the shipped fallback (see [Station agents](#station-agents)) |
| `factory agents new` | write a station's template to `.claude/agents/factory-<station>.md` (`--force` to overwrite) |
| `factory agents check` | validate every `.claude/agents/factory-*.md` against its template |
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
  "specs_dir": null,
  "remote": null,
  "advisor": {"share": false}
}
```

- **`reviewers`** - who reviews each round. The plugin ships the three above. To add a lens (say `"performance"`), add the name here and make its agent with `factory agents new reviewer-performance` (or `/factory:agents`); see [Station agents](#station-agents). A lens agent made before station agents existed, `.claude/agents/reviewer-<name>.md`, is no longer used: `factory agents` names it, and its lens text moves into the new file.
- **`max_review_rounds`**, **`max_proof_attempts`** - how many tries before a job is flagged needs-human.
- **`spec_gate`** - when true, every job stops after intake until you approve its `task.md` with `/factory:approve <id>`. Off by default; you can also ask for it per request ("...and let me review the spec first").
- **`specs_dir`** - the repo-relative directory where the project keeps living behavior specs (say `"docs/specs"`), or `null` if it keeps none. When set, intake reads the specs a change touches, lists them in `task.md`, and gives each one whose behavior changes an acceptance criterion to update it in the same job. Unset by default.

- **`remote`** - share the job state with your team through a git remote: `{"url": "<git url or path>", "branch": "<branch>", "allowed_signers": "<path>"}`; `null` (the default) keeps the factory local. `url` and `branch` are required. `url` is anything `git clone` accepts except a `<helper>::` transport or a value starting with `-`; a path starting with `./` or `../` is relative to `factory.json`'s directory. `branch` is a plain branch name such as `"factory-state"`. Two optional keys, and nothing else is allowed:
  - **`allowed_signers`** - the repo-relative path (no leading `/`, no `..`) of an SSH allowed-signers file committed in the project repo, such as `".factory/allowed_signers"`, in the format git reads for `gpg.ssh.allowedSignersFile`. `factory merge` checks every state commit of the job against it. `null` by default, and then `merge` refuses, saying how to set it up.
  - **`unsigned_ok`** - `true` turns signing off: state commits are not signed and `merge` checks no signatures, so anyone who can push to the state branch can make a job look approved and have it merged. **Not recommended.** `false` by default; it cannot be combined with `allowed_signers`.

  See [Remote factory](#remote-factory), and its Signing section for setting up keys.
- **`advisor`** - settings for the `factory-plugin-advisor` plugin: `{"share": true}` (the only key, `true` or `false`; `false` by default) shares its redacted friction log and its issue state with the team in an `advisor/` directory on the `remote` state branch. It has no effect without a `remote`. See [factory-plugin-advisor's README](plugins/factory-plugin-advisor/README.md#sharing-with-a-team-opt-in).

`factory config` prints the effective settings. Unknown keys and bad values are refused, so a typo cannot silently change the line.

## Station agents

Each station is an agent: the builder, the verifier and one reviewer per lens. The plugin ships one for each (`factory:builder`, `factory:verifier`, `factory:reviewer-security`, `-standards`, `-behavior`), the same for every project. A project can have its own instead, tailored to its stack, checks and conventions:

- **Templates.** `plugins/factory/templates/agents/` holds one template per station kind: `builder.md`, `verifier.md` and `reviewer.md`, a generic lens template (the three shipped lenses come out of it with their own lens text). Each marks the line's non-negotiables as **fixed** sections, `<!-- fixed:<id> -->` ... `<!-- /fixed -->`: the CLI only through the npx form, handoff files only in the absolute job dir (deleting a stray copy only if it is the station's own), recording its own result (`built`, `proof`, `verdict`) and follow-ups, never editing `job.json`, and the reviewer's single lens. The **fill** sections, `<!-- fill:<id> ... -->` ... `<!-- /fill -->`, are the project's: its stack, how to run its checks, its conventions and, for a reviewer, what the lens looks for here.
- **Project agents.** A project agent for a station is `.claude/agents/factory-<station>.md` in the main checkout, where station is `builder`, `verifier` or `reviewer-<name>`, with frontmatter `name` equal to the file name (`factory-reviewer-security`). It is committed with the repo. `factory agents new <station>` writes one from its template with the name filled in (refusing to overwrite without `--force`); for a reviewer not in `factory.json` it prints the `reviewers` line to set, and does not edit `factory.json`.
- **Validation.** `factory agents check` validates every `.claude/agents/factory-*.md` and exits 1 with one line per problem (file, what, fix): the frontmatter `name` matches the file and there is a `description`; every fixed section of the template is present (compared after removing HTML comments and collapsing whitespace, so re-wrapping and dropping the markers are fine and any change of wording is not); no `TODO:` placeholder is left; the CLI is called only through the npx form; the agent records its own result with the right command (`factory built`, `factory proof <job id> pass|fail`, `factory verdict <job id> <name> approve|changes`) and its follow-ups `--by` its own name; and nothing pre-approves or runs `factory merge`, `approve`, `rework` or `close` (no such `Bash(...)` rule and no rule wide enough to cover them, wherever it sits in the frontmatter and in any YAML form, with `*` and a trailing `:*` read as wildcards; no `permissionMode` other than `default`, `acceptEdits`, `plan` or `dontAsk`; no `hooks`). Frontmatter values are compared with surrounding quotes removed. The body scan for `factory merge` and the like is a lint: the PreToolUse hook is what enforces the gate. The shipped agents pass the same rules, so the fallback is never weaker than a generated agent.
- **Resolution and fallback.** `factory agents [--json]` prints, for the builder, the verifier and each reviewer in `factory.json`, the agent `/factory:run` launches and whether it is project-owned or the shipped fallback: the project agent when its file exists and passes `check`, otherwise the shipped `factory:<station>` (and it says when a project agent was skipped for failing `check`), or `missing` for a configured reviewer with neither, which `/factory:run` escalates. With no project agents the line runs exactly as before, on the shipped agents.
- **`/factory:agents`** walks Claude through making or refreshing them: read the repository (languages, test, typecheck and lint commands, the check script, CLAUDE.md conventions, any `specs_dir`), run `factory agents new` for each station, fill in only the fill sections, run `factory agents check` until it is clean, then show you the result and ask before committing. It pre-approves only `factory agents` and `factory agents check`. Claude Code loads `.claude/agents/` when a session starts, so a new agent is used from the next session.

A project agent has no `${CLAUDE_PLUGIN_ROOT}` of its own, so `/factory:run` gives every station the factory plugin root in its prompt, and the templates say to read `${CLAUDE_PLUGIN_ROOT}` as that path.

## Dashboard

One self-contained HTML file, no build step and no dependencies. `factory dashboard [--port 8787]` copies it into the project's `factory/` directory and serves that directory on 127.0.0.1 only, listing directories the way the page expects and refusing any path outside `factory/` or inside a `.git` directory. Its responses carry a Content-Security-Policy: the page loads and sends nothing beyond that server, so a job file cannot pull in or send data to another site (an image in job markdown that links elsewhere does not load).

Jobs are cards that move across the stage columns. Each review round is a row of reviewer chips that fill in as verdicts land. Jobs that need a human are highlighted and counted in the header and the tab title. Click a card to read its markdown files, follow-ups and history. The **Follow-ups** view in the header lists every job's follow-ups in one place (open by default, or all), and cards show their open count. In a remote factory, cards and the job drawer show who claimed the job; older `job.json` files without an owner show none. The header shows three line metrics once there is data: first-pass proof rate, review rounds to approval, and time to approval. The page reads `jobs/*/job.json` through the server's directory listing every two seconds, so the files are the only source of truth.

## Remote factory

By default the factory is private to one checkout: everything lives in the gitignored `factory/`, and deleting it deletes the job history. With `remote` set in `factory.json`, the job state lives on a git branch instead, so a team runs one shared line and the history survives.

**Setup.** Pick where the state goes and commit `factory.json`:

- a separate repo, say `org/project-factory`: `{"remote": {"url": "git@github.com:org/project-factory.git", "branch": "factory-state"}}`. An empty repo is fine;
- or an orphan branch of the project repo itself: the same `url` as the project's `origin`, with a branch of its own such as `"factory-state"`. Never the code's branch: a branch holding anything but job directories and the state README is refused.

Then each person runs `factory init`. The first creates the branch (an orphan with only a README, so it shares no history with the code) and pushes it; everyone else clones it. The state checkout is the factory dir's `jobs/` directory itself (`factory/jobs/`, a git checkout of the branch), so job dirs keep their paths and the dashboard works unchanged.

**What is stored.** One directory per job at the top of the branch: `job.json`, the station markdown files (`task.md`, `build.md`, `proof.md`, reviews, `ship.md`, `rework-*.md`) and `evidence/`, plus a README, and with `advisor.share` on, factory-plugin-advisor's `advisor/` directory (never a job). Never the builders' worktrees: they stay in `factory/worktrees/`, outside the state checkout, and only reach others through the job's code branch (`factory/<id>`), which is pushed to the code remote like any branch. **A public remote makes every job's content public**: the tasks, reviews and follow-ups. Use a private repo unless that is what you want.

**Trust.** Whoever can push to the state branch writes what your commands read. Signatures decide what may be merged (see **Signing** below): `factory merge` refuses a job unless every change to it was signed by a key your project's allowed-signers file lists, so a hand-edited `job.json` that only looks approved is not enough. Beyond that, the CLI accepts only what it writes itself: a branch holding a symbolic link or submodule anywhere is refused (and the checkout never materialises one), a job dir file that is not a regular file is never read or published, and a `job.json` whose `id` is not its directory name, whose `branch` is not `factory/<id>` or whose `base` is not a commit hash is refused. A job's `worktree` is always your own `factory/worktrees/<id>`, whatever path the branch holds. One `job.json` that is not valid JSON or not the shape the CLI writes does not take the line down: `status`, `stats`, `followup list` and the dashboard skip it with one warning naming its directory and why (on stderr; in the browser console for the dashboard), and every command that acts on that job by id refuses it. The dashboard escapes every `job.json` value it renders, and its Content-Security-Policy keeps a job file from sending anything off this machine. You can run `factory` from anywhere, including inside `factory/jobs/`: it finds the project checkout that holds the factory dir.

**Signing.** In a remote factory every state commit the CLI makes is signed with your own SSH key (`git commit -S`), and `factory merge` verifies the job's history before merging. Set it up once:

1. Have an SSH key (`ssh-keygen -t ed25519` makes one) and tell git to sign with it: `git config --global gpg.format ssh` and `git config --global user.signingkey ~/.ssh/id_ed25519` (or the same without `--global`, in the project checkout). The CLI reads these from the project checkout and refuses any command that changes a job, before changing anything, until they are set (it names the settings). Only SSH signing is supported: GPG (`gpg.format openpgp`) is refused, because the allowed-signers file lists SSH keys; at merge, a state commit with an OpenPGP or X.509 signature is refused even when git calls it good, since git checks those against your own keyring, not the file.
2. Add your public key to the project's allowed-signers file, one line per person, `<email> <public key>` (for example `ann@example.com ssh-ed25519 AAAA...`, from `~/.ssh/id_ed25519.pub`), **by pull request** like any code change, and point `remote.allowed_signers` in `factory.json` at it (say `".factory/allowed_signers"`).

`factory merge <id>` then walks the state branch's history of that job's directory and refuses (exit 1, naming the commit and why) unless every commit that touched it, from its `new` on, has a good signature from a key in the allowed-signers file. The file is read as committed at `HEAD` of your project checkout, never from the state branch and never from an uncommitted edit, so changing who is trusted takes a reviewed change to the project. Merge also refuses while the job's `job.json` in your `factory/jobs/` differs from its committed version. Without `allowed_signers`, merge refuses and says how to set it up; `"unsigned_ok": true` is the only way out, and it gives up this protection.

What it guarantees: a job is merged only if every change to its state was signed by someone the project trusts, so an unsigned or foreign-signed edit (a forged approval pushed straight to the branch) is caught at the merge gate. What it does not: **the trust boundary is the key, not the tool** - a person with an allowed key can commit a hand-edited `job.json` outside the CLI and it passes, as their signature is their word. It does not stop anyone pushing to the branch (use the git host's branch protection for that), does not check the code on the job's branch (the reviewers and you at the merge prompt do), does not stop someone who can force-push the branch from rolling it back to an older tip whose commits are all signed, and does not cover state commits made before signing was set up: a job whose history holds older unsigned commits cannot be merged until it is recreated. factory-plugin-advisor's `advisor/` commits touch no job and are not checked. When a push loses a race, the CLI replays your state commits onto the remote with `git rebase --gpg-sign`, so they stay signed.

**Sync.** Every command that changes a job (`new`, `start`, `spec`, `approve`, `built`, `proof`, `round`, `verdict`, `human`, `resume`, `merge`, `rework`, `close`, `note`, `followup add/done/drop`, `claim`) pulls first, applies its change, commits only that job's directory as `factory: <command> <job id>` with your git identity as the author, signed with your key (see **Signing**), and pushes. Station files a stage writes (say `build.md`) are committed by the command that records the stage (`built`). If another push landed first, the command pulls and retries (up to 5 times); two people creating jobs at once get two distinct ids, the second renumbered (a `new` is never replayed onto a number someone else took; after 5 lost races it refuses and asks you to retry). A push the server declines (a hook, a protected branch) is refused with the server's reason, not retried. If the same job changed on both sides, the command is refused (exit 1, naming the job and the files): your change is not applied, the job is reset to the remote's version, the version you tried is kept under `factory/conflicts/`, and the checkout matches the remote. Nothing is ever merged silently. Within one machine the factory lock still serializes commands.

**Offline.** A command that changes a job refuses when the remote cannot be reached, says so, and changes nothing; run it again when you are back online. Read commands (`status`, `followup list`, `stats`, `path`, `config`, `dashboard`) pull first; with `--offline`, or when the remote is unreachable, they show the last-pulled state and say so on stderr. The dashboard pulls once when it starts.

**Claims.** `factory start` records who claimed the job in `job.json` (`owner`: the git `user.name` and `user.email` its commits carry), and the dashboard and `factory status <id>` show it. Anyone can read a job, but commands that change it are refused for everyone but its owner (exit 1, naming the owner), except the human gates `approve`, `merge`, `rework` and `close`, which any person may run (each asks a person first: see [How it is enforced](#how-it-is-enforced)). `factory claim <id> --take-over` moves the claim to you and records it in the history. It is a human command: the gate hook makes Claude Code ask before it runs, and the station agents are told never to run it. Taking over a job in build or later recreates its worktree on your machine from `factory/<id>` on the code remote (`origin` of your checkout); if the previous owner never pushed that branch, it is refused and says they must push it first.

**Migration.** `factory remote push` publishes an existing local `factory/jobs/` to a newly configured remote, keeping its ids and history (never the worktrees); it refuses a job number the remote already uses for a different job. It also publishes local changes from an attached checkout, say jobs changed while `remote` was removed. Until it runs, commands that change a job refuse to mix local and remote state and point at it. Removing `remote` from `factory.json` goes back to local mode with the last-pulled jobs intact, and nothing is pushed from then on. `factory remote status` shows the remote, the branch, ahead/behind counts against the remote, uncommitted files and the last sync.

## How it is enforced

Prompts ask; the `factory` CLI (`plugins/factory/src/`, run through `npx` as above) decides. It is the only writer of `job.json` and the only way a job changes stage:

- `start` refuses without a `task.md` that has acceptance criteria, then creates the worktree. With the spec gate, it also refuses until a human has approved `task.md`, and again if `task.md` changed after approval.
- `built` refuses with uncommitted changes, no commits, or no `build.md`.
- `proof pass|fail` is recorded by the verifier, not the builder or supervisor.
- `verdict` refuses without the reviewer's written review; a round with any `changes` sends the job back to build, then through proof again.
- `built`, `proof` and `verdict` each refuse while an untracked copy of their own handoff file (`build.md`, `proof.md`, `review-<round>-<reviewer>.md`) sits at the root of the main checkout or of the job's worktree, naming the stray file to move or delete and saying whether it is byte-identical to the job dir's copy: handoff files belong only in the job dir, and `git add -A` would commit a stray copy. A tracked file of the same name is the project's own and is ignored.
- Three failed proofs or three review rounds without approval (configurable) flag the job **needs-human** and stop it. So does `factory human <job> <reason>`, which any station runs when it needs a person.
- Exit codes: 0 ok, 1 refused (a gate was not met), 2 escalated to a human.
- `rework` (human) sends a job in `ship` back to `build` with a request saved as `rework-<round>.md`; the builder does what it asks, and the job is proven and reviewed again in a new round.
- `merge` only works from `ship`. A `PreToolUse` hook turns any `factory merge`, `factory approve`, `factory rework`, `factory claim` or `factory close` command into a permission prompt, so an agent cannot merge a job, approve a spec, reopen an approved job, take a job over from another person or close a job without a person saying yes. `factory agents check` fails a station agent that pre-approves or runs `merge`, `approve`, `rework` or `close`.
- In a [remote factory](#remote-factory), `merge` also refuses unless every state commit of the job is signed by a key in the project's allowed-signers file (see **Signing** there).
- In a [remote factory](#remote-factory), commands that change a job refuse while someone else owns it, and refuse rather than merge when the same job changed on the remote.

Run `factory --help` for every command. `factory status` is the text version of the dashboard, and `factory stats` prints the line metrics (add `--json` to track them over time).

Runtime state lives in `<project>/factory/` (`jobs/`, `worktrees/`, `index.html`) and ignores itself in git. In a [remote factory](#remote-factory), `jobs/` is a git checkout of the state branch.

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
  skills/agents                            make the project's own station agents (factory agents)
  agents/                                  builder, verifier, reviewer-{security,standards,behavior}: the shipped fallback
  templates/agents/                        builder, verifier and reviewer templates for project agents
  src/                                     the CLI: state machine, gates, remote state sync, station agents, dashboard server
  hooks/hooks.json, src/human-gate.ts      human-gate hook (merge, spec approval, rework, claim, close)
  dashboard/index.html                     the dashboard
  test/                                    node:test suites (CLI, npx, hook, dashboard, compatibility, upgrade, agents, remote)
plugins/factory-plugin-builder/            builds plugins for this marketplace: new, check (the CLI convention), verify
plugins/factory-dev/                       develops this repo: check (every CI gate), release (tag/version check, notes)
plugins/factory-docs/                      keeps this repo's docs in sync with its code: which, stale, lint, gate
plugins/factory-plugin-advisor/            tracks recurring friction with these plugins and drafts fixes: record, suggest, file
plugins/factory-plugin-discover/           finds the plugin or skill that fits a software-factory task: catalog, match, install, a prompt hook
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

When the same problem with one of these plugins keeps coming back, the `factory-plugin-advisor`
plugin notices: its skill and its hook record each friction in a local, redacted log, and once an
issue recurs it drafts a fix with a paste-ready `/factory:run` request (and, only after you confirm,
files it as an issue on this public repository); see
[plugins/factory-plugin-advisor/README.md](plugins/factory-plugin-advisor/README.md).

So that Claude reaches for the right one of these plugins in the first place, the
`factory-plugin-discover` plugin's skill and prompt hook have it run `match` with a one-line summary
before software-factory work, use the installed plugin or skill that fits, offer to install a
fitting marketplace plugin (as your mode setting says), and record the gap with
`factory-plugin-advisor` when none fits; see
[plugins/factory-plugin-discover/README.md](plugins/factory-plugin-discover/README.md).

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

## Versioning

Every plugin in this marketplace carries the same version, the repository's. `CHANGELOG.md` lists what changed in each release. A patch release carries fixes only.
