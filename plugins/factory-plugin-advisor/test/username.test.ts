// A username that is also a word the advisor writes itself (a marketplace plugin, bin or factory
// subcommand) is not masked as a whole word, and nothing below run() reads the real OS identity.
// Every identity here is made up and reaches run() through Io.system.
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { draftFields, draftTitle, issues, record, renderDraft, suggest, targetOf, type Issue } from '../src/advisor.ts';
import { draftPersonal, draftSecrets, fileIssue } from '../src/file.ts';
import { handleHookInput } from '../src/hook.ts';
import { FACTORY_COMMANDS, FACTORY_FOLLOWUP_COMMANDS, FALLBACK_PLUGINS, marketplacePlugins, reservedNames } from '../src/plugins.ts';
import { identityOf, maskPersonal, osIdentity, signature, type SystemIdentity } from '../src/redact.ts';
import { EXIT } from '../src/run.ts';
import { Store } from '../src/store.ts';
import { FIXTURES, fakeGh, PLUGIN_ROOT, sandbox, type Sandbox } from './helpers.ts';

let box: Sandbox | undefined;
let other: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  other?.cleanup();
  box = undefined;
  other = undefined;
});

const ISSUE_URL = 'https://github.com/kwcantrell/software-factory/issues/42';

function json(r: { code: number; stdout: string; stderr: string }): any {
  assert.equal(r.code, EXIT.ok, r.stderr);
  return JSON.parse(r.stdout);
}

/** A sandbox whose OS user is `username`, with home /home/<username> and $HOME and $USER set to match. */
function as(username: string, home = `/home/${username}`): Sandbox {
  const system: SystemIdentity = { username, homedir: `/home/${username}` };
  return sandbox({ HOME: home, USER: username }, PLUGIN_ROOT, system);
}

function stored(b: Sandbox): any[] {
  const path = join(b.config, 'occurrences.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

/** Every marketplace plugin name and bin, every factory subcommand and every factory followup subcommand. */
const RESERVED = [...reservedNames(marketplacePlugins(PLUGIN_ROOT, {}))];

test('a username equal to a plugin, bin or factory subcommand (any case) is not masked as a word', () => {
  for (const user of ['factory', 'Factory', 'FACTORY-DEV', 'factory-docs', 'factory-plugin-advisor', 'proof', 'merge', 'followup']) {
    for (const id of [identityOf({ USER: user }, {}), identityOf({ USERNAME: user }, {}), identityOf({}, { username: user })]) {
      assert.deepEqual(id.users, [], user);
      assert.equal(maskPersonal(`${user} proof exited 1`, id), `${user} proof exited 1`);
    }
  }
  // Others still are, exactly as before.
  assert.deepEqual(identityOf({ USER: 'jdoe-test' }, {}).users, ['jdoe-test']);
  assert.deepEqual(identityOf({ USER: 'factory-test' }, {}).users, ['factory-test']);
});

test('the reserved names are the marketplace plugins and bins (read at run time, else the fallback) and the factory subcommands', () => {
  const market = marketplacePlugins(PLUGIN_ROOT, {});
  const names = reservedNames(market);
  for (const p of market.plugins) assert.ok(names.has(p), p);
  for (const b of market.bins.keys()) assert.ok(names.has(b), b);
  for (const c of FACTORY_COMMANDS) assert.ok(names.has(c), c);
  for (const c of FACTORY_FOLLOWUP_COMMANDS) assert.ok(names.has(c), c);
  // A bin the marketplace adds is reserved too.
  const custom = reservedNames({ plugins: ['new-thing'], bins: new Map([['New-Thing-Cli', 'new-thing']]) });
  assert.ok(custom.has('new-thing') && custom.has('new-thing-cli') && custom.has('verdict'));
  assert.ok(!custom.has('factory-docs'), 'only what the marketplace lists');
  assert.deepEqual(identityOf({ USER: 'new-thing-cli' }, {}, custom).users, []);
  assert.deepEqual(identityOf({ USER: 'factory-docs' }, {}, custom).users, ['factory-docs']);
  // With no marketplace, FALLBACK_PLUGINS.
  const fallback = reservedNames();
  for (const p of FALLBACK_PLUGINS) assert.ok(fallback.has(p), p);
});

test("with the username 'factory', record stores 'factory proof exited 1' unchanged; so for every reserved name", () => {
  box = as('factory');
  const r = json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', 'factory proof exited 1', '--json']));
  assert.equal(stored(box)[0]?.summary, 'factory proof exited 1');
  assert.equal(r.signature, signature('factory', 'cli-failure', 'factory proof exited 1'));
  box.cleanup();
  for (const user of RESERVED) {
    box = as(user);
    const summary = `${user} ran: factory proof exited 1 and factory-dev check failed`;
    json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', summary, '--detail', `${user} again`, '--json']));
    const [o] = stored(box);
    assert.equal(o.summary, summary, user);
    assert.equal(o.detail, `${user} again`, user);
    box.cleanup();
  }
  box = undefined;
});

test("with the username 'factory', home paths, $HOME, emails and mentions are still masked", () => {
  box = as('factory', '/srv/people/factory');
  const summary = 'factory proof failed at /home/factory/repo/x and /srv/people/factory/y, mailed factory@example.com, cc @factory';
  json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', summary, '--json']));
  assert.equal(stored(box)[0]?.summary, 'factory proof failed at ~/repo/x and ~/y, mailed [email], cc @[user]');
});

test("with a username equal to a factory followup subcommand (any case), record stores 'factory followup list printed nothing' unchanged", () => {
  for (const user of ['list', 'add', 'done', 'drop', 'List', 'ADD', 'Done', 'dRoP']) {
    const id = identityOf({ USER: user }, { username: user }, reservedNames());
    assert.deepEqual(id.users, [], user);
    box = as(user);
    const summary = `factory followup ${user.toLowerCase()} printed nothing; factory followup ${user} again`;
    json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', summary, '--json']));
    assert.equal(stored(box)[0]?.summary, summary, user);
    box.cleanup();
  }
  box = undefined;
});

test('with a followup-subcommand username, home paths, $HOME, emails and mentions are still masked, and the pre-file check still refuses them', () => {
  for (const user of ['list', 'add', 'done', 'drop']) {
    box = as(user, `/srv/people/${user}`);
    const summary = `factory followup ${user} failed at /home/${user}/repo/x and /srv/people/${user}/y, mailed ${user}@example.com, cc @${user}`;
    json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', summary, '--json']));
    assert.equal(stored(box)[0]?.summary, `factory followup ${user} failed at ~/repo/x and ~/y, mailed [email], cc @[user]`, user);
    box.cleanup();
    const id = identityOf({ HOME: `/home/${user}`, USER: user }, { username: user, homedir: `/home/${user}` }, reservedNames());
    assert.deepEqual(draftPersonal(`# t\n\nfactory followup ${user} printed nothing\n${user}`, id), [], user);
    assert.deepEqual(draftPersonal(`# t\n\nok\nsee /home/${user}/x\nmail a@b.example\ncc @octocat`, id), [4, 5, 6], user);
  }
  box = undefined;
});

test('a username that is not reserved is still masked as a whole word through run()', () => {
  box = as('jdoe-test');
  json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', 'factory proof exited 1 for jdoe-test', '--json']));
  assert.equal(stored(box)[0]?.summary, 'factory proof exited 1 for [user]');
});

test("with the username 'factory', a summary about the factory plugin gets the same signature as on another machine", () => {
  box = as('factory');
  other = as('jdoe-test');
  for (const summary of ['factory proof exited 1', 'factory verdict refused: 005-port-the-factory-cli-to-typescript at /home/factory/x']) {
    const argv = ['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', summary, '--json'];
    const mine = json(box.call(argv));
    const theirs = json(other.call(argv.map((a) => a.replace('/home/factory/', '/home/jdoe-test/'))));
    assert.equal(mine.signature, theirs.signature, summary);
  }
  // And the stored summaries match too.
  assert.deepEqual(stored(box).map((o) => o.summary), stored(other).map((o) => o.summary));
});

test("with the username 'factory', a draft for the factory plugin files without a refusal", () => {
  box = as('factory');
  box.env.PATH = `${fakeGh(box.dir, `console.log(${JSON.stringify(ISSUE_URL)});`)}:${process.env.PATH ?? ''}`;
  let sig = '';
  for (let i = 0; i < 3; i++) {
    sig = json(box.call(['record', '--plugin', 'factory', '--kind', 'cli-failure', '--summary', 'factory proof exited 1 at /home/factory/repo', '--detail', 'factory said: refused', '--json'])).signature;
  }
  assert.equal(json(box.call(['suggest', '--json'])).suggestions.length, 1);
  const draft = readFileSync(join(box.config, 'drafts', `${sig}.md`), 'utf8');
  assert.ok(draft.includes('factory proof exited 1 at ~/repo') && !draft.includes('[user]'), draft);
  const dry = json(box.call(['file', sig, '--json']));
  assert.equal(dry.dryRun, true);
  const r = json(box.call(['file', sig, '--confirm', '--json']));
  assert.equal(r.filed, true);
  assert.equal(r.url, ISSUE_URL);
});

test("the pre-file check still refuses a home path, email or mention edited into a 'factory' user's draft", () => {
  const id = identityOf({ HOME: '/home/factory', USER: 'factory' }, { username: 'factory', homedir: '/home/factory' }, reservedNames());
  assert.deepEqual(draftPersonal('# t\n\nfactory proof exited 1\nfactory', id), []);
  assert.deepEqual(draftPersonal('# t\n\nok\nsee /home/factory/x\nmail a@b.example\ncc @octocat', id), [4, 5, 6]);
});

/** Replaces os.userInfo and os.homedir (for every importer of node:os) with ones that count calls. */
function watchOs(): { calls: string[]; restore: () => void } {
  const os = createRequire(import.meta.url)('node:os');
  const { userInfo, homedir } = os;
  const calls: string[] = [];
  os.userInfo = (...a: unknown[]) => {
    calls.push('userInfo');
    return userInfo(...a);
  };
  os.homedir = () => {
    calls.push('homedir');
    return homedir();
  };
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      os.userInfo = userInfo;
      os.homedir = homedir;
      syncBuiltinESMExports();
    },
  };
}

test('record, draft*, suggest, draftSecrets, fileIssue and the hook never read os.userInfo() or os.homedir() by default', () => {
  box = sandbox();
  box.env.PATH = `${fakeGh(box.dir, `console.log(${JSON.stringify(ISSUE_URL)});`)}:${process.env.PATH ?? ''}`;
  const watch = watchOs();
  try {
    // Through run() under the sandbox.
    let sig = '';
    for (let i = 0; i < 3; i++) sig = json(box.call(['record', '--plugin', 'factory-docs', '--kind', 'workaround', '--summary', 'had to retry', '--json'])).signature;
    json(box.call(['suggest', '--json']));
    json(box.call(['file', sig, '--json']));
    json(box.call(['file', sig, '--confirm', '--json']));
    assert.equal(box.call(['hook'], { stdin: readFileSync(join(FIXTURES, 'hook-npx-failure.json'), 'utf8') }).code, EXIT.ok);
    assert.deepEqual(watch.calls, [], 'run() under the sandbox');
    // Called directly with their default identity.
    const store = new Store(box.env);
    const at = new Date('2026-11-02T10:00:00.000Z');
    for (let i = 0; i < 3; i++) record(store, { plugin: 'factory', kind: 'workaround', summary: 'factory proof exited 1' }, at);
    suggest(store, 3, [...FALLBACK_PLUGINS], at);
    const occ = store.occurrences().filter((o) => o.plugin === 'factory');
    const [issue] = issues(occ, store.state()) as [Issue];
    const target = targetOf('factory', [...FALLBACK_PLUGINS]);
    draftTitle(issue, target);
    draftFields('factory', occ);
    const { text } = renderDraft(issue, occ, target);
    draftSecrets(text, 'factory', occ);
    draftPersonal(text);
    fileIssue(store, issue.signature, { confirm: false, env: box.env });
    handleHookInput(readFileSync(join(FIXTURES, 'hook-npx-failure.json'), 'utf8'), box.env, PLUGIN_ROOT, at);
    identityOf(box.env);
    assert.deepEqual(watch.calls, [], 'default identity');
  } finally {
    watch.restore();
  }
  // The watch itself works: osIdentity(), which only run() calls, is seen.
  const check = watchOs();
  try {
    osIdentity();
    assert.deepEqual(check.calls.sort(), ['homedir', 'userInfo']);
  } finally {
    check.restore();
  }
});
