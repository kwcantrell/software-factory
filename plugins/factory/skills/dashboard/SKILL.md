---
name: dashboard
description: Start the software factory dashboard, a live board of factory jobs moving through intake, build, proof, review and ship. Use when the user asks to see or open the factory dashboard or job status board.
argument-hint: [port]
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory dashboard:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory status:*)
---

# Factory dashboard

Requested port (optional): $ARGUMENTS

**The `factory` CLI.** Wherever this skill says `factory <command>`, run exactly this, from any directory, with no install or build step (never a bare `factory`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory <command>
```

Start the dashboard server in the background with the Bash tool (`run_in_background: true`):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory dashboard --port 8787
```

It serves the project's `factory/` directory (the job records the board reads) on 127.0.0.1 only. With a remote factory it pulls the shared job state once when it starts (or not at all with `--offline`); restart it, or run `factory status`, to pull again.

Then give the user the URL (`http://127.0.0.1:<port>/`) in one line. If the port is taken, pick the next free one. For a quick text view instead, run `factory status`; `factory dashboard --help` lists the server's options.

If `factory` refuses `factory.json` (an unknown key) or a `job.json` it cannot read, the repo was likely written by another software-factory version: point the user to `factory-doctor migrate` (the factory-doctor skill), which replaced `factory upgrade`, instead of editing either file.
