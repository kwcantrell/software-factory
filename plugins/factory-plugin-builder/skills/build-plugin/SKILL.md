---
name: build-plugin
description: Builds a new plugin for the software-factory marketplace from idea to a passing plugin - scaffold from the template, implement the CLI and skills, test, check against the repo's CLI convention and run the full gate. Use when asked to add, create or write a plugin (or a skill backed by a new CLI) in a software-factory checkout, or when a plugin there fails its convention, typecheck or tests.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder check:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder verify:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder --help:*)
---

# Build a software-factory plugin

Every plugin in this marketplace is a TypeScript CLI run through `npx`, plus skills (and maybe
hooks) that call it. The rules are in the checkout's `CLAUDE.md` ("Plugin layout" and "CLI
convention"); read those sections before writing code. This plugin's CLI scaffolds, checks and
verifies. Run its commands exactly as written, from anywhere inside the checkout (or add
`--repo <path>`), with no install or build step first. `check`, `verify` and `--help` run without
asking; `new` writes into the checkout, so it asks for permission first.

1. Pick the name: kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 64 characters), not already
   in `plugins/`. It is the plugin, its first skill and its CLI bin name. Then scaffold it from
   `templates/plugin` (the same as `npm run new-plugin -- <name>`), with a one-sentence description:

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder new <name> --description "<text>" --json
   ```

   It prints `{"name","path","marketplace","description"}`: the plugin is in `plugins/<name>/` and
   listed in `.claude-plugin/marketplace.json`, at the version the other plugins share (so leave
   `version` alone). Exit 1 means the name is taken; exit 2 means it is not kebab-case. Either way
   nothing was written.

2. Implement the commands. Put each command's logic in `src/<logic>.ts` as plain functions, and wire
   them in `src/run.ts` (argument parsing with `parseArgs`, usage text, `--json`, exit codes 0/1/2,
   errors on stderr only). Delete the template's `hello` command, `src/hello.ts` and its tests. Use
   only Node's standard library, relative imports ending in `.ts`, erasable TypeScript only, no
   dependencies in the plugin's `package.json`, and no Python or shell scripts.

3. Write the skills in `skills/<skill>/SKILL.md` with a frontmatter `name` equal to the folder: say
   when to use the skill and which command to run. Every command line goes in a ` ```sh ` block and
   starts with the exact prefix (`npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}"
   -- <name>`), and the frontmatter `allowed-tools` allows that prefix. Commands that write, act on
   the machine or need a person are left out: then pre-approve only the safe ones, one rule each
   (`Bash(<prefix> <name> <command>:*)`, comma-separated), like this skill does. Name arguments as
   `<placeholder>`s.

   If the plugin needs a hook, put it in `hooks/hooks.json` and make every `command` hook run the
   plugin's TypeScript in exec form: `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts",
   "<command>"]` (`plugins/factory/hooks/hooks.json` is the example). `check` reports anything else
   under the `hooks-cli` rule.

4. Write the tests in `test/`: unit tests that call `run()` with a fake `Io`, and the end-to-end test
   (start from the template's `test/cli.test.ts`) that runs every skill's command lines through npx
   from a fresh copy, filling the placeholders.

5. Check the plugin against the convention:

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder check <name> --json
   ```

   Exit 1: stdout is empty and stderr lists each finding as `<file>:<line>: [<rule>] <problem>`
   with a `fix:` line under it. Apply the fixes and run it again until it exits 0.

6. Run the full gate (check, `claude plugin validate` for the plugin and the marketplace,
   `npm run typecheck`, and the plugin's tests); the steps' own output streams on stderr:

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder verify <name> --json
   ```

   It prints JSON with `ok` and one entry per step (`pass`, `fail` or `skipped`). A step is
   `skipped` only when `claude` is not on the PATH; say so to the user, since that step did not
   run. On exit 1 fix the failing steps and run it again.

7. Before finishing, list the plugin in the root `CLAUDE.md`, give it a `README.md`, add an entry
   under `## [Unreleased]` in `CHANGELOG.md`, and check that every plugin still follows the
   convention:

   ```sh
   npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder check --all --json
   ```

Exit codes: 0 success, 1 the command or a check failed, 2 a usage error or not inside a
software-factory checkout; the reason is on stderr. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder --help
```
