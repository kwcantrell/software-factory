---
name: factory-plugin-advisor
description: Records friction with the software-factory marketplace plugins (factory, factory-plugin-builder, factory-dev, factory-docs and the rest) and suggests a plugin change once the same issue recurs. Use after working around a software-factory plugin's bug or gap, after doing by hand something one of those plugins should do, when a plugin skill's guidance was missing or wrong, when the user corrects how a plugin was used, and at the end of a task to check for recurring issues worth a fix.
---

# factory-plugin-advisor

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor dismiss
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor file
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor list
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor record
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor show
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-advisor suggest
```
