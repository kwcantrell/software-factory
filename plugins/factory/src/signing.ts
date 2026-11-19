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

let current: Signing = UNSIGNED;

/** Set how this process signs the state commits it makes (factory.ts, before any state change). */
export function useSigning(signing: Signing): void {
  current = signing;
}

/** The git arguments of a state commit: `[...settings, 'commit', '-S']`, or `['commit']` unsigned. */
export function commitArgs(): string[] {
  if (current.args === null) throw new Refused(current.problem ?? 'state commits must be signed');
  return current.args.length > 0 ? [...current.args, 'commit', '-S'] : ['commit'];
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
    for (const record of commits) {
      const [sha = '', status = '', key = '', subject = ''] = record.split('\x1f');
      if (status === 'G') continue;
      const why = REASONS[status] ?? `has a signature git reports as '${status}'`;
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
