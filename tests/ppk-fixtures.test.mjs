import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ensurePpkFixtures, fixtureNames} from '../scripts/ppk-fixtures.mjs';
const require = createRequire(import.meta.url);
const {utils} = require('ssh2');

test('fresh PPK test inputs are encrypted, decode independently, and never overwrite existing files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nearly-generated-ppk-'));
  try {
    const dir = path.join(root, 'fixtures');
    assert.equal(await ensurePpkFixtures(dir), 'generated');
    const contents = await Promise.all(fixtureNames.map(n => fs.readFile(path.join(dir,n),'utf8')));
    for (const [i,text] of contents.entries()) {
      assert.match(text, new RegExp(`^PuTTY-User-Key-File-${i+2}: ssh-rsa\\nEncryption: aes256-cbc\\n`));
      assert.ok(!text.includes('PRIVATE KEY-----'));
    }
    const key = utils.parseKey(contents[0], 'fixture-only-not-a-user-secret');
    assert.ok(!(key instanceof Error), key instanceof Error ? key.message : '');
    assert.ok(utils.parseKey(contents[0], 'wrong') instanceof Error);
    const signature = key.sign(Buffer.from('disposable test fixture'));
    assert.equal(key.verify(Buffer.from('disposable test fixture'), signature), true);
    assert.equal(await ensurePpkFixtures(dir), 'existing');
    assert.deepEqual(await Promise.all(fixtureNames.map(n=>fs.readFile(path.join(dir,n),'utf8'))), contents);
    await fs.unlink(path.join(dir,fixtureNames[1]));
    await assert.rejects(ensurePpkFixtures(dir), /Partial/);
    assert.equal(await fs.readFile(path.join(dir,fixtureNames[0]),'utf8'), contents[0]);
  } finally {
    const real = await fs.realpath(root), base = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(real).toLowerCase(),base.toLowerCase());
    assert.match(path.basename(real),/^nearly-generated-ppk-/);
    await fs.rm(real,{recursive:true,force:true});
  }
});

test('hosted native tests generate their ignored inputs before cargo compiles them', async () => {
  const yaml = await fs.readFile(new URL('../.github/workflows/release-windows.yml',import.meta.url),'utf8');
  const generate = yaml.indexOf('run: node scripts/ppk-fixtures.mjs');
  assert.ok(generate > 0);
  assert.ok(generate < yaml.indexOf('run: cargo test --offline --locked'));
});
