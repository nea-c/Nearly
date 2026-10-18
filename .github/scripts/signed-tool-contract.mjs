import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256,auditBytes,assertSafeSourcePath} from './release-contract.mjs';
import {regular,canonical,oid,digest,pe} from './signed-release-contract.mjs';
import {publicKeySha256,loadTrustedPublicKey} from './release-trust.mjs';
const inputs=['.github/signing-dependencies.json','.github/updater-public-key.pub','.github/scripts/prepare-signing-tools.ps1','.github/scripts/signed-tool-contract.mjs','.github/scripts/signed-release-contract.mjs','.github/scripts/release-contract.mjs','.github/scripts/release-trust.mjs','tools/updater-signer/Cargo.toml','tools/updater-signer/Cargo.lock','tools/updater-signer/build.rs','tools/updater-signer/src/lib.rs','tools/updater-signer/src/main.rs','src-tauri/src/update_package.rs'];
const names=['nearly-updater-signer.exe','7z.exe','7z.dll'];
const fail=m=>{throw Error(m);};
export async function collectToolInputs(root,r){
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true}).trim();
  if(git('rev-parse','HEAD')!==r.workflowCommit||git('status','--porcelain=v1','--untracked-files=all'))fail('Trusted controller checkout changed');
  const tree=git('rev-parse','HEAD^{tree}');if(!oid(tree))fail('Invalid controller tree');
  const tracked=git('ls-files','-z','--','.github','tools/updater-signer','src-tauri/src/update_package.rs').split('\0').filter(Boolean).sort();
  if(inputs.some(name=>!tracked.includes(name)))fail('Incomplete trusted build source closure');
  const sources=[];for(const name of tracked){assertSafeSourcePath(name);sources.push({name,sha256:sha256(await regular(path.join(root,name),16*1024*1024))});}
  return{controllerTree:tree,sources};
}
export async function createToolBundle(root,output,r,{signerPath,extractorDirectory}){
  await loadTrustedPublicKey(root);
  const sourceInputs=await collectToolInputs(root,r),lockBytes=await regular(path.join(root,'.github/signing-dependencies.json'),16384),lock=JSON.parse(lockBytes);
  const files=[await regular(signerPath),await regular(path.join(extractorDirectory,'7z.exe')),await regular(path.join(extractorDirectory,'7z.dll'))];
  for(const bytes of files)pe(bytes,0x8664);
  if(lock.schemaVersion!==1||lock.toolchain!=='1.97.1'||sha256(files[1])!==lock.files['7z.exe']||sha256(files[2])!==lock.files['7z.dll'])fail('Unreviewed CI extractor pair');
  auditBytes(files[0],[root,process.env.USERPROFILE,process.env.GITHUB_WORKSPACE,process.env.RUNNER_TEMP]);
  const m={schemaVersion:1,kind:'trusted-signer',repository:r.repository,workflowCommit:r.workflowCommit,runId:r.runId,runAttempt:r.runAttempt,mode:r.mode,toolchain:'1.97.1',publicKeySha256,dependencyLockSha256:sha256(lockBytes),inputs:sourceInputs,assets:files.map((data,i)=>({name:names[i],bytes:data.length,sha256:sha256(data)}))};
  await fs.mkdir(output);for(const [i,data]of files.entries())await fs.writeFile(path.join(output,names[i]),data,{flag:'wx'});const bytes=canonical(m);await fs.writeFile(path.join(output,'tool-manifest.json'),bytes,{flag:'wx'});return{manifestHash:sha256(bytes)};
}
export async function verifyToolBundle(root,dir,r,{manifestHash}){
  await loadTrustedPublicKey(root);
  const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||JSON.stringify((await fs.readdir(dir)).sort())!==JSON.stringify([...names,'tool-manifest.json'].sort())||!digest(manifestHash))fail('Unexpected trusted tool bundle');
  const bytes=await regular(path.join(dir,'tool-manifest.json'),131072),m=JSON.parse(bytes),lockBytes=await regular(path.join(root,'.github/signing-dependencies.json'),16384),lock=JSON.parse(lockBytes);
  if(sha256(bytes)!==manifestHash||!canonical(m).equals(bytes)||JSON.stringify(Object.keys(m).sort())!==JSON.stringify(['schemaVersion','kind','repository','workflowCommit','runId','runAttempt','mode','toolchain','publicKeySha256','dependencyLockSha256','inputs','assets'].sort())||m.schemaVersion!==1||m.kind!=='trusted-signer'||m.toolchain!=='1.97.1'||m.publicKeySha256!==publicKeySha256||m.dependencyLockSha256!==sha256(lockBytes)||['repository','workflowCommit','runId','runAttempt','mode'].some(k=>m[k]!==r[k])||!canonical(m.inputs).equals(canonical(await collectToolInputs(root,r))))fail('Trusted tool provenance mismatch');
  if(!Array.isArray(m.assets)||m.assets.length!==3)fail('Invalid trusted tool assets');
  for(const [i,a]of m.assets.entries()){if(JSON.stringify(Object.keys(a).sort())!=='["bytes","name","sha256"]'||a.name!==names[i]||!digest(a.sha256)||!Number.isSafeInteger(a.bytes)||a.bytes<=0)fail('Invalid tool descriptor');const data=await regular(path.join(dir,a.name));if(data.length!==a.bytes||sha256(data)!==a.sha256)fail('Tool bytes changed');pe(data,0x8664);if(i&&sha256(data)!==lock.files[a.name])fail('Unreviewed extractor bytes');}
  return m;
}
