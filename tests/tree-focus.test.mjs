import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FolderTree } from '../.test-build/tree.js';
import { BrowseHistory } from '../.test-build/navigation.js';

const file = new URL('../.test-build/tree-focus.js', import.meta.url);
const focus = existsSync(file) ? await import(file) : {};
test('selection projection follows rendered expansion without opening or allocating nodes', () => {
  assert.equal(typeof focus.renderedTreePaths, 'function');
  for (const [side, root, parent, current] of [['remote', '/', '/a', '/a/b'], ['local', '@pc', 'C:\\', 'C:\\a']]) {
    const tree = new FolderTree(side, root); tree.record(current, []);
    const before = tree.snapshot();
    assert.deepEqual(focus.renderedTreePaths(tree), [root]);
    assert.equal(focus.visibleTreeTarget(side, current, focus.renderedTreePaths(tree)), root);
    assert.deepEqual(tree.snapshot(), before);
    tree.node(root).expanded = true;
    assert.equal(focus.visibleTreeTarget(side, current, focus.renderedTreePaths(tree)), parent);
    tree.node(parent).expanded = true;
    assert.equal(focus.visibleTreeTarget(side, current, focus.renderedTreePaths(tree)), current);
    tree.node(parent).expanded = false;
    assert.equal(focus.visibleTreeTarget(side, current, focus.renderedTreePaths(tree)), parent);
  }
});
test('branch reveal ownership follows only current-directory ancestry',()=>{
 assert.equal(typeof focus.treeBranchContains,'function');const owns=focus.treeBranchContains;
 assert.equal(owns('remote','/current','/current/child'),true);assert.equal(owns('remote','/other','/current/child'),false);assert.equal(owns('remote','/cur','/current'),false);assert.equal(owns('remote','/','/current'),true);
 assert.equal(owns('local','@pc','C:\\current'),true);assert.equal(owns('local','c:/CURRENT','C:\\current\\child'),true);assert.equal(owns('local','D:\\','C:\\current'),false);
});

test('reveal selects only the closest rendered ancestor including case-insensitive local drive and PC roots', () => {
  assert.equal(typeof focus.visibleTreeTarget, 'function', 'tree reveal resolver is missing');
  const pick = focus.visibleTreeTarget;
  assert.equal(pick('remote', '/one/two', ['/', '/one', '/one/two']), '/one/two');
  assert.equal(pick('remote', '/one/two', ['/', '/one', '/one-too']), '/one');
  assert.equal(pick('remote', '/one/two', ['/']), '/');
  assert.equal(pick('remote', '/', ['/']), '/');
  assert.equal(pick('local', 'c:/Work/Child', ['@pc', 'C:\\', 'C:\\work']), 'C:\\work');
  assert.equal(pick('local', 'D:\\folder', ['@pc', 'C:\\']), '@pc');
  assert.equal(pick('local', '\\\\host\\share\\child', ['@pc', '\\\\host\\share']), '\\\\host\\share');
  assert.equal(pick('remote', '/one/two', []), undefined);
});

test('reveal intent waits for rows then consumes once without touching navigation or expansion', () => {
  assert.equal(typeof focus.TreeRevealIntent, 'function', 'one-shot reveal intent is missing');
  const intent = new focus.TreeRevealIntent();
  const tree = new FolderTree('remote', '/');
  tree.record('/a/b', []); tree.node('/').expanded = true;
  const navigation = new BrowseHistory(); navigation.commit('/a/b');
  const context = { workspace: {}, connection: {}, tree, side: 'remote', path: navigation.current };
  const before = { tree: tree.snapshot(), navigation: navigation.snapshot() };
  intent.request(context);
  assert.equal(intent.consume(context, []), undefined);
  assert.equal(intent.consume(context, ['/', '/a']), '/a');
  assert.equal(intent.consume(context, ['/', '/a', '/a/b']), undefined);
  assert.deepEqual({ tree: tree.snapshot(), navigation: navigation.snapshot() }, before);
  intent.request(context);
  assert.equal(intent.consume(context, ['/']), '/'); // explicit reopen
  assert.deepEqual({ tree: tree.snapshot(), navigation: navigation.snapshot() }, before);
});

test('user cancellation and every stale ownership component discard delayed reveal', () => {
  assert.equal(typeof focus.TreeRevealIntent, 'function', 'one-shot reveal intent is missing');
  const context = { workspace: {}, connection: {}, tree: {}, side: 'remote', path: '/a' };
  for (const change of [{ workspace: {} }, { connection: {} }, { tree: {} }, { side: 'local' }, { path: '/b' }]) {
    const intent = new focus.TreeRevealIntent();
    intent.request(context);
    assert.equal(intent.consume({ ...context, ...change }, ['/']), undefined);
    assert.equal(intent.consume(context, ['/']), undefined);
  }
  const intent = new focus.TreeRevealIntent(); intent.request(context); intent.cancel();
  assert.equal(intent.consume(context, ['/']), undefined);
});
