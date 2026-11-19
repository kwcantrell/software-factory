---
name: approve
description: Human spec gate for the software factory. Approves a job's task.md so it can be built, or sends it back with changes.
---

# approve

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory path
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status
```
