# factory-plugin-advisor

Makes the software-factory plugins improve from use. When Claude hits the same problem with one of
this marketplace's plugins again and again (a CLI failing, a workaround, a step done by hand, missing
skill guidance, a user correction), this plugin notices and drafts a fix: which plugin to change (or
a new plugin), the evidence, a proposed change and a paste-ready `/factory:run` request that the
factory in this repository can build. With your confirmation, a draft can be filed as a GitHub issue
on `kwcantrell/software-factory`, which is **public**.

It also watches the factory line itself: in a repository that runs the software factory, it
reports how each station agent (builder, verifier, every reviewer) has done across the jobs and
drafts new or changed station agents from fixed rules, which you can apply after a dry run (see
[Station agents](#station-agents)). Those suggestions stay in your repository and are never filed.

Install it from the marketplace (it needs Node.js 22.18+; `file --confirm` also needs the GitHub CLI,
`gh`):

```text
/plugin install factory-plugin-advisor --marketplace kwcantrell/software-factory
```

Occurrences come from two places:

- **Claude**, through the `factory-plugin-advisor` skill, records each friction with `record` (after a
  workaround, a manual step, missing or wrong guidance, or a user correction).
- **A hook** (`hooks/hooks.json`) records every failed run of a marketplace plugin's CLI on its own,
  except a `factory` exit 2 (escalated to a human), which is the line working as designed.

## Commands

Skills call the CLI as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor <command> [args] --json
```

and from a checkout you can run `node plugins/factory-plugin-advisor/src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `record --plugin <name> --kind <kind> --summary <text> [--detail <text>]` | Stores one occurrence. `<name>` is a software-factory marketplace plugin, a proposed new plugin name (kebab-case) or `none`; `<kind>` is `cli-failure`, `workaround`, `manual-step`, `missing-guidance` or `user-correction`. `record --stdin` reads `{"plugin","kind","summary","detail"}` as JSON instead. Prints the issue's `signature` and `count`. |
| `list [--min <n>] [--plugin <name>]` | Issues grouped by signature: count, first and last seen, plugin, kind, latest summary, and status (`open`, `suggested`, `dismissed`, `filed`). |
| `show <signature>` | One issue with all its occurrences (already redacted). A unique prefix of 4+ characters works. |
| `suggest [--threshold <n>]` | For every issue seen at least `n` times (default 3) that has not been suggested yet, or whose count has grown by `n` since it was, writes a draft to `drafts/<signature>.md` and returns it. Dismissed issues are never suggested. |
| `dismiss <signature>` | Stops all further suggestions for the issue. |
| `file <signature> [--repo <owner/name>] [--confirm]` | Without `--confirm`, prints exactly the title, body and repo that would be filed, and files nothing. With `--confirm`, runs `gh issue create --repo <repo> --title <title> --body-file -` (body on stdin, no shell), records the issue URL, and refuses to file the same issue again. Before either, it re-checks the draft and exits 1 if anything secret-looking is left: each stored value the draft quotes (summaries, detail lines) is checked on its own, and the rest of the draft, including anything edited in by hand, without them. Where the draft's own template names the target plugin (title, `/factory:run` line, backticks), the name is read as a neutral word, so a plugin called `token-helper` or `secret-store` is not mistaken for a secret key. The repo defaults to `kwcantrell/software-factory`. |
| `stations [--repo <path>]` | How each factory station agent has done in a repository's factory jobs. Read-only. See [Station agents](#station-agents). |
| `stations suggest [--min <n>] [--repo <path>]` | Applies the station rules to that history and writes a draft per suggested new or changed station agent. |
| `stations apply <id> [--confirm] [--repo <path>]` | Without `--confirm`, prints the files a draft would write and the diff, and writes nothing. With `--confirm`, applies it, with the safeguards below. |
| `stations dismiss <id> [--repo <path>]` | Never suggests or applies that station suggestion again. |
| `hook` | Reads a Claude Code hook input on stdin and records a failed marketplace CLI call. Used by `hooks/hooks.json`; prints nothing and always exits 0. |

Every command takes `--json` (one JSON value on stdout), `--help` and `--version`. Exit codes: 0
success, 1 the command failed, 2 usage error. On a non-zero exit stdout is empty and the reason is on
stderr.

The skill pre-approves `record`, `list`, `show`, `suggest`, `--help`, `stations --json` and
`stations suggest`. `file`, `dismiss`, `stations apply` and `stations dismiss` always ask for
permission, and the skill has Claude show you the dry run and wait for an explicit yes before
`file --confirm` or `stations apply <id> --confirm`.

## The log

Everything is kept in `$FACTORY_PLUGIN_ADVISOR_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/factory-plugin-advisor`, else `~/.config/factory-plugin-advisor`: directories
`0700`, files `0600`. The CLI refuses a location inside a git checkout, so the log can't be committed
by accident. It also refuses a location that is, holds or sits inside the log dir of a
`plugin-advisor` from another marketplace (`$PLUGIN_ADVISOR_CONFIG_DIR`,
`$XDG_CONFIG_HOME/plugin-advisor`, `~/.config/plugin-advisor`), so the two logs never mix.

| File | Contents |
| --- | --- |
| `occurrences.jsonl` | One occurrence per line: signature, plugin, kind, summary, optional detail, timestamp, source (`record` or `hook`), and for the hook the subcommand and exit code. Trimmed to the newest 2000 lines once it passes 1 MiB. |
| `state.json` | Per issue: when it was last suggested (and at what count), dismissed, or filed (with the issue URL). Per station suggestion: drafted, applied or dismissed. |
| `stations/<repo key>/` | Station suggestions for one repository: `<id>.md` (the draft), `<id>.json` (the files it writes) and `backups/`. See [Station agents](#station-agents). |
| `drafts/<signature>.md` | The draft suggestion: a `# title` line, then target, problem, evidence (occurrence count, first and last dates, the most recent occurrences), proposed change and the `/factory:run` line. This file is what `file` sends. |

**Redaction.** Before anything is stored, the summary and detail are redacted: everything after
`Authorization:` or `Proxy-Authorization:` to the end of the line (any scheme), every cookie value
after `Cookie:` or `Set-Cookie:` (attributes such as `Path` are kept), bearer and basic credentials,
`KEY=value`, `key: value`, `"key": "value"` and `--key value` where the key looks secret (token,
secret, password, passphrase, api key, cookie, credential, session, session id and similar) whatever the value's
length, the value after `-p` or `--password`, JWTs, URL credentials, PEM private keys, common
provider tokens (GitHub, Slack, AWS, `sk-`), and long random-looking strings (including full
40-character git SHAs and UUIDs; short SHAs and factory job ids are kept) all become `[redacted]`.
Then summaries are made one line and capped at 200 characters, details at 2000. A cut never lands
inside a `[redacted]` marker or leaves a dangling `key=` behind. Only an exact `[redacted]` counts as
already redacted: text after a typed marker (`Cookie: a=[redacted] x; b=secret`) is still redacted.

**Personal details.** Drafts are filed on a public repo, so the same path (the `record` flags and
`--stdin`, and the hook's error line) also masks personal details before anything is stored:

- the home part of a path becomes `~`: `/home/<user>`, `/Users/<user>`, `/root` and
  `C:\Users\<user>` (either slash), and the current user's `$HOME` and `os.homedir()` wherever
  they appear;
- the current username (`os.userInfo().username`, `$USER`, `$USERNAME`) becomes `[user]` as a whole
  word anywhere, unless it is shorter than 3 characters, a common word (`root`, `admin`, `user`,
  `runner`, `node`, `ubuntu`), or, ignoring case, a word the advisor writes itself: a marketplace
  plugin or CLI bin name (read from the marketplace at run time, e.g. `factory`, `factory-dev`) or
  a `factory` subcommand (`new`, `start`, `built`, `proof`, `round`, `verdict`, `merge`, `claim`, `remote`, `agents` and the
  rest of `factory --help`) or a `factory followup` subcommand (`add`, `list`, `done`, `drop`, as
  `factory followup --help` lists them). Masking those would turn every summary about that plugin
  or command into `[user] proof exited 1` and change its signature. The home part of such a user's paths
  (`/home/factory/...`) and `$HOME` are still masked;
- email addresses become `[email]`. npm scopes (`@types/node`), `git@host:owner/repo` remotes and
  decorators (`@param`) are not emails;
- GitHub mentions (`@` and 1 to 39 letters, digits or hyphens, not after a word character, `/` or
  `.`, not before `/`) become `@[user]`, so a filed issue notifies no one. npm scopes, emails, URLs
  and code inside backticks are left alone.

Drafts mask their quoted summaries and details again (after backticks become quotes), so a log
written before masking existed gives a clean draft. `file` (dry run and `--confirm`) refuses, with
exit 1 and the line number, a draft that still holds a home-dir path, the current user's home, an
email or a linkable mention, for example one edited in by hand.

**Signatures.** An issue's signature is a hash of the plugin, the kind and the summary normalised:
lower-cased, with URLs, emails, paths, UUIDs, factory job ids (`005-port-the-factory-cli-to-...`),
hex, ids and numbers masked. So "refused: 005-port-the-factory is at stage build after 2 rounds" and
"Refused: 012-add-docs-plugin is at stage build after 3 rounds" are the same issue.

## The hook

`hooks/hooks.json` registers `node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts hook` (exec form, no shell) as an
`async` `PostToolUseFailure` hook on `Bash`.

- **Why PostToolUseFailure.** Claude Code fires `PostToolUse` only for tool calls that succeed. A
  Bash command that exits non-zero fires `PostToolUseFailure` instead, with the command in
  `tool_input.command` and an `error` string whose first line is `Exit code N`, followed by the
  command's output ([hooks reference](https://code.claude.com/docs/en/hooks), "PostToolUseFailure
  input"). So the hook runs only after failed Bash calls, never after successful ones.
- **What counts.** A command running `npx ... -- <bin> <command>` where `<bin>` is a marketplace
  plugin's bin, or `node .../plugins/<plugin>/src/cli.ts <command>` (also the plugin cache's
  `.../<plugin>/<version>/src/cli.ts`). The bins are read at run time from the marketplace's
  `.claude-plugin/marketplace.json` and each plugin's `package.json` `bin`: next to this plugin in a
  checkout, else at the install location Claude Code records for `software-factory` in
  `~/.claude/plugins/known_marketplaces.json`. If neither is found, a built-in list of the plugins at
  the time of writing is used. An interrupted command is not recorded.
- **`factory` exit codes.** The `factory` CLI exits 1 when a gate refuses (recorded, with its
  `refused: ...` line) and 2 when it escalates a job to a human, which is by design and not recorded.
  Every other plugin's exit 2 (a usage error) is recorded.
- **What is kept.** Only the plugin, the subcommand, the exit code and the redacted first line of the
  CLI's own error message (`<bin>: ...`, `refused: ...` for `factory`, or npm's `npm error ...`).
  Never the command line and never the command's stdout.
- **Never in the way.** It prints nothing, always exits 0, and swallows any error. It runs `async`,
  so Claude does not wait for it. Input that cannot be a marketplace CLI failure is rejected by a
  string check before the rest of the CLI is loaded.
- **Why `node` and not the `npx` prefix.** The hook runs this plugin's own CLI either way. `npx`
  would add about 0.3 s of npm start-up to every failed Bash call. `node` on `src/cli.ts` needs no
  `--offline` guard, because it never resolves a package.

## Station agents

After a factory job ships, or when you ask how the line is doing, the skill runs `stations` and
`stations suggest` in the repository. They read the factory's own records and suggest changes to
the repository's station agents (job 019's `.claude/agents/factory-<station>.md`). These suggestions
are project-specific: they are never filed on GitHub.

**Where it reads.** The repository is `--repo <path>` (its `factory/`), else `FACTORY_DIR` (and its
parent), else the main checkout of the git repository you are in. It reads every
`factory/jobs/*/job.json` (`rounds[].reviewers`, `followups[]`, `history[]`; each is optional, so
job.json files written by older CLIs work) and, per job, `proof.md` and `review-<round>-<name>.md`.
Each station is resolved by running the factory plugin's own `factory agents --json` (the factory
plugin is found next to this one: `plugins/factory` in a checkout, the same version in the plugin
cache, else the marketplace's `factory` entry). Like every `factory` command, that refreshes the
dashboard copy in `factory/`; nothing else is written.

**What `stations` reports**, per station (builder, verifier, each configured reviewer, then any
reviewer that recorded verdicts but is no longer configured, as `unconfigured`): the agent
`/factory:run` launches and its file (`project` or `shipped`), jobs handled, and:

- builder and verifier: first-pass proof rate (jobs whose first proof passed), proof passes and
  failures (from `history`), and the reason of each failure still in a `proof.md`;
- each reviewer: approve and changes counts, and how many of its "changes" were followed by its own
  approval in the next round (the rework passed);
- escalations: a `needs human: proof failed ...` counts for builder and verifier, `changes still
  requested after ... (<reviewers>)` for the builder and each named reviewer, `no approval after ...`
  for the builder;
- follow-ups recorded by that station (`followups[].by`).

**Themes.** Rules (a) and (c) group findings by theme. A text is about a theme when one of its
keywords starts a word in it (case-insensitive). A theme is covered by a reviewer named like it or
listed under "covered by":

| Theme | Keywords | Covered by |
| --- | --- | --- |
| `security` | security, vulnerab, inject, xss, csrf, ssrf, secret, credential, privilege, unauthori, authenticat, authoriz, sanitiz, redact, leak | security |
| `performance` | performance, slow, latency, throughput, memory, cpu, quadratic, o(n^2), n+1, benchmark, hot path | performance |
| `accessibility` | accessib, a11y, aria-, screen reader, screen-reader, keyboard navigation, focus order, contrast, alt text | accessibility, a11y |
| `docs` | documentation, docs, readme, changelog, docstring | docs, documentation, standards |
| `data-migration` | migrat, backfill, schema change, backward compat, backwards compat, old format, older format, data loss | data-migration, migration, migrations, compatibility |
| `concurrency` | concurren, race condition, racy, race between, deadlock, atomic, mutex, thread-safe, thread safe, simultaneous, in parallel | concurrency |
| `dependency` | dependenc, package-lock, lockfile, supply chain, supply-chain, third-party, npm install, unpinned, vendored | dependency, dependencies, supply-chain, security |
| `tests` | test coverage, untested, missing test, no test, flaky, weak test, assertion | tests, testing, behavior, standards |
| `correctness` | off-by-one, off by one, wrong result, incorrect, crash, edge case, regression, exit code | correctness, behavior |

A review's findings are its `Blocking` section(s) (a `## Blocking` heading or a `**Blocking**`
line; not `Non-blocking`), and only when job.json records that reviewer's verdict for that round as
`changes` (or does not record it). A section whose first line is `None`, `N/A`, `Nothing` or `No
findings` holds none.

**The rules.** Each needs at least `--min` jobs (default 3); rule (b) counts failures. Rules are
applied in this order and the output is sorted, so the same history always gives the same
suggestions, with the same ids (a hash of rule, station and key).

| Rule | Fires when | Suggests |
| --- | --- | --- |
| (a) `new-reviewer` | Follow-ups (any station) or blocking findings (any reviewer) in at least `n` jobs are about a theme that no configured reviewer covers | A new reviewer named after the theme: `.claude/agents/factory-reviewer-<theme>.md` and the name added to `factory.json` `reviewers` |
| (b) `modify-builder` | At least `n` proofs failed for the same reason: the first line of `proof.md`'s Failures section, normalised (numbers, paths, ids and job ids masked, as the advisor's signatures do). `proof.md` is rewritten on each attempt, so only the latest attempt of each job has a reason | A lesson in the builder agent: check for that reason before handing off |
| (c) `modify-reviewer` | For a configured reviewer R, in at least `n` jobs, either (miss) R approved a round and another reviewer's blocking findings in that or a later round, or a proof that failed after R's approval, were about a theme in R's own lens; or (overlap) R asked for changes and in the next round another reviewer's blocking findings were about a theme R's were about | A lesson in R's agent |
| (d) `modify-verifier` | At least `n` jobs passed proof and then got a `behavior` "changes" whose blocking findings name an unmet criterion (`criterion`, `criteria` or `acceptance`) | A lesson in the verifier agent |

**Drafts.** `stations suggest` writes, per suggestion, `stations/<repo key>/<id>.md` (the draft) and
`<id>.json` (the exact files to write and a hash of each target as it was) to the log dir, owner-only
like the rest of the log. A suggestion that was applied or dismissed is not drafted again; one that
is drafted again is rewritten against the files as they are now. The draft holds:

- a title, the rule, the station and the repository;
- the rationale and the evidence: the job ids and counts, and up to 10 quoted follow-ups, findings or
  proof failures. Quoted text is redacted, made one line, capped at 200 characters and has personal
  details masked, as everywhere else in the log;
- the change. A new agent is a complete file made from the factory plugin's template for that
  station kind (`templates/agents/<kind>.md`), its placeholders filled as `factory agents new` fills
  them, its `fill` sections taken from the repository's other project agents where they have them
  (else a pointer to the repository's own docs), and, for a reviewer with no shipped agent, a lens
  written from the theme and the jobs that raised it. A modification is a unified diff against the
  project agent, adding a bullet under a `## Lessons from this line` section; a station that runs on
  the shipped fallback gets a new project agent from the template instead, with that section;
- how to apply it, and a paste-ready `/factory:run` line that makes the same change through the
  factory instead.

Agent text added by a draft holds only job ids, counts, theme names and the normalised failure
reason, never quoted text. Before a draft is written, its agent files are run through `factory
agents check` in a scratch directory; one that fails is reported under `problems` and not drafted.

**Applying.** `stations apply <id>` is a dry run: it prints each file it would create or overwrite
and the diff, and changes nothing. `stations apply <id> --confirm`:

- writes only `<repo>/.claude/agents/factory-*.md` and `<repo>/factory.json`, and refuses any other
  path and any symbolic link on the way;
- refuses (exit 1) when a target changed, appeared or disappeared since the draft was made (run
  `stations suggest` again), and when the draft was already applied or dismissed;
- for a new reviewer, adds its name to `factory.json` `reviewers`, keeping its other keys, or
  creates `factory.json` with the current reviewers plus the new one;
- backs up every file it overwrites to `stations/<repo key>/backups/<id>-<time>/` in the log dir,
  outside the repository and its `factory/`;
- runs `factory agents check` (which also loads `factory.json`); if it fails, every file is put back
  as it was (created files and directories removed), the draft stays unapplied, and the command
  exits 1 with the check's output;
- never commits: review and commit `.claude/agents/` and `factory.json` yourself.

## Versioning

Every plugin in this marketplace carries the same version, the repository's. `CHANGELOG.md` lists what changed in each release. A patch release carries fixes only.
