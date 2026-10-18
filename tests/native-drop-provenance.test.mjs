import test from 'node:test';
import assert from 'node:assert/strict';

test('native ingress provenance survives delivery after outbound UI completion', async () => {
  let callback, rawSubscriptions = 0, hitTests = 0;
  globalThis.window = {
    devicePixelRatio: 1,
    __TAURI__: {
      core: { invoke: async () => {} },
      event: { listen: async (name, fn) => { assert.equal(name, 'native-file-drop'); callback = fn; return () => {}; } },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => { rawSubscriptions++; } }) },
    },
  };
  globalThis.document = {
    querySelectorAll: () => [], addEventListener: () => {},
    elementFromPoint: () => { hitTests++; return null; },
  };
  const { bindFileDrop } = await import('../.test-build/file-drop.js');
  bindFileDrop({ valid: () => true, uploadAllowed: () => true });
  await Promise.resolve();
  assert.equal(typeof callback, 'function', 'must consume native-tagged events');
  assert.equal(rawSubscriptions, 0, 'raw Tauri events have no source identity');
  // No UI reservation is active now; immutable native provenance still rejects it.
  callback({ payload: { type: 'drop', ownOutbound: true, paths: ['C:\\owned.txt'], position: { x: 1, y: 1 } } });
  callback({ payload: { type: 'drop', paths: ['C:\\untagged.txt'], position: { x: 1, y: 1 } } });
  assert.equal(hitTests, 0);
  callback({ payload: { type: 'drop', ownOutbound: false, paths: ['C:\\external.txt'], position: { x: 1, y: 1 } } });
  assert.equal(hitTests, 1, 'verified external events retain normal target routing');
});
