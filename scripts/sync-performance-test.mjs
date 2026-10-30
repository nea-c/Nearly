// Generated data and loopback only; same phase/latency for before/after runs.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const filter=process.argv[2]??'sync_performance_generated';assert.ok(['sync_performance_generated','sync_bulk_performance_generated','sync_tcp_policy_generated'].includes(filter));
const width=Number(process.argv[3]??2);assert.ok([1,2,4,8].includes(width));
const bulk=filter==='sync_bulk_performance_generated',delay=bulk?0:20;
const out=fixtureDirectory('sync-performance'),events=[];let active=0,maxActive=0;
const phase=()=>bulk?'bulk':fs.existsSync(path.join(out,'phase'))?fs.readFileSync(path.join(out,'phase'),'utf8'):'setup';
const f=await createFixture(out,{async beforeStat(op,p){events.push({phase:phase(),operation:op,path:p,epochMs:Date.now()});active++;maxActive=Math.max(maxActive,active);if(delay)await new Promise(r=>setTimeout(r,delay));active--;},beforeReadDir(p){events.push({phase:phase(),operation:"READDIR",path:p,epochMs:Date.now()});},beforeWrite(p){events.push({phase:phase(),operation:'WRITE',path:p,epochMs:Date.now()});},beforeRename(source,target){events.push({phase:phase(),operation:'COMMIT',path:target,epochMs:Date.now()});}});
const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
function assertComparisons(timing){
 if(bulk)return;
 const t=timing.find(t=>t.case==='upload'&&t.phase==='initial');
 const initial=events.filter(e=>e.epochMs>=t.epochMs&&e.epochMs<t.epochMs+t.elapsedMs);
 for(let i=0;i<16;i++){
  const p='/upload/a/b/c/d/file'+String(i).padStart(2,'0')+'.txt';
  assert.ok(initial.filter(e=>e.operation==='LSTAT'&&e.path===p).length<=2,'Repeated comparison before upload: '+p);
 }
}
try{assert.equal(await runFixtureTest(filter,{NEARLY_SYNC_PERF:manifest,NEARLY_SYNC_WIDTH:String(width)},out),0);if(filter!=='sync_tcp_policy_generated'){const timing=JSON.parse(fs.readFileSync(path.join(out,'timing.json'),'utf8'));assertComparisons(timing);const phases=timing.map(t=>{const es=events.filter(e=>bulk?(e.epochMs>=t.epochMs&&e.epochMs<=t.epochMs+t.elapsedMs):e.phase===`${t.case}-${t.phase}`);return {...t,metadataRequests:es.filter(e=>e.operation==='LSTAT').length,listRequests:es.filter(e=>e.operation==='READDIR').length,commits:es.filter(e=>e.operation==='COMMIT').length,firstWriteMs:es.find(e=>e.operation==='WRITE')?.epochMs-t.epochMs,lastCommitMs:es.filter(e=>e.operation==='COMMIT').at(-1)?.epochMs-t.epochMs};});if(bulk){const u=phases.find(p=>p.phase==="unchanged");assert.ok(u.metadataRequests<2000,"Unchanged4000 must use bounded listing metadata");assert.equal(u.commits,0);assert.ok(u.listRequests>0);}const result={width,maxOpenFileHandles:f.maxOpenFileHandles,timing:phases,events,connections:f.totalConnections,requests:f.requestCounts,maxActive,delayPerStatMs:delay,filesPerInitial:bulk?4000:16};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));if(process.env.NEARLY_SYNC_PERF_RESULT)fs.writeFileSync(process.env.NEARLY_SYNC_PERF_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify({out,width,maxOpenFileHandles:f.maxOpenFileHandles,timing:phases,connections:result.connections,requests:result.requests,maxActive}));}}finally{await f.close();}
