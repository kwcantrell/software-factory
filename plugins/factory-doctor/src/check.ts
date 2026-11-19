// check: this machine against a resolved profile, one result per requirement.
//
// Secrets: an env var's value is read only to test its format, and never goes into a result. Every
// `detail` and `fix` below is built from the requirement (names, paths, constraints from the file)
// and from facts this module derives (a tool's parsed version number, whether a file exists),
// never from a variable's value or a dotenv file's contents. Dotenv files are read for names only.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join } from 'node:path';
import { type ClaudeRecords, type Env, readClaudeRecords } from './claude.ts';
import { readDotenvNames, resolvePath } from './repo.ts';
import { DEFAULT_TIMEOUT_MS, type EnvRequirement, type Requirement, requirementName, type Resolved, type ServiceRequirement, type ToolRequirement } from './requirements.ts';
import { extractVersion, parseConstraint, satisfies } from './version.ts';

export type Status = 'ok' | 'missing' | 'wrong';

export interface Result {
  kind: Requirement['kind'];
  name: string;
  status: Status;
  optional: boolean;
  /** The profile that declares it. */
  profile: string;
  why: string;
  source?: string;
  /** What was found, in a few words. Never a value. */
  detail: string;
  /** How to fix it, for missing and wrong. */
  fix?: string;
}

export interface Report {
  file: string;
  profile: string;
  chain: string[];
  /** True when nothing required is missing or wrong. */
  ok: boolean;
  summary: { ok: number; missing: number; wrong: number; required_problems: number };
  results: Result[];
}

export interface CheckContext {
  root: string;
  env: Env;
  /** The cwd Claude Code would apply plugin settings in: the repository root. */
  claude?: ClaudeRecords;
}

/** The executable `name` on PATH, or null. */
export function which(name: string, env: Env): string | null {
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

function checkTool(r: ToolRequirement, ctx: CheckContext): Pick<Result, 'status' | 'detail' | 'fix'> {
  const path = which(r.name, ctx.env);
  if (path === null) {
    return { status: 'missing', detail: 'not found on PATH', fix: `install ${r.name}${r.version === undefined ? '' : ` (${r.version})`} and put it on PATH` };
  }
  if (r.version === undefined) return { status: 'ok', detail: `found at ${path}` };
  const constraint = parseConstraint(r.version);
  const [, ...args] = r.version_command ?? [r.name, '--version'];
  // No shell: the tool itself (the file found on PATH) with its arguments from the requirement.
  const run = spawnSync(path, args, { encoding: 'utf8', timeout: 5000, env: ctx.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.root });
  const version = extractVersion(`${run.stdout ?? ''}\n${run.stderr ?? ''}`, r.version_pattern);
  const command = [r.name, ...args].join(' ');
  if (version === null) {
    return { status: 'wrong', detail: `found, but '${command}' printed no version`, fix: `check that '${command}' prints ${r.name}'s version (set version_command or version_pattern), or install ${r.name} ${r.version}` };
  }
  if (constraint !== null && satisfies(version, constraint)) return { status: 'ok', detail: `${version} matches ${r.version}` };
  return { status: 'wrong', detail: `${version} does not match ${r.version}`, fix: `install ${r.name} ${r.version} (found ${version})` };
}

export function formatOk(value: string, format: NonNullable<EnvRequirement['format']>): boolean {
  if (typeof format === 'object') return new RegExp(format.regex).test(value);
  switch (format) {
    case 'non-empty':
      return value.trim() !== '';
    case 'integer':
      return /^-?\d+$/.test(value.trim());
    case 'url': {
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.trim())) return false;
      try {
        new URL(value.trim());
        return true;
      } catch {
        return false;
      }
    }
  }
}

const formatName = (f: NonNullable<EnvRequirement['format']>): string => (typeof f === 'object' ? `the pattern ${f.regex}` : f === 'url' ? 'a URL' : f === 'integer' ? 'an integer' : 'non-empty');

function checkEnv(r: EnvRequirement, ctx: CheckContext, dotenv: readonly string[]): Pick<Result, 'status' | 'detail' | 'fix'> {
  const where = dotenv.length === 0 ? 'in your environment' : `in your environment or in ${dotenv.join(', ')}`;
  const value = ctx.env[r.name];
  if (value !== undefined) {
    if (r.format === undefined || formatOk(value, r.format)) return { status: 'ok', detail: `set in the environment${r.format === undefined ? '' : `, ${formatName(r.format)}`}` };
    return { status: 'wrong', detail: `set in the environment, but not ${formatName(r.format)}`, fix: `set ${r.name} to ${formatName(r.format)} yourself ${where} (factory-doctor never shows or sets values)` };
  }
  for (const d of dotenv) {
    const names = readDotenvNames(resolvePath(ctx.root, d, ctx.env.HOME));
    if (names?.has(r.name)) return { status: 'ok', detail: `set in ${d}${r.format === undefined ? '' : ' (format not checked: dotenv values are never read)'}` };
  }
  return { status: 'missing', detail: dotenv.length === 0 ? 'not set' : `not set, and not in ${dotenv.join(', ')}`, fix: `set ${r.name} yourself ${where}${r.description === undefined ? '' : ` (${r.description})`}; factory-doctor never sets values` };
}

function checkClaude(r: Requirement & { kind: 'claude-plugin' | 'claude-skill' }, ctx: CheckContext): Pick<Result, 'status' | 'detail' | 'fix'> {
  const records = ctx.claude ?? readClaudeRecords(ctx.env, ctx.root);
  ctx.claude = records;
  if (r.kind === 'claude-plugin') {
    const plugin = records.installed.find((p) => p.id === r.name);
    const install = `claude plugin install ${r.name}`;
    if (plugin === undefined) {
      const other = records.elsewhere.find((p) => p.id === r.name);
      if (other !== undefined) return { status: 'missing', detail: `installed only for another project (${other.projectPath})`, fix: `add it to this project with /plugin, or ${install}` };
      return { status: 'missing', detail: 'not installed', fix: install };
    }
    if (!plugin.enabled) return { status: 'wrong', detail: 'installed, but disabled', fix: `enable ${r.name} with /plugin` };
    return { status: 'ok', detail: 'installed and enabled' };
  }
  const colon = r.name.indexOf(':');
  const pluginName = colon < 0 ? null : r.name.slice(0, colon);
  const skill = colon < 0 ? r.name : r.name.slice(colon + 1);
  const owners = records.installed.filter((p) => (pluginName === null || p.name === pluginName) && p.skills.includes(skill));
  if (owners.some((p) => p.enabled)) return { status: 'ok', detail: `provided by ${owners.filter((p) => p.enabled).map((p) => p.id).join(', ')}` };
  if (pluginName === null && records.skills.includes(skill)) return { status: 'ok', detail: 'a user or project skill' };
  if (owners.length > 0) return { status: 'wrong', detail: `provided by ${owners.map((p) => p.id).join(', ')}, which is disabled`, fix: `enable ${owners[0]?.id} with /plugin` };
  return {
    status: 'missing',
    detail: 'no installed plugin or skill provides it',
    fix: pluginName === null ? `install the plugin that provides the skill ${skill} (claude plugin install <plugin>@<marketplace>), or add it under ${records.claudeDir}/skills` : `install the ${pluginName} plugin (claude plugin install ${pluginName}@<marketplace>)`,
  };
}

/** Whether host:port accepts a TCP connection within the timeout. Opens and closes it; sends nothing. */
export function reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean): void => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function checkService(r: ServiceRequirement): Promise<Pick<Result, 'status' | 'detail' | 'fix'>> {
  const ms = r.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (await reachable(r.host, r.port, ms)) return { status: 'ok', detail: 'accepts connections' };
  return { status: 'missing', detail: `nothing accepted a connection within ${ms / 1000} s`, fix: `start the service on ${r.host}:${r.port} (factory-doctor never starts it)` };
}

export async function check(resolved: Resolved, ctx: CheckContext, file: string): Promise<Report> {
  const results = await Promise.all(
    resolved.requires.map(async ({ requirement: r, profile }): Promise<Result> => {
      let outcome: Pick<Result, 'status' | 'detail' | 'fix'>;
      switch (r.kind) {
        case 'tool':
          outcome = checkTool(r, ctx);
          break;
        case 'env':
          outcome = checkEnv(r, ctx, resolved.dotenv);
          break;
        case 'file':
          try {
            statSync(resolvePath(ctx.root, r.path, ctx.env.HOME));
            outcome = { status: 'ok', detail: 'exists' };
          } catch {
            outcome = { status: 'missing', detail: 'does not exist', fix: `create ${r.path} (factory-doctor never reads or writes its contents)` };
          }
          break;
        case 'claude-plugin':
        case 'claude-skill':
          outcome = checkClaude(r, ctx);
          break;
        case 'service':
          outcome = await checkService(r);
          break;
      }
      return {
        kind: r.kind,
        name: requirementName(r),
        status: outcome.status,
        optional: r.optional === true,
        profile,
        why: r.why,
        ...(r.source === undefined ? {} : { source: r.source }),
        detail: outcome.detail,
        ...(outcome.fix === undefined ? {} : { fix: outcome.fix }),
      };
    }),
  );
  const count = (s: Status): number => results.filter((r) => r.status === s).length;
  const requiredProblems = results.filter((r) => r.status !== 'ok' && !r.optional).length;
  return {
    file,
    profile: resolved.name,
    chain: resolved.chain,
    ok: requiredProblems === 0,
    summary: { ok: count('ok'), missing: count('missing'), wrong: count('wrong'), required_problems: requiredProblems },
    results,
  };
}

export function reportText(r: Report): string {
  const parents = r.chain.slice(0, -1);
  const lines = [`profile ${r.profile}${parents.length === 0 ? '' : ` (extends ${parents.join(', ')})`} from ${r.file}`];
  for (const x of r.results) {
    lines.push(`${x.status.padEnd(8)}${x.kind} ${x.name}${x.optional ? ' (optional)' : ''}: ${x.detail}`);
    if (x.fix !== undefined) lines.push(`${' '.repeat(8)}fix: ${x.fix}`);
  }
  if (r.results.length === 0) lines.push('(no requirements)');
  const s = r.summary;
  lines.push(`${s.ok} ok, ${s.missing} missing, ${s.wrong} wrong; ${s.required_problems === 0 ? 'everything required is in place' : `${s.required_problems} required ${s.required_problems === 1 ? 'problem' : 'problems'}`}`);
  return `${lines.join('\n')}\n`;
}
