import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const sourceSHA='cc0a659d56a998ca69976955d986539b87f2da9a';
export const order=['serial','parallel','parallel','serial'];
export function verifySummary(text,passed,ignored=0,filtered){
 const rows=[...text.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; (\d+) filtered out;/g)];
 const last=rows.at(-1);
 if(!last||Number(last[1])!==passed||Number(last[2])!==0||Number(last[3])!==ignored||(filtered!==undefined&&Number(last[4])!==filtered))throw Error('Exact native group summary mismatch');
}
export function npmTimers(records){
 return records.map(record=>({timers:Object.fromEntries(Object.entries(record.timers??{}).filter(([key,value])=>key.length<180&&!/https?:|token|password|authorization|[\\\r\n]/i.test(key)&&Number.isFinite(value)&&value>=0))}));
}
export async function runPair({context,root,output,processes,mode,standardArgs,fixtureCommands}){
 fs.mkdirSync(output,{recursive:true});
 const keys=new Set(['PATH','CARGO_MANIFEST_DIR','CARGO_MANIFEST_PATH','CARGO_PKG_NAME','CARGO_PKG_VERSION','CARGO_PKG_VERSION_MAJOR','CARGO_PKG_VERSION_MINOR','CARGO_PKG_VERSION_PATCH','CARGO_PKG_VERSION_PRE','CARGO_PKG_AUTHORS','CARGO_PKG_DESCRIPTION','CARGO_PKG_HOMEPAGE','CARGO_PKG_REPOSITORY','CARGO_PKG_LICENSE','CARGO_PKG_LICENSE_FILE','CARGO_PKG_RUST_VERSION']);
 const manifest=path.join(output,'test-executables.json');
 fs.writeFileSync(manifest,JSON.stringify({...context,env:Object.fromEntries(Object.entries(context.env).filter(([key])=>keys.has(key)))}));
 const events=[];
 async function measured(name,fn){const start=performance.now(),at=new Date().toISOString();try{const result=await fn();events.push({name,at,end:new Date().toISOString(),seconds:(performance.now()-start)/1000,success:true});return result;}catch(error){events.push({name,at,end:new Date().toISOString(),seconds:(performance.now()-start)/1000,success:false});await processes.stop();throw error;}}
 const normal=()=>measured('normal',async()=>{
  for(const [index,executable] of context.executables.entries()){
   const text=await processes.run(executable,standardArgs,{cwd:context.cwd,env:context.env,capture:'tee',log:path.join(output,`normal-${index}.log`)});
   verifySummary(text,executable===context.mainExecutable?588:3,executable===context.mainExecutable?53:0,executable===context.mainExecutable?2:0);
  }
 });
 const localhost=()=>measured('localhost',async()=>{
  for(const [index,command] of fixtureCommands.entries()){
   const text=await measured(`fixture-${index}`,()=>processes.run(process.execPath,[path.join(root,'scripts',command[0]),...command.slice(1)],{cwd:root,env:{...context.env,NEARLY_NATIVE_TEST_MANIFEST:manifest,NEARLY_NATIVE_PARALLEL:'1'},ipc:true,capture:'tee',log:path.join(output,`fixture-${index}.log`)}));
   verifySummary(text,[6,8,9,9][index]);
  }
 });
 const start=performance.now();let success=false;
 try{
  if(mode==='serial'){await normal();await localhost();}
  else if(mode==='parallel'){const results=await Promise.allSettled([normal(),localhost()]);if(results.some(r=>r.status==='rejected'))throw Error('Paired native lane failed');}
  else throw Error('Unsupported mode');
  success=true;
 }finally{fs.writeFileSync(path.join(output,'events.json'),JSON.stringify({mode,success,seconds:(performance.now()-start)/1000,events},null,2));}
 return {mode,success,seconds:(performance.now()-start)/1000,events};
}

async function main(){
 const [rootArg,outputArg]=process.argv.slice(2),root=path.resolve(rootArg),output=path.resolve(outputArg);
 fs.mkdirSync(output,{recursive:true});
 const {Processes,cancellation}=await import(pathToFileURL(path.join(root,'scripts/native-test-process.mjs')));
 const {resolveBuild,standardArgs,fixtureCommands}=await import(pathToFileURL(path.join(root,'scripts/native-parallel-test.mjs')));
 const processes=new Processes(),dispose=cancellation(processes);
 const sha=()=>createHash('sha256');
 const hashes=context=>context.executables.map(file=>({name:path.basename(file),sha256:sha().update(fs.readFileSync(file)).digest('hex')}));
 const stop=path.join(output,'telemetry.stop'),telemetry=path.join(output,'telemetry.jsonl');
 const sampler=processes.run('pwsh',['-NoProfile','-File',new URL('./native-pair-telemetry.ps1',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),'-OwnerPid',String(process.pid),'-Output',telemetry,'-StopFile',stop],{cwd:root,log:path.join(output,'telemetry-status.log')});
 // Attach immediately; a sampler failure must not become an unhandled rejection.
 const samplerResult=sampler.then(()=>({ok:true}),error=>({ok:false,reason:error.message}));
 const result={source:sourceSHA,order,passes:[],limits:'ABBA on one VM; filesystem caches/order effects remain. CPU/IO samples are lower-bound owned-process counters, not disk wait or hardware latency. Standard-user admission is outside the compared normal/localhost groups and its protected main-only launcher is unchanged.'};
 let success=false;
 try{
  const actual=(await processes.run('git',['rev-parse','HEAD'],{cwd:root,capture:true})).trim();
  if(actual!==sourceSHA)throw Error('Source SHA mismatch');
  const buildStart=performance.now();
  const json=await processes.run('cargo',['+1.97.1','test','--no-run','--offline','--locked','--message-format=json','--manifest-path',path.join(root,'src-tauri/Cargo.toml')],{cwd:root,capture:true,log:path.join(output,'build.jsonl')});
  const runtime=(await processes.run('rustc',['+1.97.1','--print','target-libdir'],{cwd:root,capture:true})).trim();
  const context=resolveBuild(json.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)),path.join(root,'src-tauri'),path.resolve(process.env.CARGO_TARGET_DIR),runtime);
  if(context.executables.length!==2)throw Error('Expected main and resource harnesses');
  result.buildSeconds=(performance.now()-buildStart)/1000;result.binaryHashes=hashes(context);
  for(const [index,mode] of order.entries()){
   if(JSON.stringify(hashes(context))!==JSON.stringify(result.binaryHashes))throw Error('Built executable changed');
   const phase=`${index+1}-${mode}`;fs.writeFileSync(path.join(output,'phase.txt'),phase);
   const pass=await runPair({context,root,output:path.join(output,phase),processes,mode,standardArgs,fixtureCommands});
   result.passes.push(pass);console.log('NATIVE_PAIR_PASS',JSON.stringify({index,mode,seconds:pass.seconds,events:pass.events}));
  }
  if(JSON.stringify(hashes(context))!==JSON.stringify(result.binaryHashes))throw Error('Built executable changed after measurements');
  const status=await processes.run('git',['diff','--exit-code','HEAD','--'],{cwd:root,capture:true});
  if(status.trim())throw Error('Tracked source changed');
  const npmFolder=path.join(process.env.RUNNER_TEMP,'nearly-npm-timing','_logs');
  const files=fs.existsSync(npmFolder)?fs.readdirSync(npmFolder).filter(f=>f.endsWith('-timing.json')):[];
  result.npm=npmTimers(files.map(f=>JSON.parse(fs.readFileSync(path.join(npmFolder,f),'utf8'))));
  success=true;
 }finally{
  fs.writeFileSync(stop,'stop');
  let timer;
  const sampled=await Promise.race([samplerResult,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),10000);})]);
  clearTimeout(timer);
  if(!sampled)await processes.stop();
  const exit=sampled??await samplerResult;
  const samples=fs.existsSync(telemetry)?fs.readFileSync(telemetry,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line.replace(/^\uFEFF/,''))):[];
  result.telemetry={exit,countersAvailable:samples.some(r=>r.processes?.length>0),unavailable:samples.filter(r=>r.unavailable)};
  result.success=success;fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log('NATIVE_PAIR_RESULT',JSON.stringify(result));
  await processes.stop();dispose();
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error);process.exitCode=1;});
