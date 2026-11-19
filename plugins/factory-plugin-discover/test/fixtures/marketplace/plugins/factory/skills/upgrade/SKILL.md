---
name: upgrade
description: Upgrade a repository from an older Software Factory (the original factory@kwcantrell-plugins plugin, or factory@software-factory 0.2.0 with the Python CLI) to this version - switch the plugin in Claude Code settings, migrate the factory/ runtime dir, and list what the user must do by hand. Use when the user asks to upgrade, migrate or move a repo to the current factory plugin.
---

# upgrade

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory upgrade
```
