// Argument parsing, usage text and exit codes for the `factory` CLI. The commands themselves are in
// factory.ts. Parsing follows the original CLI: options may come anywhere, long options may be
// abbreviated to a unique prefix, and a usage error exits 2 with the usage line on stderr.
import { serveDashboard } from './dashboard.ts';
import {
  cmdApprove,
  cmdBuilt,
  cmdClose,
  cmdConfig,
  cmdFollowupAdd,
  cmdFollowupList,
  cmdFollowupResolve,
  cmdHuman,
  cmdInit,
  cmdMerge,
  cmdNew,
  cmdNote,
  cmdPath,
  cmdProof,
  cmdRework,
  cmdResume,
  cmdRound,
  cmdSpec,
  cmdStart,
  cmdStats,
  cmdStatus,
  cmdVerdict,
  ensure,
  Escalated,
  factoryDir,
  loadConfig,
  Refused,
} from './factory.ts';
import type { Args, Command, Io } from './factory.ts';

export type { Io } from './factory.ts';

/** 0 ok, 1 refused (a gate was not met), 2 escalated to a human (or a usage error). */
export const EXIT = { ok: 0, refused: 1, escalated: 2, usage: 2 } as const;

const DESCRIPTION = `factory - the software factory's state machine.

Every job lives in <repo>/factory/jobs/<id>/ as a job.json plus the markdown
files the agents hand each other. This CLI is the only writer of job.json and
the only way a job changes stage, so the gates below hold no matter what a
prompt says.

    intake -> build -> proof -> review -> ship -> done

Exit codes: 0 ok, 1 refused (a gate was not met), 2 escalated to a human.`;

interface Positional {
  name: string;
  nargs?: '?' | '*' | '+';
  choices?: string[];
  int?: boolean;
  help?: string;
}

interface Option {
  name: string; // without the leading "--"
  value?: 'string' | 'int'; // absent: a boolean flag
  required?: boolean;
  default?: unknown;
  help?: string;
}

interface Spec {
  name: string;
  help: string;
  positionals?: Positional[];
  options?: Option[];
  fn?: Command | 'dashboard';
  sub?: Spec[];
  extra?: Record<string, unknown>;
}

const JOB: Positional = { name: 'job', help: 'job id, number or unique prefix' };

const FOLLOWUP: Spec[] = [
  {
    name: 'add',
    help: 'record a follow-up on a job, in any stage',
    positionals: [JOB, { name: 'text', nargs: '+' }],
    options: [
      {
        name: 'by',
        value: 'string',
        required: true,
        help: 'who raised it: builder, verifier, a reviewer name, supervisor, human',
      },
    ],
    fn: cmdFollowupAdd,
  },
  {
    name: 'list',
    help: 'open follow-ups, for one job or all jobs',
    positionals: [{ name: 'job', nargs: '?', help: 'job id, number or unique prefix' }],
    options: [{ name: 'all', help: 'include done and dropped ones' }, { name: 'json' }],
    fn: cmdFollowupList,
  },
  ...(
    [
      ['done', "mark a follow-up done (say how, e.g. 'job 047')"],
      ['drop', 'drop a follow-up that is no longer worth doing (say why)'],
    ] as const
  ).map(
    ([name, help]): Spec => ({
      name,
      help,
      positionals: [
        JOB,
        { name: 'n', int: true, help: "the follow-up's number within the job" },
        { name: 'note', nargs: '*' },
      ],
      fn: cmdFollowupResolve,
      extra: { action: name },
    }),
  ),
];

export const COMMANDS: Spec[] = [
  { name: 'init', help: 'create ./factory and install the dashboard', fn: cmdInit },
  { name: 'new', help: 'intake: open a job', positionals: [{ name: 'title', nargs: '+' }], fn: cmdNew },
  { name: 'start', help: 'intake -> build: needs task.md; creates the worktree', positionals: [JOB], fn: cmdStart },
  { name: 'spec', help: 'ask a human to approve task.md before building', positionals: [JOB], fn: cmdSpec },
  { name: 'approve', help: "human gate: approve a job's spec", positionals: [JOB], fn: cmdApprove },
  { name: 'built', help: 'build -> proof: needs build.md and clean commits', positionals: [JOB], fn: cmdBuilt },
  {
    name: 'proof',
    help: "verifier's result: pass -> review, fail -> build",
    positionals: [JOB, { name: 'result', choices: ['pass', 'fail'] }],
    fn: cmdProof,
  },
  {
    name: 'round',
    help: 'open a review round',
    positionals: [JOB, { name: 'reviewers', nargs: '*', help: 'default: the reviewers in factory.json' }],
    fn: cmdRound,
  },
  {
    name: 'verdict',
    help: "a reviewer's verdict; needs review-<round>-<reviewer>.md",
    positionals: [JOB, { name: 'reviewer' }, { name: 'verdict', choices: ['approve', 'changes'] }],
    fn: cmdVerdict,
  },
  {
    name: 'human',
    help: 'flag a job as needing a human',
    positionals: [JOB, { name: 'reason', nargs: '+' }],
    fn: cmdHuman,
  },
  {
    name: 'resume',
    help: 'human: clear needs-human and continue',
    positionals: [JOB],
    options: [{ name: 'reset', help: 'also reset proof attempts and review rounds' }],
    fn: cmdResume,
  },
  {
    name: 'merge',
    help: 'human gate: merge an approved job and clean up',
    positionals: [JOB],
    options: [{ name: 'into-current' }],
    fn: cmdMerge,
  },
  {
    name: 'rework',
    help: 'human: send an approved job back to build',
    positionals: [JOB, { name: 'reason', nargs: '+', help: 'what to change; saved as rework-<round>.md' }],
    fn: cmdRework,
  },
  {
    name: 'close',
    help: 'human: abandon a job without merging',
    positionals: [JOB, { name: 'reason', nargs: '*' }],
    fn: cmdClose,
  },
  { name: 'config', help: 'print the effective configuration (factory.json over defaults)', fn: cmdConfig },
  {
    name: 'note',
    help: "set the job's activity line",
    positionals: [JOB, { name: 'text', nargs: '+' }],
    fn: cmdNote,
  },
  {
    name: 'followup',
    help: 'record, list and resolve follow-ups (later work a job turned up)',
    sub: FOLLOWUP,
  },
  {
    name: 'path',
    help: 'print the job dir (or --worktree)',
    positionals: [JOB],
    options: [{ name: 'worktree' }],
    fn: cmdPath,
  },
  {
    name: 'status',
    help: 'list jobs, or show one',
    positionals: [{ name: 'job', nargs: '?' }],
    options: [{ name: 'json' }],
    fn: cmdStatus,
  },
  {
    name: 'stats',
    help: 'line metrics: proof and review pass rates, rounds, time, escalations',
    options: [{ name: 'json' }],
    fn: cmdStats,
  },
  {
    name: 'dashboard',
    help: 'serve the dashboard',
    options: [{ name: 'port', value: 'int', default: 8787 }],
    fn: 'dashboard',
  },
];

class UsageError extends Error {
  readonly usage: string;
  readonly prog: string;
  constructor(prog: string, usage: string, message: string) {
    super(message);
    this.prog = prog;
    this.usage = usage;
  }
}

/** Printed by --help; exits 0. */
class HelpRequested extends Error {}

const choiceList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

function positionalUsage(p: Positional): string {
  const shown = p.choices ? `{${p.choices.join(',')}}` : p.name;
  switch (p.nargs) {
    case '?':
      return `[${shown}]`;
    case '*':
      return `[${shown} ...]`;
    case '+':
      return `${shown} [${shown} ...]`;
    default:
      return shown;
  }
}

function optionUsage(o: Option): string {
  const metavar = o.name.toUpperCase().replace(/-/g, '_');
  const text = o.value ? `--${o.name} ${metavar}` : `--${o.name}`;
  return o.required ? text : `[${text}]`;
}

function usageLine(prog: string, spec: Spec): string {
  const parts = [`usage: ${prog} [-h]`];
  for (const o of spec.options ?? []) parts.push(optionUsage(o));
  if (spec.sub) parts.push(`{${spec.sub.map((x) => x.name).join(',')}} ...`);
  for (const p of spec.positionals ?? []) parts.push(positionalUsage(p));
  return parts.join(' ');
}

function row(name: string, help: string | undefined): string {
  if (!help) return `  ${name}\n`;
  return name.length <= 20 ? `  ${name.padEnd(20)}${help}\n` : `  ${name}\n  ${' '.repeat(20)}${help}\n`;
}

function commandHelp(prog: string, spec: Spec): string {
  let text = `${usageLine(prog, spec)}\n`;
  if (spec.help) text += `\n${spec.help}\n`;
  const positionals = spec.positionals ?? [];
  if (spec.sub) {
    text += `\npositional arguments:\n  {${spec.sub.map((x) => x.name).join(',')}}\n`;
    for (const x of spec.sub) text += row(`  ${x.name}`, x.help);
  } else if (positionals.length > 0) {
    text += '\npositional arguments:\n';
    for (const p of positionals) text += row(p.choices ? `{${p.choices.join(',')}}` : p.name, p.help);
  }
  text += '\noptions:\n' + row('-h, --help', 'show this help message and exit');
  for (const o of spec.options ?? []) {
    const metavar = o.name.toUpperCase().replace(/-/g, '_');
    text += row(o.value ? `--${o.name} ${metavar}` : `--${o.name}`, o.help);
  }
  return text;
}

export function topHelp(): string {
  let text = `usage: factory [-h] {${COMMANDS.map((c) => c.name).join(',')}} ...\n\n${DESCRIPTION}\n\ncommands:\n`;
  for (const c of COMMANDS) {
    const name = c.sub ? `${c.name} {${c.sub.map((x) => x.name).join(',')}}` : c.name;
    text += row(name, c.help);
  }
  text += `\nRun 'factory <command> --help' for a command's arguments.\n\noptions:\n`;
  text += row('-h, --help', 'show this help message and exit');
  return text;
}

function parseInt10(text: string): number | null {
  return /^\s*[+-]?\d+\s*$/.test(text) ? Number.parseInt(text, 10) : null;
}

const looksNegative = (t: string): boolean => /^-\d+$|^-\d*\.\d+$/.test(t);

interface Parsed {
  spec: Spec;
  args: Record<string, unknown>;
}

function parseCommand(prog: string, spec: Spec, argv: string[]): Parsed {
  const usage = usageLine(prog, spec);
  const fail = (message: string): never => {
    throw new UsageError(prog, usage, message);
  };
  const options = spec.options ?? [];
  const args: Record<string, unknown> = { ...spec.extra };
  for (const o of options) args[o.name.replace(/-/g, '_')] = o.value ? (o.default ?? null) : false;
  const positionals: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (spec.sub && positionals.length === 0 && !token.startsWith('-')) {
      const sub = spec.sub.find((x) => x.name === token);
      if (!sub) fail(`argument action: invalid choice: '${token}' (choose from ${choiceList(spec.sub.map((x) => x.name))})`);
      const inner = parseCommand(`${prog} ${token}`, sub as Spec, argv.slice(i + 1));
      return { spec: inner.spec, args: { action: token, ...inner.args } };
    }
    if (!token.startsWith('-') || token === '-' || looksNegative(token)) {
      positionals.push(token);
      continue;
    }
    if (token === '-h') throw new HelpRequested(commandHelp(prog, spec));
    if (!token.startsWith('--')) fail(`unrecognized arguments: ${token}`);
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).slice(2);
    const candidates = [...options.map((o) => o.name), 'help'];
    let match = candidates.find((c) => c === name);
    if (!match) {
      const hits = candidates.filter((c) => c.startsWith(name));
      if (hits.length > 1) {
        fail(`ambiguous option: --${name} could match ${hits.map((h) => `--${h}`).join(', ')}`);
      }
      match = hits[0];
    }
    if (!match) {
      fail(`unrecognized arguments: ${token}`);
      continue;
    }
    if (match === 'help') throw new HelpRequested(commandHelp(prog, spec));
    const option = options.find((o) => o.name === match) as Option;
    const key = option.name.replace(/-/g, '_');
    seen.add(option.name);
    if (!option.value) {
      if (eq !== -1) fail(`argument --${option.name}: ignored explicit argument '${token.slice(eq + 1)}'`);
      args[key] = true;
      continue;
    }
    let value: string;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && !looksNegative(next))) {
        return fail(`argument --${option.name}: expected one argument`);
      }
      value = next;
      i++;
    }
    if (option.value === 'int') {
      const n = parseInt10(value);
      if (n === null) fail(`argument --${option.name}: invalid int value: '${value}'`);
      args[key] = n;
    } else {
      args[key] = value;
    }
  }

  if (spec.sub) fail('the following arguments are required: action');

  const specs = spec.positionals ?? [];
  const minimum = (p: Positional): number => (p.nargs === '?' || p.nargs === '*' ? 0 : 1);
  const missing: string[] = [];
  let at = 0;
  specs.forEach((p, index) => {
    const laterMin = specs.slice(index + 1).reduce((t, q) => t + minimum(q), 0);
    const available = Math.max(0, positionals.length - at - laterMin);
    if (p.nargs === undefined) {
      if (available < 1) {
        missing.push(p.name);
        return;
      }
      args[p.name] = positionals[at++];
    } else if (p.nargs === '?') {
      args[p.name] = available >= 1 ? positionals[at++] : null;
    } else {
      if (p.nargs === '+' && available < 1) missing.push(p.name);
      args[p.name] = positionals.slice(at, at + available);
      at += available;
    }
  });
  for (const o of options) if (o.required && !seen.has(o.name)) missing.push(`--${o.name}`);
  if (missing.length > 0) fail(`the following arguments are required: ${missing.join(', ')}`);
  if (at < positionals.length) fail(`unrecognized arguments: ${positionals.slice(at).join(' ')}`);

  for (const p of specs) {
    const values = Array.isArray(args[p.name]) ? (args[p.name] as string[]) : [args[p.name]];
    for (const v of values) {
      if (typeof v !== 'string') continue;
      if (p.choices && !p.choices.includes(v)) {
        fail(`argument ${p.name}: invalid choice: '${v}' (choose from ${choiceList(p.choices)})`);
      }
    }
    if (p.int && typeof args[p.name] === 'string') {
      const n = parseInt10(args[p.name] as string);
      if (n === null) fail(`argument ${p.name}: invalid int value: '${String(args[p.name])}'`);
      args[p.name] = n;
    }
  }
  return { spec, args };
}

function parse(argv: string[]): Parsed {
  const usage = `usage: factory [-h] {${COMMANDS.map((c) => c.name).join(',')}} ...`;
  for (const [i, token] of argv.entries()) {
    if (token === '-h' || (token.startsWith('--') && token.length > 2 && 'help'.startsWith(token.slice(2)))) {
      throw new HelpRequested(topHelp());
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError('factory', usage, `unrecognized arguments: ${token}`);
    }
    const spec = COMMANDS.find((c) => c.name === token);
    if (!spec) {
      throw new UsageError(
        'factory',
        usage,
        `argument cmd: invalid choice: '${token}' (choose from ${choiceList(COMMANDS.map((c) => c.name))})`,
      );
    }
    return parseCommand(`factory ${token}`, spec, argv.slice(i + 1));
  }
  throw new UsageError('factory', usage, 'the following arguments are required: cmd');
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse([...argv]);
  } catch (error) {
    if (error instanceof HelpRequested) {
      io.stdout(error.message);
      return EXIT.ok;
    }
    if (error instanceof UsageError) {
      io.stderr(`${error.usage}\n${error.prog}: error: ${error.message}\n`);
      return EXIT.usage;
    }
    throw error;
  }
  try {
    const root = ensure(factoryDir());
    const a: Args = { ...parsed.args, cfg: loadConfig(root) };
    const fn = parsed.spec.fn;
    if (fn === 'dashboard') {
      await serveDashboard(root, a.port as number, io);
      return EXIT.ok;
    }
    (fn as Command)(root, a, io);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof Refused) {
      io.stderr(`refused: ${error.message}\n`);
      return EXIT.refused;
    }
    if (error instanceof Escalated) {
      io.stderr(`escalated to a human: ${error.message}\n`);
      return EXIT.escalated;
    }
    io.stderr(`factory: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.refused;
  }
}
