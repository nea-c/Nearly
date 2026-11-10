import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';

for(const mode of (process.env.NEARLY_CLOSE_MODES??'overlap,source-failed,target-failed,both-failed').split(',')){
 const out=fixtureDirectory('remote-copy-close-'+mode);
 const pending=new Map(),responses=new Set(),closed=[];let peak=0;
 const fixture=await createFixture(out,{
  responseDelayMs:15,
  async beforeClose(target){
   closed.push(target);
   // Fail one acknowledgement immediately while the other remains outstanding.
   const fail=mode==='both-failed'||mode==='source-failed'&&target==='/bench/source0'||mode==='target-failed'&&target==='/bench/copy0';
   if(!fail && mode!=='overlap')await new Promise(resolve=>setTimeout(resolve,200));
   return fail?4:undefined;
  },
  observeRequest(op,id,connection){if(op==='CLOSE'){pending.set(connection+':'+id,true);peak=Math.max(peak,pending.size);}},
  observeResponse(data,connection){if(data.length>=9){const key=connection+':'+data.readUInt32BE(5);if(pending.delete(key))responses.add(key);}},
 });
 const manifest=path.join(out,'fixture.json');
 fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode:mode==='overlap'?'copy':'close-failed',fileBytes:1024,baseline:false,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
 try{
  assert.equal(await runFixtureTest('remote_selection_fixture',{NEARLY_OPERATION_FIXTURE:manifest},out),0);
  assert.ok(peak>=2&&peak<=8,'bounded source and target CLOSE acknowledgements overlap');
  assert.equal(pending.size,0,'all CLOSE acknowledgements must settle before completion');
  const expected=mode==='overlap'?10:8;
  assert.equal(closed.length,expected,'no retry or later selected copy after CLOSE failure');
  assert.equal(responses.size,expected,'both source and target CLOSE replies required');
  assert.equal(fixture.requestCounts.OPEN,expected,'no mutation retry');
  console.log('CLOSE_RESULT',JSON.stringify({mode,peak,closed,responses:responses.size}));
 }finally{await fixture.close();}
}
