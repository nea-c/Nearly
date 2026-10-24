// Generated loopback only. No normal Nearly application or saved configuration.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
for(const mode of ['create','slash-root','missing-root','missing-ancestor','escape','symlink','file','swap','permission','local-change','cancel']){
 const output=fixtureDirectory('empty-safe-'+mode),seen=new Map();
 const f=await createFixture(output,{beforeStat(op,p){
  const count=(seen.get(p)||0)+1;seen.set(p,count);
  if(mode==='permission'&&p==='/upload/safe/root/deep/leaf'&&count>=3)return 3;
 },mapStat(p,a){
  if(mode==='symlink'&&p==='/upload/safe/root/link')return {...a,mode:0o120777};
  if(mode==='swap'&&p==='/upload/safe/root/deep/leaf'&&seen.get(p)>=3)return {...a,mode:0o120777};
  return a;
 }});
 const manifest=path.join(output,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
 try {
  const code=await runFixtureTest('empty_remote_directory_creation_safety',{NEARLY_EMPTY_FIXTURE:manifest},output);assert.equal(code,0,mode);
  const mutations=f.requestPaths.filter(e=>['MKDIR','REMOVE','RMDIR','RENAME','OPEN','WRITE','EXTENDED'].includes(e.operation));
  // Fixed two-call microcase, unlike the worker's nondeterministic queue order:
  // create then confirm /upload/safe/root/deep/leaf. The former separate root
  // walk plus target prelookup cost another 5 LSTATs per call (36 rather than26).
  if(mode==='create')assert.deepEqual(f.requestCounts,{LSTAT:26,MKDIR:2,REALPATH:2},'one full creation walk and one final guard per call');
  if(['missing-root','missing-ancestor','escape','symlink','file','cancel'].includes(mode))assert.equal(mutations.length,0,'unsafe/cancel must not mutate: '+mode);
  else assert.ok(mutations.every(e=>e.operation==='MKDIR'&&(mode==='slash-root'?e.path==='/generated-root-child':e.path.startsWith('/upload/safe/root/deep'))),'only in-root directory creation permitted');
  fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify({counts:f.requestCounts,requests:f.requestPaths},null,2));console.log('EMPTY_SAFETY_PASS',mode,output);
 }finally{await f.close();}
}
for(const mode of ['late','swap','incomplete','opaque','unknown','permission','cancel','save','save-during','reconnect','excluded','replace-dir','rename-after']){
 const output=fixtureDirectory('absence-'+mode);let injected=false,edited=false,deniedAt,disconnected=false,resumed=false;
 const rootPath=`/upload/${mode}`;let f;
 f=await createFixture(output,{
  beforeReadDir(p){
   if(p!==path.join(f.remote,'upload',mode))return;
   if(mode==='incomplete')return 3;
   if(injected)return;injected=true;
   if(mode==='late') {const file=path.join(p,'a.txt');fs.writeFileSync(file,Buffer.alloc(128,65));fs.utimesSync(file,1700000000,1700000000);}
   if(mode==='swap') {fs.writeFileSync(path.join(f.remote,'other/sentinel'),'untouched');fs.symlinkSync(path.join(f.remote,'other'),path.join(p,'parent'),'junction');}
  },
  mapReadDir(p,names){
   if(p===path.join(f.remote,'upload',mode)&&mode==='opaque')names.push({filename:'bad:stream',longname:'',attrs:{mode:0o100644,size:1,mtime:1700000000}});
   if(p===path.join(f.remote,'upload',mode)&&mode==='unknown')for(const n of names)if(n.filename==='a.txt')n.attrs={mode:0o100644};
   return names;
  },
  beforeStat(op,p){if(['opaque','unknown','permission'].includes(mode)&&p===`${rootPath}/a.txt`){deniedAt??=f.requestPaths.length;return 3;}},
  beforeWrite(p){if(mode==='save-during'&&!edited){edited=true;const file=path.join(output,'local/a.txt');fs.writeFileSync(file,Buffer.alloc(65536,66));fs.utimesSync(file,1700000010,1700000010);}},
 });
 const manifest=path.join(output,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
 const timer=setInterval(()=>{
  if(mode==='reconnect'&&!disconnected&&fs.existsSync(path.join(output,'disconnect-now'))){disconnected=true;f.disconnect();}
  if(disconnected&&!resumed&&f.connectionCount===0){resumed=true;const file=path.join(f.remote,'upload',mode,'a.txt');fs.writeFileSync(file,Buffer.alloc(128,65));fs.utimesSync(file,1700000000,1700000000);f.resume();fs.writeFileSync(path.join(output,'reconnected-ready'),'generated');}
 },5);
 try{
  const code=await runFixtureTest('empty_remote_absence_contracts',{NEARLY_EMPTY_FIXTURE:manifest},output);assert.equal(code,0,mode);
  const mutations=f.requestPaths.filter(e=>['OPEN','WRITE','MKDIR','REMOVE','RMDIR','RENAME','EXTENDED'].includes(e.operation));
  if(['incomplete','opaque','unknown','permission','cancel','reconnect'].includes(mode))assert.equal(mutations.length,0,'no mutation after incomplete/unsafe/cancel/reconnect candidate invalidation');
  if(mode==='swap'){assert.equal(fs.readFileSync(path.join(f.remote,'other/sentinel'),'utf8'),'untouched');assert.equal(mutations.filter(e=>e.path.startsWith(`${rootPath}/parent/`)).length,0);}
  if(deniedAt!==undefined)assert.equal(f.requestPaths.slice(deniedAt).filter(e=>['OPEN','WRITE','MKDIR','REMOVE','RMDIR','RENAME','EXTENDED'].includes(e.operation)).length,0,'error must stop subsequent mutation');
  if(mode==='reconnect')assert.ok(f.totalConnections>=2);
  fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify({counts:f.requestCounts,requests:f.requestPaths},null,2));console.log('ABSENCE_CONTRACT_PASS',mode,output);
 }finally{clearInterval(timer);await f.close();}
}
