import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createToolBundle,verifyToolBundle} from '../.github/scripts/signed-tool-contract.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const required=['.github/signing-dependencies.json','.github/updater-public-key.pub','.github/scripts/prepare-signing-tools.ps1','.github/scripts/signed-tool-contract.mjs','.github/scripts/signed-release-contract.mjs','.github/scripts/release-contract.mjs','.github/scripts/release-trust.mjs','tools/updater-signer/Cargo.toml','tools/updater-signer/Cargo.lock','tools/updater-signer/build.rs','tools/updater-signer/src/lib.rs','tools/updater-signer/src/main.rs','src-tauri/src/update_package.rs'];
test('trusted tool bundle binds clean controller Git tree, complete inputs, exact executable bytes and dependency lock',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-tool-contract-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,'control'),pair=path.join(temp,'pair');await fs.mkdir(pair);await fs.mkdir(root);
  const pe=Buffer.alloc(256);pe.write('MZ');pe.writeUInt32LE(64,0x3c);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);
  const signer=path.join(temp,'signer.exe');await fs.writeFile(signer,pe);await fs.writeFile(path.join(pair,'7z.exe'),pe);await fs.writeFile(path.join(pair,'7z.dll'),pe);
  for(const name of required){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.copyFile(path.join(project,name),path.join(root,name));}
  // Fixture controller is an isolated, generated Git repository; never commits
  // or modifies the user's real worktree and contains no private material.
  const lock=JSON.parse(await fs.readFile(path.join(root,'.github/signing-dependencies.json'),'utf8'));lock.files={'7z.exe':sha(pe),'7z.dll':sha(pe)};await fs.writeFile(path.join(root,'.github/signing-dependencies.json'),JSON.stringify(lock));
  const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-b','main']);git(['add','.']);git(['-c','user.name=Generated fixture','-c','user.email=fixture@users.noreply.github.com','commit','-m','Generated trusted-tool fixture']);
  const r={repository:'nea-c/Nearly',workflowCommit:git(['rev-parse','HEAD']),runId:'123',runAttempt:'2',mode:'verify-signature'},out=path.join(temp,'bundle');
  const result=await createToolBundle(root,out,r,{signerPath:signer,extractorDirectory:pair});
  assert.equal((await verifyToolBundle(root,out,r,{manifestHash:result.manifestHash})).assets.length,3);
  await assert.rejects(()=>verifyToolBundle(root,out,{...r,mode:'release'},{manifestHash:result.manifestHash}));
  await assert.rejects(()=>verifyToolBundle(root,out,{...r,runAttempt:'3'},{manifestHash:result.manifestHash}));
  await fs.writeFile(path.join(out,'7z.dll'),Buffer.from('tampered'));await assert.rejects(()=>verifyToolBundle(root,out,r,{manifestHash:result.manifestHash}));
  await fs.writeFile(path.join(root,'tools/updater-signer/src/main.rs'),'dirty');await assert.rejects(()=>createToolBundle(root,path.join(temp,'another'),r,{signerPath:signer,extractorDirectory:pair}));
});
