// Redaction, length caps, normalisation and signatures: everything that decides what text is stored
// and which occurrences count as the same issue. Pattern-based, because this CLI never sees the
// secrets themselves, only text that might contain them. Over-redacting is the safe failure.
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import type { Env } from './plugins.ts';

export const REDACTED = '[redacted]';
export const SUMMARY_MAX = 200;
export const DETAIL_MAX = 2000;

/** Key names whose values are treated as secrets in `key=value`, `key: value` and `--key value`. */
const SECRET_KEY = /(secret|token|passw(or)?d|passphrase|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|(^|[_.-])sid$|^sid$|^auth$|authorization|session[_-]?id|(^|[_.-])session$|jwt)/i;

/** Set-Cookie attributes: their values describe the cookie and are not secret. */
const COOKIE_ATTRIBUTE = /^(path|domain|expires|max-age|samesite|secure|httponly|partitioned|priority)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Values left alone: empty, or exactly the marker, so a second pass changes nothing. A value that only
 * starts with the marker (`[redacted]x`) is redacted again: a typed marker must not shield a secret. */
function keep(value: string): boolean {
  return value === '' || value === REDACTED;
}

/** A long run of token characters that looks random (mixes letters and digits) rather than a word. */
function looksRandom(text: string, needsCaseMix: boolean): boolean {
  const digit = /\d/.test(text);
  const lower = /[a-z]/.test(text);
  const upper = /[A-Z]/.test(text);
  return needsCaseMix ? digit && lower && upper : digit && (lower || upper);
}

/**
 * A Cookie or Set-Cookie header value with every cookie's value redacted, attributes kept. Only an
 * exact `[redacted]` counts as already redacted, so anything after it on the line (a cookie, or a bare
 * word) is redacted too. `file` does not depend on this being stable once text is appended to a
 * redacted line: it checks each stored field on its own (see `draftFields` in advisor.ts).
 */
function redactCookies(value: string): string {
  return value
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      const raw = eq === -1 ? '' : part.slice(eq + 1);
      const v = raw.trim();
      if (eq === -1) return name === '' || name === REDACTED || COOKIE_ATTRIBUTE.test(name) ? part : part.replace(name, REDACTED);
      if (COOKIE_ATTRIBUTE.test(name) || v === '' || v === REDACTED) return part;
      return `${part.slice(0, eq + 1)}${raw.match(/^\s*/)?.[0] ?? ''}${REDACTED}`;
    })
    .join(';');
}

/**
 * A factory job id: a number of 3+ digits, then the slug of the job's title (`factory new` lower-cases
 * it and joins its words with `-`). Its first part is a word (a short number may lead it), each later
 * part a word with at most two trailing digits or a short number, so a random token that happens to
 * start with digits and a dash is not taken for one.
 */
const JOB_ID_SOURCE = String.raw`\d{3,}-\d{0,4}[a-z]+\d{0,2}(?:-(?:[a-z]+\d{0,2}|\d{1,4}))*`;
export const JOB_ID = new RegExp(String.raw`\b${JOB_ID_SOURCE}\b`, 'g');
const WHOLE_JOB_ID = new RegExp(`^${JOB_ID_SOURCE}$`);

export function isJobId(text: string): boolean {
  return WHOLE_JOB_ID.test(text);
}

type Rule = [RegExp, (match: string, ...groups: string[]) => string];

const RULES: Rule[] = [
  // PEM private keys, to the END line (or the end of the text when cut off).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => REDACTED],
  // user:password@ in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (_m, scheme) => `${scheme}${REDACTED}@`],
  // Authorization and Proxy-Authorization headers: the whole value to the end of the line, any scheme.
  [
    /\b((?:Proxy-)?Authorization)([ \t]*:[ \t]*)([^\n]*)/gi,
    (m, name, sep, value) => (value.trim() === '' || value.trim() === REDACTED ? m : `${name}${sep}${REDACTED}`),
  ],
  // Cookie and Set-Cookie headers: every cookie value, whatever its length.
  [/\b((?:Set-)?Cookie)([ \t]*:[ \t]*)([^\n]*)/gi, (_m, name, sep, value) => `${name}${sep}${redactCookies(value)}`],
  // Authorization header schemes elsewhere in text.
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme, space) => `${scheme}${space}${REDACTED}`],
  // Common provider token shapes: GitHub, `sk-` keys, Slack, AWS access key ids.
  [/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, () => REDACTED],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, () => REDACTED],
  // key=value / key: value / "key": "value" with a secret-looking key. A bare value is a run of value
  // characters, where a `]` ends it unless it closes a marker or more value follows; only an exact
  // marker is kept, so `[redacted]x` is redacted again.
  [
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[=:]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|((?:\[redacted\]|\](?=[^\s"'&;,)}\]])|[^\s"'&;,)}\]])+))/g,
    (m, q, key, sep, dq, sq, bare) => {
      // Not a secret key: its value may still hold one (`failed: password=x` matches as key `failed`).
      if (!isSecretKey(key ?? '')) return `${q}${key}${q}${sep}${redactOnce(m.slice(`${q}${key}${q}${sep}`.length))}`;
      // A `Cookie:` header on its line is the cookie rule's (above): its value is `name=[redacted]`.
      if (q === '' && /^(set-)?cookie$/i.test(key ?? '') && /^[ \t]*:[ \t]*$/.test(sep ?? '')) return m;
      if (dq !== undefined) return keep(dq) ? m : `${q}${key}${q}${sep}"${REDACTED}"`;
      if (sq !== undefined) return keep(sq) ? m : `${q}${key}${q}${sep}'${REDACTED}'`;
      return keep(bare ?? '') ? m : `${q}${key}${q}${sep}${REDACTED}`;
    },
  ],
  // --token value / --api-key value (the = form is covered above).
  [
    /(--?[A-Za-z0-9-]*(?:token|secret|password|passwd|api-key|apikey|cookie)[A-Za-z0-9-]*)(\s+)(["']?)([^\s"'-][^\s"']*)\3/gi,
    (m, flag, space, q, value) => (keep(value) ? m : `${flag}${space}${q}${REDACTED}${q}`),
  ],
  // -p value / -p=value / -pvalue (a password flag for mysql and others), whatever the value's length.
  [
    /(^|[\s"'`(])(-p)(\s+|=)?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'-][^\s"']*))/g,
    (m, lead, flag, sep = '', dq, sq, bare) => {
      if (dq !== undefined) return keep(dq) ? m : `${lead}${flag}${sep}"${REDACTED}"`;
      if (sq !== undefined) return keep(sq) ? m : `${lead}${flag}${sep}'${REDACTED}'`;
      return keep(bare ?? '') ? m : `${lead}${flag}${sep}${REDACTED}`;
    },
  ],
  // Long random-looking strings: base64 with slashes (40+), then token characters (32+). A factory job
  // id (`005-port-the-factory-cli-to-typescript`) mixes digits and letters too, but is made of words.
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (looksRandom(m, true) ? REDACTED : m)],
  [/[A-Za-z0-9_+=-]{32,}/g, (m) => (looksRandom(m, false) && !isJobId(m) ? REDACTED : m)],
];

function redactOnce(text: string): string {
  let out = text;
  for (const [re, replace] of RULES) out = out.replace(re, replace as (m: string, ...g: string[]) => string);
  return out;
}

/** Passes `redact` makes at most; real text settles in one or two. */
const MAX_PASSES = 8;

/**
 * Replaces everything that looks like a token or secret with `[redacted]`, pass after pass until a
 * pass changes nothing, so the result is idempotent (`containsSecret(redact(x)) === false`) even when
 * one rule's output feeds another's input.
 */
export function redact(text: string): string {
  let out = text;
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = redactOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Whether `text` still holds anything `redact` would change. */
export function containsSecret(text: string): boolean {
  return redactOnce(text) !== text;
}

/**
 * Cuts `text` to at most `max` characters, marking the cut with an ellipsis. The cut never lands
 * inside a `[redacted]` marker (it moves to before the marker), and when `text` itself holds nothing
 * secret-looking, trailing words are dropped until the result holds nothing either, also when quoted:
 * a cut can leave a dangling `token=…`, `Authorization: …` or `"api_key": "…`.
 */
export function cap(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  let head = chars.slice(0, max - 1).join('');
  for (let at = text.indexOf(REDACTED); at !== -1 && at < head.length; at = text.indexOf(REDACTED, at + 1)) {
    if (head.length < at + REDACTED.length) head = text.slice(0, at);
  }
  if (!containsSecret(text)) {
    const dangling = (h: string): boolean => containsSecret(`${h}…`) || containsSecret(`"${h}…"`);
    while (head !== '' && dangling(head)) head = head.replace(/\s*\S*\s*$/, '');
  }
  return `${head}…`;
}

/** One line: control characters and runs of whitespace become single spaces. */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
}

/** Keeps newlines and tabs, drops other control characters, trims trailing whitespace. */
function cleanMultiline(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd();
}

// Personal details. Drafts are filed on a public repo, so the local username in a home-dir path, the
// current user's home and username, email addresses and GitHub @mentions (which also notify that
// user) are masked before anything is stored, again when a draft is rendered, and `file` refuses a
// draft that still holds one.

export const EMAIL = '[email]';
export const USER = '[user]';
export const MENTION = '@[user]';

/** Usernames too common (or too short, under 3 characters) to mask as a whole word everywhere. */
const COMMON_USERS = new Set(['root', 'admin', 'user', 'runner', 'node', 'ubuntu']);

/** Who the current user is: their home directories and usernames, as masking needs them. */
export interface Identity {
  homes: string[];
  users: string[];
}

/** What the OS says about the current user. Tests pass their own, so the real user never matters. */
export interface SystemIdentity {
  homedir?: string;
  username?: string;
}

export function osIdentity(): SystemIdentity {
  const out: SystemIdentity = {};
  try {
    out.homedir = homedir();
  } catch {
    // no home directory: nothing to mask from it
  }
  try {
    out.username = userInfo().username;
  } catch {
    // no passwd entry: nothing to mask from it
  }
  return out;
}

/** `$HOME`, `$USER`, `$USERNAME` and the OS's view of the current user. */
export function identityOf(env: Env, system: SystemIdentity = osIdentity()): Identity {
  const homes = new Set<string>();
  for (const h of [env.HOME, system.homedir]) {
    const home = (h ?? '').replace(/[\\/]+$/, '');
    // A home of `/` (or a relative one) would match far too much; `/root` and longer are kept.
    if (home.length >= 3 && /^(\/|[A-Za-z]:[\\/])/.test(home)) homes.add(home);
  }
  const users = new Set<string>();
  for (const u of [system.username, env.USER, env.USERNAME]) {
    if (u !== undefined && [...u].length >= 3 && !COMMON_USERS.has(u.toLowerCase()) && !/\s/.test(u)) users.add(u);
  }
  const byLength = (a: string, b: string): number => b.length - a.length;
  return { homes: [...homes].sort(byLength), users: [...users].sort(byLength) };
}

/** No identity: only the generic rules (home-dir paths, emails, mentions) apply. */
export const NO_IDENTITY: Identity = { homes: [], users: [] };

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What may follow the end of a home directory: the next path separator, or the end of the path. */
const PATH_END = '(?=$|[\\\\/\\s\'"`:;,()<>\\[\\]{}|])';
/** One path segment: a username. */
const SEGMENT = '[^\\\\/\\s\'"`:;,()<>\\[\\]{}|]+';
/** Either slash. */
const SLASH = '[\\\\/]';

/** `/home/<user>`, `/Users/<user>`, `/root` and `C:\Users\<user>` (either slash) at the start of a path. */
const HOME_PATH = new RegExp(`(?<![\\w.~-])(?:/home/${SEGMENT}|/[Uu]sers/${SEGMENT}|/root|[A-Za-z]:${SLASH}[Uu][Ss][Ee][Rr][Ss]${SLASH}${SEGMENT})${PATH_END}`, 'g');

/**
 * An email address: a local part (not preceded by another local-part character), `@`, and a domain
 * ending in a 2+ letter TLD. npm scopes (`@types/node`) have no local part, `pkg@1.2.3` no TLD; a
 * local part of exactly `git` is the SSH user of a remote (`git@github.com:owner/repo`) and is kept.
 */
const EMAIL_RE = /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?![\w-])/g;

/**
 * A GitHub mention outside a backtick code span or a URL: `@` plus 1 to 39 letters, digits or
 * hyphens, not preceded by a word character, `/` or `.`, and not followed by `/` (an npm scope) or
 * more name characters. Code spans and URLs (`https://[redacted]@host/x`, where the `@` ends the
 * credentials) are matched first and kept as they are.
 */
const MENTION_RE = /(`[^`\n]*`|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]*)|(?<![\w/.])@[A-Za-z0-9-]{1,39}(?![A-Za-z0-9/-])/g;

function homeRule(home: string): RegExp {
  // On Windows a home can be written with either slash; the rest of the path is kept as it is.
  const body = home.split(/[\\/]/).map(escapeRe).join(SLASH);
  return new RegExp(`(?<![\\w.~-])${body}${PATH_END}`, 'gi');
}

function userRule(user: string): RegExp {
  // A whole word: no word character, `.`, `-` or `[` before it, no word character or `-` after it.
  return new RegExp(`(?<![\\w.\\[-])${escapeRe(user)}(?![\\w-])`, 'gi');
}

/**
 * The text with personal details masked: the current user's home (`$HOME`, `os.homedir()`) and any
 * `/home/<user>`, `/Users/<user>`, `/root` or `C:\Users\<user>` become `~`, emails `[email]`, the
 * current username as a whole word `[user]`, and GitHub mentions `@[user]`. Idempotent.
 */
export function maskPersonal(text: string, identity: Identity = NO_IDENTITY): string {
  let out = text;
  for (const home of identity.homes) out = out.replace(homeRule(home), '~');
  out = out.replace(HOME_PATH, '~');
  out = out.replace(EMAIL_RE, (m, local: string) => (local === 'git' ? m : EMAIL));
  for (const user of identity.users) out = out.replace(userRule(user), USER);
  return out.replace(MENTION_RE, (m, kept: string | undefined) => (kept !== undefined ? m : MENTION));
}

/**
 * Whether `text` still holds a home-dir path, the current user's home, an email or a linkable mention.
 * The bare username is not checked here: a draft's own text names plugins and commands, which a
 * username can equal.
 */
export function containsPersonal(text: string, identity: Identity = NO_IDENTITY): boolean {
  return maskPersonal(text, { homes: identity.homes, users: [] }) !== text;
}

/**
 * The stored summary: redacted, masked, made one line, masked and redacted again, and capped.
 * Redacting before the cap means a cut can't expose part of a secret; redacting again after joining
 * lines means the stored value is clean on its own (`containsSecret` is false), which `file` relies
 * on. Redacting comes before masking so URL credentials (`https://user:pass@host`) go whole.
 */
export function cleanSummary(text: string, identity: Identity = NO_IDENTITY): string {
  return cap(redact(maskPersonal(oneLine(maskPersonal(redact(text), identity)), identity)), SUMMARY_MAX);
}

export function cleanDetail(text: string, identity: Identity = NO_IDENTITY): string {
  return cap(redact(maskPersonal(cleanMultiline(maskPersonal(redact(text), identity)), identity)), DETAIL_MAX);
}

/**
 * A summary reduced to what identifies the issue: lower-cased, with URLs, emails, paths, UUIDs, factory
 * job ids, hex, ids and numbers masked, so the same issue worded with different values gives the same
 * text.
 */
export function normalise(summary: string): string {
  return redact(summary)
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/g, '<url>')
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '<email>')
    .replace(/(^|[\s'"=(:,[])((~|\.{1,2})?\/[^\s'"(),\]]*|[a-z]:\\[^\s'"(),]*)/g, '$1<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(JOB_ID, '<job>')
    .replace(/\b(0x)?[0-9a-f]*\d[0-9a-f]*[a-f][0-9a-f]*\b|\b(0x)?[0-9a-f]*[a-f][0-9a-f]*\d[0-9a-f]*\b/g, (m) => (m.length >= 6 ? '<hex>' : m))
    .replace(/\b(?=[a-z_-]*\d)(?=[0-9_-]*[a-z])[a-z0-9_-]{5,}\b/g, '<id>')
    .replace(/\d+([.:]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .replace(/[\s.!;,]+$/, '')
    .trim();
}

/** The stable id of an issue: (plugin, kind, normalised summary), hashed. */
export function signature(plugin: string, kind: string, summary: string): string {
  return createHash('sha256').update(`${plugin}\n${kind}\n${normalise(summary)}`).digest('hex').slice(0, 12);
}
