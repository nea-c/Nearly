// Disposable loopback SFTP fixture for Rust worker tests; never reads account data.
import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
const [output,mode,local]=process.argv.slice(2);
let modified=false,committed=false,edits=0,inflight=0,maxInflight=0,comparisonPhase=false;const seenStages=new Set(),commits=[],replyPaths=[];
const fixture=await createFixture(output,{
 async beforeWrite(target){
  if(mode==='permission'&&target.startsWith('/upload/job/'))return 3;
  const rootStage=path.posix.dirname(target)==='/upload/job';
  const limit=mode==='change'||mode==='change-permission'||mode==='change-network'||mode==='atomic'?1:mode==='burst'?5:mode==='continuous'?1000:0;
  if(rootStage&&edits<limit&&!seenStages.has(target)){
   seenStages.add(target);edits++;modified=true;
   const source=path.join(local,'a.txt');
   if(mode==='atomic'){
    const old=fs.statSync(source),next=source+'.next';fs.writeFileSync(next,Buffer.alloc(1024*1024,66));fs.utimesSync(next,old.atime,old.mtime);
    // Ask the Rust test to perform its native atomic replacement. Node/libuv
    // MoveFileEx rejects an open destination on this Windows runtime.
    fs.writeFileSync(path.join(output,'replace-request'),'');
    const deadline=Date.now()+5000;
    while(!fs.existsSync(path.join(output,'replace-done'))){if(Date.now()>deadline)throw Error('fixture replacement timed out');await new Promise(r=>setTimeout(r,5));}
   }else{
    fs.writeFileSync(source,Buffer.alloc(1024*1024,65+edits%100));
    const time=new Date(Date.now()+5000+edits*1000);fs.utimesSync(source,time,time);
   }
  }
  if(mode==='change-permission'&&target.startsWith('/upload/job/'))return 3;
  if(mode==='change-network'&&target.startsWith('/upload/job/'))setImmediate(()=>fixture.disconnect());
 },
 beforeRename(source,target){
  commits.push({target,edits});fs.writeFileSync(path.join(output,'commits.json'),JSON.stringify(commits));
  if(target==='/upload/job/a.txt'){
   if((mode==='postchange'||mode==='postsame')&&!modified){modified=true;const source=path.join(local,'a.txt'),old=fs.statSync(source);fs.writeFileSync(source,Buffer.alloc(1024*1024,66));const time=mode==='postsame'?new Date(Math.floor(old.mtimeMs/1000)*1000+900):new Date(Date.now()+7000);fs.utimesSync(source,time,time);}
   committed=true;
   if(mode==='uncertain'){
    fs.renameSync(path.join(fixture.remote,source),path.join(fixture.remote,target));
    throw Object.assign(Error('synthetic lost acknowledgement'),{code:'EACCES'});
   }
  }
 },
 async beforeStat(_op,target){
  if(mode==='compare-error-listed'&&target.includes('/file')){fs.writeFileSync(path.join(output,'denied-child-lookup'),'generated');return 3;}
  if(mode.startsWith('compare')){
   inflight++;maxInflight=Math.max(maxInflight,inflight);const index=target.match(/file([0-3])\.txt$/);
   const workerBoundary=mode==='compare-worker-cancel'||mode.startsWith('compare-error');
   if(workerBoundary&&target.includes('/file'))comparisonPhase=true;
   if(mode==='compare-worker-cancel'&&maxInflight===4)fs.writeFileSync(path.join(output,'compare-observed'),'');
   // A 20ms reply can finish before the fourth request reaches the server.
   // Hold comparison-phase replies long enough to observe the real four-slot
   // batch; startup inventory stays fast and performance modes stay at 20ms.
   const delay=workerBoundary&&comparisonPhase?500:mode==='compare-reorder'&&index?(4-Number(index[1]))*30:20;
   await new Promise(r=>setTimeout(r,delay));inflight--;if(index)replyPaths.push(target);
   if(mode.startsWith('compare-error')&&maxInflight===4&&target.includes('/file'))return 3;
  }
  if(mode==='committed'&&committed&&target==='/upload/job/a.txt')return 3;
 },
});
if(mode.startsWith('compare'))setInterval(()=>{
 for(const name of fs.readdirSync(output).filter(n=>n==='metrics-request'||n.startsWith('metrics-request-'))){
 const target=path.join(output,name==='metrics-request'?'metrics.json':name.replace('metrics-request-','metrics-')+'.json');
 if(!fs.existsSync(target)){
  fs.writeFileSync(target+'.tmp',JSON.stringify({counts:fixture.requestCounts,authenticated:fixture.authenticated,maxInflight,connections:fixture.totalConnections,replyPaths}));
  fs.renameSync(target+'.tmp',target);
 }
 }
},10).unref();
fs.mkdirSync(path.join(fixture.remote,'upload/job/later'),{recursive:true});
fs.writeFileSync(path.join(fixture.remote,'upload/job/later/delete.txt'),'keep if first upload fails');
console.log(JSON.stringify({remote:fixture.remote,port:fixture.port,keyFile:fixture.ppk3,hostKey:fixture.fingerprint,passphrase:fixture.passphrase}));
process.stdin.resume();
process.stdin.on('end',()=>fixture.close().then(()=>process.exit(0)));
