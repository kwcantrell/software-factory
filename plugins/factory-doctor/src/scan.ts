// scan: reads the repository for evidence of what running it needs and proposes requirements, each
// with its source (file:line) and the profile it suggests. Read-only: it writes nothing anywhere.
//
// Values: dotenv files (real ones and examples alike) are read for variable NAMES only (repo.ts's
// dotenvNames); NODE_ENV-style values are read only from package.json, compose files, workflows and
// Dockerfiles, never from a dotenv file. No proposal carries a value.
//
// Numbering: proposals are numbered 1.. over everything found, in a fixed order (files sorted, then
// lines), before the ones already recorded are left out. So a proposal keeps its number while the
// repository's files stay the same, also after others are added; `add --from-scan <n>` re-runs the
// scan and takes number n.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { dotenvNames } from './repo.ts';
import { type DoctorFile, type Requirement, requirementKey, resolve as resolveProfile } from './requirements.ts';
import { parseConstraint } from './version.ts';

export interface Proposal {
  n: number;
  kind: 'tool' | 'env' | 'profile';
  name: string;
  /** The profile it suggests (for a `profile` proposal, the profile itself). */
  profile: string;
  source: string;
  why: string;
  /** tool: a version constraint. */
  version?: string;
  optional?: boolean;
}

export interface ScanResult {
  root: string;
  default_profile: string;
  proposals: Proposal[];
  /** How many proposals were left out because the file already records them. */
  recorded: number;
}

/** Directories never walked: dependencies, build output, VCS, caches, the factory's runtime dir. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.factory', 'dist', 'build', 'out', 'coverage', 'vendor', '.venv', 'venv', 'env', '__pycache__', 'target', '.next', '.nuxt', '.cache', '.turbo', '.tox', '.mypy_cache', '.pytest_cache']);
const MAX_FILES = 20_000;
const MAX_BYTES = 1_000_000;
const CODE = /\.(?:[cm]?[jt]sx?|py)$/;
/** Always-present system variables, not worth recording. */
const SYSTEM_VARS = new Set(['PATH', 'HOME', 'PWD', 'USER', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'LANG']);
/** Dotenv name parts that are not profiles. */
const NOT_PROFILES = new Set(['example', 'sample', 'template', 'local', 'defaults', 'dist', 'tpl']);

/** Well-known CLIs a CI `run:` step may call; first word of a command only. */
export const KNOWN_CLIS: ReadonlySet<string> = new Set(
  (
    'node npm npx pnpm yarn bun deno corepack python python3 pip pip3 pipx poetry uv pytest tox go cargo rustc rustup make cmake ' +
    'docker docker-compose podman kubectl helm terraform tofu aws gcloud az gh psql mysql redis-cli mongosh sqlite3 ' +
    'java mvn gradle ruby bundle rake php composer dotnet swift xcodebuild flutter dart elixir mix claude jq'
  ).split(' '),
);

/** Docker base images that are a language runtime: image -> the tool it provides. */
const IMAGE_TOOLS: Record<string, string> = { node: 'node', python: 'python3', ruby: 'ruby', golang: 'go', rust: 'rustc', openjdk: 'java', 'eclipse-temurin': 'java', php: 'php', deno: 'deno', 'denoland/deno': 'deno', 'oven/bun': 'bun', elixir: 'elixir' };
/** asdf/mise tool names -> the command. */
const ASDF_TOOLS: Record<string, string> = { nodejs: 'node', node: 'node', python: 'python3', golang: 'go', go: 'go', ruby: 'ruby', rust: 'rustc', java: 'java', terraform: 'terraform', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun', deno: 'deno', kubectl: 'kubectl', helm: 'helm', elixir: 'elixir', erlang: 'erl', php: 'php' };
const ENV_STYLE = /\b(NODE_ENV|APP_ENV|APP_ENVIRONMENT|RAILS_ENV|RACK_ENV|FLASK_ENV|DJANGO_ENV|ENVIRONMENT|DEPLOY_ENV|STAGE)\b\s*[:=]\s*['"]?([A-Za-z][A-Za-z0-9_-]*)/g;

export interface Found {
  kind: Proposal['kind'];
  name: string;
  /** The profile, or null for the default one. */
  profile: string | null;
  file: string;
  line: number;
  why: string;
  version?: string;
  optional?: boolean;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // The factory's runtime dir at the root (jobs and worktrees), not source.
        if (dir === root && e.name === 'factory' && (exists(join(p, 'jobs')) || exists(join(p, 'worktrees')))) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        visit(p, depth + 1);
      } else if (e.isFile()) out.push(p);
      if (out.length >= MAX_FILES) return;
    }
  };
  visit(root, 0);
  return out;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function read(path: string): string | null {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** The profile a dotenv file name names: `.env.stage` and `.env.stage.example` -> stage; `.env` -> null. */
export function dotenvProfile(name: string): string | null {
  const parts = name.split('.').slice(2).filter((p) => !NOT_PROFILES.has(p.toLowerCase()));
  return parts.length === 0 ? null : (parts[0] ?? null);
}

const isDotenvTemplate = (name: string): boolean => /^\.env(\.[\w-]+)*\.(example|sample|template|tpl|dist)$/.test(name);
const isDotenv = (name: string): boolean => /^\.env(\.[\w-]+)*$/.test(name) && !isDotenvTemplate(name);
const isCompose = (name: string): boolean => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name);
const isDockerfile = (name: string): boolean => /^Dockerfile(\.[\w-]+)?$/.test(name) || /\.Dockerfile$/.test(name);

/** A version spec from engines, .nvmrc and the like, as a constraint factory-doctor reads, or undefined. */
export function toConstraint(spec: string, pin: boolean): string | undefined {
  const s = spec.trim().replace(/^v(?=\d)/, '');
  if (parseConstraint(s) !== null) {
    if (pin && /^\d/.test(s)) return `^${s}`;
    return s.replace(/^=\s*/, '');
  }
  const loose = /^~\s*(\d+(?:\.\d+){0,2})$/.exec(s);
  if (loose?.[1] !== undefined) return `>=${loose[1]}`;
  const gt = /^>=?\s*(\d+(?:\.\d+){0,2})(\s+<.*)?$/.exec(s);
  if (gt?.[1] !== undefined) return `>=${gt[1]}`;
  return undefined;
}

function envFromDotenv(rel: string, text: string, profile: string | null, why: string): Found[] {
  return dotenvNames(text).map(({ name, line }) => ({ kind: 'env', name, profile, file: rel, line, why }));
}

function envFromCode(rel: string, text: string): Found[] {
  const out: Found[] = [];
  const patterns: [RegExp, number, string][] = [
    [/process\.env\.([A-Za-z_][A-Za-z0-9_]*)(\s*(?:\?\?|\|\|))?/g, 1, 'process.env'],
    [/process\.env\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\](\s*(?:\?\?|\|\|))?/g, 2, 'process.env'],
    [/os\.environ\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g, 2, 'os.environ'],
    [/os\.environ\.get\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*(,)?/g, 2, 'os.environ.get'],
    [/os\.getenv\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*(,)?/g, 2, 'os.getenv'],
  ];
  for (const [re, group, what] of patterns) {
    for (const m of text.matchAll(re)) {
      const name = m[group];
      if (name === undefined || SYSTEM_VARS.has(name)) continue;
      const fallback = m[group + 1] !== undefined;
      out.push({ kind: 'env', name, profile: null, file: rel, line: lineAt(text, m.index), why: `read with ${what} in ${rel}${fallback ? ', with a fallback' : ''}`, ...(fallback ? { optional: true } : {}) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function envStyleProfiles(rel: string, text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(ENV_STYLE)) {
    const value = m[2] ?? '';
    if (/^(true|false|null|none|undefined)$/i.test(value)) continue;
    out.push({ kind: 'profile', name: value, profile: value, file: rel, line: lineAt(text, m.index), why: `${m[1]}=${value} in ${rel}` });
  }
  return out;
}

function fromCompose(rel: string, text: string, name: string): Found[] {
  const suffix = /^(?:docker-)?compose\.([\w-]+)\.ya?ml$/.exec(name)?.[1];
  const profile = suffix === undefined || suffix === 'override' ? null : suffix;
  const out: Found[] = [];
  for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+][^}]*)?\}/g)) {
    const v = m[1] ?? '';
    const optional = m[2] !== undefined && /^:?-/.test(m[2]);
    out.push({ kind: 'env', name: v, profile, file: rel, line: lineAt(text, m.index), why: `used as \${${v}} in ${rel}${optional ? ', with a default' : ''}`, ...(optional ? { optional: true } : {}) });
  }
  return [...out, ...envStyleProfiles(rel, text)];
}

function fromPackageJson(rel: string, text: string): Found[] {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof pkg !== 'object' || pkg === null) return [];
  const lines = text.split('\n');
  const lineOf = (re: RegExp, from = 0): number => {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i] ?? '')) return i + 1;
    return 1;
  };
  const out: Found[] = [];
  const p = pkg as Record<string, unknown>;
  if (typeof p.engines === 'object' && p.engines !== null) {
    const enginesLine = lineOf(/"engines"\s*:/);
    for (const [tool, spec] of Object.entries(p.engines as Record<string, unknown>)) {
      if (typeof spec !== 'string' || !/^[a-z][\w-]*$/.test(tool)) continue;
      const version = toConstraint(spec, false);
      out.push({ kind: 'tool', name: tool, profile: null, file: rel, line: lineOf(new RegExp(`"${tool}"\\s*:`), enginesLine - 1), why: `${rel} engines.${tool} is ${JSON.stringify(spec)}`, ...(version === undefined ? {} : { version }) });
    }
  }
  if (typeof p.packageManager === 'string') {
    const m = /^([a-z][\w-]*)@(\d+(?:\.\d+){0,2})/.exec(p.packageManager);
    if (m?.[1] !== undefined) out.push({ kind: 'tool', name: m[1], profile: null, file: rel, line: lineOf(/"packageManager"\s*:/), why: `${rel} packageManager is ${m[1]}@${m[2]}`, version: `^${m[2]}` });
  }
  return [...out, ...envStyleProfiles(rel, text)];
}

function fromVersionFile(rel: string, text: string, tool: string): Found[] {
  const first = text.split('\n').findIndex((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (first < 0) return [];
  const spec = (text.split('\n')[first] ?? '').trim();
  const version = toConstraint(spec, true);
  return [{ kind: 'tool', name: tool, profile: null, file: rel, line: first + 1, why: `${rel} pins ${tool} ${spec}`, ...(version === undefined ? {} : { version }) }];
}

function fromToolVersions(rel: string, text: string): Found[] {
  const out: Found[] = [];
  text.split('\n').forEach((l, i) => {
    const m = /^\s*([a-z][\w-]*)\s+(\S+)/.exec(l);
    const tool = m?.[1] === undefined ? undefined : ASDF_TOOLS[m[1]];
    if (tool === undefined || m === null) return;
    const version = toConstraint(m[2] ?? '', true);
    out.push({ kind: 'tool', name: tool, profile: null, file: rel, line: i + 1, why: `${rel} pins ${m[1]} ${m[2]}`, ...(version === undefined ? {} : { version }) });
  });
  return out;
}

function fromDockerfile(rel: string, text: string): Found[] {
  const out: Found[] = [];
  const stages = new Set<string>();
  let docker = false;
  text.split('\n').forEach((l, i) => {
    const m = /^\s*FROM\s+(?:--\S+\s+)*([^\s:@]+)(?::([^\s@]+))?(?:@\S+)?(?:\s+AS\s+(\S+))?/i.exec(l);
    if (m === null) return;
    const image = (m[1] ?? '').replace(/^(docker\.io\/)?(library\/)?/, '');
    if (m[3] !== undefined) stages.add(m[3].toLowerCase());
    if (stages.has(image.toLowerCase()) && m[3]?.toLowerCase() !== image.toLowerCase()) return;
    if (image === 'scratch') return;
    if (!docker) {
      docker = true;
      out.push({ kind: 'tool', name: 'docker', profile: null, file: rel, line: i + 1, why: `${rel} builds an image (FROM ${m[1]})` });
    }
    const tool = IMAGE_TOOLS[image];
    if (tool === undefined) return;
    const tag = /^(\d+(?:\.\d+){0,2})/.exec(m[2] ?? '')?.[1];
    out.push({ kind: 'tool', name: tool, profile: null, file: rel, line: i + 1, why: `${rel} runs on ${m[1]}${m[2] === undefined ? '' : `:${m[2]}`}`, ...(tag === undefined ? {} : { version: `^${tag}` }) });
  });
  return [...out, ...envStyleProfiles(rel, text)];
}

/** The first word of each command in a shell line, past `sudo`, `env`, `time` and VAR=x prefixes. */
export function commandWords(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(/&&|\|\||;|\||\$\(|`/)) {
    const words = part.trim().split(/\s+/);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? '') || ['sudo', 'env', 'time', 'exec', 'then', 'do', 'else', '!'].includes(words[i] ?? ''))) i++;
    const w = words[i];
    if (w !== undefined && w !== '') out.push(w);
  }
  return out;
}

function fromWorkflow(rel: string, text: string): Found[] {
  const out: Found[] = [];
  const lines = text.split('\n');
  const add = (cmd: string, line: number): void => {
    for (const w of commandWords(cmd)) if (KNOWN_CLIS.has(w)) out.push({ kind: 'tool', name: w, profile: 'test', file: rel, line, why: `a CI step in ${rel} runs ${w}` });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] ?? '');
    if (m === null) continue;
    const rest = (m[2] ?? '').trim();
    if (/^[|>][+-]?\d*$/.test(rest)) {
      const indent = (m[1] ?? '').length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? '';
        if (l.trim() === '') continue;
        if ((/^\s*/.exec(l)?.[0].length ?? 0) <= indent) break;
        add(l, j + 1);
      }
    } else add(rest.replace(/^(['"])(.*)\1$/, '$2'), i + 1);
  }
  return [...out, ...envStyleProfiles(rel, text)];
}

/** Everything the sources show, in scan order, before profiles are filled in and duplicates dropped. */
export function findAll(root: string): Found[] {
  const found: Found[] = [];
  for (const path of walk(root)) {
    const rel = relative(root, path).split(sep).join('/');
    const name = basename(path);
    const top = !rel.includes('/');
    if (isDotenvTemplate(name) || isDotenv(name)) {
      // Names only: dotenvNames never captures what follows `=`.
      const text = read(path);
      if (text === null) continue;
      const profile = dotenvProfile(name);
      if (profile !== null) found.push({ kind: 'profile', name: profile, profile, file: rel, line: 1, why: `the dotenv file ${rel} names it` });
      found.push(...envFromDotenv(rel, text, profile, isDotenvTemplate(name) ? `listed in ${rel}` : `set in ${rel} (name only)`));
      continue;
    }
    const kind = name === 'package.json' ? 'pkg'
      : top && (name === '.nvmrc' || name === '.node-version') ? 'node'
      : top && name === '.python-version' ? 'python'
      : top && name === '.tool-versions' ? 'asdf'
      : isCompose(name) ? 'compose'
      : isDockerfile(name) ? 'docker'
      : /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) ? 'workflow'
      : CODE.test(name) ? 'code'
      : null;
    if (kind === null) continue;
    const text = read(path);
    if (text === null) continue;
    switch (kind) {
      case 'pkg': found.push(...fromPackageJson(rel, text)); break;
      case 'node': found.push(...fromVersionFile(rel, text, 'node')); break;
      case 'python': found.push(...fromVersionFile(rel, text, 'python3')); break;
      case 'asdf': found.push(...fromToolVersions(rel, text)); break;
      case 'compose': found.push(...fromCompose(rel, text, name)); break;
      case 'docker': found.push(...fromDockerfile(rel, text)); break;
      case 'workflow': found.push(...fromWorkflow(rel, text)); break;
      case 'code': found.push(...envFromCode(rel, text)); break;
    }
  }
  return found;
}

/** Is it already in the file: the profile exists, or its resolved requirements hold the kind and name? */
function isRecorded(doc: DoctorFile | null, p: Proposal): boolean {
  if (doc === null) return false;
  if (p.kind === 'profile') return p.name in doc.profiles;
  if (!(p.profile in doc.profiles)) return false;
  const key = requirementKey({ kind: p.kind, name: p.name } as Requirement);
  return resolveProfile(doc, p.profile).requires.some((r) => requirementKey(r.requirement) === key);
}

/** Every proposal, numbered, recorded ones included (see the numbering note at the top). */
export function proposals(root: string, doc: DoctorFile | null): { all: Proposal[]; defaultProfile: string } {
  const defaultProfile = doc?.default_profile ?? 'dev';
  const seen = new Set<string>();
  const all: Proposal[] = [];
  for (const f of findAll(root)) {
    const profile = f.profile ?? defaultProfile;
    const key = `${f.kind} ${f.name} ${profile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({
      n: all.length + 1,
      kind: f.kind,
      name: f.name,
      profile,
      source: `${f.file}:${f.line}`,
      why: f.why,
      ...(f.version === undefined ? {} : { version: f.version }),
      ...(f.optional === true ? { optional: true } : {}),
    });
  }
  return { all, defaultProfile };
}

export function scan(root: string, doc: DoctorFile | null): ScanResult {
  const { all, defaultProfile } = proposals(root, doc);
  const open = all.filter((p) => !isRecorded(doc, p));
  return { root, default_profile: defaultProfile, proposals: open, recorded: all.length - open.length };
}

export function scanText(r: ScanResult, label: string): string {
  if (r.proposals.length === 0) return `No new requirements found${r.recorded > 0 ? ` (${r.recorded} already recorded in ${label})` : ''}.\n`;
  const lines = [`${r.proposals.length} proposed (not yet in ${label}${r.recorded > 0 ? `; ${r.recorded} already recorded` : ''}):`];
  for (const p of r.proposals) {
    const extra = [p.version, p.optional === true ? 'optional' : undefined].filter((x) => x !== undefined).join(', ');
    lines.push(`  #${p.n}  ${p.kind} ${p.name}${extra === '' ? '' : ` (${extra})`}  -> profile ${p.profile}  [${p.source}]`);
    lines.push(`        ${p.why}`);
  }
  lines.push('Nothing was written. Add one with: factory-doctor add --from-scan <n> (a dry run; --confirm writes it).');
  return `${lines.join('\n')}\n`;
}
