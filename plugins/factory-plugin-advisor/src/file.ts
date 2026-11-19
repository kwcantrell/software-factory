// file: opens a draft as a GitHub issue with `gh issue create`. A dry run unless confirmed; the draft
// is checked for secret-looking text again first (each stored field on its own, the rest without
// them); the body goes to gh on stdin and the title as one argv element, with no shell in between.
import { spawnSync } from 'node:child_process';
import { draftFields, FIELD_LINES, issues, MARKETPLACE_REPO, resolveSignature, UsageError } from './advisor.ts';
import { containsSecret, redact } from './redact.ts';
import { CliError, type Occurrence, type Store } from './store.ts';
import type { Env } from './plugins.ts';

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const GH_TIMEOUT_MS = 60_000;

export interface FileResult {
  signature: string;
  repo: string;
  title: string;
  body: string;
  /** False for a dry run. */
  filed: boolean;
  url?: string;
  /** True for the marketplace repo, which is public. Other repos may be public too. */
  knownPublic: boolean;
}

/** Splits a draft into its `# title` line and the body after it. */
export function splitDraft(text: string): { title: string; body: string } {
  const [first = '', ...rest] = text.split('\n');
  if (!first.startsWith('# ')) throw new CliError('the draft does not start with a "# <title>" line; run suggest again to rewrite it');
  return { title: first.slice(2).trim(), body: rest.join('\n').replace(/^\n+/, '') };
}

/**
 * The draft with each quoted stored field taken out of its line, leaving the text around it. A field
 * is taken out only where it sits exactly between the fixed text `renderDraft` puts around it
 * (`FIELD_LINES`), and only if it is clean on its own; anything else, including text the user edited
 * in, stays and is checked as it is. So the check never reads appended text as part of a redacted
 * value, and a typed `[redacted]` shields nothing.
 */
export function withoutFields(text: string, fields: readonly string[]): string {
  const clean = fields.filter((f) => f !== '' && !containsSecret(f)).sort((a, b) => b.length - a.length);
  return text
    .split('\n')
    .map((line) => {
      for (const f of clean) {
        for (let at = line.indexOf(f); at !== -1; at = line.indexOf(f, at + 1)) {
          const before = line.slice(0, at);
          const after = line.slice(at + f.length);
          if (FIELD_LINES.some(([b, a]) => b.test(before) && a.test(after))) return `${before}${after}`;
        }
      }
      return line;
    })
    .join('\n');
}

/** What `withoutPluginName` puts where the draft names the target plugin. */
const PLUGIN_STAND_IN = 'plugin';

/**
 * The text with the target plugin's name replaced by a neutral word where `renderDraft`'s fixed text
 * names it: after the title's `factory-plugin-advisor: [new plugin ]`, after `/factory:run `, after
 * `new-plugin -- ` and as the start of a backtick span. A name with a secret-looking word in it
 * (`token-helper`, `secret-store`) followed by the template's `: ` would otherwise read as a
 * `key: value` pair, so every draft for that plugin would be refused. Only these positions are
 * replaced, and only for a name that is clean on its own; the name anywhere else (`token-helper=x`
 * typed into the draft) stays and is checked as it is.
 */
export function withoutPluginName(text: string, plugin: string): string {
  if (plugin === '' || containsSecret(plugin)) return text;
  const name = plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`^(# factory-plugin-advisor: (?:new plugin )?)${name}(?=: )`, 'gm'), `$1${PLUGIN_STAND_IN}`)
    .replace(new RegExp(`^(/factory:run )${name}(?=: )`, 'gm'), `$1${PLUGIN_STAND_IN}`)
    .replace(new RegExp(`(new-plugin -- )${name}(?=\\))`, 'g'), `$1${PLUGIN_STAND_IN}`)
    .replace(new RegExp(`(\`)${name}(?=[\` ])`, 'g'), `$1${PLUGIN_STAND_IN}`);
}

/**
 * The draft's lines (1-based) that still hold secret-looking text once its stored fields and the
 * plugin's name are taken out, or `[0]` when only text that spans lines (a PEM key) does. Empty when
 * the draft may be filed.
 */
export function draftSecrets(text: string, plugin: string, occurrences: readonly Occurrence[]): number[] {
  const rest = withoutPluginName(withoutFields(text, draftFields(plugin, occurrences)), plugin);
  const lines = secretLines(rest);
  if (lines.length > 0) return lines;
  return containsSecret(rest) ? [0] : [];
}

/** Line numbers (1-based, in the draft) that still hold secret-looking text. */
export function secretLines(text: string): number[] {
  return text
    .split('\n')
    .map((line, i) => (containsSecret(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

export function fileIssue(store: Store, wanted: string, options: { repo?: string; confirm: boolean; env: Env }): FileResult {
  const repo = options.repo ?? MARKETPLACE_REPO;
  if (!REPO.test(repo)) throw new UsageError(`--repo must be <owner>/<name>, got ${JSON.stringify(repo)}`);
  const state = store.state();
  const issue = resolveSignature(issues(store.occurrences(), state), wanted);
  const sig = issue.signature;
  const filed = state.issues[sig]?.filed;
  if (filed !== undefined) throw new CliError(`issue ${sig} was already filed as ${filed.url}; not filing it twice`);
  if (state.issues[sig]?.dismissedAt !== undefined) throw new CliError(`issue ${sig} is dismissed; not filing it`);
  const text = store.readDraft(sig);
  if (text === null) throw new CliError(`issue ${sig} has no draft yet; run suggest first`);
  const found = draftSecrets(text, issue.plugin, store.occurrences().filter((o) => o.signature === sig));
  const whole = found.filter((n) => n > 0);
  if (found.length > 0) {
    throw new CliError(
      `refusing to file ${sig}: the draft at ${store.draftPath(sig)} still has secret-looking text${whole.length > 0 ? ` on line ${whole.join(', ')}` : ''}; edit it out or dismiss the issue`,
    );
  }
  const { title, body } = splitDraft(text);
  const result: FileResult = { signature: sig, repo, title, body, filed: false, knownPublic: repo === MARKETPLACE_REPO };
  if (!options.confirm) return result;

  const gh = spawnSync('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], {
    input: body,
    encoding: 'utf8',
    env: options.env as NodeJS.ProcessEnv,
    timeout: GH_TIMEOUT_MS,
    shell: false,
  });
  if (gh.error !== undefined) {
    const code = (gh.error as NodeJS.ErrnoException).code;
    throw new CliError(code === 'ENOENT' ? 'gh is not on PATH; install the GitHub CLI and run gh auth login' : `gh could not be run: ${gh.error.message}`);
  }
  if (gh.status !== 0) {
    const reason = redact((gh.stderr ?? '').trim().split('\n')[0] ?? '');
    throw new CliError(`gh issue create exited ${String(gh.status)}${reason === '' ? '' : `: ${reason}`}`);
  }
  const url = /https:\/\/\S+\/issues\/\d+/.exec(gh.stdout ?? '')?.[0];
  if (url === undefined) throw new CliError('gh issue create succeeded but printed no issue URL; check the repo before filing again');
  state.issues[sig] = { ...state.issues[sig], filed: { url, repo, at: new Date().toISOString() } };
  store.saveState(state);
  return { ...result, filed: true, url };
}
