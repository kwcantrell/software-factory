---
name: dashboard
description: Start the software factory dashboard, a live board of factory jobs moving through intake, build, proof, review and ship. Use when the user asks to see or open the factory dashboard or job status board.
---

# dashboard

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory dashboard
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status
```
