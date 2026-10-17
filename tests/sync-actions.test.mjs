import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionResumeContext} from '../.test-build/sync-actions.js';
import {Store} from '../.test-build/core.js';
import {snapshotWorkspaceTransfer,hydrateWorkspaceTransfer} from '../.test-build/workspace-transfer.js';
import {applyPersistentSettings} from '../.test-build/shared-settings.js';
const profile={id:'p',name:'Fixture',host:'fixture.invalid',port:22,user:'test',auth:'key',mode:'sftp',keyFile:'',hostKey:'pin'};
const retained={id:'r',ownerTabId:'owner',ownerTabClosed:false,profile,local:'C:\\old',remote:'/old',exclusionRules:'old/',deleteRemoved:true,recursive:false,pendingState:'unknown'};
const job={id:'job',retainedId:'r',profile,local:'C:\\old',remote:'/old',exclusionRules:'old/',deleteRemoved:true,recursive:false,status:'stopped',logs:[],sent:0,speed:0,latency:0};
test('persisted retained metadata alone cannot create a resume context after restart',()=>{
 assert.equal(sessionResumeContext('owner',undefined,retained),undefined);
 assert.equal(sessionResumeContext('other',job,retained),undefined);
 assert.equal(sessionResumeContext('owner',{...job,retainedId:'foreign'},retained),undefined);
});
test('resume freezes actual successful session job pair and settings despite browse or metadata changes',()=>{
 const altered={...retained,local:'C:\\new',remote:'/new',exclusionRules:'new/',deleteRemoved:false,recursive:true};
 const resume=sessionResumeContext('owner',job,altered);
 assert.equal(resume.local,'C:\\old');assert.equal(resume.remote,'/old');assert.equal(resume.exclusionRules,'old/');assert.equal(resume.deleteRemoved,true);assert.equal(resume.recursive,false);
 resume.profile.name='Changed';assert.equal(job.profile.name,'Fixture');
});
test('settings saves and shared refresh preserve the live job needed for session-only resume',()=>{
 const store=new Store({profiles:[profile],retainedSyncs:[retained]},{ownedWorkspaceIds:[]});
 const w=store.createWorkspace('p','C:\\old');w.id='owner';store.connectWorkspace(w.id,profile);store.attachJob(w.id,job);
 applyPersistentSettings(store,{...store.serialize(),theme:'mint'});
 const own=store.ownRetainedForWorkspace('owner');assert.equal(sessionResumeContext(w.id,store.tabs[0],own).local,'C:\\old');
 const restarted=new Store(store.serialize(),{ownedWorkspaceIds:[]});assert.equal(restarted.tabs.length,0);
 assert.equal(sessionResumeContext('owner',restarted.tabs[0],restarted.retainedSyncs[0]),undefined);
});

test('stopped session context travels with a live detached or merged workspace',()=>{
 const source=new Store({profiles:[profile],retainedSyncs:[retained]},{ownedWorkspaceIds:[]});
 const w=source.createWorkspace('p','C:\\browsed-elsewhere');w.id='owner';source.connectWorkspace(w.id,profile);source.attachJob(w.id,job);
 const target=new Store(source.serialize(),{ownedWorkspaceIds:[]});
 const moved=hydrateWorkspaceTransfer(target,snapshotWorkspaceTransfer(source,w.id),w.id);
 const resumed=sessionResumeContext(moved.id,target.tabs.find(t=>t.id===moved.jobId),target.ownRetainedForWorkspace(moved.id));
 assert.equal(resumed.local,job.local);assert.equal(resumed.remote,job.remote);assert.equal(resumed.deleteRemoved,true);assert.equal(resumed.recursive,false);
 assert.equal(moved.localBrowse,'C:\\browsed-elsewhere');
});
