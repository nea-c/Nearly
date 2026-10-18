import test from 'node:test';
import assert from 'node:assert/strict';
import { FolderTree } from '../.test-build/tree.js';
import * as focus from '../.test-build/tree-focus.js';

const dir = name => ({name, dir:true, size:0});
test('connection initialization revalidates a loaded root before trusting synthesized restored ancestry',async()=>{
  const tree=new FolderTree('remote','/');tree.record('/',[]);tree.record('/a/b',[]);
  const reads=[];
  await focus.expandConnectionTree(tree,'/a/b',async path=>{
    reads.push(path);
    if(path==='/')tree.record(path,[]);else tree.node(path).error='denied';
    return tree.node(path).request;
  },()=>true);
  assert.equal(focus.visibleTreeTarget('remote','/a/b',focus.renderedTreePaths(tree)),'/');
  assert.deepEqual(reads,['/']);
});
test('connection initialization revalidates loaded intermediate membership without changing ordinary synthesized ancestry',async()=>{
  const tree=new FolderTree('remote','/');tree.record('/',[dir('a')]);tree.record('/a',[]);tree.record('/a/b/c',[]);
  assert(tree.node('/a').loaded);assert(tree.node('/a').children.some(child=>child.path==='/a/b'));
  const reads=[];
  await focus.expandConnectionTree(tree,'/a/b/c',async path=>{
    reads.push(path);tree.record(path,path==='/'?[dir('a')]:[]);return tree.node(path).request;
  },()=>true);
  assert.equal(focus.visibleTreeTarget('remote','/a/b/c',focus.renderedTreePaths(tree)),'/a');
  assert.deepEqual(reads,['/','/a']);
});
test('connection initialization validates and expands ancestry without opening the current folder', async () => {
  assert.equal(typeof focus.expandConnectionTree, 'function');
  for (const [side, root, target, listings, expanded] of [
    ['remote', '/', '/a/b', {'/':[dir('a')],'/a':[dir('b')]}, ['/', '/a']],
    ['local', '@pc', 'C:\\a\\b', {'C:\\':[dir('a')],'C:\\a':[dir('b')]}, ['@pc','C:\\','C:\\a']],
  ]) {
    const tree = new FolderTree(side,root);
    tree.record(target, []);
    if(side==='local')tree.setDrives([{path:'C:\\',name:'C:'}]);
    const reads=[];
    await focus.expandConnectionTree(tree,target,async path=>{
      reads.push(path);
      if(path==='@pc')tree.setDrives([{path:'C:\\',name:'C:'}]);else tree.record(path,listings[path]||[]);
      return tree.node(path).request;
    },()=>true);
    assert.deepEqual(tree.snapshot().expanded, expanded);
    assert.equal(focus.visibleTreeTarget(side,target,focus.renderedTreePaths(tree)),target);
    assert.equal(tree.peek(target).expanded,false);
    assert(!reads.includes(target));
  }
});
test('missing ancestors and failed listings select the nearest rendered parent', async () => {
  assert.equal(typeof focus.expandConnectionTree, 'function');
  for(const fail of [false,true]){
    const tree=new FolderTree('remote','/');tree.record('/a/b/c',[]);
    await focus.expandConnectionTree(tree,'/a/b/c',async path=>{
      if(path==='/')tree.record(path,[dir('a')]);
      else if(fail)tree.node(path).error='denied';
      else tree.record(path,[]);
      return tree.node(path).request;
    },()=>true);
    assert.equal(focus.visibleTreeTarget('remote','/a/b/c',focus.renderedTreePaths(tree)),'/a');
  }
});
test('user collapse or stale ownership during a held listing prevents later expansion',async()=>{
  assert.equal(typeof focus.expandConnectionTree, 'function');
  for(const cancellation of ['collapse','ownership','request']){
    const tree=new FolderTree('remote','/');tree.record('/a/b',[]);
    let release,valid=true;
    const pending=focus.expandConnectionTree(tree,'/a/b',async path=>{
      await new Promise(resolve=>release=resolve);
      tree.record(path,[dir('a')]);
      const completed=tree.node(path).request;
      if(cancellation==='request')tree.node(path).request++;
      return completed;
    },()=>valid);
    assert.equal(tree.node('/').expanded,true);
    if(cancellation==='collapse')tree.node('/').expanded=false;
    if(cancellation==='ownership')valid=false;
    release();await pending;
    assert.equal(tree.peek('/a').expanded,false);
    if(cancellation==='collapse')assert.equal(tree.node('/').expanded,false);
  }
});
