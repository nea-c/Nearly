import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const output=path.resolve('test-results/listing-worker-'+Date.now());
let fixture;let changed=false;
fixture=await createFixture(output,{beforeStat(op,p){
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
 const child=spawn('cargo',['test','--offline','--locked','--manifest-path','src-tauri/Cargo.toml','listing_worker_','--','--ignored','--nocapture','--test-threads=1'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NEARLY_PIPELINE_FIXTURE:manifest,NEARLY_LISTING_TEST_ROOT:output}});
 for(const s of [child.stdout,child.stderr])s.on('data',d=>process.stdout.write(d));
 process.exitCode=await new Promise((r,j)=>{child.on('exit',r);child.on('error',j)});
 fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(fixture.requestPaths,null,2));console.log('LISTING_RESULTS',output);
} finally {clearInterval(control);await fixture.close();}
