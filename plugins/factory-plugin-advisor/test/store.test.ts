// Creating the config dir: owner-only, and failing (never hanging) where a directory cannot be made.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DIR_MODE, makeDirs, Store } from '../src/store.ts';

const scratch = mkdtempSync(join(tmpdir(), 'factory-plugin-advisor-store-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('makeDirs creates every missing directory with the mode, and is a no-op when it exists', () => {
  const deep = join(scratch, 'a', 'b', 'c');
  makeDirs(deep, DIR_MODE);
  makeDirs(deep, DIR_MODE);
  for (const dir of [join(scratch, 'a'), join(scratch, 'a', 'b'), deep]) {
    assert.equal(statSync(dir).isDirectory(), true, dir);
    assert.equal(statSync(dir).mode & 0o777 & ~DIR_MODE, 0, `${dir} is owner-only`);
  }
});

test('makeDirs under a regular file fails with ENOTDIR', () => {
  const file = join(scratch, 'file');
  writeFileSync(file, '');
  assert.throws(() => makeDirs(join(file, 'x', 'y'), DIR_MODE), { code: 'ENOTDIR' });
});

test('makeDirs throws ENOTDIR when the path exists as a regular file, and never chmods it', () => {
  const file = join(scratch, 'plain');
  writeFileSync(file, 'x', { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => makeDirs(file, DIR_MODE), { code: 'ENOTDIR' });
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.equal(statSync(file).isFile(), true);
});

test('Store.prepare refuses a config dir that is a regular file instead of chmodding it', () => {
  const file = join(scratch, 'config-file');
  writeFileSync(file, 'x', { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.throws(() => new Store({ FACTORY_PLUGIN_ADVISOR_CONFIG_DIR: file }).prepare(), { code: 'ENOTDIR' });
  assert.equal(statSync(file).mode & 0o777, 0o644);
});

// mkdir under /proc fails with ENOENT although /proc exists. Node 24's mkdirSync({ recursive: true })
// loops forever on that, which hung CI; makeDirs must throw instead. Run in a child with a timeout,
// because a synchronous hang cannot be stopped by --test-timeout.
test('makeDirs under /proc throws ENOENT instead of hanging', { skip: existsSync('/proc/self') ? false : 'needs Linux /proc' }, () => {
  const store = new URL('../src/store.ts', import.meta.url).href;
  const code = `import { makeDirs } from ${JSON.stringify(store)};
try { makeDirs('/proc/factory-plugin-advisor-cannot-write-here/x', 0o700); console.log('created'); }
catch (error) { console.log(error.code); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, `makeDirs hung and was killed after 10 s (${process.version})`);
  assert.equal(r.stdout.trim(), 'ENOENT', r.stderr);
});
