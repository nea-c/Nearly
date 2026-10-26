import test from 'node:test';import assert from 'node:assert/strict';
import {ErrorAttention,newSyncError} from '../.test-build/error-attention.js';
const s=(status='running',errorCount=0)=>({status,errorCount});
test('new failure transitions and later errors notify once, not repeated snapshots or recovered rendering',()=>{
 const calls=[],a=new ErrorAttention(active=>{calls.push(active);return Promise.resolve();});
 a.sync(s(),s('failed',1));for(let i=0;i<10;i++)a.sync(s('failed',1),s('failed',1));
 assert.deepEqual(calls,[true]);a.focus();assert.deepEqual(calls,[true,false]);
 a.sync(s('failed',1),s('failed',1));assert.deepEqual(calls,[true,false]);
 a.sync(s('failed',1),s('failed',2));a.sync(s('failed',2),s());a.sync(s(),s('failed',1));
 assert.deepEqual(calls,[true,false,true,true]);
});
test('attention is instance-local and never mutates error state; errors in notification are contained',async()=>{
 const callsA=[],callsB=[],a=new ErrorAttention(x=>{callsA.push(x);return Promise.resolve();}),b=new ErrorAttention(x=>{callsB.push(x);return Promise.resolve();});
 const failed=s('failed',3),original=structuredClone(failed);a.error();b.focus();a.focus();assert.deepEqual(failed,original);assert.deepEqual(callsA,[true,false]);assert.deepEqual(callsB,[false]);
 new ErrorAttention(()=>Promise.reject(Error('fixture unavailable'))).error();await new Promise(r=>setTimeout(r,0));
 assert.equal(newSyncError(s('stopping'),s('stopped')),false);assert.equal(newSyncError(s(),{...s(),syncPhase:'error'}),true);
});
