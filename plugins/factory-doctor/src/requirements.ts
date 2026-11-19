// The requirements file: `.factory/doctor.json` in the repository root (or `--file <path>`), a
// committed, reviewable record of what running the application needs under each profile.
//
// Format version 1:
//   {
//     "version": 1,
//     "description": "...",                 optional
//     "default_profile": "dev",             optional; must name a profile
//     "profiles": {
//       "<name>": {
//         "description": "...",             optional
//         "extends": "base" | ["a", "b"],   optional; cycles are refused
//         "dotenv": [".env"],               optional; dotenv files whose variable NAMES count as set
//         "requires": [ <requirement>, ... ]
//       }
//     }
//   }
// A requirement is one of the KINDS below. Every one has `why` (required), `source` ("file:line",
// optional) and `optional` (default false). It never holds a value: a key named `value`, `default` or
// `secret` anywhere in the file is refused, as is any key this module does not know.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseConstraint } from './version.ts';

export const FORMAT_VERSION = 1;
export const DEFAULT_FILE = '.factory/doctor.json';
export const KINDS = ['tool', 'env', 'file', 'claude-plugin', 'claude-skill', 'service'] as const;
export type Kind = (typeof KINDS)[number];
export const ENV_FORMATS = ['non-empty', 'url', 'integer'] as const;
export type EnvFormat = (typeof ENV_FORMATS)[number] | { regex: string };
/** Keys that would hold a value, refused anywhere in the file. */
export const SECRET_KEYS: readonly string[] = ['value', 'default', 'secret'];
export const DEFAULT_TIMEOUT_MS = 1000;

interface Base {
  why: string;
  source?: string;
  optional?: boolean;
}
export interface ToolRequirement extends Base {
  kind: 'tool';
  name: string;
  version?: string;
  version_command?: string[];
  version_pattern?: string;
}
export interface EnvRequirement extends Base {
  kind: 'env';
  name: string;
  description?: string;
  format?: EnvFormat;
}
export interface FileRequirement extends Base {
  kind: 'file';
  path: string;
}
export interface PluginRequirement extends Base {
  kind: 'claude-plugin';
  name: string;
}
export interface SkillRequirement extends Base {
  kind: 'claude-skill';
  name: string;
}
export interface ServiceRequirement extends Base {
  kind: 'service';
  host: string;
  port: number;
  timeout_ms?: number;
}
export type Requirement = ToolRequirement | EnvRequirement | FileRequirement | PluginRequirement | SkillRequirement | ServiceRequirement;

export interface Profile {
  description?: string;
  extends?: string | string[];
  dotenv?: string[];
  requires?: Requirement[];
}

export interface DoctorFile {
  version: number;
  description?: string;
  default_profile?: string;
  profiles: Record<string, Profile>;
}

/** A refusal: exit 1, the message on stderr. */
export class Refused extends Error {}

/** The name a requirement is known by: `add`/`remove <kind> <name>`, and two with the same are one. */
export function requirementName(r: Requirement): string {
  if (r.kind === 'file') return r.path;
  if (r.kind === 'service') return `${r.host}:${r.port}`;
  return r.name;
}

export const requirementKey = (r: Requirement): string => `${r.kind} ${requirementName(r)}`;

export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const TOOL_NAME = /^[A-Za-z0-9_+][A-Za-z0-9._+-]*$/;
export const PLUGIN_NAME = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/;
export const SKILL_NAME = /^(?:[A-Za-z0-9][\w.-]*:)?[A-Za-z0-9][\w.-]*$/;
export const HOST_NAME = /^[A-Za-z0-9._:[\]-]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const KEYS: Record<Kind, readonly string[]> = {
  tool: ['kind', 'name', 'version', 'version_command', 'version_pattern'],
  env: ['kind', 'name', 'description', 'format'],
  file: ['kind', 'path'],
  'claude-plugin': ['kind', 'name'],
  'claude-skill': ['kind', 'name'],
  service: ['kind', 'host', 'port', 'timeout_ms'],
};
const COMMON = ['why', 'source', 'optional'];

/** The only argument a `version_command` may give its tool: flags that print a version, nothing else. */
export const VERSION_PROBES: readonly string[] = ['--version', '-version', '-v', '-V', 'version', '-Version', '--Version'];
const TOP_KEYS = ['version', 'description', 'default_profile', 'profiles'];
const PROFILE_KEYS = ['description', 'extends', 'dotenv', 'requires'];

const key = (path: string, k: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

class Validator {
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  fail(path: string, message: string): never {
    throw new Refused(`${this.label}: ${path}: ${message}`);
  }

  /** Refuses value-looking keys first (anywhere below `value`), then unknown keys of this object. */
  keys(obj: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(obj)) {
      if (SECRET_KEYS.includes(k.toLowerCase())) this.fail(key(path, k), `looks like a stored secret value ('${k}'); factory-doctor records names, never values`);
    }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) this.fail(key(path, k), `unknown key '${k}' (allowed: ${allowed.join(', ')})`);
  }

  /** Refuses a value-looking key at any depth of `value` (used before the typed checks). */
  deepSecrets(value: unknown, path: string, skipKeysOf: Set<unknown>): void {
    if (Array.isArray(value)) value.forEach((v, i) => this.deepSecrets(v, `${path}[${i}]`, skipKeysOf));
    else if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (!skipKeysOf.has(value) && SECRET_KEYS.includes(k.toLowerCase())) {
          this.fail(key(path, k), `looks like a stored secret value ('${k}'); factory-doctor records names, never values`);
        }
        this.deepSecrets(v, key(path, k), skipKeysOf);
      }
    }
  }

  str(v: unknown, path: string, pattern?: RegExp, what?: string): string {
    if (typeof v !== 'string' || v.trim() === '') this.fail(path, 'must be a non-empty string');
    // An env name that fails is not echoed: `NAME=value` in that field would print the value.
    if (pattern !== undefined && !pattern.test(v)) this.fail(path, `${pattern === ENV_NAME ? 'it' : JSON.stringify(v)} is not ${what ?? `a match for ${pattern}`}`);
    if (v.includes('\n') || v.includes('\0')) this.fail(path, 'must be one line');
    return v;
  }

  regex(v: unknown, path: string): string {
    const s = this.str(v, path);
    try {
      new RegExp(s);
    } catch (error) {
      this.fail(path, `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    return s;
  }

  requirement(r: unknown, path: string): Requirement {
    if (!isObject(r)) this.fail(path, 'must be an object');
    const kind = r.kind;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      this.fail(`${path}.kind`, `bad kind ${JSON.stringify(kind ?? null)} (kinds: ${KINDS.join(', ')})`);
    }
    const k = kind as Kind;
    this.keys(r, path, [...KEYS[k], ...COMMON]);
    this.str(r.why, `${path}.why`);
    if (r.source !== undefined) this.str(r.source, `${path}.source`);
    if (r.optional !== undefined && typeof r.optional !== 'boolean') this.fail(`${path}.optional`, 'must be true or false');
    switch (k) {
      case 'tool': {
        const name = this.str(r.name, `${path}.name`, TOOL_NAME, 'a command name (no path)');
        if (r.version !== undefined && parseConstraint(this.str(r.version, `${path}.version`)) === null) {
          this.fail(`${path}.version`, `${JSON.stringify(r.version)} is not a version constraint (>=1.2.3, ^1.2 or 1.2.3)`);
        }
        if (r.version_command !== undefined) {
          const c = r.version_command;
          if (!Array.isArray(c) || c.length === 0) this.fail(`${path}.version_command`, 'must be a non-empty array of strings, the command first');
          c.forEach((a, i) => {
            if (typeof a !== 'string' || a === '' || a.includes('\0')) this.fail(`${path}.version_command[${i}]`, 'must be a non-empty string');
          });
          if (c[0] !== name) this.fail(`${path}.version_command[0]`, `must be the tool itself, ${JSON.stringify(name)}: the check runs only the tool it checks`);
          // A committed file must not turn the pre-approved check into a code runner (node -e,
          // python -c, node -r <module>): the tool takes at most one argument, a known version probe.
          if (c.length > 2) this.fail(`${path}.version_command`, `must be the tool and at most one argument, one of ${VERSION_PROBES.join(' ')}`);
          if (c.length === 2 && !VERSION_PROBES.includes(c[1] as string)) {
            this.fail(`${path}.version_command[1]`, `must be a version probe, one of ${VERSION_PROBES.join(' ')}: the check runs nothing else`);
          }
        }
        if (r.version_pattern !== undefined) this.regex(r.version_pattern, `${path}.version_pattern`);
        break;
      }
      case 'env': {
        this.str(r.name, `${path}.name`, ENV_NAME, 'an environment variable name');
        if (r.description !== undefined) this.str(r.description, `${path}.description`);
        const f = r.format;
        if (f !== undefined) {
          if (isObject(f)) {
            this.keys(f, `${path}.format`, ['regex']);
            this.regex(f.regex, `${path}.format.regex`);
          } else if (typeof f !== 'string' || !(ENV_FORMATS as readonly string[]).includes(f)) {
            this.fail(`${path}.format`, `must be ${ENV_FORMATS.join(', ')} or {"regex": "..."}`);
          }
        }
        break;
      }
      case 'file':
        this.str(r.path, `${path}.path`);
        break;
      case 'claude-plugin':
        this.str(r.name, `${path}.name`, PLUGIN_NAME, 'a plugin id <name>@<marketplace>');
        break;
      case 'claude-skill':
        this.str(r.name, `${path}.name`, SKILL_NAME, 'a skill name, <skill> or <plugin>:<skill>');
        break;
      case 'service': {
        this.str(r.host, `${path}.host`, HOST_NAME, 'a host name or address');
        if (!Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535) this.fail(`${path}.port`, 'must be an integer from 1 to 65535');
        if (r.timeout_ms !== undefined && (!Number.isInteger(r.timeout_ms) || (r.timeout_ms as number) < 1 || (r.timeout_ms as number) > 60_000)) {
          this.fail(`${path}.timeout_ms`, 'must be an integer from 1 to 60000');
        }
        break;
      }
    }
    return r as unknown as Requirement;
  }

  profile(p: unknown, path: string): Profile {
    if (!isObject(p)) this.fail(path, 'must be an object');
    this.keys(p, path, PROFILE_KEYS);
    if (p.description !== undefined) this.str(p.description, `${path}.description`);
    if (p.extends !== undefined) {
      const list = typeof p.extends === 'string' ? [p.extends] : p.extends;
      if (!Array.isArray(list) || list.length === 0) this.fail(`${path}.extends`, 'must be a profile name or a non-empty list of them');
      list.forEach((e, i) => this.str(e, Array.isArray(p.extends) ? `${path}.extends[${i}]` : `${path}.extends`, PROFILE_NAME, 'a profile name'));
    }
    if (p.dotenv !== undefined) {
      if (!Array.isArray(p.dotenv)) this.fail(`${path}.dotenv`, 'must be a list of dotenv file paths');
      p.dotenv.forEach((d, i) => this.str(d, `${path}.dotenv[${i}]`));
    }
    if (p.requires !== undefined) {
      if (!Array.isArray(p.requires)) this.fail(`${path}.requires`, 'must be a list of requirements');
      const seen = new Map<string, number>();
      p.requires.forEach((r, i) => {
        const req = this.requirement(r, `${path}.requires[${i}]`);
        const k = requirementKey(req);
        const first = seen.get(k);
        if (first !== undefined) this.fail(`${path}.requires[${i}]`, `duplicate of ${path}.requires[${first}] (${k})`);
        seen.set(k, i);
      });
    }
    return p as Profile;
  }

  doc(doc: unknown): DoctorFile {
    if (!isObject(doc)) this.fail('$', 'must be a JSON object');
    const profiles = doc.profiles;
    // Profile names are names, not values: a profile may be called "default".
    this.deepSecrets(doc, '$', new Set([profiles]));
    this.keys(doc, '$', TOP_KEYS);
    if (doc.version !== FORMAT_VERSION) this.fail('$.version', `must be ${FORMAT_VERSION} (this factory-doctor reads format version ${FORMAT_VERSION})`);
    if (doc.description !== undefined) this.str(doc.description, '$.description');
    if (!isObject(profiles)) this.fail('$.profiles', 'must be an object of profiles');
    for (const [name, p] of Object.entries(profiles)) {
      const path = key('$.profiles', name);
      if (!PROFILE_NAME.test(name)) this.fail(path, `${JSON.stringify(name)} is not a profile name (letters, digits, '.', '_', '-')`);
      this.profile(p, path);
    }
    for (const [name, p] of Object.entries(profiles as Record<string, Profile>)) {
      for (const parent of parents(p)) {
        if (!(parent in profiles)) this.fail(`${key('$.profiles', name)}.extends`, `no profile '${parent}'`);
      }
    }
    for (const name of Object.keys(profiles)) {
      const cycle = findCycle(profiles as Record<string, Profile>, name, []);
      if (cycle !== null) this.fail(`${key('$.profiles', name)}.extends`, `cycle: ${cycle.join(' -> ')}`);
    }
    if (doc.default_profile !== undefined) {
      const d = this.str(doc.default_profile, '$.default_profile', PROFILE_NAME, 'a profile name');
      if (!(d in profiles)) this.fail('$.default_profile', `no profile '${d}'`);
    }
    return doc as unknown as DoctorFile;
  }
}

export function parents(p: Profile): string[] {
  return p.extends === undefined ? [] : typeof p.extends === 'string' ? [p.extends] : p.extends;
}

function findCycle(profiles: Record<string, Profile>, name: string, stack: string[]): string[] | null {
  if (stack.includes(name)) return [...stack.slice(stack.indexOf(name)), name];
  const p = profiles[name];
  if (p === undefined) return null;
  for (const parent of parents(p)) {
    const c = findCycle(profiles, parent, [...stack, name]);
    if (c !== null) return c;
  }
  return null;
}

/** Validates a parsed file; `label` names it in refusals. */
export function validate(doc: unknown, label: string): DoctorFile {
  return new Validator(label).doc(doc);
}

/** Reads and validates the file; null when it does not exist. */
export function load(path: string, label: string): DoctorFile | null {
  if (!existsSync(path)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never the parser's message: it quotes the input, which may be a dotenv file's value.
    throw new Refused(`${label}: not valid JSON`);
  }
  return validate(doc, label);
}

/** The file's text as factory-doctor writes it: key order kept, two-space indent, final newline. */
export function serialize(doc: DoctorFile): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function save(path: string, doc: DoctorFile, label: string): void {
  validate(JSON.parse(serialize(doc)), label);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(doc));
}

export interface ResolvedRequirement {
  requirement: Requirement;
  /** The profile that declares it (the named one, or one it extends). */
  profile: string;
}

export interface Resolved {
  name: string;
  /** Every profile applied, parents first, the named one last. */
  chain: string[];
  description?: string;
  dotenv: string[];
  requires: ResolvedRequirement[];
}

/**
 * A profile with its `extends` applied: each parent in order (recursively), then the profile itself.
 * A requirement with the same kind and name as an earlier one replaces it in place. The file was
 * validated, so every parent exists and there is no cycle.
 */
export function resolve(doc: DoctorFile, name: string): Resolved {
  const chain: string[] = [];
  const dotenv: string[] = [];
  const reqs = new Map<string, ResolvedRequirement>();
  const visit = (n: string): void => {
    const p = doc.profiles[n];
    if (p === undefined || chain.includes(n)) return;
    for (const parent of parents(p)) visit(parent);
    chain.push(n);
    for (const d of p.dotenv ?? []) if (!dotenv.includes(d)) dotenv.push(d);
    for (const r of p.requires ?? []) reqs.set(requirementKey(r), { requirement: r, profile: n });
  };
  visit(name);
  const description = doc.profiles[name]?.description;
  return { name, chain, ...(description === undefined ? {} : { description }), dotenv, requires: [...reqs.values()] };
}
