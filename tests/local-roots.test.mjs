import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLocalBrowse, parentFolder } from '../.test-build/navigation.js';
import { FolderTree, PC_ROOT } from '../.test-build/tree.js';

test('drive roots remain absolute and drive-relative input is rejected', () => {
  for (const drive of ['C', 'D']) {
    assert.equal(normalizeLocalBrowse(drive + ':\\'), drive + ':\\');
    assert.equal(normalizeLocalBrowse(drive + ':/'), drive + ':\\');
    assert.equal(parentFolder('local', drive + ':\\'), undefined);
    assert.throws(() => normalizeLocalBrowse(drive + ':'));
    assert.throws(() => normalizeLocalBrowse(drive + ':folder'));
  }
  assert.equal(normalizeLocalBrowse('D:/site/'), 'D:\\site');
  assert.throws(() => normalizeLocalBrowse('relative'));
});

test('PC tree records root listings independently and empty nodes remain toggleable', () => {
  for (const side of ['local', 'remote']) {
    const tree = new FolderTree(side, side === 'local' ? PC_ROOT : '/');
    const root = side === 'local' ? 'D:\\' : '/';
    tree.record(root, [{ name: 'file.txt', dir: false, size: 1 }]);
    const node = tree.node(root);
    assert.equal(node.loaded, true);
    assert.equal(node.children.length, 0);
    assert.equal(node.expanded, false);
    node.expanded = false;
    assert.equal(tree.node(root).expanded, false);
    node.expanded = true;
    assert.equal(tree.node(root).expanded, true);
    assert.equal(node.loading, false);
    assert.equal(node.error, '');
    if (side === 'local') {
      assert.equal(tree.node(PC_ROOT).children[0].path, 'D:\\');
      assert.throws(() => tree.node('D:'));
    }
  }
});
