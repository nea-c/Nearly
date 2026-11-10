import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const results=[];
for(const mode of (process.env.NEARLY_COPY_MODES??'pipeline,server-copy,unsupported,short-read,server-failed,incomplete-attrs').split(',')){
 const out=fixtureDirectory('remote-copy-'+mode), pending=new Set();let peak=0;
 const fixture=await createFixture(out,{
  mapReadDir:mode==='incomplete-attrs'?(_p,entries)=>entries.map(entry=>{const attrs={...entry.attrs};delete attrs.mtime;return {...entry,attrs};}):undefined,
  copyData:['server-copy','unsupported','server-failed'].includes(mode),beforeCopyData:mode==='server-failed'?()=>4:undefined,rejectCopyData:mode==='unsupported',maxReadLength:mode==='short-read'?4093:65536,responseDelayMs:15,
  observeRequest(op,id,connection){if(op==='READ'){pending.add(connection+':'+id);peak=Math.max(peak,pending.size);}},
  observeResponse(data,connection){if(data.length>=9)pending.delete(connection+':'+data.readUInt32BE(5));},
 });
 const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode:mode==='server-failed'?'write-failed':mode==='incomplete-attrs'?'mixed-copy':'copy',fileBytes:Number(process.env.NEARLY_COPY_FILE_BYTES??131072),baseline:false,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
 try{
  assert.equal(await runFixtureTest('remote_selection_fixture',{NEARLY_OPERATION_FIXTURE:manifest},out),0);
  const measurement={mode,peakReads:peak,...JSON.parse(fs.readFileSync(path.join(out,'timing.json'))),requests:fixture.requestCounts};measurement.mode=mode;fs.writeFileSync(path.join(out,'measurement.json'),JSON.stringify(measurement,null,2));console.log('COPY_MEASUREMENT',JSON.stringify(measurement));
  if(mode==='server-failed'){assert.equal(fixture.requestCounts.READ??0,0);assert.equal(fixture.requestCounts.WRITE??0,0);assert.equal(fixture.requestCounts.EXTENDED,4);}
  else if(mode==='server-copy'){assert.equal(fixture.requestCounts.READ??0,0);assert.equal(fixture.requestCounts.WRITE??0,0);assert.ok(fixture.requestCounts.EXTENDED>=5);}
  else {if(mode==='unsupported')assert.ok(fixture.requestCounts.EXTENDED>=1&&fixture.requestCounts.EXTENDED<=4,'cache unsupported extension after admitted concurrent probes');assert.ok(peak>1,'READ requests must overlap rather than serialize');assert.ok(peak<=32,'bounded aggregate READ window');}
  const result={mode,peakReads:peak,...JSON.parse(fs.readFileSync(path.join(out,'timing.json'))),requests:fixture.requestCounts};result.mode=mode;results.push(result);console.log(JSON.stringify(result));
 }finally{await fixture.close();}
}
fs.writeFileSync('test-results/remote-copy-pipeline-results.json',JSON.stringify(results,null,2));
