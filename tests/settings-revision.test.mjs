import test from 'node:test';
import assert from 'node:assert/strict';
import {sameSettingsAfterHostPin} from '../.test-build/settings-revision.js';
import {Store} from '../.test-build/core.js';
const profile={id:'fixture',name:'Fixture',host:'fixture.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',hostKey:''};
const base=()=>({version:1,settingsRevision:5,profiles:[profile],history:{},theme:'light'});
test('approval reload accepts only target pin and revision while preserving unrelated sections',()=>{
 const before=base(),after=structuredClone(before);after.settingsRevision=6;after.profiles[0].hostKey='SHA256:generated-fixture';
 assert.equal(sameSettingsAfterHostPin(before,after,'fixture'),true);
 after.theme='dark';assert.equal(sameSettingsAfterHostPin(before,after,'fixture'),false);
 after.theme='light';after.history.other='C:\\other';assert.equal(sameSettingsAfterHostPin(before,after,'fixture'),false);
});
test('approval reload rejects changed connection identity and malformed settings',()=>{
 const before=base(),after=structuredClone(before);after.profiles[0].host='changed.invalid';
 assert.equal(sameSettingsAfterHostPin(before,after,'fixture'),false);
 assert.equal(sameSettingsAfterHostPin(before,{version:999},'fixture'),false);
});
test('settings revision round trips and invalid explicit revisions never reset silently',()=>{
 for(const value of [0,1,42,Number.MAX_SAFE_INTEGER]){
  const store=new Store({settingsRevision:value});
  assert.equal(store.settingsRevision,value);
  assert.equal(new Store(store.serialize()).settingsRevision,value);
 }
 assert.equal(new Store().settingsRevision,0);
 for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,null,'1'])
  assert.throws(()=>new Store({settingsRevision:value}));
});
