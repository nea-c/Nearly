// Generated loopback fixture only. No saved settings, Nearly process or real remote endpoint.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const measurements=[];
for(const [mode,baseline] of [['copy',true],['copy',false],['delete',true],['delete',false],['collision',false],['cancel',false],['overlap',false],['symlink',false],['changed',false],['write-failed',false],['cancel-during',false],['disconnect',false],['cancel-delete',false],['mixed-copy',false],['mixed-delete',false]]){
 const out=fixtureDirectory('remote-operation-'+mode+'-'+baseline);let f;
 f=await createFixture(out,{async beforeStat(_op,p){if(mode==='cancel-delete'&&p==='/bench/source1'){fs.writeFileSync(path.join(out,'mutation-held'),'generated');const start=Date.now();while(!fs.existsSync(path.join(out,'mutation-release'))){assert.ok(Date.now()-start<20000);await new Promise(r=>setTimeout(r,5));}await new Promise(r=>setTimeout(r,100));return 4;}},mapStat(p,a){return mode==='symlink'&&p==='/bench/source1'?{...a,mode:0o120777}:a;},async beforeWrite(p){if(mode==='write-failed')return 4;if(mode==='changed'&&p==='/bench/copy0')fs.writeFileSync(path.join(f.remote,'bench/source0'),'concurrent generated change');
  if(['cancel-during','disconnect'].includes(mode)&&p==='/bench/copy1'){
   fs.writeFileSync(path.join(out,'mutation-held'),'generated');const start=Date.now();while(!fs.existsSync(path.join(out,'mutation-release'))){assert.ok(Date.now()-start<20000);await new Promise(r=>setTimeout(r,5));}
   if(mode==='disconnect')f.disconnect();else await new Promise(r=>setTimeout(r,100));return 4;
  }
 }});
 const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,baseline,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
 try{const code=await runFixtureTest('remote_selection_fixture',{NEARLY_OPERATION_FIXTURE:manifest},out);assert.equal(code,0,mode);
  const data={...JSON.parse(fs.readFileSync(path.join(out,'timing.json'),'utf8')),connections:f.totalConnections,requests:f.requestCounts};
  if(['copy','delete'].includes(mode))assert.equal(f.totalConnections,baseline?5:1);
  if(mode==='copy')assert.equal(f.requestCounts.LSTAT,baseline?75:60);
  if(['cancel','overlap'].includes(mode))assert.equal(f.totalConnections,0);
  measurements.push(data);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(data,null,2));
 }finally{await f.close();}
}
const output=process.env.NEARLY_OPERATION_RESULTS??'test-results/remote-operation-comparison.json';fs.writeFileSync(output,JSON.stringify(measurements,null,2));console.log('REMOTE_OPERATION_RESULTS',output);
