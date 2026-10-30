// Disposable loopback SFTP fixture for Rust worker tests; never reads account data.
import {createFixture} from './sftp-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
const [output,mode,local]=process.argv.slice(2);
let modified=false,committed=false,edits=0,inflight=0,maxInflight=0,comparisonPhase=false;const seenStages=new Set(),commits=[],replyPaths=[];
let listed=false,listingReads=0,targetLookups=0;
let activeWrites=0,maxWrites=0,maxWritingFiles=0;const writingFiles=new Map();
let failedStage=null,heldTarget=null;
const fixture=await createFixture(output,{
 advertisedOpenHandles:mode==='compare-parallel-advertised-one'||mode==='compare-parallel-limits-unavailable'?1:undefined,
 rejectLimits:mode==='compare-parallel-limits-unavailable',
 beforeOpen(target){
  if(mode==='compare-guard-parent-at-open'&&!modified){modified=true;const p=path.join(fixture.remote,'upload/job/nested');fs.renameSync(p,p+'-saved');fs.writeFileSync(p,'generated non-directory replacement');}
  if((mode==='compare-parallel-handles'&&fixture.openFileHandles>=2)||(mode==='compare-parallel-advertised-one'&&fixture.openFileHandles>=1))throw Error('generated handle pressure');
 },
 beforeRmdir(){if(mode==='compare-parallel-mirror'&&fixture.openFileHandles!==0){fs.writeFileSync(path.join(output,'delete-with-open-handles'),'unexpected');return 3;}},
 async beforeReadDir(target){
  if(!mode.startsWith('compare-snapshot')||path.basename(target??'')!=='nested')return;
  listed=true;listingReads++;
  if(mode==='compare-snapshot-unavailable')return 3;
  if(mode==='compare-snapshot-cancel'){fs.writeFileSync(path.join(output,'listing-held'),'generated');await new Promise(r=>setTimeout(r,3000));return 4;}
  if(mode==='compare-snapshot-partial'&&listingReads>1)return 3;
 },
 mapReadDir(target,names){
  if(mode==='compare-snapshot-attrs-unknown')for(const entry of names){delete entry.attrs.mode;delete entry.attrs.size;}
  if(mode==='compare-snapshot-entry-type')for(const entry of names)if(entry.filename==='file0.txt')entry.attrs.mode=0o120777;
  if(mode==='compare-snapshot-duplicate'&&names.length)names.push({...names[0]});
  return names;
 },
 async beforeWrite(target){
  if(mode==='compare-guard-postwrite')modified=true;
  if(mode.startsWith('compare-parallel')){activeWrites++;maxWrites=Math.max(maxWrites,activeWrites);writingFiles.set(target,(writingFiles.get(target)??0)+1);maxWritingFiles=Math.max(maxWritingFiles,writingFiles.size);await new Promise(r=>setTimeout(r,30));activeWrites--;const left=writingFiles.get(target)-1;if(left)writingFiles.set(target,left);else writingFiles.delete(target);}
  if(mode==='compare-parallel-fail'){failedStage??=target;if(target===failedStage)return 3;}
  if(mode==='compare-parallel-disconnect'){fixture.disconnect();return 4;}
  if(mode==='compare-parallel-cancel'){fs.writeFileSync(path.join(output,'batch-held'),'generated');const start=Date.now();while(!fs.existsSync(path.join(output,'release-batch'))){if(Date.now()-start>30000)return 4;await new Promise(r=>setTimeout(r,5));}}
  if(mode==='compare-upload-source'&&!modified){
   modified=true;fs.writeFileSync(path.join(output,'source-changed'),String(Date.now()));
   for(let i=0;i<8;i++)fs.writeFileSync(path.join(local,`nested/file${i}.txt`),'latest generated source after comparison');
  }
  if(mode==='compare-upload-unsafe')modified=true;
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
  if(mode==='compare-parallel-postcancel'&&!heldTarget)heldTarget=target;
  if(mode==='compare-upload-source'&&target.includes('/nested/file')){
   const expected=fs.readFileSync(path.join(local,'nested',path.posix.basename(target)));
   if(!fs.readFileSync(path.join(fixture.remote,source)).equals(expected))fs.writeFileSync(path.join(output,'stale-commit'),'unexpected');
  }
  commits.push({target,edits});fs.writeFileSync(path.join(output,'commits.json'),JSON.stringify(commits));
  if(target==='/upload/job/a.txt'){
   if((mode==='postchange'||mode==='postsame')&&!modified){modified=true;const source=path.join(local,'a.txt'),old=fs.statSync(source);fs.writeFileSync(source,Buffer.alloc(1024*1024,66));const time=mode==='postsame'?new Date(Math.floor(old.mtimeMs/1000)*1000+900):new Date(Date.now()+7000);fs.utimesSync(source,time,time);}
   committed=true;
   if(mode==='uncertain'){
    fs.renameSync(path.join(fixture.remote,source),path.join(fixture.remote,target));
    throw Object.assign(Error('synthetic lost acknowledgement'),{code:'EACCES'});
   }
  }
  if(mode==='compare-parallel-acklost'&&!failedStage){failedStage=source;fs.renameSync(path.join(fixture.remote,source),path.join(fixture.remote,target));throw Error('generated lost rename ACK');}
 },
 async beforeStat(_op,target){
  if(mode==='compare-guard-server-error'&&target==='/upload/job/nested')return 3;
  if(mode==='compare-guard-cancel'&&target==='/upload/job/nested'){
   fs.writeFileSync(path.join(output,'guard-held'),'generated');await new Promise(r=>setTimeout(r,3000));return 4;
  }
  if(mode==='compare-cancel'){
   inflight++;maxInflight=Math.max(maxInflight,inflight);
   if(inflight===4)fs.writeFileSync(path.join(output,'cancel-comparison-held'),'generated');
   await new Promise(r=>setTimeout(r,3000));inflight--;return;
  }
  if(mode==='compare-snapshot-content-race'&&target==='/upload/job/nested/file0.txt'&&fs.existsSync(path.join(output,'hold-content-compare'))&&!fs.existsSync(path.join(output,'content-compare-held'))){
   fs.writeFileSync(path.join(output,'content-compare-held'),'generated');const deadline=Date.now()+15000;
   while(!fs.existsSync(path.join(output,'release-content-compare'))){if(Date.now()>deadline)throw Error('generated content comparison barrier timed out');await new Promise(r=>setTimeout(r,5));}
  }
  if(mode==='compare-parallel-postcancel'&&target===heldTarget){fs.writeFileSync(path.join(output,'post-held'),'generated');await new Promise(r=>setTimeout(r,3000));return 3;}
  if(mode==='compare-snapshot-target-race'&&target==='/upload/job/nested/file0.txt')targetLookups++;
  if(mode==='compare-snapshot-junction'&&target==='/upload/job/nested'&&!fs.existsSync(path.join(output,'junction-ready'))){
   const dir=path.join(fixture.remote,'upload/job/nested'),outside=path.join(fixture.remote,'other/escape');
   fs.renameSync(dir,dir+'-saved');fs.mkdirSync(outside,{recursive:true});fs.writeFileSync(path.join(outside,'sentinel.txt'),'generated outside-selected-root sentinel');fs.symlinkSync(outside,dir,'junction');fs.writeFileSync(path.join(output,'junction-ready'),'generated');
  }
  if(mode==='compare-snapshot-junction'&&target.startsWith('/upload/job/nested/'))fs.writeFileSync(path.join(output,'escape-query'),'unexpected');
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
 mapStat(target,attrs){
  if(mode==='compare-guard-postwrite'&&modified&&target==='/upload/job/nested')return {...attrs,mode:0o120777};
  if(mode==='compare-guard-target-type'&&target.endsWith('.txt'))return {...attrs,mode:0o40755};
  if(mode==='compare-guard-unknown-mode'&&target==='/upload/job/nested'){const changed={...attrs};delete changed.mode;return changed;}
  if(mode==='compare-upload-unsafe'&&modified&&target==='/upload/job/nested')return {...attrs,mode:0o120777};
  if(mode==='compare-snapshot-parent'&&listed&&target==='/upload/job/nested')return {...attrs,mode:0o120777};
  if(mode==='compare-snapshot-target-race'&&targetLookups>=2&&target==='/upload/job/nested/file0.txt')return {...attrs,mode:0o120777};
  return attrs;
 },
});
// Keep filesystem failure evidence before sending an SFTP error; status is unchanged.
const recordErrors=fixture.fileSystemErrors.push.bind(fixture.fileSystemErrors);
fixture.fileSystemErrors.push=(...errors)=>{const count=recordErrors(...errors);fs.writeFileSync(path.join(output,'filesystem-errors.json'),JSON.stringify(fixture.fileSystemErrors));return count;};
if(mode.startsWith('compare'))setInterval(()=>{
 for(const name of fs.readdirSync(output).filter(n=>n==='metrics-request'||n.startsWith('metrics-request-'))){
 const target=path.join(output,name==='metrics-request'?'metrics.json':name.replace('metrics-request-','metrics-')+'.json');
 if(!fs.existsSync(target)){
  fs.writeFileSync(target+'.tmp',JSON.stringify({counts:fixture.requestCounts,authenticated:fixture.authenticated,maxInflight,maxWrites,maxWritingFiles,maxOpenFileHandles:fixture.maxOpenFileHandles,openFileHandles:fixture.openFileHandles,connections:fixture.totalConnections,replyPaths}));
  fs.renameSync(target+'.tmp',target);
 }
 }
},10).unref();
fs.mkdirSync(path.join(fixture.remote,'upload/job/later'),{recursive:true});
fs.writeFileSync(path.join(fixture.remote,'upload/job/later/delete.txt'),'keep if first upload fails');
console.log(JSON.stringify({remote:fixture.remote,port:fixture.port,keyFile:fixture.ppk3,hostKey:fixture.fingerprint,passphrase:fixture.passphrase}));
process.stdin.resume();
process.stdin.on('end',()=>fixture.close().then(()=>process.exit(0)));
