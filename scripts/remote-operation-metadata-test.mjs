import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const results=[];
for(const mode of ['copy','move','shared-ancestor-once']){
 const out=fixtureDirectory('remote-metadata-'+mode);
 let copied=false;
 const fixture=await createFixture(out,{beforeWrite(){copied=true;},mapStat(p,a){return mode==='shared-ancestor-once'&&copied&&p==='/bench'?{...a,mode:0o120777}:a;}});
 try {
  const manifest=path.join(out,'fixture.json');
  fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode:mode==='shared-ancestor-once'?'copy':mode,baseline:false,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
  const move=mode==='move';
  assert.equal(await runFixtureTest('remote_operation_tests::'+(move?'remote_move_fixture':'remote_selection_fixture'),{[move?'NEARLY_MOVE_FIXTURE':'NEARLY_OPERATION_FIXTURE']:manifest},out),0);
  assert.equal(fixture.requestCounts.LSTAT,7,'One shared ancestor walk plus one metadata read per selected root');
  for(const parent of ['/','/bench'])assert.equal(fixture.requestPaths.filter(p=>p.operation==='LSTAT'&&p.path===parent).length,1,'Shared parent '+parent+' validated once per selection');
  assert.equal(fixture.totalConnections,1);
  results.push({mode,requests:fixture.requestCounts});
 } finally {await fixture.close();}
}
console.log(JSON.stringify(results));
for(const mode of ['standalone','separate-parents','source-ancestor','target-ancestor','ancestor-between','no-post-copy-probe','target-race']){
 const out=fixtureDirectory('remote-metadata-'+mode);let firstCopied=false, sourceReads=0;
 const fixture=await createFixture(out,{
  mapStat(p,a){
   if(mode==='source-ancestor'&&p==='/bench' || mode==='ancestor-between'&&firstCopied&&p==='/bench')return {...a,mode:0o120777};
   if(mode==='target-ancestor'&&p==='/other')return {...a,mode:0o100644};
   if(mode==='no-post-copy-probe'&&p==='/bench/source0'&&++sourceReads===2)return {...a,mode:0o040755};
   return a;
  },
  beforeWrite(p){if(p==='/bench/copy0')firstCopied=true;},
  beforeOpen(p,flags){if(mode==='target-race'&&p==='/bench/copy0'&&(flags&2))fs.writeFileSync(path.join(out,'remote/bench/copy0'),'race sentinel');},
 });
 try {
  const manifest=path.join(out,'fixture.json');
  fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
  assert.equal(await runFixtureTest('remote_operation_tests::remote_metadata_validation_fixture',{NEARLY_METADATA_FIXTURE:manifest},out),0,mode);
  if(mode==='standalone'||mode==='separate-parents')assert.equal(fixture.requestCounts.LSTAT,mode==='standalone'?6:8);
  if(mode==='ancestor-between')assert.equal(fixture.requestPaths.filter(p=>p.operation==='LSTAT'&&p.path==='/bench').length,2);
  if(mode==='source-ancestor'||mode==='target-ancestor')assert.equal(fixture.requestCounts.OPEN??0,0);
  if(mode==='no-post-copy-probe')assert.equal(sourceReads,1,'No extra source metadata read after a successful copy');
  results.push({mode,requests:fixture.requestCounts});
 } finally {await fixture.close();}
}
fs.writeFileSync(process.env.NEARLY_METADATA_RESULTS??'test-results/remote-operation-metadata-results.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
