// Disposable loopback SFTP fixture for Rust worker tests; never reads account data.
import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
const [output,mode,local]=process.argv.slice(2);
let modified=false,committed=false;
const fixture=await createFixture(output,{
 async beforeWrite(target){
  if(mode==='change'&&!modified&&target.startsWith('/upload/job/')){
   modified=true;fs.writeFileSync(path.join(local,'a.txt'),Buffer.alloc(1024*1024,66));
   const time=new Date(Date.now()+5000);fs.utimesSync(path.join(local,'a.txt'),time,time);
  }
 },
 beforeRename(source,target){
  if(target==='/upload/job/a.txt'){
   committed=true;
   if(mode==='uncertain'){
    fs.renameSync(path.join(fixture.remote,source),path.join(fixture.remote,target));
    throw Object.assign(Error('synthetic lost acknowledgement'),{code:'EACCES'});
   }
  }
 },
 beforeStat(_op,target){if(mode==='committed'&&committed&&target==='/upload/job/a.txt')return 3;},
});
fs.mkdirSync(path.join(fixture.remote,'upload/job/later'),{recursive:true});
fs.writeFileSync(path.join(fixture.remote,'upload/job/later/delete.txt'),'keep if first upload fails');
console.log(JSON.stringify({remote:fixture.remote,port:fixture.port,keyFile:fixture.ppk3,hostKey:fixture.fingerprint,passphrase:fixture.passphrase}));
process.stdin.resume();
process.stdin.on('end',()=>fixture.close().then(()=>process.exit(0)));
