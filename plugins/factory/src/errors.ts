// The two ways a factory command stops short of success, shared by factory.ts and remote.ts (which
// factory.ts imports, so they cannot live in factory.ts without an import cycle).

/** A gate was not met. Exit 1. */
export class Refused extends Error {}

/** The job was handed to a human. Exit 2. */
export class Escalated extends Error {}

/** UTC now as the job records write it: 2026-01-02T03:04:05Z. */
export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
