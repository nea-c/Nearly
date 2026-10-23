import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('native fixture addons use a locked Visual Studio 2026 capable node-gyp', () => {
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  assert.equal(pkg.devDependencies['node-gyp'], '13.1.0');
  assert.equal(lock.packages[''].devDependencies['node-gyp'], '13.1.0');
  assert.equal(lock.packages['node_modules/node-gyp'].version, '13.1.0');
  assert.match(lock.packages['node_modules/node-gyp'].integrity, /^sha512-/);
});

test('qualified install loads both actual native addons, not the JavaScript fallback', {
  // npm ci can succeed after ssh2's optional native build fails. Windows CI must
  // prove the bindings exist before native fixtures or any publishing gate.
  skip: process.env.NEARLY_NATIVE_ADDON_QUALIFY !== '1'
    && !(process.platform === 'win32' && process.env.CI === 'true'),
}, () => {
  assert.equal(require('node-gyp/package.json').version, '13.1.0');
  assert.equal(require('ssh2/lib/protocol/crypto.js').bindingAvailable, true,
    'ssh2 native crypto binding did not build; npm ci success alone is insufficient');
  const cpu = require('cpu-features')();
  assert.equal(typeof cpu.arch, 'string');
  assert.equal(typeof cpu.flags, 'object');
});
