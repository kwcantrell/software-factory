---
name: factory-plugin-advisor
description: Records friction with the software-factory marketplace plugins (factory, factory-plugin-builder, factory-dev, factory-docs and the rest) and suggests a plugin change once the same issue recurs; also reports how a repository's factory station agents (builder, verifier, reviewers) perform and suggests new or changed station agents. Use after working around a software-factory plugin's bug or gap, after doing by hand something one of those plugins should do, when a plugin skill's guidance was missing or wrong, when the user corrects how a plugin was used, at the end of a task to check for recurring issues worth a fix, after a factory job ships, and when the user asks how the factory line or its agents are doing.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor record:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor list:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor show:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor suggest:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor --help:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations --json), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations suggest:*)
---

# factory-plugin-advisor

Makes the software-factory plugins improve from use. You record each friction with one of them as it
happens; the CLI groups occurrences of the same issue, and once one recurs it writes a draft
suggestion (which plugin to change, the evidence, a proposed change and a paste-ready `/factory:run`
request) for the user. Every action goes through this plugin's CLI, run exactly as written below from
any directory. Failed runs of a software-factory plugin's CLI are recorded automatically by this
plugin's hook, so you do not need to record those yourself. A `factory` command that exits 2
(escalated to a human) is the line working as designed and is not friction.

The log is local to this machine (`~/.config/factory-plugin-advisor/`, owner-only), unless the
repository's `factory.json` sets `"advisor": {"share": true}` with a remote factory: then every
occurrence is also shared with the team on the factory's state branch. The CLI redacts anything that
looks like a token or secret, and masks personal details, before storing or sharing it, but do your
part too. If `record` or `suggest` prints a warning on stderr that the remote is or may be public,
tell the user once; never turn sharing on or off yourself. An occurrence that could not be shared
yet (offline, or another advisor command was using the shared log) waits in a local queue and the
next command pushes it: never record it again.

## When to record

Record one occurrence, right after it happens, when, while using a software-factory plugin:

- you worked around its bug or gap (`--kind workaround`);
- you did by hand something the plugin should do for you (`--kind manual-step`);
- its skill or agent guidance was missing or wrong (`--kind missing-guidance`);
- the user corrected how you used it (`--kind user-correction`);
- its CLI failed in a way the hook could not see, for example inside a pipeline that still exited 0
  (`--kind cli-failure`).

`--plugin` is the software-factory plugin involved (for example `factory` or `factory-docs`). Prefer
an existing plugin: use a new kebab-case plugin name only when no existing plugin is a sensible home
for the fix, and `none` when you cannot tell. `--summary` is one short, general sentence describing
the problem, the same way each time it happens ("factory review refuses a verdict before proof
passed"), so repeats group together; job ids, paths and numbers in it are masked when grouping.
`--detail` is optional context: what you tried and what worked.

**Never put secrets, tokens, cookies, passwords, private keys or private user data (names, emails,
private code, transcript text) in a summary or detail.** Describe the problem, not the data.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor record --plugin <plugin> --kind <kind> --summary "<summary>" --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor record --plugin <plugin> --kind <kind> --summary "<summary>" --detail "<detail>" --json
```

It prints `{"signature","plugin","kind","summary","count","redacted"}`. Do not mention a record to
the user unless they ask; it is bookkeeping.

## Suggest at natural break points

At the end of a task (or another natural pause), check whether anything has crossed the threshold
(3 occurrences by default; `--threshold <n>` changes it):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor suggest --json
```

It prints `{"threshold","suggestions":[...]}`, each suggestion with `signature`, `plugin`, `count`,
`summary`, `target`, `title`, `draft` (the draft's path) and `factoryRun`. It writes a draft for
each, and will not suggest the same issue again until its count grows by the threshold again. If
`suggestions` is empty, say nothing. Otherwise tell the user in one or two lines per issue, for
example: "`factory-docs` keeps failing on X (seen 4 times). I drafted a suggested fix; want to see
it?". If they want it, show the draft and its `/factory:run` line, which they can paste in a
software-factory checkout to build the change through the factory. Never start a factory run
yourself.

To look at what has been recorded, or at one issue in full (its occurrences are already redacted;
a unique prefix of 4+ characters of a signature works too):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor list --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor list --plugin <plugin> --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor show <signature> --json
```

`list` also takes `--min <n>` to show only issues seen at least `n` times.

## Filing a draft as a GitHub issue

Only when the user asks for it. `kwcantrell/software-factory` is a **public** repository: anyone
can read what is filed there. Always go through these steps, in order.

First, the dry run. It files nothing and prints exactly the title, body and repository that would be
filed:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor file <signature> --json
```

Then show the user the title and the whole body, remind them that the repository is public, and ask
for an explicit yes. Read the body yourself for anything private, and offer to leave it unfiled if in
doubt. Anything short of a clear yes means do not file.

Only after that yes, file it. This runs `gh issue create`, so it asks for permission:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor file <signature> --confirm --json
```

It prints the issue's `url`; give it to the user. The CLI refuses (exit 1) to file a draft that still
holds secret-looking text, a home-dir path, an email address or a linkable `@mention` (the CLI
masks these when it stores and drafts; one still there was edited in), and never files the same
issue twice. `--repo <owner/name>` files
somewhere else, such as a fork; ask the user whether that repository is public too.

## Dismissing an issue

When the user says an issue is not worth fixing, stop suggesting it (this asks for permission):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor dismiss <signature> --json
```

## Station agents: how the factory line is doing

In a repository that runs the software factory, this plugin also reads the line's history
(`factory/jobs/*/job.json` and each job's proof and review files) and reports, per station agent
(builder, verifier, each reviewer; the project's own `.claude/agents/factory-<station>.md` or the
shipped fallback, as `factory agents` resolves it): jobs handled, first-pass proof rate, proof
failures, each reviewer's approve and changes counts, escalations and follow-ups. Run it **after a
factory job ships** (merged or closed) and **when the user asks how the line or its agents are
doing**, from the repository (or add `--repo <path>`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations --json
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations suggest --json
```

`stations` only reads. `stations suggest` applies fixed, documented rules (see the plugin README:
a theme no reviewer covers, the same proof failure again and again, a reviewer whose lens keeps
being caught by others, proofs that behavior later finds an unmet criterion in), at least 3 jobs
each by default (`--min <n>`), and writes a draft per suggestion to the advisor's log dir. It prints
`suggestions`, each with `id`, `title`, `station`, `jobs`, `files` (what applying would write),
`draft` (the draft's path) and `factoryRun`. If there are none, say nothing. Otherwise summarise
each in a line or two in your own words, from the draft's rationale and evidence ("the verifier
passed 3 jobs that behavior then sent back for an unmet criterion; I drafted a change to its agent,
want to see it?"). These suggestions are about this repository only: never file them on GitHub.

If the user wants one, show the dry run. It writes nothing and prints the files and the exact diff:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations apply <id> --json
```

Show the user the diff, and ask whether to apply **that** draft. Only after a clear yes for that
specific id, apply it (this asks for permission). It writes only `.claude/agents/factory-*.md` and,
for a new reviewer, `factory.json`'s `reviewers`; backs up any file it overwrites; runs
`factory agents check` and puts everything back if that fails; and refuses a draft whose target
changed since it was made (run `stations suggest` again) or that was already applied or dismissed:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations apply <id> --confirm --json
```

Then tell the user to review and commit `.claude/agents/` and `factory.json`: nothing is committed.
The draft's `/factory:run` line is the alternative: it builds the same change through the factory.
When the user does not want a suggestion, dismiss it (this asks for permission):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor stations dismiss <id> --json
```

## Exit codes

0 success, 1 the command failed, 2 usage error. On a non-zero exit the reason is on stderr; show it
to the user instead of guessing. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor --help
```
