---
name: factory-doctor
description: Checks what an application needs to run on this machine (env vars by name, tools and versions, files, services, Claude plugins and skills) against the committed record in .factory/doctor.json, per profile (dev, stage, test, ...), and proposes missing requirements by scanning the repo. Use before running, testing or demoing the app, after a run fails with a missing command, variable, file, connection or skill, and when asked what env vars or tools the app needs. Never stores, prints or asks for a value.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor check:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor scan:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor profiles:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor --help:*)
---

# factory-doctor

`.factory/doctor.json` in the repository root is the committed record of what running this
application needs under each **profile** (dev, stage, test, ...): tools and versions, environment
variable **names**, files, TCP services, Claude plugins and skills. Every action goes through this
plugin's CLI, run exactly as written below from anywhere in the repository.

**Never put a value in the file, and never print, ask for or repeat a secret in chat.** The file
holds names only; the CLI refuses `--value`, `--default`, `--secret` and `NAME=value`, and never
prints a variable's value. When a variable is missing, tell the person its name and let them set it
themselves (in their shell or their dotenv file). Do not read `.env` files yourself to "help".

## 1. Check before running the app

Before you run, test or demo the app, and again after a run fails with a missing command,
variable, file, connection or skill, check this machine against the profile the task or project
names (no profile: `$FACTORY_DOCTOR_PROFILE`, else the file's `default_profile`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor check <profile> --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor check --json
```

It prints one result per requirement, `status` `ok`, `missing` or `wrong`, each problem with a
`fix`. Exit 0: everything required is in place. Exit 1: something required is missing or wrong
(the report is then on stderr): report each problem with its fix to the person, and do not work
around it (no stub values, no skipping the step that needs it). Exit 2 with "no profile": the
message lists the profiles; pick the right one or ask. To see the profiles:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor profiles --json
```

## 2. Scan when the record is missing or incomplete

When `.factory/doctor.json` does not exist, or a run failed for a reason the file does not cover,
scan the repository. It is read-only and proposes requirements not yet recorded, each with a
number `n`, its `source` (file:line) and the `profile` it suggests:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor scan --json
```

Show the person the proposals that matter, in a short list (kind, name, profile, why), and ask
which to record. A need you discovered yourself (a run failed for want of something) is proposed
the same way, with `add`.

## 3. Change the record only after the person agrees

`init`, `add` and `remove` are dry runs that print the change; run them without `--confirm` first,
show the person the change, and run them again with `--confirm` only after they say yes. Start a
file:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor init
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor init --confirm
```

Add proposal `<n>` from the last scan, or a requirement by hand (kinds: `tool`, `env`, `file`,
`claude-plugin`, `claude-skill`, `service`; options in `--help`, such as `--tool-version`,
`--format`, `--optional`, `--source <file:line>`), or remove one:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor add --from-scan <n>
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor add --from-scan <n> --confirm
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor add <kind> <name> --profile <profile> --why "<why>"
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor add <kind> <name> --profile <profile> --why "<why>" --confirm
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor remove <kind> <name> --profile <profile>
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor remove <kind> <name> --profile <profile> --confirm
```

Commit the changed `.factory/doctor.json` with the work that needed it, so reviewers see it.

## On the factory line

The builder and verifier run `check` first when the repository has `.factory/doctor.json`. A
missing required item goes into `build.md` or `proof.md`, never worked around; a run the
environment prevented is "not verified, with why", never a pass; a newly discovered requirement is
added to `.factory/doctor.json` in the job's commits.

Exit codes: 0 success, 1 the command failed (something required missing, a refused change), 2 usage
error. On a non-zero exit the reason is on stderr; show it to the person instead of guessing. Every
command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor --help
```
