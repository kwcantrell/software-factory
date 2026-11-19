---
name: factory-plugin-discover
description: Finds which installed plugin or skill fits a piece of software-factory work before it starts, and offers to install a fitting software-factory marketplace plugin when none is installed. Use at the start of any task that involves the factory line (running work through /factory:run, jobs, worktrees, builder, verifier, reviewers, the merge gate, follow-ups, the dashboard), developing software-factory itself (its checks, releases, changelog), its docs, or its plugins (building one, its convention, friction with one) - and when a factory-plugin-discover hint says to run match first.
---

# factory-plugin-discover

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-discover catalog
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-discover install
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-discover match
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-plugin-discover settings
```
