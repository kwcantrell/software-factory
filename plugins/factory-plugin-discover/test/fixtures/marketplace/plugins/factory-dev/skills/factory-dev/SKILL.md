---
name: factory-dev
description: Runs the software-factory repository's own dev checks - every CI gate in one command, and the release tag/version check. Use when developing software-factory itself (changing its plugins, template, docs, manifests or workflows): before finishing any change, and before tagging a release.
---

# factory-dev

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev check
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-dev release
```
