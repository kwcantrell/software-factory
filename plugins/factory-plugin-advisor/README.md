# factory-plugin-advisor

Makes the software-factory plugins improve from use. When Claude hits the same problem with one of
this marketplace's plugins again and again (a CLI failing, a workaround, a step done by hand, missing
skill guidance, a user correction), this plugin notices and drafts a fix: which plugin to change (or
a new plugin), the evidence, a proposed change and a paste-ready `/factory:run` request that the
factory in this repository can build. With your confirmation, a draft can be filed as a GitHub issue
on `kwcantrell/software-factory`, which is **public**.

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
| `hook` | Reads a Claude Code hook input on stdin and records a failed marketplace CLI call. Used by `hooks/hooks.json`; prints nothing and always exits 0. |

Every command takes `--json` (one JSON value on stdout), `--help` and `--version`. Exit codes: 0
success, 1 the command failed, 2 usage error. On a non-zero exit stdout is empty and the reason is on
stderr.

The skill pre-approves `record`, `list`, `show`, `suggest` and `--help`. `file` and `dismiss` always
ask for permission, and the skill has Claude show you the dry run and wait for an explicit yes
before `file --confirm`.

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
| `state.json` | Per issue: when it was last suggested (and at what count), dismissed, or filed (with the issue URL). |
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
  word anywhere, unless it is shorter than 3 characters or a common word (`root`, `admin`, `user`,
  `runner`, `node`, `ubuntu`);
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
