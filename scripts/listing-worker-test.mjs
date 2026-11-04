import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';import path from 'node:path';import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const output=fixtureDirectory('listing-worker');
let fixture;const reads=new Map(),captured=new Set();
fixture=await createFixture(output,{
 async beforeReadDir(p){
  const name=p&&path.basename(p),count=(reads.get(p)||0)+1;reads.set(p,count);
  if(name?.startsWith('listing-')&&count>=3)fs.writeFileSync(path.join(output,`rescan-${name}`),'generated observed later inventory');
  // Actual remote inventory barrier, after the initial local checklist.
  if(name&&/^listing-(hint-|prebaseline)/.test(name)&&!captured.has(name)){
   captured.add(name);fs.writeFileSync(path.join(output,`capture-${name}`),'generated inventory barrier');
   const end=Date.now()+10000;while(!fs.existsSync(path.join(output,`continue-${name}`))){if(Date.now()>end)throw Error('generated inventory barrier timeout');await new Promise(r=>setTimeout(r,2));}
  }
  const staged=name?.match(/^listing-staged-(save|error|cancel)$/);
  if(staged&&count===1){
   const mode=staged[1];fs.writeFileSync(path.join(output,`${name}-batch-entered`),'generated real inventory boundary');
   if(mode==='save'){const peer=path.join(output,name,'deep/peer.txt');fs.writeFileSync(peer,'saved peer during inventory');fs.utimesSync(peer,1700000040,1700000040);}
   if(mode==='error')return 3;
   if(mode==='cancel'){await new Promise(r=>setTimeout(r,2000));return 4;}
  }
 },
 mapReadDir(p,names){
  if(p===path.join(fixture.remote,'listing-fixed-directory')&&fs.existsSync(path.join(output,'basis-mode-b'))){for(const entry of names)if(entry.filename==='parent'){entry.attrs.mode=0o40700;fs.writeFileSync(path.join(output,'basis-read-b'),'generated fresh directory attributes');}}
  return names;
 },
 mapStat(p,a){if(p==='/listing-fixed-directory/parent'&&fs.existsSync(path.join(output,'basis-mode-b'))){fs.writeFileSync(path.join(output,'basis-read-b'),'generated fresh scope attributes');return {...a,mode:0o40700};}return a;}
});
const manifest=path.join(output,'fixture.json');
fs.writeFileSync(manifest,JSON.stringify({root:output,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
let disconnected=false,resumed=false;
const control=setInterval(()=>{
 if(!disconnected&&fs.existsSync(path.join(output,'reconnect-now'))){disconnected=true;fixture.disconnect();}
 if(disconnected&&!resumed&&fixture.connectionCount===0){resumed=true;fixture.resume();fs.writeFileSync(path.join(output,'reconnect-closed'),'generated');}
},10);
try{
 process.exitCode=await runFixtureTest('listing_worker_', {NEARLY_PIPELINE_FIXTURE:manifest,NEARLY_LISTING_TEST_ROOT:output},output);
 for(const name of ['listing-staged-error','listing-staged-cancel'])assert.equal(fixture.requestPaths.filter(e=>e.path.startsWith('/'+name+'/')&&['OPEN','MKDIR','REMOVE','RMDIR','RENAME','EXTENDED'].includes(e.operation)).length,0,'failed/cancelled inventory must not dispatch mutations: '+name);
 fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(fixture.requestPaths,null,2));console.log('LISTING_RESULTS',output);
}finally{clearInterval(control);await fixture.close();}
