# factory-doctor

What does running this app need on this machine? `factory-doctor` keeps the answer in a committed,
reviewable file in the application's repository, `.factory/doctor.json`, per **profile** (dev, stage,
test, ...): the tools and their versions, the environment variable **names**, the files, the TCP
services, and the Claude Code plugins and skills. It **checks** this machine against a profile and
says exactly what is missing and how to fix it, and it **scans** the repository for evidence and
proposes requirements, which go into the file only after the person confirms.

The factory line's builder and verifier run the check first (see [The factory line](#the-factory-line)).

It also **migrates** a repository between software-factory versions, up or down, and updates the
installed software-factory plugins with confirmation (see [Migrate](#migrate)); it replaced
`factory upgrade`.

## What it never does

- **Store a value.** The file records names. Loading it refuses a key named `value`, `default` or
  `secret` anywhere (profile names aside), `add` refuses `--value`, `--default` and `--secret` and an
  env name written `NAME=value`, and none of those refusals echo the value.
- **Print a value.** `check` reads a variable's value only to test its format, and no line of its
  output (text or JSON, stdout or stderr) is built from it; a failed format check says "set, but
  not a URL". Dotenv files are read for variable **names** only, by `check` and by `scan`, and
  `scan` reads NODE_ENV-style values only from `package.json`, compose files, workflows and
  Dockerfiles, never from a dotenv file.
- **Send anything.** No network, except the TCP connect (opened and closed, nothing sent) that a
  `service` requirement asks for, and what Claude Code's own `claude plugin` commands fetch when
  `migrate --update-plugins --confirmed` runs them.
- **Set, generate or fetch values, install tools or plugins, or start services or the app.** `check`
  prints the fix; the person acts on it. Installing a plugin stays with `claude plugin install` (or
  `factory-plugin-discover install`); `migrate --update-plugins` only updates plugins already installed.
- **Run anything but the tool it checks** (`check`), and, for `migrate`, the installed factory
  plugin's `factory migrate-repo` plumbing through npx and `git`; `claude` only with
  `migrate --update-plugins --confirmed`. A `tool`'s version is read by running that tool, the file
  found on `PATH`, with the one argument in its `version_command` (default `--version`), without a
  shell, from a neutral directory (the system temp dir, not the repository). That argument must be a
  version probe (`--version`, `-version`, `-v`, `-V`, `version`, `-Version` or `--Version`); a
  `version_command` naming another program, or with any other or further argument (`node -e ...`,
  `python -c ...`, `node -r <module>`), is refused, so a committed file cannot make `check` run code.

## The file

`.factory/doctor.json` in the repository root (the nearest directory up from the current one that
holds `.git`); `--file <path>` uses another. Paths inside it (`file` requirements, `dotenv`) are
relative to the repository root, and `~/` is the home directory. Format version 1, in full:

```json
{
  "version": 1,
  "description": "What running the shop app needs",
  "default_profile": "dev",
  "profiles": {
    "base": {
      "description": "Needed everywhere",
      "requires": [
        { "kind": "tool", "name": "node", "version": ">=22.18", "why": "runs the app", "source": "package.json:8" },
        { "kind": "tool", "name": "java", "version": "^21", "version_command": ["java", "-version"], "version_pattern": "version \"([\\d.]+)\"", "why": "the search service" }
      ]
    },
    "dev": {
      "description": "Running the app locally",
      "extends": "base",
      "dotenv": [".env"],
      "requires": [
        { "kind": "env", "name": "DATABASE_URL", "description": "Postgres connection URL", "format": "url", "why": "the app stores orders", "source": ".env.example:2" },
        { "kind": "env", "name": "LOG_LEVEL", "optional": true, "why": "quieter logs" },
        { "kind": "env", "name": "REGION", "format": { "regex": "^[a-z]+-[a-z]+-\\d$" }, "why": "picks the bucket" },
        { "kind": "file", "path": "certs/dev.pem", "why": "TLS for the local server" },
        { "kind": "service", "host": "localhost", "port": 5432, "why": "the database" },
        { "kind": "claude-plugin", "name": "factory-docs@software-factory", "why": "the docs gate" },
        { "kind": "claude-skill", "name": "factory-docs:factory-docs", "why": "the docs gate" }
      ]
    },
    "test": {
      "description": "Running the test suite",
      "extends": ["dev"],
      "requires": [
        { "kind": "tool", "name": "psql", "why": "a CI step loads fixtures", "source": ".github/workflows/ci.yml:31" },
        { "kind": "service", "host": "127.0.0.1", "port": 6379, "timeout_ms": 500, "optional": true, "why": "cache tests" }
      ]
    }
  }
}
```

- **Top level**: `version` (1), optional `description`, optional `default_profile` (must name a
  profile), and `profiles`.
- **A profile**: optional `description`; optional `extends`, one profile name or a list (parents
  apply first, in order; a requirement with the same kind and name in a later profile replaces it;
  a cycle or a missing parent is refused); optional `dotenv`, files whose variable names count as
  set; and `requires`.
- **Every requirement**: `kind`, `why` (required), optional `source` (`file:line` where it was
  found) and `optional` (true: a problem with it is reported but does not fail `check`). Its name
  is `name`, or `path` for a file, or `host:port` for a service; two with the same kind and name
  in one profile are refused.
- **`tool`**: `name`, a command on `PATH` (no path); optional `version`, `>=1.2.3`, `^1.2.3` (same
  major; for 0.x, same minor) or an exact `1.2.3` (fewer parts match more: `22` is any 22.x);
  optional `version_command` (the tool, then at most one version probe such as `-version`; see
  "What it never does") and `version_pattern` (a regex
  whose first group is the version; by default the first `1.2.3`-like number of the output).
- **`env`**: `name`, a variable name; optional `description`; optional `format`, `non-empty`, `url`,
  `integer` or `{"regex": "..."}` (tested with `RegExp.test`, so anchor it yourself). Checked in the
  process environment first, then by name in the profile's `dotenv` files (whose formats cannot be
  checked: their values are never read).
- **`file`**: `path`, which must exist. Its contents are never read.
- **`claude-plugin`**: `name`, `<plugin>@<marketplace>`, installed for this project and enabled.
  **`claude-skill`**: `name`, a skill (`<skill>`, from an enabled plugin, the user's
  `~/.claude/skills` or the project's `.claude/skills`) or `<plugin>:<skill>`. Both are read from
  Claude Code's own records under `$CLAUDE_CONFIG_DIR`, else `~/.claude` (`plugins/installed_plugins.json`,
  the `enabledPlugins` of each settings file, each install's `skills/`), the same files
  `factory-plugin-discover` reads; `check` never runs `claude`.
- **`service`**: `host` and `port` must accept a TCP connection within `timeout_ms` (default 1000).

Anything else is refused when the file is loaded (exit 1), naming the JSON path:
`.factory/doctor.json: $.profiles.dev.requires[0].value: looks like a stored secret value ('value'); factory-doctor records names, never values`.

## Commands

Run through npx as the skill does (`npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-doctor <command>`),
or from a checkout with `node plugins/factory-doctor/src/cli.ts <command>`. Every command takes
`--file <path>` and `--json`.

| Command | What it does |
| --- | --- |
| `check [<profile>]` | Resolves the profile with its `extends` and checks each requirement: one line per requirement, `ok`, `missing` or `wrong`, and a `fix:` line for each problem. Exit 0 when everything required is in place (on stdout); exit 1 when anything required is missing or wrong (the report on stderr, stdout empty). The profile: the argument, else `$FACTORY_DOCTOR_PROFILE`, else `default_profile`; one that does not exist is a usage error (exit 2) that lists the profiles. No file: exit 1, pointing at `scan` and `init` |
| `scan` | Read-only. Proposes requirements not yet recorded, numbered, each with its `source` (file:line), the profile it suggests and why. Sources: env names in `.env.example`, `.env.sample`, `.env.<profile>.example` and real `.env*` files (names only), `process.env.X` / `process.env['X']`, `os.environ[...]`, `os.environ.get(...)`, `os.getenv(...)` in JS/TS/Python, `${X}` in compose files; tools from `package.json` `engines` and `packageManager`, `.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, Dockerfile `FROM` (docker, and the runtime of a known image), and well-known CLIs in `run:` steps of `.github/workflows/*.yml` (for the `test` profile); profiles from `.env.<name>` and `.env.<name>.example` file names and `NODE_ENV`/`APP_ENV`-style values. Skips `node_modules`, build output, hidden directories but `.github`, and the factory's runtime dir. A proposal's number holds while the repository's files stay the same, also after others are added |
| `profiles` | Lists the profiles: default, `extends`, description, requirement count with parents |
| `add <kind> <name> --profile <p> --why "<text>"` | Adds a requirement. Options: `--source <file:line>`, `--optional`; env: `--description`, `--format non-empty\|url\|integer\|regex:<re>`; tool: `--tool-version <c>`, `--version-command "<tool> <probe>"` (one version probe, as above), `--version-pattern <re>`. A service is named `<host>:<port>`, a file by its path. `add profile <name> [--description] [--extends a,b]` adds a profile. Refuses one already recorded in the profile or inherited |
| `add --from-scan <n> [--profile <p>] [--why "<text>"]` | Adds proposal `n` of `scan` (it scans again to find it), with its source |
| `remove <kind> <name> --profile <p>` | Removes a requirement from that profile (refused when it is inherited: remove it where it is declared); `remove profile <name>` (refused while another profile extends it or it is the default) |
| `migrate [--to <version>] [--repo <path>]` | Read-only. Detects the version of the repo and of the installed plugins and prints the plan to move to the target (default: the latest version this factory-doctor knows), in order, each step with its kind, files and why; exit 1 when the move is refused, with the reasons first. See [Migrate](#migrate) |
| `migrate --apply [--scope <s>]...` | Makes the automatic repo steps through the installed factory plugin's `factory migrate-repo`, backups first, then plans again and prints what is left; exit 0 when only manual or plugin steps are left |
| `migrate --update-plugins [--confirmed]` | The `claude` commands that move every installed software-factory plugin to the target together; only `--confirmed` runs them |
| `init` | Writes a starter file with `dev` (dotenv `.env`) and `test` (extends dev) profiles; refused when the file exists |

`add`, `remove` and `init` are **dry runs** that print the change unless `--confirm` is given. They
create `.factory/doctor.json` when it is missing (the first profile becomes `default_profile`), keep
the existing key order and the two-space indent, and validate the whole file before writing.

Exit codes: 0 success, 1 the command failed (something required missing, a refused change or
file), 2 usage error. Messages go to stderr as `factory-doctor: <message>`.

## Migrate

`migrate` moves a repository from one software-factory version to another, **up or down**.

**Where things are.** It reads the installed plugins from Claude Code's records
(`$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json`, else `~/.claude`; an install resolves to a
version by its release commit, else by its version), and the repository: settings that enable
`factory@kwcantrell-plugins`, the `factory/` dir's layout (the Python CLI's `.lock`, the dashboard a
release installed), the `job.json` fields in use, the `factory.json` keys, the project agents' fixed
sections and the `.factory/doctor.json` format. The repo's version is the newest thing it uses (or,
with nothing old in it, the installed plugins'). Going up, the repo's manual steps are checked
against the repo itself for every version up to the target, so they still show after the plugins
were updated first.

**The plan**, in order, each step with its kind and the files it touches and why:

- `plugin`: `claude plugin marketplace update software-factory`, then `claude plugin update
  <name>@software-factory` for each installed software-factory plugin, together. Claude Code can
  only install a marketplace's latest version, so a downgrade, or a target that is not the latest,
  gets the manual steps instead (a clone at the release tag, `claude plugin disable`, `claude
  --plugin-dir`), never a guessed command;
- `automatic`: what the factory CLI's plumbing changes (settings, the `factory/` dir, `factory.json`);
- `manual`: what the person does (refresh project agents with `/factory:agents`, set up signing for
  a remote factory, install or uninstall a plugin, the `claude plugin` commands of a legacy move).

Upgrades update the plugins first, then migrate the repo; downgrades migrate the repo first, while
the newer tools that read both formats are installed, then switch the plugins. A downgrade that
would lose meaning is **refused** up front (exit 1, nothing changed): a remote factory (its state
branch and signed history protect merges), an unfinished job whose recorded commit (`head`) protects
its merge, and any move before 0.3.0 (the retired Python CLI). Otherwise what the target cannot read
is migrated back: `factory.json` keys it refuses (`advisor`, and `"remote": null`, the local
default) and `job.json` fields it does not know.

**`--apply`** makes only the repo steps. It never edits `job.json` itself: it runs `factory
migrate-repo --from <version> --to <version> --apply` (the plumbing, in `plugins/factory/src/upgrade.ts`)
through npx with the installed factory plugin's root, and is refused when that plugin is not
installed, or is older than the plumbing (update the plugins first). The plumbing writes the backups
first: the runtime dir's originals under `factory/upgrade-backup-<time>/`, and the settings files
and `factory.json` in a private `factory-upgrade-backup-<time>/` (mode 0700) in the repo's git dir,
since settings can hold secrets. User-scope settings change only with `--scope user`. Then it plans
again and prints what is left.

**`--update-plugins`** prints the commands; only `--confirmed` runs them, stopping at the first
failure, and it says to restart Claude Code. It never installs a plugin that is not installed and
never removes one. With `--json`, every form prints one JSON value.

### The registry

`src/registry.ts` holds one entry per version a repo can be at, oldest first: `kwcantrell` (the
original plugin), `0.2.0`, `0.3.0`, `0.3.1`, `0.4.0`, `0.5.0` and `unreleased` (the `[Unreleased]` changes of
`CHANGELOG.md`, carrying the repo version). Each entry lists what moving to it changes in a repo
(`factory.json` keys, `job.json` fields, station-template fixed sections, requirements such as
remote signing, the doctor file format, the marketplace's plugins), each with its `up` and `down`
handling: `automatic`, `manual` (the exact step) or, going down, `refused` (the reason and the
person's choice). The keys, fields, sections and plugins of each version are derived from these
changes. `test/migrate.test.ts` fails when the newest version's lists differ from the checkout
(`DEFAULTS` and the `Job` interface in `plugins/factory/src/factory.ts`, the fixed sections in
`plugins/factory/templates/agents/`, `.claude-plugin/marketplace.json`) or from what `factory
migrate-repo --versions` knows, so a change that forgets the registry fails CI.

**Adding an entry.** When a change adds or removes a `factory.json` key, a `job.json` field, a fixed
section or a plugin, or adds a requirement or a doctor file format: add a `Change` to the
`unreleased` entry with its `up` and `down` handling (and, for a key or field, add it to the
`unreleased` row of `VERSIONS` in `plugins/factory/src/upgrade.ts`, and teach the plumbing the
downgrade when the target cannot read it). Mark a change whose job is not merged yet with `pending:
'<job>'`, and drop the mark once it lands (the test says so). At a release, rename `unreleased` to
the new version, here and in `VERSIONS` (with its `tag`, and its `commit` once tagged), and start a
new, empty `unreleased` entry carrying the new version, whose keys and fields equal the release's.

## The skill

`skills/factory-doctor/SKILL.md` tells Claude to run `check` before running, testing or demoing the
app and after a run fails with a missing command, variable, file, connection or skill; to run `scan`
when the file is missing or a failure is not covered by it; to show the proposed change and run
`add`, `remove` or `init` with `--confirm` only after the person agrees; and never to put a value in
the file, nor print or ask for a secret in chat. For `migrate`, it says when (after Claude Code
updates a software-factory plugin, when the user asks to switch versions, when `factory` refuses a
`factory.json` key or a `job.json`) and how: the dry run first; ask before `--apply`; ask again
before `--scope user`; ask separately before `--update-plugins --confirmed`; then tell the user to
restart Claude Code. Its `allowed-tools` pre-approves `check`, `scan`, `profiles`, `--help` and the
migrate dry runs `migrate` and `migrate --json` only, never `--apply` or `--update-plugins`.

## The factory line

The builder and verifier station templates (`plugins/factory/templates/agents/`) have a fixed
`doctor` section, with the same text in the shipped `factory:builder` and `factory:verifier`: when
the repository has `.factory/doctor.json`, the station runs the factory-doctor check for the profile
the task or project names, through this skill, before running the app; it reports a missing
required item in `build.md` or `proof.md` and does not work around it; the verifier records a run
the environment prevented as not verified, with why, never as a pass; a requirement newly
discovered during the job is added to `.factory/doctor.json` in the job's commits (by the builder),
where the reviewers see it; and when this plugin is not installed, the station says so once and
carries on.

## Layout

| Path | What it is |
| --- | --- |
| `src/cli.ts`, `src/run.ts` | Entry, argument parsing, usage text, exit codes |
| `src/requirements.ts` | The file format: types, validation, extends resolution, writing |
| `src/check.ts` | `check`: each kind on this machine, the report |
| `src/scan.ts` | `scan`: the sources and proposals |
| `src/edit.ts` | `add`, `remove`, `init` |
| `src/claude.ts` | Claude Code's plugin and skill records (copied from factory-plugin-discover's `catalog.ts`) |
| `src/version.ts` | Version constraints |
| `src/repo.ts` | The repository root, the file's location, dotenv names |
| `src/registry.ts` | The version registry `migrate` plans from |
| `src/migrate.ts` | `migrate`: detection, the plan, `--apply` through `factory migrate-repo`, `--update-plugins` |
| `test/` | `node:test` suites in temp dirs with a temp `HOME`, `CLAUDE_CONFIG_DIR` and `PATH`; `cli.test.ts` runs every skill command line through npx; `migrate.test.ts` keeps the registry in sync with the checkout and runs migrate against fixtures, the factory CLI and a fake `claude` |
