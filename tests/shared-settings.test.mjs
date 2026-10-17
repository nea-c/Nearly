import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, Queue } from '../.test-build/core.js';
import { applyPersistentSettings } from '../.test-build/shared-settings.js';
const profile={id:'p',name:'Original',host:'example.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',keyFile:'C:\\generated.ppk',hostKey:''};
test('shared refresh replaces the complete persisted baseline but preserves live tab and job identity',()=>{
  const store=new Store({profiles:[profile],settingsRevision:1});
  const w=store.createWorkspace('p','C:\\local');store.connectWorkspace(w.id,profile);
  store.attachJob(w.id,{id:'job',profile,local:'C:\\sync',remote:'/sync',status:'running',queue:new Queue(),sent:4,speed:0,latency:1,logs:[]});
  const job=store.tabs[0],workspaces=store.workspaces,tabs=store.tabs,connection=w.connection;
  const fresh={...store.serialize(),settingsRevision:2,profiles:[{...profile,name:'Other window edited'}],theme:'mint',language:'en',retainedSyncs:[{id:'foreign',ownerTabId:'other-window-tab',ownerTabClosed:false,profile,local:'C:\\foreign',remote:'/foreign',exclusionRules:'*.tmp',deleteRemoved:false,recursive:true,pendingState:'unknown'}]};
  applyPersistentSettings(store,fresh);
  assert.equal(store.workspaces,workspaces);assert.equal(store.tabs,tabs);assert.equal(store.workspaces[0],w);assert.equal(store.tabs[0],job);assert.equal(w.connection,connection);
  assert.equal(w.localBrowse,'C:\\local');assert.equal(job.remote,'/sync');assert.equal(job.status,'running');assert.equal(connection.name,'Original');
  assert.equal(store.profiles[0].name,'Other window edited');assert.equal(store.theme,'mint');assert.equal(store.language,'en');assert.equal(store.settingsRevision,2);
  assert.equal(store.workspaces.length,1);assert.equal(store.retainedSyncs[0].ownerTabId,'other-window-tab');assert.deepEqual(store.serialize().retainedSyncs,fresh.retainedSyncs);
});
test('invalid shared document cannot partially mutate current settings or resources',()=>{
  const store=new Store({profiles:[profile],theme:'forest'}),w=store.createWorkspace('p','C:\\own'),before=store.serialize();
  assert.throws(()=>applyPersistentSettings(store,{profiles:[profile],theme:'unknown'}));assert.deepEqual(store.serialize(),before);assert.equal(store.workspaces[0],w);
});

