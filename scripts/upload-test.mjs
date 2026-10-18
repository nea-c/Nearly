import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const output=path.resolve('test-results/upload-'+Date.now());let raced=false;
const fixture=await createFixture(output,{beforeOpen(p){
 if(p==='/race/one.txt'&&!raced){raced=true;fs.writeFileSync(path.join(fixture.remote,'race/one.txt'),'race sentinel');}
},beforeWrite(p,offset){
 if(p==='/partial/large.bin'&&offset>=32768)return 4;
 if(p==='/cancel/large.bin'){fs.writeFileSync(path.join(output,'cancel-observed'),'generated');return new Promise(resolve=>setTimeout(()=>resolve(4),500));}
}});
fs.symlinkSync(path.join(fixture.remote,'other'),path.join(fixture.remote,'link-parent'),'junction');
fs.mkdirSync(path.join(output,'junction-target'));fs.writeFileSync(path.join(output,'junction-target/sentinel.txt'),'junction sentinel');fs.symlinkSync(path.join(output,'junction-target'),path.join(output,'junction-source'),'junction');
const manifest=path.join(output,'generated-fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,root:output,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
try{const child=spawn('cargo',['test','--offline','--locked','--manifest-path','src-tauri/Cargo.toml','--target-dir',process.env.CARGO_TARGET_DIR||path.resolve('src-tauri/target'),'upload_generated_localhost','--','--ignored','--nocapture','--test-threads=1'],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,NEARLY_UPLOAD_FIXTURE:manifest}});const log=fs.createWriteStream(path.join(output,'native.log'));for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{process.stdout.write(data);log.write(data);});const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});log.end();if(fixture.requestPaths.some(e=>['REMOVE','RMDIR','RENAME'].includes(e.operation)))throw Error('One-shot upload must never remove or rename remote paths');fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({code,requests:fixture.requestCounts,paths:fixture.requestPaths},null,2));process.exitCode=code??1;console.log('Generated upload results:',output);}finally{await fixture.close();}
