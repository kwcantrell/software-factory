// `status`: read-only diagnosis of commit signing in one repository, with one fix line per problem.
import {
  agentKeys,
  getSetting,
  type KeyInfo,
  type Repo,
  requirement,
  resolveKey,
  type Setting,
  signersCheck,
  type SignersCheck,
  testSignature,
} from './signing.ts';

export interface Problem {
  problem: string;
  fix: string;
}

export interface Status {
  repo: string;
  gpgFormat: (Setting & { ok: boolean }) | null;
  signingKey: (Setting & { kind: KeyInfo['kind']; publicKeyPath: string | null; publicKey: string | null }) | null;
  commitGpgsign: Setting | null;
  tagGpgsign: Setting | null;
  agent: { reachable: boolean; keyLoaded: boolean | null; keys: number; error: string | null };
  testSignature: { ok: boolean | null; error: string | null };
  requires: { required: boolean; reasons: string[] };
  allowedSigners: SignersCheck | null;
  problems: Problem[];
  ok: boolean;
}

const SETUP = 'run `factory-signing setup` (a dry run; it applies only with --confirm after you say yes)';

/** The `! ssh-add` fix: the person types it, because Claude cannot enter a passphrase. */
export function sshAddFix(privatePath: string | null): string {
  return `run \`! ssh-add ${privatePath ?? '<path to your private key>'}\` yourself at the Claude Code prompt: Claude cannot enter your key's passphrase`;
}

export function status(repo: Repo): Status {
  const problems: Problem[] = [];
  const cwd = repo.top;

  const format = getSetting(cwd, 'gpg.format');
  const gpgFormat = format ? { ...format, ok: format.value === 'ssh' } : null;
  if (!gpgFormat?.ok) {
    problems.push({ problem: format ? `gpg.format is '${format.value}', not ssh` : 'gpg.format is not set (git defaults to openpgp)', fix: SETUP });
  }

  const configured = getSetting(cwd, 'user.signingkey');
  let key: KeyInfo | null = null;
  if (!configured || configured.value === '') {
    problems.push({ problem: 'user.signingkey is not set', fix: SETUP });
  } else {
    key = resolveKey(configured.value, cwd);
    if (key.problem) problems.push({ problem: key.problem, fix: 'point user.signingkey at your public key: `factory-signing setup --key <path to your .pub>`' });
  }

  const commitGpgsign = getSetting(cwd, 'commit.gpgsign', { bool: true });
  if (commitGpgsign?.value !== 'true') problems.push({ problem: 'commit.gpgsign is not true, so commits are not signed by default', fix: SETUP });
  const tagGpgsign = getSetting(cwd, 'tag.gpgsign', { bool: true });
  if (tagGpgsign?.value !== 'true') problems.push({ problem: 'tag.gpgsign is not true, so annotated tags are not signed by default', fix: SETUP });

  const agent = agentKeys();
  const keyLoaded = key?.publicKey ? agent.keys.some((k) => k.key === key?.publicKey) : null;
  if (!agent.reachable) {
    problems.push({
      problem: `no ssh-agent is reachable: ${agent.error}`,
      fix: `start an ssh-agent in the shell you start Claude Code from (\`eval "$(ssh-agent -s)"\`), then ${sshAddFix(key?.privatePath ?? null)}`,
    });
  } else if (keyLoaded === false) {
    problems.push({ problem: `the signing key ${key?.path ?? key?.configured} is not loaded in the ssh-agent`, fix: sshAddFix(key?.privatePath ?? null) });
  }

  let signature: Status['testSignature'] = { ok: null, error: 'not tried: the signing key is not usable through the ssh-agent' };
  if (gpgFormat?.ok && key?.publicKey && keyLoaded) {
    signature = testSignature(key.publicKey);
    if (!signature.ok) problems.push({ problem: `a test signature failed: ${signature.error}`, fix: 'check that ssh-keygen (OpenSSH 8.2 or later) is installed and that the agent can use the key' });
  }

  const req = requirement(repo);
  let allowedSigners: SignersCheck | null = null;
  if (req.factory?.error) problems.push({ problem: req.factory.error, fix: `fix ${req.factory.path}` });
  const file = req.factory?.remote?.allowed_signers;
  if (typeof file === 'string') {
    allowedSigners = signersCheck(repo.main, file, key?.publicKey ?? null);
    if (allowedSigners.error) {
      problems.push({ problem: allowedSigners.error, fix: `commit ${file} in ${repo.main} (by pull request)` });
    } else if (allowedSigners.listed === false) {
      problems.push({ problem: `your public key is not listed in ${file} at HEAD`, fix: `run \`factory-signing allowed-signers\` and add its line to ${file} by pull request` });
    }
  }

  return {
    repo: repo.top,
    gpgFormat,
    signingKey: configured && key ? { ...configured, kind: key.kind, publicKeyPath: key.path, publicKey: key.publicKey } : null,
    commitGpgsign,
    tagGpgsign,
    agent: { reachable: agent.reachable, keyLoaded, keys: agent.keys.length, error: agent.error },
    testSignature: signature,
    requires: { required: req.required, reasons: req.reasons },
    allowedSigners,
    problems,
    ok: problems.length === 0,
  };
}

const at = (s: Setting | null): string => (s ? `${s.value} (${s.scope})` : 'unset');

export function formatStatus(s: Status): string {
  const lines = [
    `Commit signing in ${s.repo}`,
    `  gpg.format        ${at(s.gpgFormat)}`,
    `  user.signingkey   ${s.signingKey ? `${s.signingKey.value} (${s.signingKey.scope}, ${s.signingKey.kind === 'literal' ? 'key:: literal' : 'public key path'})` : 'unset'}`,
    `  commit.gpgsign    ${at(s.commitGpgsign)}`,
    `  tag.gpgsign       ${at(s.tagGpgsign)}`,
    `  ssh-agent         ${s.agent.reachable ? `reachable, ${s.agent.keys} key(s)${s.agent.keyLoaded === null ? '' : s.agent.keyLoaded ? ', signing key loaded' : ', signing key NOT loaded'}` : `not reachable (${s.agent.error})`}`,
    `  test signature    ${s.testSignature.ok === null ? 'not tried' : s.testSignature.ok ? 'ok (signed and verified)' : 'failed'}`,
    `  requires signing  ${s.requires.required ? `yes: ${s.requires.reasons.join('; ')}` : 'no'}`,
  ];
  if (s.allowedSigners) {
    const a = s.allowedSigners;
    lines.push(`  allowed signers   ${a.file} at HEAD: ${a.error ?? (a.listed === null ? 'unknown (no public key)' : a.listed ? 'your key is listed' : 'your key is NOT listed')}`);
  }
  if (s.problems.length === 0) {
    lines.push('', 'No problems: commits made here are signed with your key through your ssh-agent.');
  } else {
    lines.push('', 'Problems:');
    for (const p of s.problems) lines.push(`  - ${p.problem}`, `    fix: ${p.fix}`);
  }
  return `${lines.join('\n')}\n`;
}
