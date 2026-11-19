---
name: run
description: Run a request through the software factory - triage it into scoped jobs, build each in an isolated worktree, prove it independently, review it with three reviewers, and stop at the human merge gate. Use when the user asks to run, build or ship something "through the factory", or to continue factory jobs.
---

# run

Fixture: the frontmatter and command lines of the real skill.

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory built
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory config
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory followup
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory human
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory new
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory note
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory path
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory proof
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory round
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory spec
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory start
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory stats
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory verdict
```
