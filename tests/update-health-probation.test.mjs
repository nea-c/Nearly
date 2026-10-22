import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

async function fixture(phase='waitingForUi') {
 const elements=new Map(),attributes=new Set();let listener,ack=0;
 const document={documentElement:{toggleAttribute:(key,on)=>on?attributes.add(key):attributes.delete(key)},body:{append:node=>elements.set(node.id,node)},getElementById:id=>elements.get(id),createElement:()=>({setAttribute(){},remove(){elements.delete(this.id);}})};
 globalThis.document=document;globalThis.window={__TAURI__:{event:{listen:async(_,fn)=>{listener=fn;return()=>{};}}},addEventListener(){}};
 globalThis.MutationObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=fn=>fn();
 globalThis.__healthInvoke=async cmd=>{if(cmd==='update_restart_status')return{phase,revision:1};if(cmd==='ack_update_restart_ready'){ack++;return;}throw Error(cmd);};
 const source=await readFile(process.env.HEALTH_UI_SOURCE??new URL('../.test-build/update-recovery.js',import.meta.url),'utf8');
 const module=source.replace(/^import.*from '\.\/api\.js';$/m,'const invoke=globalThis.__healthInvoke;'+(process.env.HEALTH_UI_SOURCE?' type UpdateRestartReport={phase:string;revision:number};':'' )).replace(/^import.*from '\.\/i18n\.js';$/m,"const getLanguage=()=> 'en';").replace(/^import '\.\/update-recovery\.css';$/m,'');
 const root=await mkdtemp(join(tmpdir(),'nearly-probation-ui-'));const path=join(root,process.env.HEALTH_UI_SOURCE?'recovery.mts':'recovery.mjs');await writeFile(path,module);
 const api=await import(pathToFileURL(path));
 return{api,elements,attributes,get ack(){return ack;},event:(phase,revision)=>listener({payload:{phase,revision}}),dispose:()=>rm(root,{recursive:true,force:true})};
}

test('probation renders then acknowledges readiness while withholding startup until native Success',async()=>{
 const f=await fixture();try{let continued=false;const startup=f.api.initializeUpdateRestart('main',()=>true).then(()=>continued=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.ack,1);assert.equal(continued,false);assert(f.elements.has('update-probation'));
 f.event('awaitingSuccess',2);await Promise.resolve();assert.equal(continued,false);
 f.event('succeeded',3);await startup;assert.equal(continued,true);assert(!f.elements.has('update-probation'));
 }finally{await f.dispose();}
});
test('native evidence loss rejects startup and a stale Success cannot admit work',async()=>{
 const f=await fixture();try{const startup=f.api.initializeUpdateRestart('main',()=>true);const rejection=assert.rejects(startup,/repair/);
 await new Promise(resolve=>setImmediate(resolve));f.event('recoveryRequired',3);await rejection;
 f.event('succeeded',2);assert(f.elements.has('update-probation'));assert(f.elements.has('update-recovery-notice'));
 }finally{await f.dispose();}
});
test('ordinary startup remains immediate and does not show probation',async()=>{
 const f=await fixture('idle'),frames=[];globalThis.requestAnimationFrame=fn=>frames.push(fn);
 try{let completed=false;const startup=f.api.initializeUpdateRestart('main',()=>true).then(()=>completed=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,true,'ordinary startup must not wait for animation frames in a background window');
 await startup;assert.equal(f.ack,1);assert.equal(frames.length,0);assert(!f.elements.has('update-probation'));
 }finally{while(frames.length)frames.shift()();await f.dispose();}
});

test('cleanup deferral preserves successful startup and shows a separate nonfatal notice',async()=>{
 const f=await fixture();try{
 const startup=f.api.initializeUpdateRestart('main',()=>true);
 await new Promise(resolve=>setImmediate(resolve));f.event('succeeded',2);await startup;
 f.event('cleanupPending',3);
 assert(!f.elements.has('update-probation'));assert(!f.elements.has('update-recovery-notice'));
 assert.match(f.elements.get('update-cleanup-notice')?.textContent??'',/update succeeded/i);
 f.event('cleaned',4);assert(!f.elements.has('update-cleanup-notice'));
 }finally{await f.dispose();}
});

test('actual probation still requires both rendered frames and authenticated native Success',async()=>{
 const f=await fixture(),frames=[];globalThis.requestAnimationFrame=fn=>frames.push(fn);
 try{let completed=false;const startup=f.api.initializeUpdateRestart('main',()=>true).then(()=>completed=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.ack,0);assert.equal(completed,false);assert.equal(frames.length,1);
 frames.shift()();assert.equal(f.ack,0);assert.equal(frames.length,1);
 frames.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.ack,1);assert.equal(completed,false);
 f.event('succeeded',2);await startup;assert.equal(completed,true);
 }finally{while(frames.length)frames.shift()();await f.dispose();}
});
test('actual app orders rendered readiness before native workspace or connection admission',async()=>{
 const source=await readFile(process.env.HEALTH_APP_SOURCE??new URL('../src/app.ts',import.meta.url),'utf8');
 const handshake=source.indexOf('await initializeUpdateRestart(');assert(handshake>=0);
 const registration=source.indexOf('await Promise.all(store.workspaces.map(w => registerWorkspace(w.id)))');
 assert(handshake<registration);assert(source.lastIndexOf('render();',handshake)>=0);
 assert(source.indexOf('openConnection(workspace());',handshake)>registration);
});
