// The version registry `migrate` plans from: one entry per software-factory version a repo can be
// at, oldest first, from the original kwcantrell-plugins factory to the [Unreleased] changes of
// CHANGELOG.md. Each entry lists what moving to it from the entry before changes in a repo, and how
// migrate handles that change in each direction:
//   automatic - nothing for the person to do (migrate, through the factory CLI's `migrate-repo`
//               plumbing, makes the change, or there is none to make);
//   manual    - the exact step the person takes; migrate lists it and never does it;
//   refused   - (down only) going back would lose meaning: migrate refuses, with the reason.
// The factory.json keys, job.json fields, station-template fixed sections and marketplace plugins of
// each version are derived from these changes (stateOf), and test/migrate.test.ts checks the newest
// one against the checkout (DEFAULTS, the Job interface, plugins/factory/templates/agents/,
// .claude-plugin/marketplace.json) and against `factory migrate-repo --versions`, so a change that
// forgets the registry fails CI. README.md ("Migrate") says how to add an entry.

export type HandlingKind = 'automatic' | 'manual' | 'refused';

export interface Handling {
  kind: HandlingKind;
  /** What happens (automatic), the exact step (manual) or the reason and the person's choice (refused). */
  text: string;
}

/** What a change is about; a `name` is unique within its area. */
export type Area = 'factory.json' | 'job.json' | 'agents' | 'requirement' | 'doctor-file' | 'plugins' | 'runtime' | 'settings';

export interface Change {
  area: Area;
  /** The key, field, plugin or requirement; `<station kind>:<section id>` for agents; the format number for doctor-file. */
  name: string;
  op: 'added' | 'removed' | 'changed';
  what: string;
  up: Handling;
  down: Handling;
  /** The factory job that adds this and was not yet merged when the entry was written; may be absent from the code. */
  pending?: string;
}

export interface VersionEntry {
  /** The id `--to` takes and `factory migrate-repo` knows: a version number, `kwcantrell`, or `unreleased`. */
  id: string;
  label: string;
  /** The version in the plugins' manifests (null: the original plugin, unversioned). */
  plugin_version: string | null;
  marketplace: 'kwcantrell-plugins' | 'software-factory';
  /** The release tag and its commit (a version without one was never tagged). */
  tag?: string;
  commit?: string;
  /** sha256 of the dashboard (factory/index.html) its CLI installs; only for released versions. */
  dashboard_sha256?: string;
  changes: Change[];
}

const auto = (text: string): Handling => ({ kind: 'automatic', text });
const manual = (text: string): Handling => ({ kind: 'manual', text });
const refused = (text: string): Handling => ({ kind: 'refused', text });

const PYTHON_GONE = refused('the Python CLI (kwcantrell-plugins and 0.2.0) is retired: migrate never moves a repo before 0.3.0. Stay on this version');
const BASE = auto('part of the first version');
const NOT_BEFORE = refused('nothing older exists');

const plugin = (name: string, pending?: string): Change => ({
  area: 'plugins',
  name,
  op: 'added',
  what: `the ${name} plugin joins the software-factory marketplace`,
  up: manual(`not installed: install it yourself if you want it (claude plugin install ${name}@software-factory); migrate never installs a plugin`),
  down: manual(`not in the target version: uninstall it yourself if you want (claude plugin uninstall ${name}@software-factory); migrate never removes a plugin`),
  ...(pending === undefined ? {} : { pending }),
});

const sections = (kind: 'builder' | 'verifier' | 'reviewer', ids: string[], up: Handling, down: Handling, what: string): Change[] =>
  ids.map((id) => ({ area: 'agents', name: `${kind}:${id}`, op: 'added', what, up, down }));

const FIRST_AGENTS_UP = auto('project agents are optional: the line runs on the shipped agents; /factory:agents makes the project its own');
const FIRST_AGENTS_DOWN = manual(
  "the target launches only the shipped agents: the project's .claude/agents/factory-*.md stay and are not used; delete them yourself if you like",
);
const DOCTOR_UP = manual(
  'project agents of this station fail `factory agents check` (and the shipped agent runs instead) until refreshed: run /factory:agents, or `factory agents new <station> --force`, or add the section from the template',
);
const DOCTOR_DOWN = auto("an older `factory agents check` ignores a fixed section it does not know");

export const REGISTRY: readonly VersionEntry[] = [
  {
    id: 'kwcantrell',
    label: 'the original factory plugin (factory@kwcantrell-plugins, the Python CLI before follow-ups)',
    plugin_version: null,
    marketplace: 'kwcantrell-plugins',
    dashboard_sha256: 'ec4cd71e0a5bdc17a79372e454118af50940fa8c9ef72577866641d3f2f241aa',
    changes: [
      ...['reviewers', 'max_review_rounds', 'max_proof_attempts', 'spec_gate'].map(
        (name): Change => ({ area: 'factory.json', name, op: 'added', what: `factory.json key '${name}'`, up: BASE, down: NOT_BEFORE }),
      ),
      ...['id', 'title', 'stage', 'status', 'needs_human', 'activity', 'spec', 'spec_sha', 'branch', 'base', 'base_branch', 'worktree', 'proof_attempts', 'rounds', 'created', 'history', 'updated'].map(
        (name): Change => ({ area: 'job.json', name, op: 'added', what: `job.json field '${name}'`, up: BASE, down: NOT_BEFORE }),
      ),
      { area: 'plugins', name: 'factory', op: 'added', what: 'the factory plugin', up: BASE, down: NOT_BEFORE },
    ],
  },
  {
    id: '0.2.0',
    label: 'factory@software-factory 0.2.0, the Python CLI with follow-ups',
    plugin_version: '0.2.0',
    marketplace: 'software-factory',
    dashboard_sha256: '3ebeb2bcaa41743bb12d846c738fee3d28419ab1a472f0829cedd049fcea530c',
    changes: [
      {
        area: 'settings',
        name: 'factory@software-factory',
        op: 'changed',
        what: 'the plugin moved from factory@kwcantrell-plugins to factory@software-factory',
        up: auto('migrate switches enabledPlugins in project and local settings (user settings only with --scope user) and lists the claude plugin install/uninstall commands to run'),
        down: PYTHON_GONE,
      },
      { area: 'factory.json', name: 'specs_dir', op: 'added', what: "factory.json key 'specs_dir'", up: auto('accepted as it is'), down: PYTHON_GONE },
      { area: 'job.json', name: 'followups', op: 'added', what: "job.json field 'followups'", up: auto('migrate adds "followups": [] to each job that lacks it'), down: PYTHON_GONE },
    ],
  },
  {
    id: '0.3.0',
    label: '0.3.0, the TypeScript CLI run through npx',
    plugin_version: '0.3.0',
    marketplace: 'software-factory',
    tag: 'v0.3.0',
    commit: 'f8fd0f98761834aa5b4457042801ad42ac3333dc',
    dashboard_sha256: '9ef503250064d6caf31d276c337fbb82fd0ff9437498d20fa62b35f60940c6bd',
    changes: [
      {
        area: 'runtime',
        name: 'typescript-cli',
        op: 'changed',
        what: "the CLI is TypeScript run by Node through npx: the runtime dir locks with .lock.pid, not the Python CLI's .lock, and gets a new dashboard and a .gitignore",
        up: auto('migrate removes .lock, replaces the dashboard, creates .gitignore (originals backed up under factory/upgrade-backup-<time>/)'),
        down: PYTHON_GONE,
      },
      {
        area: 'requirement',
        name: 'node',
        op: 'added',
        what: 'Node.js 22.18 or later runs the CLI (Python is no longer used)',
        up: manual('install Node.js 22.18 or later (node --version shows it)'),
        down: auto('nothing to change'),
      },
      ...['factory-plugin-builder', 'factory-dev', 'factory-docs', 'factory-plugin-advisor', 'factory-plugin-discover'].map((n) => plugin(n)),
    ],
  },
  {
    id: '0.3.1',
    label: '0.3.1 (never tagged; folded into 0.4.0)',
    plugin_version: '0.3.1',
    marketplace: 'software-factory',
    commit: 'a5b78f47f49998d3c89004ba1a04c9cf5f6661c5',
    changes: [],
  },
  {
    id: '0.4.0',
    label: '0.4.0, station agents a project owns',
    plugin_version: '0.4.0',
    marketplace: 'software-factory',
    tag: 'v0.4.0',
    commit: '9e2da24b5051af8b27a0b20b74f81f6db1335559',
    changes: [
      ...sections('builder', ['handoff', 'cli', 'state', 'integrity', 'followup', 'result'], FIRST_AGENTS_UP, FIRST_AGENTS_DOWN, 'station template fixed section'),
      ...sections('verifier', ['handoff', 'cli', 'state', 'integrity', 'followup', 'result', 'pass-bar'], FIRST_AGENTS_UP, FIRST_AGENTS_DOWN, 'station template fixed section'),
      ...sections('reviewer', ['role', 'handoff', 'cli', 'state', 'lens', 'followup', 'result', 'calibration', 'read-only'], FIRST_AGENTS_UP, FIRST_AGENTS_DOWN, 'station template fixed section'),
    ],
  },
  {
    id: 'unreleased',
    label: 'the [Unreleased] changes after 0.4.0',
    plugin_version: '0.4.0',
    marketplace: 'software-factory',
    changes: [
      {
        area: 'factory.json',
        name: 'remote',
        op: 'added',
        what: "factory.json key 'remote': a remote factory, the job state shared on a git branch, with claims (021) and signed state commits (025)",
        up: auto('accepted as it is'),
        down: refused(
          'the target has no remote factory: the job state lives on the state branch, whose signed history (remote.allowed_signers) is what merge checks, and the claims on it would be lost. Stay on this version, or stop using the remote factory first (remove "remote" from factory.json yourself)',
        ),
      },
      {
        area: 'factory.json',
        name: 'advisor',
        op: 'added',
        what: "factory.json key 'advisor' (factory-plugin-advisor sharing, 022)",
        up: auto('accepted as it is'),
        down: auto('migrate removes the key from factory.json (the target refuses unknown keys; sharing needs a remote factory anyway); the original is backed up'),
      },
      {
        area: 'job.json',
        name: 'owner',
        op: 'added',
        what: "job.json field 'owner': who claimed a job in a remote factory (021)",
        up: auto('written by factory start in a remote factory'),
        down: auto('migrate removes it from each job (the original is backed up)'),
      },
      {
        area: 'job.json',
        name: 'head',
        op: 'added',
        what: "job.json field 'head': the commit proof and review passed, which merge checks (028)",
        up: auto('the next factory built records it'),
        down: refused(
          'an unfinished job that records it is refused: the target would merge whatever the branch holds. Finish the job first (merge or close it), or stay on this version; a finished job keeps nothing to protect, and migrate removes the field',
        ),
      },
      {
        area: 'requirement',
        name: 'remote-signing',
        op: 'added',
        what: 'a remote factory signs every state commit with your own SSH key and merge checks them against remote.allowed_signers (025)',
        up: manual(
          'set up SSH signing for this repo: git config gpg.format ssh; git config user.signingkey <your public key>; and commit an allowed-signers file named by remote.allowed_signers in factory.json (the factory-signing plugin helps). remote.unsigned_ok: true turns it off, which the README warns against',
        ),
        down: refused('a remote factory relies on signing to protect merges; see factory.json remote'),
      },
      {
        area: 'requirement',
        name: 'recorded-commit',
        op: 'added',
        what: 'merge merges only the commit proof and review passed (028)',
        up: manual('in a remote factory with signing on, merge refuses a job built by an older factory (no recorded commit): a person sends it back with factory rework, then the builder runs factory built again, which records the commit and sends it through proof and review'),
        down: refused('recorded commits protect merges; see job.json head'),
      },
      ...sections('builder', ['doctor'], DOCTOR_UP, DOCTOR_DOWN, 'the factory-doctor check runs first (030)'),
      ...sections('verifier', ['doctor'], DOCTOR_UP, DOCTOR_DOWN, 'the factory-doctor check runs first (030)'),
      {
        area: 'doctor-file',
        name: '1',
        op: 'added',
        what: '.factory/doctor.json, version 1: what running the app needs, per profile (030)',
        up: auto('nothing to change'),
        down: auto('kept as it is: nothing in the target reads it'),
      },
      plugin('factory-doctor'),
      plugin('factory-signing'),
    ],
  },
];

export const LATEST = (REGISTRY[REGISTRY.length - 1] as VersionEntry).id;

export const indexOf = (id: string): number => REGISTRY.findIndex((v) => v.id === id);

export function entry(id: string): VersionEntry {
  const v = REGISTRY[indexOf(id)];
  if (v === undefined) throw new Error(`no registry entry ${id}`);
  return v;
}

export interface VersionState {
  config_keys: string[];
  job_fields: string[];
  /** `<kind>:<id>` */
  fixed_sections: string[];
  plugins: string[];
  doctor_formats: string[];
  /** Pending names (their job not yet merged): allowed to be absent from the code. */
  pending: string[];
}

const AREA_KEY: Partial<Record<Area, keyof Omit<VersionState, 'pending'>>> = {
  'factory.json': 'config_keys',
  'job.json': 'job_fields',
  agents: 'fixed_sections',
  plugins: 'plugins',
  'doctor-file': 'doctor_formats',
};

/** What a version has: every added (minus removed) key, field, section, plugin and format up to it. */
export function stateOf(id: string): VersionState {
  const state: VersionState = { config_keys: [], job_fields: [], fixed_sections: [], plugins: [], doctor_formats: [], pending: [] };
  for (const v of REGISTRY.slice(0, indexOf(id) + 1)) {
    for (const c of v.changes) {
      const key = AREA_KEY[c.area];
      if (key === undefined) continue;
      if (c.op === 'added' && !state[key].includes(c.name)) state[key].push(c.name);
      if (c.op === 'removed') state[key] = state[key].filter((n) => n !== c.name);
      if (c.pending !== undefined) state.pending.push(`${c.area}:${c.name}`);
    }
  }
  return state;
}

/** The version that added a name to an area, or null. */
export function addedIn(area: Area, name: string): string | null {
  for (const v of REGISTRY) if (v.changes.some((c) => c.area === area && c.name === name && c.op === 'added')) return v.id;
  return null;
}
