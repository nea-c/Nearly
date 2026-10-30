// Generated localhost profiling only. No system networking changes or user endpoints.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';

const mode=process.argv[2]??'smoke';assert.ok(['smoke','bulk'].includes(mode));
const delays=(process.argv[3]??'0,10').split(',').map(Number);
assert.ok(delays.length<=2&&delays.every(n=>[0,10].includes(n)));
const filter=mode==='bulk'?'sync_bulk_performance_generated':'sync_performance_generated';
const results=[];
for(const delay of delays){
 const out=fixtureDirectory('sync-roundtrip-'+mode+'-'+delay),transactions=[],pending=new Map(),issues=[];
 let active=0,maxActive=0,versionReplies=0;
 const f=await createFixture(out,{
  responseDelayMs:delay,
  observeRequest(operation,id,connection,p){
   if(transactions.length>=200000){issues.push('transaction bound');return;}
   const key=connection+':'+id;if(pending.has(key))issues.push('request id collision');
   const role=typeof p==='string'?(p.endsWith('.txt')?'file':p.endsWith('.part')?'stage':'ancestor'):'handle';
   const record={operation,role,start:Date.now(),end:null};transactions.push(record);pending.set(key,record);active++;maxActive=Math.max(active,maxActive);
  },
  observeResponse(data,connection){
   if(data.length<9||data.readUInt32BE(0)+4!==data.length){issues.push('non-frame response');return;}
   if(data[4]===2){versionReplies++;return;}
   const key=connection+':'+data.readUInt32BE(5),record=pending.get(key);
   if(!record){issues.push('unmatched reply');return;}
   pending.delete(key);active--;record.end=Date.now();
  },
 });
 const manifest=path.join(out,'fixture.json');
 fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
 try{
  assert.equal(await runFixtureTest(filter,{NEARLY_SYNC_PERF:manifest,NEARLY_SYNC_WIDTH:'4'},out),0);
  assert.ok(transactions.length>0,'profiling must observe actual SFTP requests');
  assert.ok(versionReplies>0,'profiling must include the actual VERSION response');
  assert.equal(pending.size,0,'every observed request must have a paired response');assert.deepEqual(issues,[]);
  const timing=JSON.parse(fs.readFileSync(path.join(out,'timing.json'),'utf8'));
  const phases=timing.map(phase=>{
   const rows=transactions.filter(t=>t.start>=phase.epochMs&&t.start<phase.epochMs+phase.elapsedMs),counts={},waitMs={},roleCounts={};
   for(const t of rows){counts[t.operation]=(counts[t.operation]??0)+1;waitMs[t.operation]=(waitMs[t.operation]??0)+t.end-t.start;roleCounts[t.operation+':'+t.role]=(roleCounts[t.operation+':'+t.role]??0)+1;}
   const first=rows[0],write=rows.find(t=>t.operation==='WRITE'),commits=rows.filter(t=>t.operation==='EXTENDED');
   const last=commits.length?Math.max(...commits.map(t=>t.end)):null;
   return {...phase,requests:rows.length,counts,roleCounts,responseWaitSumMs:waitMs,
    firstRequestMs:first?first.start-phase.epochMs:null,firstWriteMs:write?write.start-phase.epochMs:null,
    lastCommitReplyMs:last===null?null:last-phase.epochMs,tailAfterCommitMs:last===null?null:phase.epochMs+phase.elapsedMs-last};
  });
  if(mode==='bulk'){assert.equal(phases.find(p=>p.phase==='unchanged').counts.WRITE??0,0);assert.equal(phases.find(p=>p.phase==='unchanged').sent,0);}
  const result={mode,sourceTree:'current local tree; width4; no live endpoints',
   simulation:'hold EVERY server SFTP response (including VERSION and extensions) before SSH channel send; SSH handshake, TCP bandwidth/loss and client-to-server traffic are not delayed; not a symmetric network RTT model',
   nominalResponseHoldMs:delay,files:mode==='bulk'?4000:16,initialBytes:mode==='bulk'?4000*512:null,
   maxActive,connections:f.totalConnections,versionReplies,requests:f.requestCounts,phases};
  fs.writeFileSync(path.join(out,'profile.json'),JSON.stringify(result,null,2));results.push({out,...result});
  console.log(JSON.stringify({out,mode,delay,maxActive,phases}));
 }finally{await f.close();}
}
if(process.env.NEARLY_ROUNDTRIP_RESULT){const destination=path.resolve(process.env.NEARLY_ROUNDTRIP_RESULT);const task=path.resolve('..')+path.sep;assert.ok(destination.startsWith(task));fs.writeFileSync(destination,JSON.stringify(results,null,2));}
