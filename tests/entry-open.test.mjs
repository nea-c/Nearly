import test from 'node:test';
import assert from 'node:assert/strict';
import { entryOpenTarget } from '../.test-build/entry-open.js';

test('real directories use their child paths without resolving shortcuts', async () => {
  const resolve = () => { throw Error('must not resolve'); };
  assert.equal(await entryOpenTarget('local', 'C:\\base', { name: 'child', dir: true }, resolve), 'C:\\base\\child');
  assert.equal(await entryOpenTarget('remote', '/', { name: 'child', dir: true }, resolve), '/child');
});
test('only local non-directory .lnk entries are resolved, preserving file classification', async () => {
  const calls = [], entry = { name: 'folder.LNK', dir: false };
  const resolve = async path => { calls.push(path); return 'D:\\target'; };
  assert.equal(await entryOpenTarget('local', 'C:\\base', entry, resolve), 'D:\\target');
  assert.equal(entry.dir, false);
  assert.deepEqual(calls, ['C:\\base\\folder.LNK']);
  for (const [side, name] of [['remote', 'folder.lnk'], ['local', 'program.exe'], ['local', 'note.txt'], ['local', '../bad.lnk']]) {
    assert.equal(await entryOpenTarget(side, 'C:\\base', { name, dir: false }, resolve), undefined);
  }
  assert.deepEqual(calls, ['C:\\base\\folder.LNK']);
});
test('resolver failures propagate without inventing a navigation target', async () => {
  await assert.rejects(entryOpenTarget('local', 'C:\\base', { name: 'broken.lnk', dir: false }, async () => { throw Error('unavailable'); }), /unavailable/);
});
