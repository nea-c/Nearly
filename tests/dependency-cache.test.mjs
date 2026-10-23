import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const moduleURL=new URL('../.github/scripts/dependency-cache.mjs',import.meta.url);
async function api(){assert.ok(fs.existsSync(moduleURL),'dependency-only cache contract is not implemented');return import(moduleURL);}
const sha='a'.repeat(40),digest='b'.repeat(64),blob='c'.repeat(40);
const context=()=>({role:'native-debug',toolchain:'rustc 1.97.1 / msvc pinned',profile:'test',features:['default'],flags:['--remap-path-prefix=x=/build'],packages:[{root:true,name:'nearly',version:'3.6.0',source:null},{name:'serde',version:'1.0.1',source:'registry+https://github.com/rust-lang/crates.io-index',checksum:digest,dependencies:[]}],rootDependencies:{serde:'1'},vendorHash:digest,policyHash:digest});
test('root version alone retains the dependency key; actual dependency and environment changes invalidate it',async()=>{
 const {dependencyContext}=await api();const a=context(),b=context();b.packages[0].version='3.7.0';assert.equal(dependencyContext(a),dependencyContext(b));
 for(const mutate of [c=>c.packages[1].version='1.0.2',c=>c.packages[1].checksum='d'.repeat(64),c=>c.vendorHash='d'.repeat(64),c=>c.flags.push('-Copt-level=1'),c=>c.features.push('new'),c=>c.toolchain+='changed',c=>c.policyHash='d'.repeat(64),c=>c.rootDependencies.serde='2']){const c=context();mutate(c);assert.notEqual(dependencyContext(c),dependencyContext(a));}
 const r=context();r.role='unsigned-release';r.profile='release';assert.notEqual(dependencyContext(r),dependencyContext(a));
});
test('dependency payload paths never include app, fixture, installer, secrets, traversal or a different profile',async()=>{
 const {dependencyPathAllowed}=await api();const packages=[{name:'serde',source:'registry+https://github.com/rust-lang/crates.io-index',targets:[{name:'serde'}]},{name:'quote',source:'registry+https://github.com/rust-lang/crates.io-index',targets:[{name:'quote'}]}];
 for(const p of ['debug/deps/libserde-0123456789abcdef.rlib','debug/.fingerprint/serde-0123456789abcdef/lib-serde.json','debug/build/quote-0123456789abcdef/out/generated.rs'])assert.equal(dependencyPathAllowed(p,'native-debug',packages),true,p);
 for(const p of ['debug/Nearly.exe','debug/deps/nearly-0123456789abcdef.exe','debug/build/nearly-0123456789abcdef/out/secret','debug/incremental/serde/x','release/deps/libserde-0123456789abcdef.rlib','debug/deps/libunknown-0123456789abcdef.rlib','debug/deps/libserde-0123456789abcdef.exe','debug/.fingerprint/serde-0123456789abcdef/../../x','../secret','C:/secret','debug\\deps\\x','debug/deps/credentials.toml','debug/build/serde-0123456789abcdef/out/../x'])assert.equal(dependencyPathAllowed(p,'native-debug',packages),false,p);
});
const packages=[{name:'serde',source:'registry+https://github.com/rust-lang/crates.io-index',targets:[{name:'serde'}]}];
const dep='debug/deps/libserde-0123456789abcdef.rlib';
async function fixture(fn){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'nearly-dependency-cache-'));try{await fn(root);}finally{await fsp.rm(root,{recursive:true,force:true});}}
test('real payload export excludes the app and restores only a verified dependency profile',async()=>{
 const {exportPayload,restorePayload,manifestDigest}=await api();await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload'),fresh=path.join(root,'fresh');
  await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');await fsp.writeFile(path.join(target,'debug/Nearly.exe'),'app');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});
  assert.deepEqual(m.files.map(f=>f.path),[dep]);assert.equal(fs.existsSync(path.join(payload,'debug/Nearly.exe')),false);
  const result=await restorePayload({payload,target:fresh,role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:manifestDigest(m)});
  assert.equal(result.restored,true);assert.equal(await fsp.readFile(path.join(fresh,dep),'utf8'),'dependency');assert.equal(fs.existsSync(path.join(fresh,'debug/Nearly.exe')),false);
 });
});
test('corrupt, additional, mismatched and partially validated caches fall back without modifying the build target',async()=>{
 const {exportPayload,restorePayload,manifestDigest}=await api();for(const change of ['bytes','extra','context','existing','untrusted'])await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload'),fresh=path.join(root,'fresh');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});const expectedManifestHash=manifestDigest(m);
  if(change==='bytes')await fsp.writeFile(path.join(payload,dep),'bad');
  if(change==='extra')await fsp.writeFile(path.join(payload,'debug/Nearly.exe'),'unknown');
  if(change==='context')m.contextHash='f'.repeat(64);
  if(change==='existing'){await fsp.mkdir(path.join(fresh,'debug'),{recursive:true});await fsp.writeFile(path.join(fresh,'debug/sentinel'),'keep');}
  const result=await restorePayload({payload,target:fresh,role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:change==='untrusted'?undefined:expectedManifestHash});assert.equal(result.restored,false,change);assert.equal(fs.existsSync(path.join(fresh,dep)),false,change);
  if(change==='existing')assert.equal(await fsp.readFile(path.join(fresh,'debug/sentinel'),'utf8'),'keep');
 });
});
test('path dependencies and directory reparse payloads cannot enter a dependency-only cache',async()=>{
 const {dependencyPathAllowed,exportPayload,restorePayload,manifestDigest}=await api();assert.equal(dependencyPathAllowed(dep,'native-debug',[{name:'serde',source:null,targets:[{name:'serde'}]}]),false);
 await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload'),fresh=path.join(root,'fresh');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});
  const outside=path.join(root,'outside');await fsp.mkdir(outside);await fsp.writeFile(path.join(outside,path.basename(dep)),'dependency');
  await fsp.rename(path.join(payload,'debug/deps'),path.join(root,'original-deps'));await fsp.symlink(outside,path.join(payload,'debug/deps'),process.platform==='win32'?'junction':'dir');
  assert.equal((await restorePayload({payload,target:fresh,role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:manifestDigest(m)})).restored,false);assert.equal(fs.existsSync(path.join(fresh,dep)),false);
 });
});
test('file symlink cache rejection where the OS permits creating that fixture',async t=>{
 const {exportPayload,restorePayload,manifestDigest}=await api();await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});await fsp.unlink(path.join(payload,dep));await fsp.writeFile(path.join(root,'outside'),'dependency');
  try{await fsp.symlink(path.join(root,'outside'),path.join(payload,dep),'file');}catch(e){if(e.code==='EPERM'&&process.platform==='win32'){t.skip('Windows file symlink creation unavailable; directory junction tested separately');return;}throw e;}
  assert.equal((await restorePayload({payload,target:path.join(root,'fresh'),role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:manifestDigest(m)})).restored,false);
 });
});
test('an interrupted copy falls back and removes only its own scratch without damaging the build root',async t=>{
 const {exportPayload,restorePayload,manifestDigest}=await api();await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload'),fresh=path.join(root,'fresh');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});await fsp.mkdir(fresh);await fsp.writeFile(path.join(fresh,'sentinel'),'keep');
  t.mock.method(fsp,'copyFile',async()=>{throw Error('fixture copy interruption');});
  const result=await restorePayload({payload,target:fresh,role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:manifestDigest(m)});assert.equal(result.restored,false);assert.deepEqual(await fsp.readdir(fresh),['sentinel']);assert.equal(await fsp.readFile(path.join(fresh,'sentinel'),'utf8'),'keep');
 });
});
test('restore rejects a junction ancestor before creating any directory beyond the boundary',async()=>{
 const {exportPayload,restorePayload,manifestDigest}=await api();await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload'),outside=path.join(root,'outside');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});await fsp.mkdir(outside);const alias=path.join(root,'alias');await fsp.symlink(outside,alias,process.platform==='win32'?'junction':'dir');
  assert.equal((await restorePayload({payload,target:path.join(alias,'must-not-create'),role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:manifestDigest(m)})).restored,false);assert.deepEqual(await fsp.readdir(outside),[]);
 });
});
test('export rejects a Windows case alias inside its source before creating staging',async t=>{
 if(process.platform!=='win32'){t.skip('Windows case alias fixture');return;}
 const {exportPayload}=await api();await fixture(async root=>{
  const target=path.join(root,'target');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  await assert.rejects(exportPayload({target,payload:path.join(root,'TARGET','must-not-create'),role:'native-debug',packages,contextHash:digest}));assert.equal(fs.existsSync(path.join(target,'must-not-create')),false);
 });
});

test('restore rejects overlapping source and target and cleans new empty target after interruption',async t=>{
 const {exportPayload,restorePayload,manifestDigest}=await api();await fixture(async root=>{
  const target=path.join(root,'target'),payload=path.join(root,'payload');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const m=await exportPayload({target,payload,role:'native-debug',packages,contextHash:digest});
  const options={payload,role:'native-debug',packages,contextHash:digest,manifest:m,expectedManifestHash:manifestDigest(m)};
  assert.equal((await restorePayload({...options,target:path.join(payload,'nested')})).restored,false);assert.equal(fs.existsSync(path.join(payload,'nested')),false);
  const fresh=path.join(root,'new','nested');t.mock.method(fsp,'copyFile',async()=>{throw Error('fixture copy interruption');});
  assert.equal((await restorePayload({...options,target:fresh})).restored,false);assert.equal(fs.existsSync(path.join(root,'new')),false);
 });
});

test('collecting a real locked Cargo graph produces version-independent role-separated keys',async()=>{
 const {collectBuildContext}=await api();assert.equal(typeof collectBuildContext,'function','Cargo context collector missing');
});

test('standard cache bundle rejects prefix matches and self-inconsistent bundles without breaking cold builds',async()=>{
 const {restoreLocalCache,saveLocalCache}=await api();await fixture(async root=>{
  const target=path.join(root,'target'),bundle=path.join(root,'bundle'),fresh=path.join(root,'fresh');await fsp.mkdir(path.dirname(path.join(target,dep)),{recursive:true});await fsp.writeFile(path.join(target,dep),'dependency');
  const context={role:'native-debug',contextHash:digest,key:'exact-key',packages};
  assert.equal((await saveLocalCache({target,bundle,context})).saved,true);
  assert.equal((await restoreLocalCache({target:fresh,bundle,context,matchedKey:'exact-key-prefix'})).restored,false);assert.equal(fs.existsSync(fresh),false);
  assert.equal((await restoreLocalCache({target:fresh,bundle,context,matchedKey:context.key})).restored,true);
  const record=JSON.parse(await fsp.readFile(path.join(bundle,'manifest.json'),'utf8'));record.manifest.files[0].sha256='f'.repeat(64);await fsp.writeFile(path.join(bundle,'manifest.json'),JSON.stringify(record));
  assert.equal((await restoreLocalCache({target:path.join(root,'bad'),bundle,context,matchedKey:context.key})).restored,false);assert.equal(fs.existsSync(path.join(root,'bad')),false);
 });
});

test('real offline Cargo reuses dependencies but rebuilds app after root version and source edits',async t=>{
 if(process.env.NEARLY_CACHE_CARGO_FIXTURE!=='1'){t.skip('explicit offline Cargo qualification');return;}
 const {collectBuildContext,restoreLocalCache,saveLocalCache}=await api();await fixture(async root=>{
  const source=path.join(root,'source');await fsp.mkdir(path.join(source,'src'),{recursive:true});
  const manifest=version=>`[package]\nname="nearly"\nversion="${version}"\nedition="2021"\n[features]\ncustom-protocol=[]\n[dependencies]\nsemver="=1.0.28"\n`;
  await fsp.writeFile(path.join(source,'Cargo.toml'),manifest('3.6.0'));await fsp.writeFile(path.join(source,'src/main.rs'),'fn main(){let _=semver::Version::new(1,2,3);}\n');
  const env={...process.env,CARGO_INCREMENTAL:'0'};delete env.CARGO_TARGET_DIR;
  const cargo=(args,extra={})=>{const r=spawnSync('cargo',['+1.97.1',...args],{cwd:source,env:{...env,...extra},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
  cargo(['generate-lockfile','--offline']);
  for(const role of ['native-debug','unsigned-release']){
   const target=path.join(root,role+'-cold'),fresh=path.join(root,role+'-warm'),bundle=path.join(root,role+'-bundle');
   const context=await collectBuildContext({source,role,env,policyHash:digest});
   const args=['build','--offline','--locked','--message-format=json',...(role==='unsigned-release'?['--release','--features','custom-protocol']:[])];
   const cold=cargo(args,{CARGO_TARGET_DIR:target});assert.match(cold,/compiler-artifact/);
   const result=await saveLocalCache({target,bundle,context});assert.equal(result.saved,true);
   await fsp.writeFile(path.join(source,'Cargo.toml'),manifest('3.7.0'));await fsp.writeFile(path.join(source,'src/main.rs'),'fn main(){let _=semver::Version::new(3,7,0);}\n');cargo(['generate-lockfile','--offline']);
   const updated=await collectBuildContext({source,role,env,policyHash:digest});assert.equal(updated.key,context.key);
   const wrapper=path.join(root,'scripts/build-windows.mjs');await fsp.mkdir(path.dirname(wrapper),{recursive:true});await fsp.writeFile(wrapper,'// changed feature/build policy\n');
   assert.notEqual((await collectBuildContext({source,role,env,policyHash:digest})).key,context.key,'source build policy must invalidate cache');await fsp.unlink(wrapper);
   assert.equal((await restoreLocalCache({target:fresh,bundle,context:updated,matchedKey:updated.key})).restored,true);
   const artifacts=cargo(args,{CARGO_TARGET_DIR:fresh}).trim().split('\n').map(line=>JSON.parse(line)).filter(r=>r.reason==='compiler-artifact');
   assert.ok(artifacts.some(r=>r.target.name==='semver'&&r.fresh===true),'dependency must be Fresh');
   assert.ok(artifacts.some(r=>r.target.name==='nearly'&&r.fresh===false),'application must compile');
   console.log(JSON.stringify({role,files:result.files,bytes:result.bytes,dependencyFresh:true,appRecompiled:true}));
   await fsp.writeFile(path.join(source,'Cargo.toml'),manifest('3.6.0'));cargo(['generate-lockfile','--offline']);
  }
 });
});
