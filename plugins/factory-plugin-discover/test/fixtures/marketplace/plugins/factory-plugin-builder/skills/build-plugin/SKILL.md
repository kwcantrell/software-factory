---
name: build-plugin
description: Builds a new plugin for the software-factory marketplace from idea to a passing plugin - scaffold from the template, implement the CLI and skills, test, check against the repo's CLI convention and run the full gate. Use when asked to add, create or write a plugin (or a skill backed by a new CLI) in a software-factory checkout, or when a plugin there fails its convention, typecheck or tests.
---

# build-plugin

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder check
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder new
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-builder verify
```
