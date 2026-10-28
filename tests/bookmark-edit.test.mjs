import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, connectionKey } from '../.test-build/core.js';

const profile = id => ({ id, name: id, mode: 'sftp', host: `${id}.invalid`, port: 22, user: 'test', auth: 'key', hostKey: 'pin' });

test('paired edit round trip updates name and paths under the selected ID, retaining grouping and other scopes', () => {
  const p = profile('edit'), q = profile('foreign');
  const store = new Store({ profiles: [p, q] });
  const pair = store.saveFolderBookmark(p, { name: 'Original', local: 'C:\\saved', remote: '/saved' });
  store.saveFolderBookmark(p, { name: 'Neighbor', local: 'D:\\neighbor', remote: '/neighbor' });
  store.saveFolderBookmark(q, { name: 'Foreign', local: 'E:\\foreign', remote: '/foreign' });
  const group = store.createBookmarkGroup(connectionKey(p), 'Group');
  store.moveBookmarkNode(connectionKey(p), pair.id, group);
  store.saveSideBookmark('local', { name: 'Local', path: 'C:\\local' });
  store.saveSideBookmark('remote', { name: 'Remote', path: '/remote' }, p);
  const before = structuredClone(store.serialize());
  const candidate = new Store(structuredClone(before));
  candidate.saveFolderBookmark(p, { ...pair, name: 'Edited <pair>', local: 'D:/edited/', remote: '/edited//' });
  const after = new Store(structuredClone(candidate.serialize())).serialize();
  assert.deepEqual(after.folderBookmarks, before.folderBookmarks.map(b => b.id === pair.id ? { ...b, name: 'Edited <pair>', local: 'D:\\edited', remote: '/edited' } : b));
  for (const field of ['bookmarkTree', 'localBookmarks', 'remoteBookmarks', 'localBookmarkTree', 'remoteBookmarkTree', 'history']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.deepEqual(store.serialize(), before, 'candidate changes do not publish before persistence');
});

test('paired path edits reject invalid paths and another pair target without changing any records', () => {
  const p = profile('edit');
  const store = new Store({ profiles: [p] });
  const pair = store.saveFolderBookmark(p, { name: 'Original', local: 'C:\\saved', remote: '/saved' });
  store.saveFolderBookmark(p, { name: 'Neighbor', local: 'D:\\neighbor', remote: '/neighbor' });
  const before = structuredClone(store.serialize());
  for (const paths of [
    { local: 'relative', remote: '/valid' },
    { local: 'C:\\valid', remote: '/a/../b' },
    { local: 'D:\\neighbor', remote: '/neighbor' },
  ]) {
    assert.throws(() => store.saveFolderBookmark(p, { ...pair, ...paths }));
    assert.deepEqual(store.serialize(), before);
  }
});

test('paired update cannot change the connection identity of an existing bookmark', () => {
  const p = profile('edit'), q = profile('foreign');
  const store = new Store({ profiles: [p, q] });
  const pair = store.saveFolderBookmark(p, { name: 'Original', local: 'C:\\saved', remote: '/saved' });
  const before = structuredClone(store.serialize());
  assert.throws(() => store.saveFolderBookmark(q, { ...pair, name: 'Wrong scope' }), /cannot change its connection identity/);
  assert.deepEqual(store.serialize(), before);
});
