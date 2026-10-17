import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, connectionKey } from '../.test-build/core.js';
import { applyPersistentSettings } from '../.test-build/shared-settings.js';
const profile = (id, name=id) => ({id,name,host:`${id}.invalid`,port:22,user:'fixture',auth:'key',mode:'sftp',keyFile:'',hostKey:''});
const profiles=[profile('first'),profile('last')];

test('restart selects the saved stable ID with no connection or sync restoration',()=>{
  const store=new Store({profiles});
  assert.equal(store.initialProfileId(),'first');
  store.selectSavedProfile('last');
  const restored=new Store(JSON.parse(JSON.stringify(store.serialize())));
  assert.equal(restored.initialProfileId(),'last');
  const w=restored.createWorkspace();
  assert.equal(w.profileId,'last');assert.equal(w.connection,undefined);
  assert.deepEqual(restored.tabs,[]);assert.equal(w.remoteBrowse,'/');
});
test('rename retains selection; deleted IDs fall back without borrowing their browse path',()=>{
  const browseLocations={
    [connectionKey(profiles[0])]:{local:'C:\\first-only',remote:'/first-only'},
    [connectionKey(profiles[1])]:{local:'C:\\last-only',remote:'/last-only'},
  };
  const store=new Store({profiles,lastSelectedProfileId:'last',browseLocations});
  store.saveProfile({...profiles[1],name:'Renamed'});
  const renamed=new Store(store.serialize());
  assert.equal(renamed.initialProfileId(),'last');
  assert.equal(renamed.createWorkspace().remoteBrowse,'/last-only');
  const deleted=new Store({profiles:[profiles[0]],lastSelectedProfileId:'last',browseLocations});
  assert.equal(deleted.initialProfileId(),'first');
  const fallback=deleted.createWorkspace();
  assert.equal(fallback.localBrowse,'C:\\first-only');assert.equal(fallback.remoteBrowse,'/first-only');
  assert.equal(new Store({profiles:[],lastSelectedProfileId:'last'}).initialProfileId(),'');
  assert.throws(()=>new Store({profiles,lastSelectedProfileId:123}));
});
test('explicit reselection is an intent and old acknowledgements cannot clear newer intent',()=>{
  const store=new Store({profiles,lastSelectedProfileId:'last'});
  store.selectSavedProfile('last');const revision=store.lastSelectedProfileRevision;
  assert.equal(store.serialize().lastSelectedProfileChanged,true);
  store.selectSavedProfile('first');
  assert.equal(store.markLastSelectedProfileSaved(revision),false);
  assert.equal(store.serialize().lastSelectedProfileChanged,true);
  store.markLastSelectedProfileSaved();
  assert.equal(store.serialize().lastSelectedProfileChanged,false);
  assert.equal(store.selectSavedProfile('missing'),false);
});
test('shared refresh updates future startup preference without jumping existing workspace',()=>{
  const store=new Store({profiles,lastSelectedProfileId:'first'});
  const w=store.createWorkspace('first','C:\\own');
  applyPersistentSettings(store,{profiles,lastSelectedProfileId:'last'});
  assert.equal(store.initialProfileId(),'last');assert.equal(w.profileId,'first');
  store.closeWorkspace(w.id);assert.equal(store.initialProfileId(),'last');
});
