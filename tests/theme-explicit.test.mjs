import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../.test-build/core.js';

test('missing and historical system themes resolve once while retaining the complete settings snapshot', () => {
  for (const theme of [undefined, 'system']) {
    for (const [osDark, expected] of [[false, 'light'], [true, 'dark']]) {
      const store = new Store({ version: 1, settingsRevision: 7, theme, profiles: [{id:'saved', name:'Saved', host:'fixture.invalid', port:22, user:'fixture', mode:'sftp', auth:'key', keyFile:'fixture.ppk', hostKey:''}], history:{saved:'/original'}, localPaneRatio:.62, exclusions:{pair:'*.tmp'} });
      const before = structuredClone(store.serialize());
      assert.equal(typeof store.resolveInitialTheme, 'function');
      assert.equal(store.resolveInitialTheme(osDark), true);
      assert.equal(store.theme, expected);
      assert.deepEqual(store.serialize(), {...before, theme:expected});
      assert.equal(store.resolveInitialTheme(!osDark), false);
      assert.equal(store.theme, expected);
    }
  }
});

test('all three explicit choices survive restart without OS re-resolution', () => {
  for (const theme of ['light','dark','midnight']) {
    const first = new Store({theme, settingsRevision:9});
    assert.equal(typeof first.resolveInitialTheme, 'function');
    assert.equal(first.resolveInitialTheme(theme === 'light'), false);
    const restarted = new Store(first.serialize());
    assert.equal(restarted.resolveInitialTheme(theme !== 'light'), false);
    assert.equal(restarted.theme, theme);
    assert.equal(restarted.settingsRevision,9);
  }
});

test('unknown themes remain rejected instead of becoming a first-run default', () => {
  for (const theme of ['',null,'automatic','MIDNIGHT',3]) assert.throws(() => new Store({theme}));
});
