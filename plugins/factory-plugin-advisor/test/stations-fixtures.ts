// Fixture factory dirs for the `stations` tests: job dirs (job.json, review, proof and build files)
// written the way the factory CLI writes them, from a short spec, so each test states its history.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface JobSpec {
  id: string;
  /** history events in order, as the factory CLI logs them. Rounds and verdicts are derived from them. */
  events: string[];
  /** [by, text] follow-ups. */
  followups?: Array<[string, string]>;
  /** `<round>-<reviewer>` -> the Blocking section's text (default `None.`). */
  blocking?: Record<string, string>;
  /** proof.md: PASS, or FAIL with the first failure line. */
  proof?: 'PASS' | { fail: string };
  /** Leave keys out, like job.json files written by older CLIs. */
  omit?: Array<'followups' | 'rounds' | 'history'>;
}

/** The usual event run of one job: built, proof passed, one round in which everyone approved. */
export const APPROVED = (reviewers: string[] = ['security', 'standards', 'behavior']): string[] => [
  'created',
  'building',
  'awaiting independent proof',
  'proof passed',
  'review round 1 opened',
  ...reviewers.map((r) => `round 1: ${r} -> approve`),
  'approved in round 1',
  'needs human: approved by every reviewer - awaiting your merge',
  'merged into main',
];

const at = (i: number): string => new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function writeJob(factoryDir: string, spec: JobSpec): void {
  const dir = join(factoryDir, 'jobs', spec.id);
  mkdirSync(dir, { recursive: true });
  const rounds: Array<{ n: number; reviewers: Record<string, { verdict: string | null; at: string | null }> }> = [];
  const history = spec.events.map((event, i) => {
    const opened = /^review round (\d+) opened$/.exec(event);
    if (opened) rounds.push({ n: Number(opened[1]), reviewers: {} });
    const v = /^round (\d+): ([a-z0-9-]+) -> (approve|changes)$/.exec(event);
    if (v) {
      const r = rounds.find((x) => x.n === Number(v[1]));
      if (r) r.reviewers[v[2] as string] = { verdict: v[3] as string, at: at(i) };
    }
    return { at: at(i), stage: /^(building|awaiting|proof failed|rework)/.test(event) ? 'build' : 'review', event };
  });
  const job: Record<string, unknown> = {
    id: spec.id,
    title: spec.id,
    stage: 'done',
    status: 'merged',
    needs_human: null,
    activity: spec.events.at(-1) ?? '',
    branch: `factory/${spec.id}`,
    base: null,
    base_branch: 'main',
    worktree: null,
    proof_attempts: spec.events.filter((e) => e.startsWith('proof failed')).length,
    rounds,
    followups: (spec.followups ?? []).map(([by, text], i) => ({ n: i + 1, text, by, stage: 'review', at: at(0), status: 'open', resolution: null, resolved_at: null })),
    created: at(0),
    history,
  };
  for (const key of spec.omit ?? []) delete job[key];
  writeFileSync(join(dir, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(join(dir, 'task.md'), '# A job\n\n## Acceptance criteria\n\n1. It works.\n');
  if (spec.events.includes('building')) writeFileSync(join(dir, 'build.md'), '# Build\n');
  for (const r of rounds) {
    for (const [name, slot] of Object.entries(r.reviewers)) {
      const blocking = spec.blocking?.[`${r.n}-${name}`] ?? 'None.';
      writeFileSync(
        join(dir, `review-${r.n}-${name}.md`),
        `# Review ${r.n}: ${name}\n\n**Verdict: ${slot.verdict === 'approve' ? 'APPROVE' : 'CHANGES'}**\n\n## Blocking\n\n${blocking}\n\n## Non-blocking\n\n- The performance, docs and security of this change look fine.\n`,
      );
    }
  }
  if (spec.proof !== undefined) {
    const fail = spec.proof === 'PASS' ? null : spec.proof.fail;
    writeFileSync(
      join(dir, 'proof.md'),
      `# Proof: ${spec.id}\n\n## Verdict\n${fail === null ? 'PASS' : 'FAIL'}\n\n## Criteria\n| # | Criterion | Met |\n|---|---|---|\n| 1 | It works | ${fail === null ? 'yes' : 'no'} |\n\n## Failures\n${fail === null ? 'None.' : `1. ${fail}\n   Reproduce: run the tests.`}\n`,
    );
  }
}

export function writeLine(factoryDir: string, jobs: readonly JobSpec[]): void {
  mkdirSync(join(factoryDir, 'jobs'), { recursive: true });
  for (const j of jobs) writeJob(factoryDir, j);
}

/**
 * The report fixture: five jobs with known numbers (see stations.test.ts).
 * - 001: approved in round 1, first-pass proof, a builder follow-up.
 * - 002: proof failed once, then passed; behavior asked for changes in round 1 and approved round 2.
 * - 003: proof failed three times and escalated; its proof.md holds the last failure.
 * - 004: intake only, written like an old job.json (no rounds, no followups).
 * - 005: standards asked for changes twice and the job escalated after round 2.
 */
export const REPORT_LINE: JobSpec[] = [
  { id: '001-alpha', events: APPROVED(), followups: [['builder', 'The list scan in src/x.ts:10 is quadratic.']], proof: 'PASS' },
  {
    id: '002-beta',
    events: [
      'created', 'building', 'awaiting independent proof', 'proof failed (attempt 1)', 'awaiting independent proof', 'proof passed',
      'review round 1 opened', 'round 1: security -> approve', 'round 1: standards -> approve', 'round 1: behavior -> changes', 'round 1: changes requested by behavior',
      'awaiting independent proof', 'proof passed', 'review round 2 opened', 'round 2: security -> approve', 'round 2: standards -> approve', 'round 2: behavior -> approve',
      'approved in round 2', 'merged into main',
    ],
    followups: [['security', 'Tokens could reach the log in src/y.ts:4.']],
    blocking: { '1-behavior': '1. src/z.ts:3 returns the wrong exit code on empty input.' },
    proof: 'PASS',
  },
  {
    id: '003-gamma',
    events: [
      'created', 'building', 'awaiting independent proof', 'proof failed (attempt 1)', 'awaiting independent proof', 'proof failed (attempt 2)',
      'awaiting independent proof', 'proof failed (attempt 3)', 'needs human: proof failed 3 times - see proof.md',
    ],
    proof: { fail: 'The full checks are red: npm test has 2 failing tests in test/parser.test.ts.' },
  },
  { id: '004-delta', events: ['created'], omit: ['rounds', 'followups'] },
  {
    id: '005-epsilon',
    events: [
      'created', 'building', 'awaiting independent proof', 'proof passed',
      'review round 1 opened', 'round 1: security -> approve', 'round 1: standards -> changes', 'round 1: behavior -> approve', 'round 1: changes requested by standards',
      'awaiting independent proof', 'proof passed', 'review round 2 opened', 'round 2: security -> approve', 'round 2: standards -> changes', 'round 2: behavior -> approve',
      'needs human: changes still requested after 2 rounds (standards)',
    ],
    blocking: { '1-standards': '1. CLAUDE.md requires a changelog entry; there is none.', '2-standards': '1. The changelog entry is still missing.' },
    proof: 'PASS',
  },
];
