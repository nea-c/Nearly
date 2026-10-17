import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseConnection, connectionModeOptions, parseConnectionMode, mockEnabled } from '../.test-build/connection-mode.js';
import { Store } from '../.test-build/core.js';

test('normal use rejects Mock and unselected modes without interpreting them as SFTP', () => {
  assert.equal(mockEnabled, false);
  assert.equal(canUseConnection('mock', false), false);
  assert.equal(canUseConnection('sftp', false), true);
  assert.throws(() => parseConnectionMode('mock', false));
  assert.throws(() => parseConnectionMode('', false));
  assert.throws(() => parseConnectionMode(null, false));
  assert.equal(parseConnectionMode('sftp', false), 'sftp');
});

test('saved Mock remains Mock and requires an explicit mode selection in normal editing', () => {
  const saved={id:'old',name:'Old mock',host:'fixture.invalid',port:22,user:'fixture',mode:'mock'};
  const store=new Store({version:1,profiles:[saved],history:{}});
  assert.equal(store.profiles[0].mode,'mock');
  const options=connectionModeOptions(store.profiles[0].mode,false);
  assert.match(options,/value=""[^>]*selected/);
  assert.doesNotMatch(options,/value="mock"/);
  assert.doesNotMatch(options,/value="sftp"[^>]*selected/);
  assert.match(connectionModeOptions(undefined,false),/value="sftp"[^>]*selected/);
  assert.equal(store.profiles[0].mode,'mock');
});

test('explicit development opt-in retains the Mock simulation without changing SFTP choices', () => {
  assert.equal(canUseConnection('mock',true),true);
  assert.equal(parseConnectionMode('mock',true),'mock');
  const options=connectionModeOptions('mock',true);
  assert.match(options,/value="mock"[^>]*selected/);
  assert.doesNotMatch(options,/（|）|実接続/);
});
