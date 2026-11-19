// The plugin's own per-user config dir: the mode setting (config.json) and the sessions the prompt
// hook has already hinted in (hinted-sessions.json). Directory 0700, files 0600. Kept free of other
// imports so the hook can load it cheaply.
//
// The dir is named after this plugin (factory-plugin-discover) and set by its own variable
// (FACTORY_PLUGIN_DISCOVER_CONFIG_DIR), so it never shares settings with a `plugin-discover` from
// another marketplace.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Env = Record<string, string | undefined>;

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
export const CONFIG_NAME = 'factory-plugin-discover';
export const CONFIG_ENV = 'FACTORY_PLUGIN_DISCOVER_CONFIG_DIR';

export const MODES = ['ask', 'notify', 'auto-install', 'off'] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = 'ask';

/** `$FACTORY_PLUGIN_DISCOVER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/factory-plugin-discover`, else `~/.config/factory-plugin-discover`. */
export function configDir(env: Env): string {
  const override = env[CONFIG_ENV];
  if (override !== undefined && override !== '') return resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : join(env.HOME ?? homedir(), '.config');
  return resolve(base, CONFIG_NAME);
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Writes `value` as JSON to `<configDir>/<file>`, owner-only, replacing the file atomically. */
export function writeConfigFile(env: Env, file: string, value: unknown): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const path = join(dir, file);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, path);
  return path;
}

export interface Settings {
  mode: Mode;
  /** True when the mode is the default because none was set (or the file is unreadable). */
  isDefault: boolean;
  path: string;
}

export function readSettings(env: Env): Settings {
  const path = join(configDir(env), 'config.json');
  const parsed = readJson(path);
  const mode = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).mode : undefined;
  return isMode(mode) ? { mode, isDefault: false, path } : { mode: DEFAULT_MODE, isDefault: true, path };
}

export function setMode(env: Env, mode: Mode): Settings {
  const path = join(configDir(env), 'config.json');
  const parsed = readJson(path);
  const current = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  writeConfigFile(env, 'config.json', { ...current, mode });
  return { mode, isDefault: false, path };
}

export const SESSIONS_FILE = 'hinted-sessions.json';
/** How many hinted session ids are remembered (oldest dropped first). */
export const MAX_SESSIONS = 200;

export function hintedSessions(env: Env): string[] {
  const parsed = readJson(join(configDir(env), SESSIONS_FILE));
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).sessions : undefined;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
}

export function rememberSession(env: Env, sessionId: string): void {
  const sessions = hintedSessions(env).filter((s) => s !== sessionId);
  sessions.push(sessionId);
  writeConfigFile(env, SESSIONS_FILE, { sessions: sessions.slice(-MAX_SESSIONS) });
}
