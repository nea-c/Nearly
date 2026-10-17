import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../.test-build/core.js';

// Markup is pure; importing the UI also registers document lifecycle listeners.
globalThis.document={addEventListener(){}};
globalThis.window={addEventListener(){}};
const {connectionTreeMarkup}=await import('../.test-build/connection-tree-ui.js');
const profile={id:'fixture',name:'Fixture',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'mock',keyFile:'',hostKey:''};

test('connection tree has no persistent management buttons while retaining selection and chevrons',()=>{
  const store=new Store({profiles:[profile]});
  const group=store.createConnectionGroup('Group');
  const html=connectionTreeMarkup(store,{profileId:'fixture'});
  assert.doesNotMatch(html,/id="(?:add-profile|add-connection-group|connection-actions)"|data-connection-action=/);
  assert.match(html,/data-connection-select="fixture"/);
  assert.doesNotMatch(html,/connection-root-drop|data-connection-drop-root/,'root footer and its layout row are absent');
  assert.match(html,new RegExp(`data-connection-toggle="${group}"`));
  assert.equal((html.match(/<button\b/g)||[]).length,3,'only two selection buttons and one chevron remain');
});

test('an empty connection tree retains an accessible context-menu target without add buttons',()=>{
  const html=connectionTreeMarkup(new Store({profiles:[]}),{profileId:''});
  assert.doesNotMatch(html,/<button\b/);
  assert.match(html,/id="connection-tree"[^>]*tabindex="0"/);
  assert.match(html,/connection-tree-empty/);
  assert.doesNotMatch(html,/connection-root-drop|data-connection-drop-root/);
});
