import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';import {createHash} from 'node:crypto';
import {prepareStorage,applyStorage,inspectStorageWriters} from '../scripts/storage-once.mjs';import {packSettings,names} from '../scripts/storage-fixture.mjs';
import {spawn} from 'node:child_process';
import {runInNewContext} from 'node:vm';
const writerProbeProgram=`let closing=false;
 const watchdog=setTimeout(()=>finish(2),180000);
 function finish(code){if(closing)return;closing=true;clearTimeout(watchdog);process.exitCode=code;if(process.connected)process.disconnect();}
 process.once('message',m=>finish(m?.type==='release'&&m.pid===process.pid?0:3));
 process.once('disconnect',()=>{if(!closing)finish(4);});
 process.send({type:'ready',pid:process.pid},error=>{if(error)finish(5);});`;
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nearly-storage-once-generated-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'source');fs.mkdirSync(source);for(const [n,b]of Object.entries({'settings.json':'generated legacy','settings.backup.json':'generated older backup','Nearly.exe':'MZ generated old executable'}))fs.writeFileSync(path.join(source,n),b);const candidate=path.join(root,'candidate.exe');fs.writeFileSync(candidate,'MZ generated new executable');const validator=path.join(root,'validator.exe');fs.writeFileSync(validator,'generated validator marker');const workspace=path.join(root,'migration');const options={directory:source,workspace,candidate,validator,validatorSha256:hash(fs.readFileSync(validator))};const validate=({output})=>{const a={schemaVersion:1,revision:1,connections:{profiles:[],history:{},tree:{version:1,nodes:[]}},appearance:{},explorer:{localBookmarks:[],remoteBookmarks:[],folderBookmarks:[],folderPairHistory:[],paneColumns:{},bookmarkTree:{version:1,nodes:[]}},browse:{browseLocations:{},paneSorts:{}},sync:{exclusions:{},syncOptions:{},syncPresets:[],retainedSyncs:[]},trust:{version:1,pins:{}}};for(const [n,b]of Object.entries(packSettings(a)))fs.writeFileSync(path.join(output,n),b);};return {root,source,candidate,validator,workspace,options,services:{probe:()=>[],validate}};}
test('external preparation backs up exact original bytes and guarded apply publishes five files plus matching executable',t=>{const f=fixture(t);const old=fs.readFileSync(path.join(f.source,'settings.json'));const plan=prepareStorage(f.options,f.services);assert.equal(fs.readFileSync(path.join(f.source,'settings.json'),'utf8'),'generated legacy');assert.deepEqual(fs.readFileSync(path.join(f.workspace,'legacy/settings.json')),old);const receipt=applyStorage(plan.path,plan.sha256,{probe:()=>[]});assert.equal(receipt.status,'applied');for(const n of names){assert.ok(fs.existsSync(path.join(f.source,n)));assert.deepEqual(fs.readFileSync(path.join(f.source,n)),fs.readFileSync(path.join(f.source,n.replace('.json','.backup.json'))));}assert.deepEqual(fs.readFileSync(path.join(f.source,'Nearly.exe')),fs.readFileSync(f.candidate));assert.deepEqual(fs.readFileSync(path.join(f.workspace,'legacy/settings.json')),old);});
test('running app and stale source prevent all publication',t=>{const f=fixture(t);assert.throws(()=>prepareStorage(f.options,{...f.services,probe:()=>[{pid:123}]}),/running/i);assert.equal(fs.existsSync(f.workspace),false);const plan=prepareStorage(f.options,f.services);fs.appendFileSync(path.join(f.source,'settings.json'),' external change');assert.throws(()=>applyStorage(plan.path,plan.sha256,{probe:()=>[]}),/changed/i);assert.equal(fs.existsSync(path.join(f.source,'history.json')),false);});
test('tampered plan, prepared bytes, candidate and destination collisions fail closed',t=>{for(const what of ['plan','prepared','candidate','collision']){const f=fixture(t);const p=prepareStorage(f.options,f.services);if(what==='plan')fs.appendFileSync(p.path,' ');if(what==='prepared')fs.appendFileSync(path.join(f.workspace,'prepared/history.json'),' ');if(what==='candidate')fs.appendFileSync(f.candidate,' ');if(what==='collision')fs.writeFileSync(path.join(f.source,'history.json'),'foreign existing');assert.throws(()=>applyStorage(p.path,p.sha256,{probe:()=>[]}));assert.equal(fs.readFileSync(path.join(f.source,'settings.json'),'utf8'),'generated legacy');}});
test('partial publication reports exact targets and retains complete verified originals',t=>{const f=fixture(t);const p=prepareStorage(f.options,f.services);assert.throws(()=>applyStorage(p.path,p.sha256,{probe:()=>[],beforePublish:({index})=>{if(index===3)throw Error('generated failure');}}),/generated failure/);const receipt=JSON.parse(fs.readFileSync(path.join(f.workspace,'apply-result.json')));assert.equal(receipt.status,'partial');assert.equal(receipt.published.length,3);for(const n of ['settings.json','settings.backup.json','Nearly.exe'])assert.ok(fs.existsSync(path.join(f.workspace,'legacy',n)));assert.equal(fs.existsSync(path.join(f.source,'.nearly-settings.lock')),false);});
test('validation failure leaves live files unchanged and never replaces an existing workspace',t=>{const f=fixture(t);assert.throws(()=>prepareStorage(f.options,{probe:()=>[],validate:()=>{throw Error('invalid source');}}),/invalid source/);assert.equal(fs.readFileSync(path.join(f.source,'settings.json'),'utf8'),'generated legacy');assert.throws(()=>prepareStorage(f.options,f.services));assert.equal(fs.existsSync(path.join(f.source,'connections.json')),false);});
test('actual renamed executable in live directory blocks maintenance before backup creation',async t=>{
 const f=fixture(t),renamed=path.join(f.source,'renamed-writer-probe.exe');fs.copyFileSync(process.execPath,renamed);
 // Slow process inspection must not outlive an arbitrary fixture lifetime.
 // Only the owning IPC channel can release this generated child; a watchdog
 // or unexpected disconnect exits nonzero and cannot establish a passing test.
 const child=spawn(renamed,['-e',writerProbeProgram],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 const ready=new Promise((resolve,reject)=>{
  child.once('message',m=>m?.type==='ready'&&m.pid===child.pid?resolve():reject(Error('Invalid owned probe readiness')));
  child.once('error',()=>reject(Error('Owned probe could not start')));
 });
 async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned probe '+label+' timed out')),15000);})]);}finally{clearTimeout(timer);}}
 try{
  await bounded(Promise.race([ready,closed.then(()=>{throw Error('Owned probe exited before ready');})]),'readiness');
  assert.ok(inspectStorageWriters(f.source).some(p=>p.pid===child.pid),'Exact renamed child PID must be detected, independently of other applications');
  assert.throws(()=>prepareStorage(f.options,{validate:f.services.validate}),/running/i);
  assert.equal(fs.existsSync(f.workspace),false);
 }finally{
  if(child.connected)child.send({type:'release',pid:child.pid},()=>{});
  assert.deepEqual(await bounded(closed,'cooperative exit'),{code:0,signal:null});
 }
});
test('owned writer fixture cannot turn a watchdog or channel failure into success',()=>{
 for(const [mode,expected] of [['watchdog',2],['disconnect',4],['invalid-message',3],['send-error',5],['release',0]]){
  const handlers=new Map();let watchdog;
  const owned={pid:42,connected:true,exitCode:undefined,once:(name,fn)=>handlers.set(name,fn),disconnect(){this.connected=false;handlers.get('disconnect')?.();},send(message,callback){assert.equal(message.type,'ready');assert.equal(message.pid,42);callback(mode==='send-error'?Error('generated send failure'):null);}};
  runInNewContext(writerProbeProgram,{process:owned,setTimeout(fn,delay){assert.equal(delay,180000);watchdog=fn;return 1;},clearTimeout(id){assert.equal(id,1);}});
  if(mode==='watchdog')watchdog();
  else if(mode==='disconnect')owned.disconnect();
  else if(mode==='invalid-message')handlers.get('message')({type:'release',pid:43});
  else if(mode==='release')handlers.get('message')({type:'release',pid:42});
  handlers.get('message')({type:'release',pid:42});
  assert.equal(owned.exitCode,expected,mode+' must retain its first terminal result');
 }
});
test('publication interruption keeps a durable pending target rather than claiming no replacement',t=>{
 const f=fixture(t),p=prepareStorage(f.options,f.services);
 assert.throws(()=>applyStorage(p.path,p.sha256,{probe:()=>[],afterPublish:()=>{throw Error('generated interruption after rename');}}),/generated interruption/);
 const receipt=JSON.parse(fs.readFileSync(path.join(f.workspace,'apply-result.json')));assert.equal(receipt.status,'partial');assert.equal(receipt.published.length,0);assert.equal(receipt.pending.name,'history.json');assert.equal(hash(fs.readFileSync(path.join(f.source,'history.json'))),receipt.pending.afterSha256);
});
