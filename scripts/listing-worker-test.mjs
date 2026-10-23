import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';import path from 'node:path';import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const output=fixtureDirectory('listing-worker');
let fixture;let changed=false;
fixture=await createFixture(output,{async beforeStat(op,p){
 const staged=p.match(/^\/listing-staged-(save|error|cancel)\/(a|b)\.txt$/);
 if(staged){const mode=staged[1],name=`listing-staged-${mode}`,marker=path.join(output,`${name}-batch-entered`);if(!fs.existsSync(marker)){fs.writeFileSync(marker,"generated");if(mode==="save"){const peer=path.join(output,name,"deep/peer.txt");fs.writeFileSync(peer,"save");fs.utimesSync(peer,1700000000.5,1700000000.5);}}if(mode==="error")return 3;if(mode==="cancel")await new Promise(resolve=>setTimeout(resolve,200));}

 if(p==='/listing-batch/deep/b.txt'&&!changed){changed=true;fs.writeFileSync(path.join(fixture.remote,'listing-batch/deep/b.txt'),'remote changed after listing');}
},mapStat(p,a){
 if(p==='/listing-fixed-directory/parent'&&fs.existsSync(path.join(output,'basis-mode-b'))){fs.writeFileSync(path.join(output,'basis-read-b'),'generated');return {...a,mode:0o40700};}
 return a;
}});
const manifest=path.join(output,'fixture.json');
fs.writeFileSync(manifest,JSON.stringify({root:output,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
let disconnected=false,resumed=false;
const control=setInterval(()=>{
 if(!disconnected&&fs.existsSync(path.join(output,'reconnect-now'))){disconnected=true;fixture.disconnect();}
 if(disconnected&&!resumed&&fixture.connectionCount===0){resumed=true;fixture.resume();fs.writeFileSync(path.join(output,'reconnect-closed'),'generated');}
},10);
try {
 process.exitCode=await runFixtureTest('listing_worker_', {NEARLY_PIPELINE_FIXTURE:manifest,NEARLY_LISTING_TEST_ROOT:output},output);
 for(const name of ['listing-staged-error','listing-staged-cancel']) {assert.equal(fixture.requestPaths.filter(e=>e.path.startsWith('/'+name+'/')&&['OPEN','MKDIR','REMOVE','RMDIR','RENAME','EXTENDED'].includes(e.operation)).length,0,'failed/cancelled fresh batch must not dispatch mutations: '+name);}
 fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(fixture.requestPaths,null,2));console.log('LISTING_RESULTS',output);
} finally {clearInterval(control);await fixture.close();}
