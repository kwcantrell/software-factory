// Masking personal details (home-dir usernames, the current user's home and username, emails and
// GitHub mentions) before anything is stored or filed. Every identity here is made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanDetail, cleanSummary, containsPersonal, identityOf, maskPersonal, NO_IDENTITY, signature } from '../src/redact.ts';

/** The fake current user: HOME outside /home, so the HOME rule is what masks it. */
const ID = identityOf({ HOME: '/srv/people/jdoe-test', USER: 'jdoe-test' }, {});

/** What GitHub would turn into a mention (and a notification): see the job's criterion 3. */
const LINKABLE = /(?<![\w/.`])@[A-Za-z0-9-]{1,39}(?![A-Za-z0-9/-])/;

test('home-dir paths of any user become ~, in each form', () => {
  for (const [input, expected] of [
    ['failed at /home/jdoe-test/proj/a.json', 'failed at ~/proj/a.json'],
    ['failed at /Users/jdoe-test/proj/a.json', 'failed at ~/proj/a.json'],
    ['failed at /root/.npmrc', 'failed at ~/.npmrc'],
    ['failed at C:\\Users\\jdoe-test\\proj\\a.json', 'failed at ~\\proj\\a.json'],
    ['failed at C:/Users/jdoe-test/proj/a.json', 'failed at ~/proj/a.json'],
    ['failed at c:\\users\\jdoe-test', 'failed at ~'],
    ['cd /home/jdoe-test && ls', 'cd ~ && ls'],
    ['read "/home/someone-else/x"', 'read "~/x"'],
    ['opened file:///home/jdoe-test/x.html', 'opened file://~/x.html'],
  ] as const) {
    assert.equal(maskPersonal(input, NO_IDENTITY), expected, input);
    assert.equal(maskPersonal(expected, NO_IDENTITY), expected, `idempotent: ${expected}`);
  }
});

test('paths that only contain home or root deeper down are not home dirs', () => {
  for (const text of ['/srv/root/x', '/var/lib/home/x', '/rootfs/x', 'chroot/home/x', '/home/', 'see ~/notes']) {
    assert.equal(maskPersonal(text, NO_IDENTITY), text, text);
  }
});

test("the current user's $HOME and os.homedir() become ~ wherever they appear", () => {
  assert.equal(maskPersonal('cannot read /srv/people/jdoe-test/.config/x', ID), 'cannot read ~/.config/x');
  assert.equal(maskPersonal('cannot read /srv/people/jdoe-test', ID), 'cannot read ~');
  // Not a longer directory that only starts like it.
  assert.equal(maskPersonal('cannot read /srv/people/jdoe-testing/x', ID), 'cannot read /srv/people/jdoe-testing/x');
  const os = identityOf({}, { homedir: '/opt/homes/jdoe-test', username: 'jdoe-test' });
  assert.equal(maskPersonal('at /opt/homes/jdoe-test/a', os), 'at ~/a');
  const win = identityOf({ HOME: 'D:\\Profiles\\jdoe-test' }, {});
  assert.equal(maskPersonal('at D:\\Profiles\\jdoe-test\\a and D:/Profiles/jdoe-test/b', win), 'at ~\\a and ~/b');
  // A home of / would match everything: it is ignored.
  assert.deepEqual(identityOf({ HOME: '/' }, {}).homes, []);
});

test('the current username is masked as a whole word, from $USER, $USERNAME and os.userInfo()', () => {
  for (const id of [identityOf({ USER: 'jdoe-test' }, {}), identityOf({ USERNAME: 'jdoe-test' }, {}), identityOf({}, { username: 'jdoe-test' })]) {
    assert.equal(maskPersonal('owned by jdoe-test, not JDOE-TEST either: /srv/jdoe-test/x', id), 'owned by [user], not [user] either: /srv/[user]/x');
    // Only the whole word: not inside a longer name.
    for (const text of ['xjdoe-test', 'jdoe-tests', 'jdoe-test_2', 'my.jdoe-test', 'a-jdoe-test']) assert.equal(maskPersonal(text, id), text, text);
    assert.equal(maskPersonal('[user]', id), '[user]');
  }
});

test('a username shorter than 3 characters, or a common word, is not masked as a word', () => {
  for (const user of ['jd', 'root', 'admin', 'user', 'runner', 'node', 'ubuntu', 'Runner']) {
    const id = identityOf({ USER: user }, { username: user });
    assert.deepEqual(id.users, [], user);
    assert.equal(maskPersonal(`the ${user} process`, id), `the ${user} process`);
  }
  // Their home paths are still masked.
  assert.equal(maskPersonal('/home/runner/work/x', identityOf({ USER: 'runner' }, {})), '~/work/x');
});

test('emails become [email]: plain, inside a URL or git error text, and user+tag@sub.domain', () => {
  for (const [input, expected] of [
    ['mail jdoe.test@example.com bounced', 'mail [email] bounced'],
    ['open https://x.example/invite?to=jdoe-test@example.org&x=1', 'open https://x.example/invite?to=[email]&x=1'],
    ['mailto:jdoe-test@example.com', 'mailto:[email]'],
    ["fatal: unable to auto-detect email address (got 'jdoe-test@laptop.example.net')", "fatal: unable to auto-detect email address (got '[email]')"],
    ['Author: J Doe <jdoe-test@example.com>', 'Author: J Doe <[email]>'],
    ['sent to jdoe+tag@sub.example.co.uk.', 'sent to [email].'],
  ] as const) {
    assert.equal(maskPersonal(input, NO_IDENTITY), expected, input);
  }
});

test('npm scopes, git@ remotes and decorators are not emails', () => {
  for (const text of [
    'npm i @anthropic-ai/claude-code',
    'npm i -D @types/node',
    'git clone git@github.com:owner/repo.git',
    'remote ssh://git@github.com/owner/repo',
    'installed @anthropic-ai/claude-code@2.1.0',
    'react@18.3.1',
  ]) {
    assert.equal(maskPersonal(text, NO_IDENTITY), text, text);
  }
  assert.ok(!maskPersonal('a @param decorator', NO_IDENTITY).includes('[email]'));
});

test('GitHub mentions become @[user]; npm scopes, emails, URLs and code spans are left alone', () => {
  for (const [input, expected] of [
    ['ask @octocat about it', 'ask @[user] about it'],
    ['(@octo-cat) and @a.', '(@[user]) and @[user].'],
    ['@jdoe-test said so', '@[user] said so'],
    ['the @param decorator', 'the @[user] decorator'],
    ['cc:@someone', 'cc:@[user]'],
  ] as const) {
    assert.equal(maskPersonal(input, NO_IDENTITY), expected, input);
    assert.equal(maskPersonal(expected, NO_IDENTITY), expected);
  }
  for (const text of [
    'npm i @anthropic-ai/claude-code @types/node',
    'run `@octocat` in code',
    'see https://[redacted]@git.example/x',
    'path/@x and a.@y and word@z',
    `@${'a'.repeat(40)} is too long to be a login`,
  ]) {
    assert.equal(maskPersonal(text, NO_IDENTITY), text, text);
  }
  assert.equal(maskPersonal('mail jdoe-test@example.com', NO_IDENTITY), 'mail [email]', 'an email is not a mention');
});

test('cleanSummary and cleanDetail mask before they store, and redact URL credentials whole', () => {
  const raw = 'jdoe-test at /home/jdoe-test/x and /srv/people/jdoe-test/y mailed jdoe-test@example.com, cc @octocat';
  const s = cleanSummary(raw, ID);
  assert.equal(s, '[user] at ~/x and ~/y mailed [email], cc @[user]');
  const d = cleanDetail(`line one by jdoe-test\nC:\\Users\\jdoe-test\\a\n@octocat`, ID);
  assert.equal(d, 'line one by [user]\n~\\a\n@[user]');
  assert.equal(cleanSummary('cloned https://jdoe-test:pa55@example.com/x', ID), 'cloned https://[redacted]@example.com/x');
  for (const out of [s, d]) assert.ok(!out.includes('jdoe-test') && !out.includes('octocat') && !out.includes('example.com'), out);
});

test('containsPersonal finds home paths, the current home, emails and mentions, not the bare username', () => {
  assert.equal(containsPersonal('at /home/x/y'), true);
  assert.equal(containsPersonal('at /srv/people/jdoe-test/y', ID), true);
  assert.equal(containsPersonal('a@b.example'), true);
  assert.equal(containsPersonal('cc @octocat'), true);
  assert.equal(containsPersonal('by jdoe-test', ID), false);
  assert.equal(containsPersonal('[user] at ~/x mailed [email], cc @[user], npm i @types/node, `@x`'), false);
});

test('summaries that differ only in the username in a path or in an email share a signature', () => {
  const sig = (s: string): string => signature('factory-docs', 'workaround', cleanSummary(s, ID));
  assert.equal(sig('cannot read /home/alice-test/x.json'), sig('cannot read /home/bob-test/x.json'));
  assert.equal(sig('cannot read C:\\Users\\alice-test\\x.json'), sig('cannot read C:\\Users\\bob-test\\x.json'));
  assert.equal(sig('mail alice-test@example.com bounced'), sig('mail bob.test+x@example.org bounced'));
  assert.equal(sig('asked @alice-test to review'), sig('asked @bob-test to review'));
  // Without personal details, the stored summary (and so its signature) is what it was.
  const plain = 'refused: 005-port-the-factory-cli-to-typescript at https://x.example/a in /tmp/a.json, npm i @types/node';
  assert.equal(cleanSummary(plain, ID), plain);
  assert.equal(signature('factory', 'cli-failure', cleanSummary(plain, ID)), signature('factory', 'cli-failure', plain));
});

test('no linkable mention survives masking (the pattern the draft test checks with)', () => {
  assert.ok(LINKABLE.test('@octocat'));
  assert.ok(!LINKABLE.test(maskPersonal('@octocat (@a) cc:@b-c x @d.', NO_IDENTITY)));
});
