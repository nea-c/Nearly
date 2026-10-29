// Generated loopback and temporary files only; no user settings or application process.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createFixture} from './sftp-fixture.mjs';import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const evidence=[];
const modes=['roundtrip','conflict','later-conflict','write-failed','cancel-before','cancel-mid','concurrent','disconnect-before','disconnect-mid','no-posix','symlink','large','binary','sync-conflict','local-sync','remote-resume','fork-origin-close','origin-lifecycle','destroy-mid'];
for(const mode of modes.filter(mode=>!process.env.NEARLY_EDITOR_MODES||process.env.NEARLY_EDITOR_MODES.split(',').includes(mode))){
 const out=fixtureDirectory('text-editor-'+mode);let f,changed=false;
 f=await createFixture(out,{posixRename:mode!=='no-posix',mapStat(p,a){return mode==='symlink'&&p==='/docs/file.txt'?{...a,mode:0o120777}:a;},async beforeWrite(p,offset){
  if(!p.includes('.nearly-edit-'))return;
  if(mode==='write-failed')return 4;
  if(mode==='later-conflict'&&!changed){changed=true;const file=path.join(f.remote,'docs/file.txt');fs.writeFileSync(file,Buffer.from('\ufeffexternal\r\n'));fs.utimesSync(file,1700000000,1700000000);}
  if(mode==='disconnect-mid'){f.disconnect();return 4;}
  if((mode==='concurrent'&&offset===0)||((mode==='cancel-mid'||mode==='destroy-mid')&&offset===32768)){fs.writeFileSync(path.join(out,'write-held'),'generated');const start=Date.now();while(!fs.existsSync(path.join(out,'release-write'))){assert.ok(Date.now()-start<20000);await new Promise(r=>setTimeout(r,3));}if(mode==='cancel-mid'||mode==='destroy-mid'){await new Promise(r=>setTimeout(r,100));return 4;}}
 }});
 const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
 try{const code=await runFixtureTest('text_editor_generated_localhost',{NEARLY_EDITOR_FIXTURE:manifest},out);assert.equal(code,0,mode);const row={mode,passed:true,connections:f.totalConnections,requests:f.requestCounts,stagingFiles:fs.readdirSync(path.join(f.remote,'docs')).filter(n=>n.startsWith('.nearly-edit-'))};evidence.push(row);if(!['roundtrip','concurrent','sync-conflict','local-sync','remote-resume','origin-lifecycle'].includes(mode))assert.equal(f.requestPaths.filter(r=>r.operation==='EXTENDED').length,0,'failed/refused save must not publish');fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(row,null,2));}
 finally{await f.close();}
}
if(process.env.NEARLY_EDITOR_RESULTS)fs.writeFileSync(process.env.NEARLY_EDITOR_RESULTS,JSON.stringify(evidence,null,2));console.log('TEXT_EDITOR_FIXTURE_PASS',evidence.length);
