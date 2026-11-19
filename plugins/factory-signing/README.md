# factory-signing

Makes **every commit Claude makes** signed with **your own SSH key**, through your ssh-agent: the
software factory's state commits in a [remote factory](../../README.md#remote-factory), builder
commits on job branches, and any `git commit`, merge, rebase, cherry-pick, revert or am Claude runs.
Claude can't type a passphrase or guess git's signing settings, so without this a missing setup only
shows up as a refused command or an unsigned commit. This plugin:

- diagnoses what is missing (`status`);
- sets git up, only when you confirm (`setup`);
- prints your line for an allowed-signers file (`allowed-signers`);
- has a hook that stops Claude from making an unsigned commit in a repository that requires signing.

Install it from the marketplace (it needs Node.js 22.18+ and OpenSSH 8.2+ for `ssh-keygen -Y`):

```text
/plugin install factory-signing --marketplace kwcantrell/software-factory
```

## What it never does

- **Generate a key.** It uses the key you already have. Make one yourself with `ssh-keygen -t ed25519`
  if you need one.
- **Touch a private key.** It never writes, copies or uses one, and reads only public keys. To
  recognise a private key passed by mistake (and refuse it), it looks at the file's first 16 bytes
  for the `-----BEGIN` armour, and nothing else. Its test signature hands `ssh-keygen` only a copy of
  the public key, so the signature must come from the agent.
- **Enter a passphrase.** Claude cannot type one, so loading the key is yours: run
  `! ssh-add ~/.ssh/id_ed25519` (your key's path) yourself at the Claude Code prompt. The `!` runs it
  in your session, where `ssh-add` can ask for the passphrase. The ssh-agent must be reachable from
  the shell Claude Code runs in (`SSH_AUTH_SOCK`); start one with `eval "$(ssh-agent -s)"` before
  starting Claude Code if needed.
- **Bypass signing.** No command or option turns signing off, and the skill tells Claude never to
  use `--no-gpg-sign`, `-c commit.gpgsign=false`, another `gpg.format` or `unsigned_ok`.
- **Write anything but git config.** `setup --confirm` writes four git settings and nothing else;
  `allowed-signers` only prints. Add its line to the project's allowed-signers file **by pull
  request**, like any change to who is trusted.

Only SSH signing is supported (`gpg.format ssh`), as in the remote factory, whose allowed-signers file
lists SSH keys.

## Commands

The skill calls the CLI as

```sh
npx --yes --offline --loglevel=error --package="${CLAUDE_PLUGIN_ROOT}" -- factory-signing <command> [options]
```

and from a checkout you can run `node plugins/factory-signing/src/cli.ts <command>`. Each command
acts on the repository in the current directory, or on `--repo <path>`; `--json` prints one JSON
value. The skill pre-approves `status`, `allowed-signers` and `--help` only, never `setup`.

| Command | What it does |
| --- | --- |
| `status [--repo <path>] [--json]` | Read-only. Reports `gpg.format` (must be `ssh`) and `user.signingkey` (a public key path or a `key::` literal), each with the config level it comes from; `commit.gpgsign` and `tag.gpgsign`; whether an ssh-agent is reachable and holds the signing key (`ssh-add -L`); a test signature (`ssh-keygen -Y sign -n git` on a temp file through the agent, then verified; the temp files are removed); whether the repository **requires** signing and why (`commit.gpgsign=true`, and/or `factory.json` with a `remote` and no `unsigned_ok`); and, when `factory.json` names `remote.allowed_signers`, whether your public key is listed in that file as committed at HEAD. One fix line per problem. Exits 0 whatever it finds (1 only outside a git repository). |
| `setup [--repo <path>] [--key <public key path>] [--scope repo\|global] [--confirm]` | Prints the exact `git config` commands: `gpg.format ssh`, `user.signingkey <public key>`, `commit.gpgsign true` and `tag.gpgsign true`. A dry run that changes nothing unless `--confirm` is given; then it applies them and reruns `status`. The default scope, `repo`, writes the repository's local config, which its worktrees (the factory's job worktrees) share; `--scope global` writes your global git config and must be named. Without `--key` it uses the one key loaded in the agent (its `~/.ssh/*.pub` path if one matches, else a `key::` literal) and refuses (exit 1) when there is none or several, listing them. `--key` must be a public key: it refuses a private key, and a file that does not hold an `ssh-*` or `sk-*` (or `ecdsa-sha2-*`) public key. |
| `allowed-signers [--repo <path>] [--json]` | Prints your line for an allowed-signers file: `<git user.email> <public key>`. Refuses without `user.email` (saying how to set it) or without a signing key. Writes nothing: add the line to the file by pull request. |
| `hook` | The `PreToolUse` hook (below); reads its payload on stdin. |

## The hook

`hooks/hooks.json` runs `node src/cli.ts hook` before every Bash call, with a 5 s timeout. It acts
only on commands that create commits: `git commit`, `merge`, `rebase`, `cherry-pick`, `revert` and
`am` (also as `git -C <dir> …`, with `-c …` options, after `cd <dir> &&`, and anywhere in a compound
command; `--abort` and `--quit` are not commits), and the factory CLI's state-changing commands
(`new`, `start`, `built`, `note`, `followup add`, …) when `factory.json` sets a remote factory.

In a repository that **requires** signing (as `status` defines it), it **denies** the call, with a
one-line reason and the fix (`factory-signing status`), when:

- signing is not usable: no signing key, the key not loaded in the ssh-agent (or no agent), or
  `gpg.format` not `ssh`; or
- the command would turn signing off: `--no-gpg-sign`, `-c commit.gpgsign=false`, or
  `-c gpg.format=…` other than `ssh`.

In a repository that does not require signing it prints nothing and allows. It is quiet for every
other command, never rewrites a command, and never blocks on its own failure: any internal error, a
subprocess that does not answer in time, or a run past the 5 s timeout allows the call. It runs
only `git` and `ssh-add -L`, never a shell.

## Tests

`node --test plugins/factory-signing/test/*.test.ts`. Every test sets `HOME`, `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_NOSYSTEM` and `SSH_AUTH_SOCK` to temp values, makes throwaway passphrase-less keys with
`ssh-keygen` and runs its own `ssh-agent`, so it never touches your keys, agent or git config.
`signing.test.ts` signs for real: plain commits in a repository and a linked worktree, and a remote
factory's state commits (the factory CLI against a temp bare remote) that `factory merge` accepts.
Tests that need OpenSSH are skipped, saying why, when `ssh-agent`, `ssh-add` or `ssh-keygen` is
missing.
