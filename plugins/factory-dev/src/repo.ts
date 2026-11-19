// The software-factory checkout the CLI works on, its marketplace, and the errors that map to exit codes.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MARKETPLACE_NAME = 'software-factory';
export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

/** Exit 2: bad arguments. */
export class UsageError extends Error {}
/** Exit 2: the CLI was not pointed at a software-factory checkout. */
export class NotACheckoutError extends Error {}
/** Exit 1: the command could not do its job. */
export class CommandError extends Error {}

export interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
  version?: unknown;
}

function readObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The plugin entries of a checkout's marketplace.json (entries that are not objects are dropped). */
export function marketplaceEntries(root: string): MarketplaceEntry[] {
  const plugins = readObject(join(root, MARKETPLACE_PATH))?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((p): p is MarketplaceEntry => typeof p === 'object' && p !== null && !Array.isArray(p));
}

/**
 * A marketplace entry's folder relative to the checkout root ('.' for "./"), or null when its source is
 * not a "./" path inside the checkout.
 */
export function entryDir(entry: MarketplaceEntry): string | null {
  const source = entry.source;
  if (typeof source !== 'string' || !source.startsWith('./') || source.split('/').includes('..')) return null;
  const rel = source.slice(2).replace(/\/+$/, '');
  return rel === '' ? '.' : rel;
}

/**
 * The nearest directory at or above `repoOption` (resolved against cwd), or cwd, whose
 * .claude-plugin/marketplace.json is named software-factory.
 */
export function findCheckout(cwd: string, repoOption?: string): string {
  const start = repoOption === undefined ? cwd : resolve(cwd, repoOption);
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    throw new NotACheckoutError(`--repo ${repoOption}: no such directory`);
  }
  let dir = realpathSync(start);
  for (;;) {
    if (readObject(join(dir, MARKETPLACE_PATH))?.name === MARKETPLACE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const hint = repoOption === undefined ? '; run it inside the checkout or pass --repo <path>' : '';
  throw new NotACheckoutError(
    `not inside a ${MARKETPLACE_NAME} checkout: no ${MARKETPLACE_PATH} named '${MARKETPLACE_NAME}' at or above ${start}${hint}`,
  );
}
