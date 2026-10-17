import test from 'node:test';
import assert from 'node:assert/strict';
import {FileSelection} from '../.test-build/selection.js';
test('click, control toggle, shift range and focus are independent',()=>{
  const s=new FileSelection();s.context('a',['a','b','c','d']);
  s.click(0);s.click(2,{ctrl:true});assert.deepEqual(s.values(),['a','c']);
  s.click(3,{shift:true});assert.deepEqual(s.values(),['c','d']);
  s.focus='b';assert.deepEqual(s.values(),['c','d']);
  s.click(2,{ctrl:true});assert.deepEqual(s.values(),['d']);
});
test('marquee additive snapshot and directory/profile reset prevent stale targets',()=>{
  const s=new FileSelection();s.context('profile-a:/one',['a','b','c']);s.click(0);
  s.rectangle(['b'],s.values());assert.deepEqual(s.values(),['a','b']);
  s.rectangle(['c'],['a']);assert.deepEqual(s.values(),['a','c']);
  s.context('profile-a:/two',['a','c']);assert.deepEqual(s.values(),[]);
  s.click(0);s.context('profile-b:/two',['a']);assert.deepEqual(s.values(),[]);
});
test('refresh prunes vanished names and preserves surviving selection',()=>{
  const s=new FileSelection();s.context('same',['a','b']);s.all();s.context('same',['b','c']);
  assert.deepEqual(s.values(),['b']);
});
test('sorting keeps the range anchor attached to its file identity',()=>{
  const s=new FileSelection();s.context('same',['a','b','c','d']);s.click(1);
  s.context('same',['d','c','b','a']);s.click(3,{shift:true});
  assert.deepEqual(s.values(),['b','a']);
});
