// The software-factory checkout the CLI works on, and the errors that map to its exit codes.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const MARKETPLACE_NAME = 'software-factory';
export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
export const TEMPLATE_PATH = 'templates/plugin';
/** A plugin name: kebab-case, starting with a letter. */
export const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_NAME_LENGTH = 64;

/** Exit 2: bad arguments. */
export class UsageError extends Error {}
/** Exit 2: the CLI was not pointed at a software-factory checkout. */
export class NotACheckoutError extends Error {}
/** Exit 1: the command could not do its job. */
export class CommandError extends Error {}

export interface MarketplaceEntry {
  name?: unknown;
  source?: unknown;
  description?: unknown;
}

export interface Marketplace {
  name?: unknown;
  plugins?: unknown;
}

/** Throws a UsageError unless `name` is a kebab-case plugin name of at most 64 characters. */
export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new UsageError(
      `invalid plugin name '${name}': use kebab-case (lowercase letters and digits separated by single hyphens, starting with a letter, at most ${MAX_NAME_LENGTH} characters)`,
    );
  }
}

export function readMarketplace(root: string): Marketplace | null {
  const path = join(root, MARKETPLACE_PATH);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Marketplace) : null;
  } catch {
    return null;
  }
}

/** The plugin entries of a checkout's marketplace.json (entries that are not objects are dropped). */
export function marketplaceEntries(root: string): MarketplaceEntry[] {
  const plugins = readMarketplace(root)?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((p): p is MarketplaceEntry => typeof p === 'object' && p !== null && !Array.isArray(p));
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
    if (readMarketplace(dir)?.name === MARKETPLACE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const hint = repoOption === undefined ? '; run it inside the checkout or pass --repo <path>' : '';
  throw new NotACheckoutError(
    `not inside a ${MARKETPLACE_NAME} checkout: no ${MARKETPLACE_PATH} named '${MARKETPLACE_NAME}' at or above ${start}${hint}`,
  );
}
