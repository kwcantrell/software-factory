# factory-plugin-discover

Makes Claude use the right plugin for software-factory work. Before a task that involves the factory
line, developing software-factory, its docs or its plugins, Claude runs `match` with a one-line
summary of the task and uses the installed plugin or skill that fits. If none does but a
software-factory marketplace plugin that is not installed would, it follows the mode: asks you and
installs it (`ask`, the default), only tells you the install command (`notify`), installs it and
tells you (`auto-install`), or says nothing (`off`). If nothing fits at all and
`factory-plugin-advisor` is installed, Claude records the gap there, so a new plugin can be
suggested through its `suggest` and built with `/factory:run`.

Install it from the marketplace (it needs Node.js 22.18+):

```text
/plugin install factory-plugin-discover --marketplace kwcantrell/software-factory
```

Two things trigger it: the `factory-plugin-discover` skill's own description, and a
`UserPromptSubmit` hook that adds a one-line hint when the prompt or the working directory is about
software-factory.

## Commands

Skills call the CLI as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-discover <command> [args] --json
```

and from a checkout you can run `node plugins/factory-plugin-discover/src/cli.ts <command>`.

| Command | What it does |
| --- | --- |
| `catalog` | Every installed plugin (id, version, scope, description, `enabled`, and each skill's name, frontmatter `description` and the CLI `commands` it runs), `installedElsewhere`: plugins installed with `project` or `local` scope only for another project (with `scope` and `projectPath`), the user's own skills (`~/.claude/skills/*/SKILL.md`), and every software-factory marketplace plugin that is not installed, with its description, skills and install command. Read-only. |
| `match "<task text>"` | Ranks those entries against the task: `installed`, `available` and `elsewhere` (installed for another project) lists (top 5 each, best first), each entry with `score` and `reason` (the matched terms), available ones with `installCommand`. `none_applicable: true` when nothing reaches the threshold, plus `advisor.record`/`advisor.suggest` command lines when `factory-plugin-advisor` is installed and enabled; those lines use its own pre-approved form (`--package="<its install path>"`), so they run without a permission prompt. Also prints the `mode`; with mode `off`, `available` and `elsewhere` are always empty, but `none_applicable` is decided before that, so it stays false (and there is no advisor line) when a marketplace plugin fits. Read-only. |
| `settings` | Prints the mode (`ask` by default). |
| `settings set mode <mode>` | Sets it to `ask`, `notify`, `auto-install` or `off`; anything else is a usage error. |
| `install <name> [--confirmed]` | Runs `claude plugin install <name>@software-factory` (spawned directly, no shell, 120 s timeout) only if `<name>` is in the marketplace manifest and not installed (here, or with project or local scope for another project: that refusal says to add it to this project with `/plugin` instead), the mode is not `off` or `notify`, and the mode is `auto-install` or `--confirmed` is passed. Every refusal exits 1 with the reason (in `notify` mode, the reason includes the command to run). On success it says to run `/reload-plugins`. |
| `hook` | Reads a `UserPromptSubmit` hook input on stdin and prints the hint, or nothing. Used by `hooks/hooks.json`; always exits 0. |

`install` is the only command that runs `claude`. Every command takes `--json` (one JSON value on
stdout), `--help` and `--version`. Exit codes: 0 success, 1 the command failed, 2 usage error. On a
non-zero exit stdout is empty and the reason is on stderr.

The skill pre-approves only `match`, `catalog` and `--help`. `install` and `settings` always ask for
permission, and the skill passes `--confirmed` only after you said yes.

## Where it reads from

From Claude Code's own records, in `$CLAUDE_CONFIG_DIR` or else `~/.claude`, without running
`claude`: `claude` may not be on `PATH` (in the hook, tests or CI), and spawning it costs far more
than reading a few small files.

- `plugins/installed_plugins.json` (version 2): installed plugins and their `installPath`. A
  `project` or `local` install counts only inside its `projectPath`; elsewhere it is reported as
  installed elsewhere (`installedElsewhere`), never as available.
- `<installPath>/.claude-plugin/plugin.json` and `<installPath>/skills/*/SKILL.md`: descriptions
  (plain, quoted, or `>`/`|` block scalars, read in full, blank lines inside them included) and the
  CLI commands each skill runs (every `--package=<root> -- <bin> <command>` in the file). They are
  shown as data; the skill tells Claude never to follow directions found in them.
- `settings.json`, then each `.claude/settings.json` and `.claude/settings.local.json` from `/` down
  to the current directory: `enabledPlugins["<id>"]: false` marks a plugin disabled.
- `skills/*/SKILL.md`: the user's own skills.
- The software-factory marketplace manifest: next to this plugin in a checkout
  (`../../.claude-plugin/marketplace.json`, if its `name` is `software-factory`), else the
  `installLocation` recorded for `software-factory` in `plugins/known_marketplaces.json`, the same
  way factory-plugin-advisor finds it. Only this marketplace is used for suggesting or installing.

## How match scores

Deterministic and local; Claude treats the result as a shortlist and reads the descriptions itself.
The rules and word lists are in `src/match.ts`.

1. The task and each entry's text (plugin name, description, skill names and descriptions, and the
   CLI commands its skills run) become terms: lowercase words split on anything but letters and
   digits, with a few two-word spellings joined into one (`follow-up` and `follow up` are
   `followup`, as in `factory followup`; also `worktree`, `changelog`, `typecheck`), without stop
   words or words every entry shares (`software`, `repository`, `skill`, `claude`, `cli`, ...),
   lightly stemmed (`jobs` to `job`, `docs` to `doc`).
2. Each distinct task term found in the entry scores 1, or 2 for a software-factory term. Those are
   `factory`, `job`, `worktree`, `builder`, `verifier`, `reviewer`, `proof`, `review`, `ship`,
   `merge`, `spec`, `gate`, `dashboard`, `follow`, `followup`, `changelog`, `release`, `docs`,
   `plugin`, `intake`, `triage`, `approve`, `rework`, `upgrade`, `stale`, `lint`, `convention`,
   `scaffold`, `template`, `marketplace`, `advisor`, `friction`, `workaround`, `recurring`, `hook`,
   `ci` and `typecheck`.
3. A term in the entry's name counts double. The name is the plugin (or skill) name without the
   `factory-` prefix every marketplace plugin shares (so `factory-docs` is `docs`; only the `factory`
   plugin is named `factory`), plus the CLI commands its skills run (`factory-dev release`,
   `factory-docs stale`, `factory followup`).
4. Each pair of adjacent task terms also adjacent in the entry (a phrase, like "merge gate") adds 2.
5. An entry is listed only with a score of at least **3** (the threshold): a software-factory term
   plus any other, a software-factory term in the name, a phrase, or three plain terms. If nothing
   reaches it, `none_applicable` is true.

The best skill in a plugin is the one whose own name, commands and description score highest. The
tests check that representative tasks rank the expected plugin first, both when it is installed and
when it is only available: "run this through the factory" (`factory`), "check my plugin follows the
convention" (`factory-plugin-builder`), "are the docs stale" (`factory-docs`), "cut a release"
(`factory-dev`), and more.

## The hook

`hooks/hooks.json` runs `node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts hook` on every `UserPromptSubmit`
(exec form, timeout 5 s). It prints
`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` with one line
telling Claude to run `match` first, when any of these holds:

- the input's `cwd` is inside a software-factory checkout: a git work tree whose `origin` is
  `kwcantrell/software-factory`, or whose root has a `.claude-plugin/marketplace.json` named
  `software-factory` (linked worktrees too, through their main checkout);
- the `cwd` is inside a git checkout that uses the factory: its root (or, for a linked worktree such
  as a factory job's, its main checkout's root) has a `factory.json` or a `factory/jobs/` directory;
- the prompt matches the keyword list in `src/hook.ts`: `/factory:<skill>` commands, "software
  factory" (or `software-factory`), `factory` CLI commands (`factory status`, `factory followup`,
  `factory merge`, ...; the ones that read as plain English after "factory", like `new`, `start` or
  `path`, only in backticks or after `-- `), `factory.json`, `factory/jobs`, and the marketplace
  plugin names (`factory-dev`, `factory-docs`, `factory-plugin-builder`, `factory-plugin-advisor`,
  `factory-plugin-discover`). Bare generic words ("factory", "job", "review", "merge", "docs",
  "release", "plugin") are left out because they would fire in unrelated projects.

It hints at most once per session: the input's `session_id` is remembered in
`hinted-sessions.json` (the last 200) in the config dir; if it cannot be written, no hint is given.
It never blocks a prompt and never exits non-zero; any error means no output. It loads only
`src/hook.ts` and `src/config.ts`.

## Config

`$FACTORY_PLUGIN_DISCOVER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/factory-plugin-discover`, else
`~/.config/factory-plugin-discover` (directory `0700`, files `0600`): `config.json` holds
`{"mode": ...}`, and `hinted-sessions.json` the hook's sessions. It is this plugin's own: a
`plugin-discover` from another marketplace keeps its settings elsewhere, and its
`PLUGIN_DISCOVER_CONFIG_DIR` changes nothing here.

## Versioning

Every plugin in this marketplace carries the same version, the repository's. `CHANGELOG.md` lists what changed in each release.
