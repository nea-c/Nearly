// Generated localhost-only move benchmark. Never uses a saved profile or real server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const results=[];
for (const [mode,baseline] of [['move',true],['move',false],['collision',false],['target-race',false],['rename-failure',false],['symlink',false],['cancel',false]]) {
 const output=fixtureDirectory('remote-move-'+mode+'-'+baseline);
 const fixture=await createFixture(output,{
  responseDelayMs:5,
  mapStat(p,a){return mode==='symlink' && p==='/bench/source1'?{...a,mode:0o120777}:a;},
  beforeRename(source,target,overwrite){assert.equal(overwrite,false,'Use standard non-replacing RENAME only');if(mode==='target-race'&&source==='/bench/source1')fs.writeFileSync(path.join(output,'remote/bench/target1'),'sentinel');if(mode==='rename-failure' && source==='/bench/source1')throw Error('generated rename rejection');},
  async beforeStat(_op,p){
   if(mode!=='cancel'||p!=='/bench/source1')return;
   fs.writeFileSync(path.join(output,'mutation-held'),'generated');const start=Date.now();
   while(!fs.existsSync(path.join(output,'mutation-release'))){assert.ok(Date.now()-start<20000);await new Promise(resolve=>setTimeout(resolve,5));}
  }
 });
 try {
  const manifest=path.join(output,'fixture.json');
  fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,baseline,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
  assert.equal(await runFixtureTest('remote_operation_tests::remote_move_fixture',{NEARLY_MOVE_FIXTURE:manifest},output),0,mode);
  assert.equal(fixture.requestCounts.READDIR??0,0,'Rename must not enumerate descendants');
  assert.equal(fixture.requestCounts.OPEN??0,0,'Rename must not open file contents');
  assert.equal(fixture.totalConnections,baseline?5:1);
  const result={...JSON.parse(fs.readFileSync(path.join(output,'timing.json'),'utf8')),connections:fixture.totalConnections,requests:fixture.requestCounts};
  results.push(result); console.log(JSON.stringify(result));
 } finally { await fixture.close(); }
}
fs.writeFileSync('test-results/remote-move-comparison.json',JSON.stringify(results,null,2));