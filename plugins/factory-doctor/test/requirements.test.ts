// The requirements file: its format, validation (each refusal names the JSON path, exit 1), and
// profile resolution with extends.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { resolve, validate } from '../src/requirements.ts';
import { parseConstraint, satisfies, extractVersion } from '../src/version.ts';
import { doc, sandbox } from './helpers.ts';

const s = sandbox();
after(s.cleanup);

async function refusal(file: unknown): Promise<string> {
  s.writeJson('.factory/doctor.json', file);
  const r = await s.call(['profiles']);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.stdout, '');
  return r.stderr;
}

const tool = { kind: 'tool', name: 'node', why: 'runs the app' };

const REFUSALS: ReadonlyArray<readonly [string, unknown, RegExp]> = [
  ['an unknown top-level key', doc({}, { extra: 1 }), /\.factory\/doctor\.json: \$\.extra: unknown key 'extra'/],
  ['an unknown profile key', doc({ dev: { requires: [], env: {} } }), /\$\.profiles\.dev\.env: unknown key 'env'/],
  ['an unknown requirement key', doc({ dev: { requires: [{ ...tool, path: 'x' }] } }), /\$\.profiles\.dev\.requires\[0\]\.path: unknown key 'path'/],
  ['a bad kind', doc({ dev: { requires: [{ kind: 'database', name: 'pg', why: 'x' }] } }), /\$\.profiles\.dev\.requires\[0\]\.kind: bad kind "database"/],
  ['a missing kind', doc({ dev: { requires: [{ name: 'pg', why: 'x' }] } }), /\$\.profiles\.dev\.requires\[0\]\.kind: bad kind null/],
  ['a key named value', doc({ dev: { requires: [{ kind: 'env', name: 'API_KEY', why: 'x', value: 'abc' }] } }), /\$\.profiles\.dev\.requires\[0\]\.value: looks like a stored secret value/],
  ['a key named default', doc({ dev: { requires: [{ kind: 'env', name: 'PORT', why: 'x', default: '3000' }] } }), /\$\.profiles\.dev\.requires\[0\]\.default: looks like a stored secret value/],
  ['a key named secret', doc({ dev: { secret: 'x', requires: [] } }), /\$\.profiles\.dev\.secret: looks like a stored secret value/],
  ['a secret key at the top', doc({}, { Secret: 'x' }), /\$\.Secret: looks like a stored secret value/],
  ['a secret key nested in a format', doc({ dev: { requires: [{ kind: 'env', name: 'A', why: 'x', format: { regex: '.', value: 'v' } }] } }), /\$\.profiles\.dev\.requires\[0\]\.format\.value: looks like a stored secret value/],
  ['a missing why', doc({ dev: { requires: [{ kind: 'tool', name: 'node' }] } }), /\$\.profiles\.dev\.requires\[0\]\.why: must be a non-empty string/],
  ['a wrong format version', { version: 2, profiles: {} }, /\$\.version: must be 1/],
  ['an extends cycle', doc({ a: { extends: 'b' }, b: { extends: ['c'] }, c: { extends: 'a' } }), /\$\.profiles\.a\.extends: cycle: a -> b -> c -> a/],
  ['a self extends', doc({ a: { extends: 'a' } }), /\$\.profiles\.a\.extends: cycle: a -> a/],
  ['extends of a missing profile', doc({ a: { extends: 'nope' } }), /\$\.profiles\.a\.extends: no profile 'nope'/],
  ['a missing default_profile', doc({ a: {} }, { default_profile: 'b' }), /\$\.default_profile: no profile 'b'/],
  ['a bad version constraint', doc({ dev: { requires: [{ ...tool, version: '~> 2' }] } }), /\$\.profiles\.dev\.requires\[0\]\.version: "~> 2" is not a version constraint/],
  ['a version_command for another program', doc({ dev: { requires: [{ ...tool, version_command: ['sh', '-c', 'x'] }] } }), /version_command\[0\]: must be the tool itself, "node"/],
  ['a tool given as a path', doc({ dev: { requires: [{ ...tool, name: '/bin/node' }] } }), /\.name: "\/bin\/node" is not a command name/],
  ['a bad env format', doc({ dev: { requires: [{ kind: 'env', name: 'A', why: 'x', format: 'email' }] } }), /\.format: must be non-empty, url, integer or \{"regex": "..."\}/],
  ['a bad regex', doc({ dev: { requires: [{ kind: 'env', name: 'A', why: 'x', format: { regex: '(' } }] } }), /\.format\.regex: not a valid regular expression/],
  ['a bad plugin id', doc({ dev: { requires: [{ kind: 'claude-plugin', name: 'factory', why: 'x' }] } }), /\.name: "factory" is not a plugin id <name>@<marketplace>/],
  ['a bad port', doc({ dev: { requires: [{ kind: 'service', host: 'localhost', port: 70000, why: 'x' }] } }), /\.port: must be an integer from 1 to 65535/],
  ['a duplicate requirement', doc({ dev: { requires: [tool, { ...tool, why: 'again' }] } }), /\$\.profiles\.dev\.requires\[1\]: duplicate of \$\.profiles\.dev\.requires\[0\] \(tool node\)/],
  ['not JSON', null, /not valid JSON/],
];

for (const [what, file, expected] of REFUSALS) {
  test(`loading refuses ${what}, naming the JSON path`, async () => {
    if (file === null) {
      s.write('.factory/doctor.json', '{"version": 1,');
      const r = await s.call(['profiles']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, expected);
      return;
    }
    assert.match(await refusal(file), expected);
  });
}

test('an env name that is really NAME=value is refused without echoing the value', async () => {
  const err = await refusal(doc({ dev: { requires: [{ kind: 'env', name: 'TOKEN=hunter2-value', why: 'x' }] } }));
  assert.match(err, /\$\.profiles\.dev\.requires\[0\]\.name: it is not an environment variable name/);
  assert.ok(!err.includes('hunter2'), err);
});

test('a profile may be named default or secret: names are not values', () => {
  const d = validate(doc({ default: { requires: [] }, secret: { extends: 'default' } }, { default_profile: 'default' }), 'f');
  assert.deepEqual(Object.keys(d.profiles), ['default', 'secret']);
});

test('a full example with every kind validates', () => {
  validate(
    doc(
      {
        base: { description: 'shared', requires: [{ kind: 'tool', name: 'node', version: '>=22.18', version_command: ['node', '--version'], version_pattern: 'v(\\d+\\.\\d+\\.\\d+)', why: 'runs the app', source: 'package.json:8' }] },
        dev: {
          extends: 'base',
          dotenv: ['.env'],
          requires: [
            { kind: 'env', name: 'DATABASE_URL', description: 'Postgres URL', format: 'url', why: 'the app stores data', source: '.env.example:1' },
            { kind: 'env', name: 'LOG_LEVEL', optional: true, why: 'logging' },
            { kind: 'file', path: 'certs/dev.pem', why: 'TLS in dev' },
            { kind: 'claude-plugin', name: 'factory-docs@software-factory', why: 'docs gate' },
            { kind: 'claude-skill', name: 'factory-docs:factory-docs', why: 'docs gate' },
            { kind: 'service', host: 'localhost', port: 5432, timeout_ms: 500, optional: true, why: 'the database' },
          ],
        },
      },
      { description: 'what the app needs', default_profile: 'dev' },
    ),
    'f',
  );
});

test('resolve applies extends parents first, in order; a child replaces a parent requirement in place', () => {
  const d = validate(
    doc({
      a: { dotenv: ['.env.a'], requires: [{ kind: 'tool', name: 'node', why: 'a' }, { kind: 'env', name: 'A', why: 'a' }] },
      b: { dotenv: ['.env.b'], requires: [{ kind: 'env', name: 'B', why: 'b' }] },
      c: { extends: ['a', 'b'], dotenv: ['.env.a'], requires: [{ kind: 'tool', name: 'node', version: '>=22', why: 'c' }, { kind: 'env', name: 'C', why: 'c' }] },
      d: { extends: 'c' },
    }),
    'f',
  );
  const r = resolve(d, 'd');
  assert.deepEqual(r.chain, ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.dotenv, ['.env.a', '.env.b']);
  assert.deepEqual(r.requires.map((x) => [x.requirement.kind, 'name' in x.requirement ? x.requirement.name : '', x.profile]), [
    ['tool', 'node', 'c'],
    ['env', 'A', 'a'],
    ['env', 'B', 'b'],
    ['env', 'C', 'c'],
  ]);
});

test('version constraints: >=, ^ and exact, with partial versions', () => {
  const ok = (v: string, c: string): boolean => satisfies(v, parseConstraint(c) ?? assert.fail(c));
  assert.ok(ok('22.18.0', '>=22.18'));
  assert.ok(!ok('22.17.9', '>=22.18'));
  assert.ok(ok('23.0.0', '>=22.18'));
  assert.ok(ok('22.20.1', '^22.18'));
  assert.ok(!ok('23.0.0', '^22.18'));
  assert.ok(!ok('0.3.0', '^0.2.1'));
  assert.ok(ok('0.2.5', '^0.2.1'));
  assert.ok(ok('3.12.4', '3.12'));
  assert.ok(ok('3.12.4', '=3.12.4'));
  assert.ok(!ok('3.13.0', '3.12'));
  assert.equal(parseConstraint('~1.2'), null);
  assert.equal(parseConstraint('latest'), null);
  assert.equal(extractVersion('v22.18.0\n'), '22.18.0');
  assert.equal(extractVersion('Python 3.12.1'), '3.12.1');
  assert.equal(extractVersion('openjdk version "21.0.2" 2024-01-16', 'version "([\\d.]+)"'), '21.0.2');
  assert.equal(extractVersion('no digits'), null);
});
