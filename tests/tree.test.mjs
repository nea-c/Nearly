import test from 'node:test';
import assert from 'node:assert/strict';
import {FolderTree, childPath} from '../.test-build/tree.js';

test('listing and navigation cache preserve every chevron expansion state',()=>{
  for (const [side,root,path] of [['remote','/','/site/deep'],['local','@pc','C:\\site\\deep']]) {
    const tree=new FolderTree(side,root);
    tree.node(root).expanded=false;
    tree.record(path,[{name:'.private',dir:true,size:0,hidden:true},{name:'visible',dir:true,size:0}]);
    assert.equal(tree.node(root).expanded,false);
    assert.equal(tree.node(path).expanded,false);
    assert.equal(tree.node(path).children[0].hidden,true);
    tree.node(path).expanded=true;
    tree.record(path,[]);
    assert.equal(tree.node(path).expanded,true);
  }
});

test('folder tree is lazy and byte-safe paths cannot traverse',()=>{
  const tree=new FolderTree('remote','/');
  assert.equal(tree.node('/').loaded,false);
  tree.record('/',[{name:'site',dir:true,size:0},{name:'file',dir:false,size:4},{name:'..',dir:true,size:0}]);
  assert.equal(tree.node('/').children.length,1);
  assert.equal(tree.node('/site').loaded,false);
  assert.equal(childPath('local','C:\\root','site'),'C:\\root\\site');
  assert.throws(()=>childPath('remote','/root','../escape'));
});
test('tree requests are superseded and reset discards another profile cache',()=>{
  const tree=new FolderTree('remote','/','profile-a');
  const first=tree.begin('/site');
  const latest=tree.begin('/site');
  assert.equal(tree.current('/site',first),false);
  assert.equal(tree.current('/site',latest),true);
  tree.record('/site',[{name:'child',dir:true,size:0}]);
  assert.equal(tree.node('/').children[0].path,'/site');
  tree.reset('/','profile-b');
  assert.equal(tree.current('/site',latest),false);
  assert.equal(tree.node('/').loaded,false);
  assert.equal(tree.key,'profile-b');
});
test('tree has bounded nodes and displayed children',()=>{
  const tree=new FolderTree('remote','/');
  tree.record('/',Array.from({length:600},(_,i)=>({name:'dir'+i,dir:true,size:0})));
  assert.equal(tree.node('/').children.length,500);
  assert.equal(tree.node('/').limited,true);
  for(let i=0;i<255;i++) tree.node('/x'+i);
  assert.throws(()=>tree.node('/overflow'),/上限/);
});
