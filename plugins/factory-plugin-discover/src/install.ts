// install: installs one software-factory marketplace plugin with `claude plugin install
// <name>@software-factory`, run directly (no shell), and only when every guard holds.
import { spawnSync } from 'node:child_process';
import { type Catalog, installCommand, MARKETPLACE_NAME, readMarketplace } from './catalog.ts';
import type { Env, Mode } from './config.ts';

export class CliError extends Error {}
export class UsageError extends Error {}

export const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const CLAUDE_TIMEOUT_MS = 120_000;
export const RELOAD = 'Run /reload-plugins (or restart Claude Code) to load it.';

export interface InstallResult {
  plugin: string;
  marketplace: typeof MARKETPLACE_NAME;
  command: string;
  mode: Mode;
  installed: true;
  /** What `claude plugin install` printed (stdout, trimmed). */
  output: string;
  reload: string;
}

function firstLine(text: string | null | undefined): string {
  return (text ?? '').trim().split('\n')[0]?.trim() ?? '';
}

/**
 * Installs `name` after checking, in order: it is in the marketplace manifest, it is not installed
 * (here, or with project or local scope for another project), the mode is not `off`, not `notify`, and either the mode is `auto-install` or `confirmed` is set.
 * Every refusal throws a CliError with the reason.
 */
export function install(catalog: Catalog, name: string, options: { mode: Mode; confirmed: boolean; env: Env }): InstallResult {
  if (!NAME.test(name)) throw new UsageError(`install takes a plugin name in kebab-case, got ${JSON.stringify(name)}`);
  const command = installCommand(name);
  if (catalog.manifest === null) {
    throw new CliError(`cannot find the ${MARKETPLACE_NAME} manifest (no checkout next to this plugin, and no installLocation in known_marketplaces.json); add the marketplace first`);
  }
  const listed = (readMarketplace(catalog.manifest) ?? []).some((p) => p.name === name);
  if (!listed) throw new CliError(`'${name}' is not a plugin in ${MARKETPLACE_NAME} (${catalog.manifest}); only that marketplace's plugins are installed`);
  const existing = catalog.installed.find((p) => p.name === name && p.marketplace === MARKETPLACE_NAME);
  if (existing !== undefined) {
    throw new CliError(`${existing.id} is already installed${existing.enabled ? '' : ' but disabled; enable it with /plugin instead'}`);
  }
  const elsewhere = catalog.installedElsewhere.find((p) => p.name === name && p.marketplace === MARKETPLACE_NAME);
  if (elsewhere !== undefined) {
    throw new CliError(
      `${elsewhere.id} is already installed with ${elsewhere.scope} scope for another project (${elsewhere.projectPath}); ` +
        `this command installs only at user scope, which would add it to every project. ` +
        `To use it in this project, install it for this project with /plugin (or claude plugin install ${elsewhere.id} --scope project, run from this project)`,
    );
  }
  if (options.mode === 'off') throw new CliError(`suggesting and installing plugins is off (mode off); change it with: factory-plugin-discover settings set mode ask`);
  if (options.mode === 'notify') throw new CliError(`mode is notify, so nothing is installed; to install it, run: ${command}`);
  if (options.mode !== 'auto-install' && !options.confirmed) {
    throw new CliError(`mode is ${options.mode}: ask the user first, and pass --confirmed only after they say yes (or run: ${command})`);
  }
  const r = spawnSync('claude', ['plugin', 'install', `${name}@${MARKETPLACE_NAME}`], {
    encoding: 'utf8',
    env: options.env as NodeJS.ProcessEnv,
    timeout: CLAUDE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CliError(`claude is not on PATH; run this yourself: ${command}`);
    if (code === 'ETIMEDOUT') throw new CliError(`${command} did not finish within ${CLAUDE_TIMEOUT_MS / 1000}s`);
    throw new CliError(`could not run ${command}: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const reason = firstLine(r.stderr) || firstLine(r.stdout);
    throw new CliError(`${command} exited ${String(r.status ?? r.signal)}${reason === '' ? '' : `: ${reason}`}`);
  }
  return { plugin: name, marketplace: MARKETPLACE_NAME, command, mode: options.mode, installed: true, output: (r.stdout ?? '').trim(), reload: RELOAD };
}
