import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dependencyPathAllowed,collectBuildContext,saveLocalCache,restoreLocalCache} from '../.github/scripts/dependency-cache.mjs';

const registry='registry+https://github.com/rust-lang/crates.io-index';
const custom=name=>({name,kind:['custom-build'],crate_types:['bin']});
const hash='0123456789abcdef';
const graph=[
 {name:'aws-lc-sys',source:registry,targets:[custom('build-script-main')]},
 {name:'serde',source:registry,targets:[custom('build-script-build')]},
 {name:'other',source:registry,targets:[{name:'build-script-main',kind:['bin'],crate_types:['bin']}]},
 {name:'local',source:null,targets:[custom('build-script-main')]},
 {name:'nearly',root:true,source:null,targets:[custom('build-script-main')]},
];

test('cache includes only the owning registry custom-build target, including nondefault main names',()=>{
 for(const [role,profile]of [['native-debug','debug'],['unsigned-release','release']]){
  for(const file of [`build_script_main-${hash}.exe`,`build_script_main-${hash}.pdb`,`build_script_main-${hash}.d`,'build-script-main.exe']){
   assert.equal(dependencyPathAllowed(`${profile}/build/aws-lc-sys-${hash}/${file}`,role,graph),true,file);
  }
  assert.equal(dependencyPathAllowed(`${profile}/build/serde-${hash}/build_script_build-${hash}.exe`,role,graph),true);
  for(const file of ['Nearly.exe','helper.exe','build-script-build.exe',`build_script_main-${'f'.repeat(16)}.exe`]){
   assert.equal(dependencyPathAllowed(`${profile}/build/aws-lc-sys-${hash}/${file}`,role,graph),false,file);
  }
  for(const owner of ['other','local','nearly','unknown','serde']){
   assert.equal(dependencyPathAllowed(`${profile}/build/${owner}-${hash}/build_script_main-${hash}.exe`,role,graph),false,owner);
  }
 }
});

test('offline Cargo reuses a nondefault registry build script without rerunning it or caching the application',async t=>{
 if(process.env.NEARLY_CACHE_CARGO_FIXTURE!=='1'){t.skip('explicit offline Cargo qualification');return;}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-custom-build-cache-'));
 try{
  const source=path.join(root,'source'),crate=path.join(source,'registry/custom-build-sys');
  const write=async(file,data)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);};
  // Synthetic directory-source registry: no published dependency is edited.
  const files={
   'Cargo.toml':'[package]\nname="custom-build-sys"\nversion="1.0.0"\nedition="2021"\nbuild="builder/main.rs"\n',
   'src/lib.rs':'include!(concat!(env!("OUT_DIR"), "/generated.rs"));\n',
   'builder/main.rs':'use std::{fs,io::Write,path::PathBuf};fn main(){let p=std::env::var_os("NEARLY_CUSTOM_BUILD_MARKER").unwrap();fs::OpenOptions::new().create(true).append(true).open(p).unwrap().write_all(b"run\\n").unwrap();fs::write(PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("generated.rs"),"pub const VALUE:u32=42;").unwrap();println!("cargo:rerun-if-changed=builder/main.rs");}\n',
  };
  for(const [file,data]of Object.entries(files))await write(path.join(crate,file),data);
  await write(path.join(crate,'.cargo-checksum.json'),JSON.stringify({package:'1'.repeat(64),files:Object.fromEntries(Object.entries(files).map(([file,data])=>[file,createHash('sha256').update(data).digest('hex')]))}));
  await write(path.join(source,'.cargo/config.toml'),'[source.crates-io]\nreplace-with="fixture-registry"\n[source.fixture-registry]\ndirectory="registry"\n');
  const manifest=version=>`[package]\nname="nearly"\nversion="${version}"\nedition="2021"\n[features]\ncustom-protocol=[]\n[dependencies]\ncustom-build-sys="=1.0.0"\n`;
  await write(path.join(source,'Cargo.toml'),manifest('3.6.0'));await write(path.join(source,'src/main.rs'),'fn main(){let _=custom_build_sys::VALUE;}\n');
  for(const role of ['native-debug','unsigned-release']){
   const target=path.join(root,role+'-target'),bundle=path.join(root,role+'-bundle'),marker=path.join(root,role+'-marker');
   const env={...process.env,CARGO_INCREMENTAL:'0',NEARLY_CUSTOM_BUILD_MARKER:marker};delete env.CARGO_TARGET_DIR;
   const cargo=(args,extra={})=>{const r=spawnSync('cargo',['+1.97.1',...args],{cwd:source,env:{...env,...extra},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
   cargo(['generate-lockfile','--offline']);
   const context=await collectBuildContext({source,role,env,policyHash:'b'.repeat(64)});
   const args=['build','--offline','--locked','--message-format=json',...(role==='unsigned-release'?['--release','--features','custom-protocol']:[])];
   cargo(args,{CARGO_TARGET_DIR:target});assert.equal(await fs.readFile(marker,'utf8'),'run\n');
   assert.equal((await saveLocalCache({target,bundle,context})).saved,true);
   const {manifest:stored}=JSON.parse(await fs.readFile(path.join(bundle,'manifest.json'),'utf8'));
   assert.ok(stored.files.some(f=>/\/build_script_main-[a-f0-9]{16}\.exe$/.test(f.path)),'custom build script must be stored');
   assert.ok(stored.files.every(f=>!f.path.includes('/nearly-')&&!/\/nearly\.exe$/i.test(f.path)),'app outputs must be absent');
   // CI reuses the same absolute target path across ephemeral runners.
   const backup=path.join(root,role+'-previous');assert.equal(path.dirname(target),root);assert.equal(path.dirname(backup),root);await fs.rename(target,backup);
   await write(path.join(source,'Cargo.toml'),manifest('3.7.0'));cargo(['generate-lockfile','--offline']);
   const updated=await collectBuildContext({source,role,env,policyHash:'b'.repeat(64)});assert.equal(updated.key,context.key);
   assert.equal((await restoreLocalCache({target,bundle,context:updated,matchedKey:updated.key})).restored,true);
   const artifacts=cargo(args,{CARGO_TARGET_DIR:target}).trim().split('\n').map(line=>JSON.parse(line)).filter(r=>r.reason==='compiler-artifact');
   assert.ok(artifacts.some(r=>r.target.name==='build-script-main'&&r.fresh),'custom script binary must be Fresh');
   assert.ok(artifacts.some(r=>r.target.name==='custom_build_sys'&&r.fresh),'dependent library must be Fresh');
   assert.ok(artifacts.some(r=>r.target.name==='nearly'&&!r.fresh),'application must compile');
   assert.equal(await fs.readFile(marker,'utf8'),'run\n','custom script must not execute again');
   console.log(JSON.stringify({role,customBuildFresh:true,libraryFresh:true,scriptRuns:1,appRecompiled:true}));
   await write(path.join(source,'Cargo.toml'),manifest('3.6.0'));
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
