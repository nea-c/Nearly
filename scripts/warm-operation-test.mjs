// Generated loopback fixtures only. No saved profiles, app launch or real endpoints.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const measurements=[];
const modes=process.env.NEARLY_WARM_MODES?.split(',')??['baseline','healthy','identity','ancestor','partial','cancel','disconnect','stale','uncertain'];
for(const mode of modes){
 assert.ok(['baseline','healthy','identity','ancestor','partial','cancel','disconnect','stale','uncertain'].includes(mode));
 const out=fixtureDirectory('warm-operation-'+mode);
 const snapshots={};let fixture,second,ancestorBlocked=false,renames=0,watchError;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 fixture=await createFixture(out,{
  responseDelayMs:2,
  mapStat(p,a){return ancestorBlocked&&p==='/bench'?{...a,mode:0o120777}:a;},
  async beforeWrite(p){
   if(['cancel','disconnect'].includes(mode)&&p==='/bench/cancelled'){
    fs.writeFileSync(path.join(out,'mutation-held'),'generated');const start=Date.now();
    while(!fs.existsSync(path.join(out,'mutation-release'))){assert.ok(Date.now()-start<25000);await sleep(5);}
    await sleep(100);return 4;
   }
  },
  beforeRename(a,b){
   if(mode==='uncertain'&&b==='/bench/uncertain'){
    renames++;
    assert.equal(a,'/bench/source1');
    fs.renameSync(path.join(fixture.remote,'bench/source1'),path.join(fixture.remote,'bench/uncertain'));
    fixture.disconnect();
    throw Error('Generated committed rename with lost acknowledgement');
   }
  }
 });
 const config=f=>({remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint});
 if(mode==='identity')second=await createFixture(path.join(out,'second'));
 const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,...config(fixture),...(second?{second:config(second)}:{})}));
 const seen=new Set();let polling=false;
 const timer=setInterval(async()=>{
  if(polling||watchError)return;polling=true;
  try{
   for(const stage of ['connected','cold','warm','failed','disconnect-idle','finished']){
    if(seen.has(stage)||!fs.existsSync(path.join(out,stage+'.ready')))continue;
    seen.add(stage);snapshots[stage]={connections:fixture.totalConnections,requests:fixture.requestCounts,paths:fixture.requestPaths};
    if(stage==='warm'&&mode==='ancestor')ancestorBlocked=true;
    if(stage==='failed'){ancestorBlocked=false;fixture.resume();await sleep(100);}
    if(stage==='disconnect-idle'){fixture.disconnect();await sleep(250);fixture.resume();await sleep(250);}
    fs.writeFileSync(path.join(out,stage+'.ack'),'generated');
   }
  }catch(error){watchError=error;}finally{polling=false;}
 },5);
 try{
  const code=await runFixtureTest('warm_operation_tests::warm_operation_fixture',{NEARLY_WARM_FIXTURE:manifest},out);
  if(watchError)throw watchError;
  assert.equal(code,0,mode);
  assert.equal(snapshots.connected.connections,1,'browse startup does not eagerly open operation transport');
  assert.equal(snapshots.cold.connections,2,'first mutation opens separate transport');
  assert.equal(snapshots.warm.connections,mode==='baseline'?3:2,'later mutation retains healthy transport');
  const expected={baseline:10,healthy:2,identity:2,ancestor:3,partial:3,cancel:3,disconnect:4,stale:3,uncertain:3}[mode];
  assert.equal(fixture.totalConnections,expected,mode+' exact total connections');
  if(second)assert.equal(second.totalConnections,2,'equal profile IDs do not share endpoints');
  if(mode==='uncertain'){assert.equal(renames,1,'uncertain mutation is never replayed');assert.equal(fixture.requestCounts.RENAME,1);}
  if(mode==='ancestor'){
   const old=snapshots.warm.paths.filter(x=>x.operation==='LSTAT'&&x.path==='/bench').length;
   const fresh=snapshots.failed.paths.filter(x=>x.operation==='LSTAT'&&x.path==='/bench').length;
   assert.equal(fresh,old+1,'reused operation revalidates ancestor');
  }
  const timing=JSON.parse(fs.readFileSync(path.join(out,'timing.json'),'utf8'));
  const data={...timing,coldFirstCopyMicroseconds:timing.operationMicroseconds[0],subsequentIdenticalCopyMicroseconds:timing.operationMicroseconds[1],connections:fixture.totalConnections,requests:fixture.requestCounts,secondConnections:second?.totalConnections,snapshots};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(data,null,2));measurements.push(data);
 }finally{clearInterval(timer);await fixture.close();if(second)await second.close();}
}
const output=process.env.NEARLY_WARM_RESULTS??'test-results/warm-operation-comparison.json';
assert.ok(path.resolve(output).startsWith(path.resolve('test-results')+path.sep));
fs.writeFileSync(output,JSON.stringify(measurements,null,2));console.log('WARM_OPERATION_RESULTS',output);
