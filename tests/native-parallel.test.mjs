import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('single build retains root resource harness and Cargo runtime environment', async () => {
 const {resolveBuild} = await import('../scripts/native-parallel-test.mjs');
 const target=fs.mkdtempSync(path.join(os.tmpdir(),'native-lanes-'));
 try {
 const deps=path.join(target,'debug','deps');fs.mkdirSync(deps,{recursive:true});
 const main=path.join(deps,'nearly-abcd.exe'), resource=path.join(deps,'windows_version_resource-abcd.exe');
 for(const file of [main,resource])fs.writeFileSync(file,'dummy');
 const root=path.resolve('src-tauri');
 const rows=[main,resource].map((executable,i)=>({reason:'compiler-artifact',manifest_path:path.join(root,'Cargo.toml'),target:{name:i?'windows_version_resource':'nearly',kind:[i?'test':'bin']},profile:{test:true},executable}));
 rows.push({reason:'compiler-artifact',manifest_path:path.join(root,'vendor','Cargo.toml'),target:{name:'dependency',kind:['lib']},profile:{test:true},executable:main});
 rows.push({reason:'build-script-executed',linked_paths:['native='+deps]},{reason:'build-finished',success:true});
 const result=resolveBuild(rows,root,target,deps,{PATH:'original'});
 assert.deepEqual(result.executables,[main,resource]);assert.equal(result.mainExecutable,main);
 assert.equal(result.cwd,root);assert.equal(result.env.CARGO_MANIFEST_DIR,root);
 assert.ok(result.env.PATH.includes(deps));assert.ok(result.env.PATH.endsWith('original'));
 assert.throws(()=>resolveBuild(rows.slice(0,-1),root,target,deps,{}),/successful/i);
 }finally{fs.rmSync(target,{recursive:true,force:true});}
});

// Real dummy executables exercise Windows spawn, working directory, environment,
// IPC cancellation and descendants without opening the application or using keys.
import {spawnSync} from 'node:child_process';
import {before,after} from 'node:test';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let sandbox,exe;
before(()=>{
 sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'native-process-tests-'));exe=path.join(sandbox,'harness.exe');
 const source=path.join(sandbox,'harness.rs');
 fs.writeFileSync(source,`use std::{env,fs,thread,time::Duration};
 fn main(){let root=env::var("EVENT_ROOT").unwrap();if env::current_exe().unwrap().file_stem().unwrap()=="cargo"{fs::write(format!("{root}/build-args"),env::args().collect::<Vec<_>>().join(" ")).unwrap();let count=fs::read_to_string(format!("{root}/build-count")).unwrap_or("0".into()).parse::<u32>().unwrap()+1;fs::write(format!("{root}/build-count"),count.to_string()).unwrap();println!("{}",fs::read_to_string(env::var("DUMMY_CARGO_JSON").unwrap()).unwrap());return;}fs::write(format!("{root}/harness-args"),env::args().collect::<Vec<_>>().join(" ")).unwrap();let marker=env::var("MARKER").unwrap_or("normal".into());fs::write(format!("{root}/{marker}-start"),env::current_dir().unwrap().display().to_string()+"\\n"+&env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).unwrap();if env::var("FAIL_NATIVE").is_ok(){std::process::exit(17)};while !std::path::Path::new(&format!("{root}/fixture-start")).exists(){thread::sleep(Duration::from_millis(10));}thread::sleep(Duration::from_millis(100));fs::write(format!("{root}/{marker}-end"),"done").unwrap();println!("test result: ok. 1 passed; 0 failed; 0 ignored;");}`);
 const built=spawnSync('rustc',['+1.97.1',source,'-o',exe],{encoding:'utf8',windowsHide:true});assert.equal(built.status,0,built.stderr);
});
after(()=>{if(sandbox)fs.rmSync(sandbox,{recursive:true,force:true});});
function scenario(){const output=fs.mkdtempSync(path.join(sandbox,'case-'));const scripts=path.join(output,'scripts');fs.mkdirSync(scripts);return {root:output,output};}
test('normal/resource harnesses overlap sequential fixtures and preserve runtime cwd/env',async()=>{
 const {executeLanes}=await import('../scripts/native-parallel-test.mjs');
 const {root,output}=scenario();
 fs.writeFileSync(path.join(root,'scripts','fixture.mjs'),`import fs from 'node:fs';import path from 'node:path';const r=process.env.EVENT_ROOT;const index=process.argv[2];if(index==='2'&&!fs.existsSync(path.join(r,'fixture-1-end')))throw Error('fixtures overlap');fs.writeFileSync(path.join(r,'fixture-start'),'');if(!fs.existsSync(path.join(r,'normal-start')))await new Promise(r=>setTimeout(r,100));if(!fs.existsSync(path.join(r,'normal-start')))throw Error('normal did not overlap');await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(r,'fixture-'+index+'-end'),'');`);
 const resource=path.join(root,'resource.exe');fs.copyFileSync(exe,resource);
 const context={executables:[exe,resource],mainExecutable:exe,cwd:root,env:{...process.env,EVENT_ROOT:root,CARGO_MANIFEST_DIR:root,CARGO_REGISTRY_TOKEN:"dummy-token-do-not-persist",CARGO_REGISTRIES_PRIVATE_TOKEN:"dummy-private-token"}};
 await executeLanes(context,{root,output,commands:[['fixture.mjs','1'],['fixture.mjs','2']]});
 assert.equal(fs.readFileSync(path.join(root,'normal-start'),'utf8'),root+'\n'+root);
 assert.ok(fs.existsSync(path.join(root,'fixture-2-end')));
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'test-executables.json')));assert.equal(manifest.env.CARGO_REGISTRY_TOKEN,undefined);assert.equal(manifest.env.CARGO_REGISTRIES_PRIVATE_TOKEN,undefined);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'lane-results.json'))).map(x=>x.status),['fulfilled','fulfilled']);
});
test('failed harness cancels fixture and its owned descendant, preserving failure result',async()=>{
 const {executeLanes}=await import('../scripts/native-parallel-test.mjs');
 const {Processes}=await import('../scripts/native-test-process.mjs');
 const {root,output}=scenario();const processes=new Processes();
 fs.writeFileSync(path.join(root,'scripts','fixture.mjs'),`import {Processes,cancellation} from ${JSON.stringify(new URL('../scripts/native-test-process.mjs',import.meta.url).href)};const p=new Processes();const off=cancellation(p);try{await p.run(process.execPath,['-e',"setInterval(()=>{},1000)"]);}catch(error){if(!p.cancelled)throw error;}finally{await p.stop();off();}`);
 await assert.rejects(executeLanes({executables:[exe],mainExecutable:exe,cwd:root,env:{...process.env,EVENT_ROOT:root,FAIL_NATIVE:'1'}},{root,output,processes,commands:[['fixture.mjs']]}),/failed or cancelled/);
 assert.equal(processes.children.size,0);const result=JSON.parse(fs.readFileSync(path.join(root,'lane-results.json')));assert.ok(result.some(x=>x.error?.includes('17')));assert.ok(result.every(x=>x.status==='rejected'));
});
test('fixture directory allocation is collision-proof within one clock tick',async()=>{
 const {fixtureDirectory}=await import('../scripts/native-test-process.mjs');const dirs=Array.from({length:20},()=>fixtureDirectory('isolated-native-test'));
 try{assert.equal(new Set(dirs).size,dirs.length);}finally{for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});}
});

test('cancellation waits for child shutdown and closes the owned fixture port',async()=>{
 const {Processes}=await import('../scripts/native-test-process.mjs');const {connect}=await import('node:net');const {root}=scenario();
 const script=path.join(root,'cancel.mjs');
 fs.writeFileSync(script,`import fs from 'node:fs';import net from 'node:net';import {Processes,cancellation} from ${JSON.stringify(new URL('../scripts/native-test-process.mjs',import.meta.url).href)};const p=new Processes();const off=cancellation(p);const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));fs.writeFileSync(process.env.PORT_FILE,String(server.address().port));try{await p.run(process.execPath,['-e',"require('fs').writeFileSync(process.env.PID_FILE,String(process.pid));setInterval(()=>{},1000)"]);}catch(error){if(!p.cancelled)throw error;}finally{await p.stop();await new Promise(r=>server.close(r));off();}`);
 const processes=new Processes();const portFile=path.join(root,'port'),pidFile=path.join(root,'pid');
 const pending=processes.run(process.execPath,[script],{env:{...process.env,PORT_FILE:portFile,PID_FILE:pidFile},ipc:true}).catch(error=>error);
 for(let i=0;i<200 && !fs.existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(fs.existsSync(pidFile),'fixture child became ready');const port=Number(fs.readFileSync(portFile));const pid=Number(fs.readFileSync(pidFile));
 await processes.stop();const result=await pending;assert.ok(result instanceof Error);assert.equal(processes.children.size,0);
 assert.throws(()=>process.kill(pid,0));
 await new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1');socket.on('error',resolve);socket.on('connect',()=>{socket.destroy();reject(Error('fixture port remained open'));});});
});
test('empty or skipped native harness output cannot make a lane green',async()=>{
 const {assertHarnessResult}=await import('../scripts/native-test-process.mjs');
 assert.throws(()=>assertHarnessResult('test result: ok. 0 passed; 0 failed; 4 ignored;'),/passing tests/);
 assert.doesNotThrow(()=>assertHarnessResult('test result: ok. 2 passed; 0 failed; 4 ignored;'));
});

test('entry command performs exactly one Cargo build before both lanes',async()=>{
 const {Processes}=await import('../scripts/native-test-process.mjs');const {root,output}=scenario();
 const tools=path.join(root,'tools'),target=path.join(root,'target'),deps=path.join(target,'debug','deps'),pkg=path.join(root,'src-tauri');
 for(const dir of [tools,deps,pkg])fs.mkdirSync(dir,{recursive:true});
 fs.copyFileSync(exe,path.join(tools,'cargo.exe'));
 const main=path.join(deps,'nearly-abcd.exe'),resource=path.join(deps,'windows_version_resource-abcd.exe');for(const item of [main,resource])fs.copyFileSync(exe,item);
 fs.writeFileSync(path.join(pkg,'Cargo.toml'),'[package]\nname = "nearly"\nversion = "3.6.0"\n');
 for(const name of ['native-parallel-test.mjs','native-test-process.mjs'])fs.copyFileSync(path.join(repo,'scripts',name),path.join(root,'scripts',name));
 for(const name of ['sync-difference-test.mjs','listing-worker-test.mjs','listing-existing-pipeline-test.mjs'])fs.writeFileSync(path.join(root,'scripts',name),`import fs from 'node:fs';import path from 'node:path';const root=process.env.EVENT_ROOT;if(fs.readFileSync(path.join(root,'build-count'),'utf8')!=='1')throw Error('unexpected build count');const manifest=JSON.parse(fs.readFileSync(process.env.NEARLY_NATIVE_TEST_MANIFEST));if(manifest.mainExecutable!==${JSON.stringify(main)})throw Error('wrong shared executable');fs.appendFileSync(path.join(root,'fixture-filters'),process.argv.slice(1).join(' ')+'\\n');fs.writeFileSync(path.join(root,'fixture-start'),'');await new Promise(r=>setTimeout(r,100));`);
 const jsonFile=path.join(root,'cargo.jsonl');fs.writeFileSync(jsonFile,[main,resource].map((executable,i)=>JSON.stringify({reason:'compiler-artifact',manifest_path:path.join(pkg,'Cargo.toml'),target:{name:i?'windows_version_resource':'nearly',kind:[i?'test':'bin']},profile:{test:true},executable})).concat(JSON.stringify({reason:'build-finished',success:true})).join('\n'));
 const p=new Processes();try{await p.run(process.execPath,[path.join(root,'scripts','native-parallel-test.mjs')],{cwd:root,env:{...process.env,PATH:tools+path.delimiter+process.env.PATH,EVENT_ROOT:root,CARGO_TARGET_DIR:target,DUMMY_CARGO_JSON:jsonFile}});}finally{await p.stop();}
 assert.equal(fs.readFileSync(path.join(root,'build-count'),'utf8'),'1');
 const args=fs.readFileSync(path.join(root,'build-args'),'utf8');assert.match(args,/\+1\.97\.1 test --no-run --offline --locked --message-format=json/);
 const filters=fs.readFileSync(path.join(root,'fixture-filters'),'utf8').trim().split('\n');assert.equal(filters.length,4);assert.match(filters[0],/sync_difference_generated_localhost/);assert.match(filters[1],/directory_deletion_generated_localhost/);
 const resultRoot=fs.readdirSync(path.join(root,'test-results')).find(name=>name.startsWith('native-parallel-'));
 assert.ok(fs.existsSync(path.join(root,'test-results',resultRoot,'normal-1.log')),'resource integration executable ran');
});

test('fixture helper uses pinned executable and fails closed without runner manifest',async()=>{
 const {runFixtureTest}=await import('../scripts/native-test-process.mjs');const {root,output}=scenario();
 const previous={parallel:process.env.NEARLY_NATIVE_PARALLEL,manifest:process.env.NEARLY_NATIVE_TEST_MANIFEST};
 try{
 process.env.NEARLY_NATIVE_PARALLEL='1';delete process.env.NEARLY_NATIVE_TEST_MANIFEST;
 await assert.rejects(runFixtureTest('listing_worker_',{},output),/manifest required/);
 const file=path.join(root,'manifest.json');fs.writeFileSync(path.join(root,'fixture-start'),'');
 const context={executables:[exe],mainExecutable:exe,cwd:root,env:{...process.env,EVENT_ROOT:root,CARGO_MANIFEST_DIR:root,PATH:''}};
 fs.writeFileSync(file,JSON.stringify(context));process.env.NEARLY_NATIVE_TEST_MANIFEST=file;
 assert.equal(await runFixtureTest('listing_worker_',{},output),0);
 assert.match(fs.readFileSync(path.join(root,'harness-args'),'utf8'),/listing_worker_ --ignored --nocapture --test-threads=1/);
 context.env.FAIL_NATIVE='1';fs.writeFileSync(file,JSON.stringify(context));
 assert.equal(await runFixtureTest('listing_worker_',{},output),17,'nonzero harness code is retained');
 }finally{for(const [key,value]of [['NEARLY_NATIVE_PARALLEL',previous.parallel],['NEARLY_NATIVE_TEST_MANIFEST',previous.manifest]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
