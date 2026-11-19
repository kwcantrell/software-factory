// add, remove and init: the only commands that change the requirements file. Each is a dry run that
// says what it would change unless `confirm` is set. The file keeps its key order and two-space
// indent, and is validated before it is written.
import { existsSync } from 'node:fs';
import type { Location } from './repo.ts';
import {
  type DoctorFile,
  ENV_FORMATS,
  type EnvFormat,
  FORMAT_VERSION,
  KINDS,
  type Kind,
  load,
  PROFILE_NAME,
  type Profile,
  Refused,
  type Requirement,
  requirementKey,
  requirementName,
  resolve as resolveProfile,
  save,
  validate,
} from './requirements.ts';
import type { Proposal } from './scan.ts';

export interface Change {
  action: 'add' | 'remove' | 'init';
  file: string;
  profile?: string;
  requirement?: Requirement;
  /** True when this change creates the file. */
  created_file: boolean;
  /** True when it creates (add) or deletes (remove) the profile itself. */
  profile_change: boolean;
  /** False for a dry run. */
  written: boolean;
  /** The file as it would be (dry run) or now is. */
  content: string;
}

export interface AddOptions {
  kind: string;
  name: string;
  profile: string;
  why?: string;
  source?: string;
  optional?: boolean;
  description?: string;
  format?: string;
  version?: string;
  versionCommand?: string;
  versionPattern?: string;
  extends?: string;
}

/** A usage problem in add/remove arguments: exit 2. */
export class UsageError extends Error {}

function empty(): DoctorFile {
  return { version: FORMAT_VERSION, profiles: {} };
}

function parseFormat(f: string): EnvFormat {
  if ((ENV_FORMATS as readonly string[]).includes(f)) return f as EnvFormat;
  if (f.startsWith('regex:')) return { regex: f.slice('regex:'.length) };
  throw new UsageError(`--format must be ${ENV_FORMATS.join(', ')} or regex:<pattern>`);
}

/** Builds the requirement from add's arguments, keys in the file's canonical order. */
export function buildRequirement(o: AddOptions): Requirement {
  if (!(KINDS as readonly string[]).includes(o.kind)) throw new UsageError(`unknown kind '${o.kind}' (kinds: ${KINDS.join(', ')}, profile)`);
  const kind = o.kind as Kind;
  // Never echo it: whatever follows `=` would be a value.
  if (kind === 'env' && o.name.includes('=')) throw new Refused('an env requirement is a variable name, not NAME=value: factory-doctor never stores values; set the value yourself');
  if (o.why === undefined || o.why.trim() === '') throw new UsageError('add needs --why "<text>": why running the app needs it');
  const allowed: Record<Kind, readonly (keyof AddOptions)[]> = {
    tool: ['version', 'versionCommand', 'versionPattern'],
    env: ['description', 'format'],
    file: [],
    'claude-plugin': [],
    'claude-skill': [],
    service: [],
  };
  const flags: Record<string, string> = { version: '--tool-version', versionCommand: '--version-command', versionPattern: '--version-pattern', description: '--description', format: '--format' };
  for (const [k, flag] of Object.entries(flags)) {
    if (o[k as keyof AddOptions] !== undefined && !allowed[kind].includes(k as keyof AddOptions)) throw new UsageError(`${flag} does not apply to a ${kind} requirement`);
  }
  if (o.extends !== undefined) throw new UsageError('--extends applies only to add profile');
  let head: Record<string, unknown>;
  switch (kind) {
    case 'tool':
      head = {
        kind,
        name: o.name,
        ...(o.version === undefined ? {} : { version: o.version }),
        ...(o.versionCommand === undefined ? {} : { version_command: o.versionCommand.trim().split(/\s+/) }),
        ...(o.versionPattern === undefined ? {} : { version_pattern: o.versionPattern }),
      };
      break;
    case 'env':
      head = { kind, name: o.name, ...(o.description === undefined ? {} : { description: o.description }), ...(o.format === undefined ? {} : { format: parseFormat(o.format) }) };
      break;
    case 'file':
      head = { kind, path: o.name };
      break;
    case 'service': {
      const m = /^(.+):(\d+)$/.exec(o.name);
      if (m === null) throw new UsageError('a service is named <host>:<port>');
      head = { kind, host: (m[1] ?? '').replace(/^\[(.*)\]$/, '$1'), port: Number(m[2]) };
      break;
    }
    default:
      head = { kind, name: o.name };
  }
  return { ...head, ...(o.optional === true ? { optional: true } : {}), why: o.why, ...(o.source === undefined ? {} : { source: o.source }) } as unknown as Requirement;
}

function loadOrEmpty(loc: Location): { doc: DoctorFile; created: boolean } {
  const doc = load(loc.path, loc.label);
  return doc === null ? { doc: empty(), created: true } : { doc, created: false };
}

function finish(loc: Location, doc: DoctorFile, change: Omit<Change, 'written' | 'content' | 'file'>, confirm: boolean): Change {
  // Validate what would be written, in full, before writing anything (also on a dry run).
  const content = `${JSON.stringify(doc, null, 2)}\n`;
  validate(JSON.parse(content), loc.label);
  if (confirm) save(loc.path, doc, loc.label);
  return { ...change, file: loc.label, written: confirm, content };
}

function checkProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) throw new UsageError(`'${name}' is not a profile name (letters, digits, '.', '_', '-')`);
}

export function addProfile(loc: Location, name: string, description: string | undefined, ext: string | undefined, confirm: boolean): Change {
  checkProfileName(name);
  const { doc, created } = loadOrEmpty(loc);
  if (name in doc.profiles) throw new Refused(`${loc.label} already has a profile '${name}'`);
  const extendsList = ext === undefined ? [] : ext.split(',').map((e) => e.trim()).filter((e) => e !== '');
  const profile: Profile = {
    ...(description === undefined ? {} : { description }),
    ...(extendsList.length === 0 ? {} : { extends: extendsList.length === 1 ? extendsList[0] : extendsList }),
    requires: [],
  };
  doc.profiles[name] = profile;
  if (created) doc.default_profile = name;
  if (created) reorder(doc);
  return finish(loc, doc, { action: 'add', profile: name, created_file: created, profile_change: true }, confirm);
}

/** Puts a new file's top-level keys in the documented order. */
function reorder(doc: DoctorFile): void {
  const { version, description, default_profile, profiles } = doc;
  for (const k of Object.keys(doc)) delete (doc as unknown as Record<string, unknown>)[k];
  Object.assign(doc, { version, ...(description === undefined ? {} : { description }), ...(default_profile === undefined ? {} : { default_profile }), profiles });
}

export function add(loc: Location, o: AddOptions, confirm: boolean): Change {
  checkProfileName(o.profile);
  const requirement = buildRequirement(o);
  const { doc, created } = loadOrEmpty(loc);
  let newProfile = false;
  if (!(o.profile in doc.profiles)) {
    doc.profiles[o.profile] = { requires: [] };
    newProfile = true;
    if (created) {
      doc.default_profile = o.profile;
      reorder(doc);
    }
  }
  const profile = doc.profiles[o.profile] as Profile;
  const key = requirementKey(requirement);
  const own = (profile.requires ?? []).find((r) => requirementKey(r) === key);
  if (own !== undefined) throw new Refused(`profile '${o.profile}' already has ${key}; remove it first to change it`);
  const inherited = resolveProfile(doc, o.profile).requires.find((r) => requirementKey(r.requirement) === key);
  if (inherited !== undefined) throw new Refused(`profile '${o.profile}' already gets ${key} from profile '${inherited.profile}'`);
  profile.requires = [...(profile.requires ?? []), requirement];
  return finish(loc, doc, { action: 'add', profile: o.profile, requirement, created_file: created, profile_change: newProfile }, confirm);
}

/** add --from-scan: the proposal as add options (the person may override profile and why). */
export function fromProposal(p: Proposal, profile: string | undefined, why: string | undefined): AddOptions {
  return {
    kind: p.kind,
    name: p.name,
    profile: profile ?? p.profile,
    why: why ?? p.why,
    source: p.source,
    ...(p.version === undefined ? {} : { version: p.version }),
    ...(p.optional === true ? { optional: true } : {}),
  };
}

export function remove(loc: Location, kind: string, name: string, profileName: string | undefined, confirm: boolean): Change {
  const doc = load(loc.path, loc.label);
  if (doc === null) throw new Refused(`${loc.label} does not exist; nothing to remove`);
  if (kind === 'profile') {
    if (!(name in doc.profiles)) throw new Refused(`${loc.label} has no profile '${name}'`);
    const dependents = Object.entries(doc.profiles).filter(([, p]) => [p.extends ?? []].flat().includes(name)).map(([n]) => n);
    if (dependents.length > 0) throw new Refused(`profile '${name}' is extended by ${dependents.join(', ')}; change those first`);
    if (doc.default_profile === name) throw new Refused(`profile '${name}' is the default_profile; change that first`);
    delete doc.profiles[name];
    return finish(loc, doc, { action: 'remove', profile: name, created_file: false, profile_change: true }, confirm);
  }
  if (!(KINDS as readonly string[]).includes(kind)) throw new UsageError(`unknown kind '${kind}' (kinds: ${KINDS.join(', ')}, profile)`);
  if (profileName === undefined) throw new UsageError('remove needs --profile <p>');
  const profile = doc.profiles[profileName];
  if (profile === undefined) throw new Refused(`${loc.label} has no profile '${profileName}'`);
  const reqs = profile.requires ?? [];
  const i = reqs.findIndex((r) => r.kind === kind && requirementName(r) === name);
  if (i < 0) {
    const inherited = resolveProfile(doc, profileName).requires.find((r) => r.requirement.kind === kind && requirementName(r.requirement) === name);
    if (inherited !== undefined) throw new Refused(`profile '${profileName}' gets ${kind} ${name} from profile '${inherited.profile}'; remove it there`);
    throw new Refused(`profile '${profileName}' has no ${kind} ${name}`);
  }
  const requirement = reqs[i] as Requirement;
  profile.requires = reqs.filter((_, j) => j !== i);
  return finish(loc, doc, { action: 'remove', profile: profileName, requirement, created_file: false, profile_change: false }, confirm);
}

export function starter(): DoctorFile {
  return {
    version: FORMAT_VERSION,
    default_profile: 'dev',
    profiles: {
      dev: { description: 'Running the app locally for development', dotenv: ['.env'], requires: [] },
      test: { description: 'Running the test suite', extends: 'dev', requires: [] },
    },
  };
}

export function init(loc: Location, confirm: boolean): Change {
  if (existsSync(loc.path)) throw new Refused(`${loc.label} already exists; change it with add and remove`);
  return finish(loc, starter(), { action: 'init', created_file: true, profile_change: true }, confirm);
}

export function changeText(c: Change): string {
  const verb = c.written ? (c.action === 'remove' ? 'Removed' : c.action === 'init' ? 'Wrote' : 'Added') : c.action === 'remove' ? 'Would remove' : c.action === 'init' ? 'Would write' : 'Would add';
  const lines: string[] = [];
  if (c.action === 'init') lines.push(`${verb} ${c.file} with the profiles dev and test:`, ...c.content.trimEnd().split('\n').map((l) => `  ${l}`));
  else if (c.requirement !== undefined) {
    lines.push(`${verb} in ${c.file}, profile ${c.profile}${c.action === 'add' && c.profile_change ? ' (a new profile)' : ''}:`);
    lines.push(`  ${c.action === 'remove' ? '-' : '+'} ${JSON.stringify(c.requirement)}`);
  } else lines.push(`${verb} the profile ${c.profile} ${c.action === 'remove' ? 'from' : 'in'} ${c.file}`);
  if (c.created_file && c.action !== 'init') lines.push(`${c.written ? 'Created' : 'Would create'} ${c.file}.`);
  if (!c.written) lines.push('Dry run: nothing was written. Run it again with --confirm to write it.');
  return `${lines.join('\n')}\n`;
}
