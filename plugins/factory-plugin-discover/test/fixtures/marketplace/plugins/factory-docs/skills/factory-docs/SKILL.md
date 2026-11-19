---
name: factory-docs
description: Keeps the software-factory repository's docs (README, CLAUDE.md, CONTRIBUTING.md, CHANGELOG.md, plugin READMEs, skill and agent prompts) in sync with its code. Use when changing software-factory itself, before finishing a change, committing or opening a PR, and when asked which docs describe a file.
---

# factory-docs

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs gate
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs lint
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs stale
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-docs which
```
