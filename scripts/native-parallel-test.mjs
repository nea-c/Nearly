import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Processes,cancellation,fixtureDirectory,assertHarnessResult} from './native-test-process.mjs';

export const standardArgs=['--skip','install_root::native::tests::ordinary_inherited_namespace_is_admitted_by_production_validation','--skip','install_root::native::tests::generated_custom_root_payload_current_identity_and_namespace_guards','--test-threads=1'];
export const fixtureCommands=[['sync-difference-test.mjs','sync_difference_generated_localhost'],['sync-difference-test.mjs','directory_deletion_generated_localhost'],['listing-worker-test.mjs'],['listing-existing-pipeline-test.mjs']];

export function resolveBuild(rows,root,target,runtime,environment=process.env) {
  const finished=rows.filter(row=>row.reason==='build-finished');
  if(finished.length!==1 || finished[0].success!==true)throw Error('One successful Cargo build required');
  const artifacts=rows.filter(row=>row.reason==='compiler-artifact' && row.profile?.test===true && row.executable && path.resolve(row.manifest_path)===path.join(root,'Cargo.toml'));
  const executables=[...new Set(artifacts.map(row=>path.resolve(row.executable)))];
  const main=artifacts.filter(row=>row.target.name==='nearly' && row.target.kind.includes('bin'));
  if(!executables.length || main.length!==1)throw Error('Root package main test executable required');
  const deps=path.join(target,'debug','deps');
  for(const executable of executables)if(path.dirname(executable)!==deps || !fs.statSync(executable).isFile())throw Error('Cargo test executable outside expected target deps');
  const runtimePaths=[];
  for(const row of rows)if(row.reason==='build-script-executed')for(const value of row.linked_paths??[]) {
    const directory=path.resolve(value.replace(/^(native|dependency|crate|framework|all)=/,''));
    if(directory.startsWith(target+path.sep))runtimePaths.push(directory);
  }
  runtimePaths.push(deps,path.join(target,'debug'),runtime);
  for(const directory of runtimePaths)if(!path.isAbsolute(directory)||!fs.statSync(directory).isDirectory())throw Error('Missing native runtime directory');
  // Cargo executes each harness from its package root and supplies these variables.
  const packageInfo=fs.readFileSync(path.join(root,'Cargo.toml'),'utf8');
  const version=packageInfo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]??'';
  const [numeric,pre='']=version.split('-');const [major,minor,patch]=numeric.split('.');
  const env={...environment,CARGO_MANIFEST_DIR:root,CARGO_MANIFEST_PATH:path.join(root,'Cargo.toml'),CARGO_PKG_NAME:'nearly',CARGO_PKG_VERSION:version,CARGO_PKG_VERSION_MAJOR:major??'',CARGO_PKG_VERSION_MINOR:minor??'',CARGO_PKG_VERSION_PATCH:patch??'',CARGO_PKG_VERSION_PRE:pre,CARGO_PKG_AUTHORS:'',CARGO_PKG_DESCRIPTION:'',CARGO_PKG_HOMEPAGE:'',CARGO_PKG_REPOSITORY:'',CARGO_PKG_LICENSE:'Apache-2.0',CARGO_PKG_LICENSE_FILE:'',CARGO_PKG_RUST_VERSION:'',PATH:[...new Set(runtimePaths),environment.PATH??environment.Path??''].join(path.delimiter)};
  // Windows environment keys are case-insensitive; Node otherwise picks one alphabetically.
  for(const key of Object.keys(env))if(key.toUpperCase()==='PATH' && key!=='PATH')delete env[key];
  return {executables,mainExecutable:path.resolve(main[0].executable),cwd:root,env};
}

export async function executeLanes(context,{root,output,processes=new Processes(),commands=fixtureCommands}={}) {
  const manifest=path.join(output,'test-executables.json');
  // Only runtime additions need to cross the child boundary; never persist inherited secrets.
  const runtimeKeys=new Set(['PATH','CARGO_MANIFEST_DIR','CARGO_MANIFEST_PATH','CARGO_PKG_NAME','CARGO_PKG_VERSION','CARGO_PKG_VERSION_MAJOR','CARGO_PKG_VERSION_MINOR','CARGO_PKG_VERSION_PATCH','CARGO_PKG_VERSION_PRE','CARGO_PKG_AUTHORS','CARGO_PKG_DESCRIPTION','CARGO_PKG_HOMEPAGE','CARGO_PKG_REPOSITORY','CARGO_PKG_LICENSE','CARGO_PKG_LICENSE_FILE','CARGO_PKG_RUST_VERSION']);
  const saved={...context,env:Object.fromEntries(Object.entries(context.env).filter(([key])=>runtimeKeys.has(key)))};
  fs.writeFileSync(manifest,JSON.stringify(saved,null,2));
  const env={...context.env,NEARLY_NATIVE_TEST_MANIFEST:manifest,NEARLY_NATIVE_PARALLEL:'1'};
  const normal=async()=>{for(const [index,executable] of context.executables.entries()){
    const result=await processes.run(executable,standardArgs,{cwd:context.cwd,env:context.env,log:path.join(output,`normal-${index}.log`),capture:'tee'});
    assertHarnessResult(result);
  }};
  const localhost=async()=>{for(const [index,command] of commands.entries())await processes.run(process.execPath,[path.join(root,'scripts',command[0]),...command.slice(1)],{cwd:root,env,ipc:true,log:path.join(output,`localhost-${index}.log`)});};
  const results=await Promise.allSettled([normal().catch(async error=>{await processes.stop();throw error;}),localhost().catch(async error=>{await processes.stop();throw error;})]);
  fs.writeFileSync(path.join(output,'lane-results.json'),JSON.stringify(results.map((result,index)=>({lane:index?'localhost':'normal',status:result.status,error:result.reason?.message})),null,2));
  const failures=results.filter(result=>result.status==='rejected');
  if(failures.length || processes.cancelled)throw new AggregateError(failures.map(result=>result.reason),'Native lane failed or cancelled');
}

export async function main() {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const output=fixtureDirectory('native-parallel');
  const processes=new Processes();const dispose=cancellation(processes);
  console.log('Native parallel results:',output);
  try {
    const json=await processes.run('cargo',['+1.97.1','test','--no-run','--offline','--locked','--message-format=json','--manifest-path',path.join(root,'src-tauri','Cargo.toml')],{cwd:root,capture:true,log:path.join(output,'cargo-build.jsonl')});
    const runtime=(await processes.run('rustc',['+1.97.1','--print','target-libdir'],{cwd:root,capture:true})).trim();
    const target=path.resolve(process.env.CARGO_TARGET_DIR||path.join(root,'src-tauri','target'));
    const context=resolveBuild(json.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)),path.join(root,'src-tauri'),target,runtime);
    await executeLanes(context,{root,output,processes});
  }finally{await processes.stop();dispose();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
