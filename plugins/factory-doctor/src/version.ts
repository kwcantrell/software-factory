// Version constraints for `tool` requirements: `>=1.2.3`, `^1.2.3` (same major; for 0.x, same minor)
// or an exact `1.2.3` (`=1.2.3` too). A constraint may give fewer parts: `>=22`, `^3.12`, and an
// exact `22` matches any 22.x.y.

export type Op = '>=' | '^' | '=';

export interface Constraint {
  op: Op;
  /** The parts given, 1 to 3 numbers. */
  parts: number[];
  raw: string;
}

export function parseConstraint(text: string): Constraint | null {
  const m = /^\s*(>=|\^|=)?\s*v?(\d+(?:\.\d+){0,2})\s*$/.exec(text);
  if (m === null) return null;
  return { op: (m[1] ?? '=') as Op, parts: (m[2] ?? '').split('.').map(Number), raw: text.trim() };
}

/** The first version-looking number in a tool's output: `1.2.3`, `1.2`, else a lone number. */
export function extractVersion(output: string, pattern?: string): string | null {
  if (pattern !== undefined) {
    const m = new RegExp(pattern).exec(output);
    if (m === null) return null;
    const got = m[1] ?? m[0];
    return /\d+(?:\.\d+)*/.exec(got)?.[0] ?? null;
  }
  return /\d+\.\d+(?:\.\d+)?/.exec(output)?.[0] ?? /\d+/.exec(output)?.[0] ?? null;
}

const pad = (v: readonly number[]): number[] => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];

function compare(a: readonly number[], b: readonly number[]): number {
  const x = pad(a);
  const y = pad(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function satisfies(version: string, c: Constraint): boolean {
  const found = version.split('.').map(Number);
  if (found.some((n) => Number.isNaN(n))) return false;
  const f = pad(found);
  switch (c.op) {
    case '>=':
      return compare(f, c.parts) >= 0;
    case '=':
      return c.parts.every((p, i) => f[i] === p);
    case '^': {
      if (compare(f, c.parts) < 0) return false;
      const [major, minor] = pad(c.parts);
      if (major !== 0) return f[0] === major;
      if (c.parts.length >= 2 && minor !== 0) return f[0] === 0 && f[1] === minor;
      return f[0] === 0;
    }
  }
}
