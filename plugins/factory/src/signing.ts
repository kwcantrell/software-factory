// Signed state commits (remote factory). Anyone who can push to the state branch could hand-edit a
// job.json to look approved, so in remote mode every state commit the CLI makes is signed with the
// committer's own SSH key (git's `gpg.format ssh`, `user.signingkey`), and `factory merge` refuses
// unless every commit that touched the job's directory carries a good signature from a key in the
// project's allowed-signers file (factory.json `remote.allowed_signers`), read from the project
// checkout's committed HEAD, never from the state branch. The trust boundary is the key, not the
// tool: a commit made by hand with an allowed key passes, as it should.
//
// factory.json `remote.unsigned_ok: true` turns both off; the README warns against it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { Refused } from './errors.ts';

/** Where the README suggests keeping the allowed-signers file. */
export const EXAMPLE_SIGNERS = '.factory/allowed_signers';

/**
 * How this command's state commits are signed. `args` are the `-c` settings that make
 * `git commit -S` sign as this person; `[]` means commits are not signed (local mode, or
 * `unsigned_ok`); null means signing is required but not set up, and `problem` says how to set it up.
 */
export interface Signing {
  args: string[] | null;
  problem: string | null;
}

export const UNSIGNED: Signing = { args: [], problem: null };

/**
 * Until a command chooses (factory.ts `signFor`), a state commit is refused rather than made
 * unsigned: a command that forgot to choose would otherwise leave a commit merge refuses for good.
 */
let current: Signing = {
  args: null,
  problem: 'internal error: this command did not choose how to sign state commits (src/signing.ts useSigning); nothing was committed',
};

/** Set how this process signs the state commits it makes (factory.ts, before any state change). */
export function useSigning(signing: Signing): void {
  current = signing;
}

/** The git arguments of a state commit: `[...settings, 'commit', '-S']`, or `['commit']` unsigned. */
export function commitArgs(): string[] {
  if (current.args === null) throw new Refused(current.problem ?? 'state commits must be signed');
  return current.args.length > 0 ? [...current.args, 'commit', '-S'] : ['commit'];
}

/**
 * The git arguments that replay local state commits onto the remote's tip: `[...settings, 'rebase',
 * '--gpg-sign']`, or `['rebase']` unsigned. `git rebase` writes new commits and, without these, would
 * drop the signatures of the commits it replays. Refused, like a commit, when signing is required but
 * not set up.
 */
export function rebaseArgs(): string[] {
  if (current.args === null) throw new Refused(current.problem ?? 'state commits must be signed');
  return current.args.length > 0 ? [...current.args, 'rebase', '--gpg-sign'] : ['rebase'];
}

function gitConfig(key: string, cwd: string): string {
  const p = spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf8' });
  return p.status === 0 ? p.stdout.trim() : '';
}

/** A user.signingkey that is the public key itself (git then signs through ssh-agent), not a path. */
const LITERAL_KEY = /^(key::|ssh-|ecdsa-|sk-)/;

const setup = (signers: string | null): string =>
  'set up SSH commit signing in git: `git config gpg.format ssh` and ' +
  '`git config user.signingkey <path to your SSH key, e.g. ~/.ssh/id_ed25519>` ' +
  `(in this checkout, or with --global), and add your public key to ${signers ?? 'the allowed-signers file'} by pull request. ` +
  'See the README\'s "Remote factory" section; "unsigned_ok": true in factory.json\'s remote turns signing off, which the README warns against';

/**
 * This person's signing setup, read from git config in `cwd` (the project checkout, as identity()
 * reads the git identity). Only SSH signing is supported: an allowed-signers file lists SSH keys.
 */
export function gitSigning(cwd: string, signers: string | null): Signing {
  const format = gitConfig('gpg.format', cwd);
  if (format !== 'ssh') {
    const now = format === '' ? 'gpg.format is not set (git defaults to openpgp)' : `gpg.format is '${format}'`;
    return { args: null, problem: `the remote factory signs every state commit with an SSH key, but ${now}: ${setup(signers)}` };
  }
  let key = gitConfig('user.signingkey', cwd);
  if (key === '') {
    return { args: null, problem: `the remote factory signs every state commit, but user.signingkey is not set: ${setup(signers)}` };
  }
  if (!LITERAL_KEY.test(key)) {
    // State commits run in jobs/, not here: make a relative key path absolute, as this checkout means it.
    if (key === '~' || key.startsWith('~/')) key = join(homedir(), key.slice(1));
    if (!isAbsolute(key)) key = resolvePath(cwd, key);
    if (!existsSync(key)) {
      return { args: null, problem: `the remote factory signs every state commit, but user.signingkey ${key} does not exist: ${setup(signers)}` };
    }
  }
  const args = ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`];
  const program = gitConfig('gpg.ssh.program', cwd);
  if (program !== '') args.push('-c', `gpg.ssh.program=${program}`);
  return { args, problem: null };
}

/** Why merge refuses a remote factory with neither allowed_signers nor unsigned_ok. */
export function noSignersProblem(config: string): string {
  return (
    `the remote factory needs an allowed-signers file to check who changed a job before merging it, and ${config} sets none: ` +
    `commit one listing each person's SSH public key (one line each: "<email> <key type> <public key>", e.g. ` +
    `"ann@example.com ssh-ed25519 AAAA..."), for example as ${EXAMPLE_SIGNERS}, by pull request, and set ` +
    `"allowed_signers": "${EXAMPLE_SIGNERS}" in factory.json's remote. See the README's "Remote factory" section`
  );
}

const REASONS: Record<string, string> = {
  N: 'is not signed',
  B: 'has a bad signature (its content does not match it)',
  U: 'is signed by a key that is not in the allowed-signers file',
  X: 'has an expired signature',
  Y: 'is signed by an expired key',
  R: 'is signed by a revoked key',
  E: 'has a signature that cannot be checked (is ssh-keygen installed?)',
};

const KINDS: Record<string, string> = {
  openpgp: 'an OpenPGP signature, which',
  x509: 'an X.509 signature, which',
  unknown: 'a signature of an unknown kind, which',
};

const SIGNATURE_KIND: Record<string, string> = {
  '-----BEGIN SSH SIGNATURE-----': 'ssh',
  '-----BEGIN PGP SIGNATURE-----': 'openpgp',
  '-----BEGIN SIGNED MESSAGE-----': 'x509',
};

/**
 * The kind of signature each commit carries, read from its raw `gpgsig` header. Git picks the
 * verifier from the signature itself, so an OpenPGP or X.509 signature is checked against the
 * merger's own keyring, not the allowed-signers file, and can come back good (`G`) for a key that
 * was never listed. Only an SSH signature is checked against the file.
 */
function signatureKinds(dir: string, shas: string[]): Map<string, string> {
  const p = spawnSync('git', ['cat-file', '--batch'], { cwd: dir, input: `${shas.join('\n')}\n`, maxBuffer: 256 * 1024 * 1024 });
  if (p.error || p.status !== 0) throw new Refused(`cannot read the state commits in ${dir}: ${(p.stderr?.toString() || p.error?.message || '').trim()}`);
  const out = p.stdout;
  const kinds = new Map<string, string>();
  let at = 0;
  for (const sha of shas) {
    const eol = out.indexOf(0x0a, at);
    const [got = '', type = '', size = ''] = out.subarray(at, eol).toString('utf8').split(' ');
    if (got !== sha || type !== 'commit') throw new Refused(`cannot read state commit ${sha.slice(0, 12)} in ${dir}`);
    const body = out.subarray(eol + 1, eol + 1 + Number(size)).toString('utf8');
    at = eol + 1 + Number(size) + 1;
    const header = body.slice(0, body.indexOf('\n\n') === -1 ? body.length : body.indexOf('\n\n'));
    // Every signature header must be SSH (a commit may carry a second one, gpgsig-sha256).
    const found = [...header.matchAll(/^gpgsig(?:-sha256)? (.*)$/gm)].map((m) => SIGNATURE_KIND[(m[1] ?? '').trim()] ?? 'unknown');
    kinds.set(sha, found.length === 0 ? 'none' : (found.find((k) => k !== 'ssh') ?? 'ssh'));
  }
  return kinds;
}

/** Control characters and the like from a commit subject the branch's pushers wrote: never printed raw. */
const shown = (text: string): string => JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);

/**
 * Refuse unless every commit reachable from HEAD in the state checkout `dir` that touched `jobId/`
 * has a good signature from a key in `signers` (the allowed-signers file's text). `--full-history`
 * keeps every commit that changed the directory, on any side of a merge.
 */
export function verifyJobHistory(dir: string, jobId: string, signers: string, signersName: string): number {
  const tmp = mkdtempSync(join(tmpdir(), 'factory-signers-'));
  try {
    const file = join(tmp, 'allowed_signers');
    writeFileSync(file, signers.endsWith('\n') ? signers : `${signers}\n`);
    const p = spawnSync(
      'git',
      [
        '-c', `gpg.ssh.allowedSignersFile=${file}`,
        '--literal-pathspecs',
        'log', '--no-show-signature', '--full-history', '--format=%H%x1f%G?%x1f%GK%x1f%s%x1e', 'HEAD', '--', `${jobId}/`,
      ],
      { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (p.error || p.status !== 0) {
      throw new Refused(`cannot read the history of ${jobId} in ${dir}: ${(p.stderr || p.error?.message || '').trim()}`);
    }
    const commits = p.stdout.split('\x1e').map((r) => r.trim()).filter(Boolean);
    if (commits.length === 0) throw new Refused(`${jobId} has no commit on the state branch in ${dir}; nothing to verify, refusing to merge`);
    const kinds = signatureKinds(dir, commits.map((r) => r.split('\x1f')[0] ?? ''));
    for (const record of commits) {
      const [sha = '', status = '', key = '', subject = ''] = record.split('\x1f');
      const kind = kinds.get(sha) ?? 'unknown';
      if (status === 'G' && kind === 'ssh') continue;
      const why =
        kind !== 'ssh' && kind !== 'none'
          ? `has ${KINDS[kind] ?? KINDS.unknown} git checks without the allowed-signers file, so it is not accepted (only SSH signatures are)`
          : (REASONS[status] ?? `has a signature git reports as '${status}'`);
      throw new Refused(
        `refusing to merge ${jobId}: state commit ${sha.slice(0, 12)} (${shown(subject)}) ${why}` +
          `${status === 'U' && key ? ` (${key}; allowed signers: ${signersName})` : ''}. ` +
          'Every change to a job on the state branch must be signed by a key in the allowed-signers file; ' +
          'see the README\'s "Remote factory" section',
      );
    }
    return commits.length;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
