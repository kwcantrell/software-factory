---
name: factory-signing
description: Makes the git commits Claude makes signed with the user's own SSH key through their ssh-agent - diagnoses what is missing, sets git up only after the user says yes, and prints the user's allowed-signers line. Use before committing in a repository that requires signed commits (commit.gpgsign=true, or a remote software factory), when a git commit, merge, rebase, cherry-pick or a factory command fails with a signing error (or the factory-signing hook denies one), and when the user asks to sign their commits or set up SSH commit signing.
allowed-tools: Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing status:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing allowed-signers:*), Bash(npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing --help:*)
---

# factory-signing

Every commit you make here (factory state commits, builder commits on job branches, and any
`git commit`, merge, rebase, cherry-pick, revert or am) should be signed with **the user's own SSH
key**, through their ssh-agent. This plugin never generates a key, never reads or copies a private
key, and cannot enter a passphrase. Run its CLI exactly as written, from any directory (add
`--repo <path>` for another repository), with no install or build step.

**When to run `status`:** before committing in a repository that requires signing, and whenever a
commit or a `factory` command fails with a signing error, or this plugin's hook denies a command.
It only reads, and exits 0 whatever it finds:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing status --json
```

It reports `gpg.format`, `user.signingkey`, `commit.gpgsign`, `tag.gpgsign` (with the config level
each comes from), whether an ssh-agent is reachable and holds the signing key, a test signature,
whether the repository requires signing and why, and, for a remote factory with
`allowed_signers`, whether the user's key is listed there at HEAD. `problems` holds one `fix` per
problem: tell the user each one.

**The passphrase is the user's.** When the key is not loaded in the agent, ask the user to type
`! ssh-add <path to their private key>` themselves at the Claude Code prompt (status prints the
exact line). Never try to load a key, enter a passphrase or read a private key yourself.

**Setting git up.** Show the dry run first; it changes nothing and prints the exact `git config`
commands (`gpg.format ssh`, `user.signingkey <public key>`, `commit.gpgsign true`,
`tag.gpgsign true`) for this repository's local config, which its worktrees share. Without
`--key` it uses the one key loaded in the agent; with several, pass `--key <public key path>`:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing setup --key <public key path>
```

Show the user the commands and ask. Only after they say yes, apply it (it asks for permission; it
then reruns `status` and prints the result):

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing setup --key <public key path> --confirm
```

`--scope global` writes the user's global git config instead. Never choose it yourself: show its
dry run and ask again, separately, before running it with `--confirm`.

**Allowed signers.** For a remote factory (or any project that checks signatures), print the
user's line, `<user.email> <public key>`, and tell them to add it to the project's allowed-signers
file by pull request. The command writes nothing:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing allowed-signers
```

**Never bypass signing.** Do not use `--no-gpg-sign`, `-c commit.gpgsign=false`, another
`gpg.format`, `unsigned_ok` in `factory.json`, or any other way around it to get a commit through.
If signing does not work, stop, run `status`, and tell the user what to fix.

Exit codes: 0 success, 1 the command failed or was refused (the reason is on stderr; show it to the
user), 2 usage error. Every command and option:

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing --help
```
