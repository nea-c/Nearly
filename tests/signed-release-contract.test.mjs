import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import * as contract from '../.github/scripts/signed-release-contract.mjs';
import {fixture} from './helpers/updater-proof-fixture.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const env={GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_SHA:'b'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',GITHUB_WORKFLOW_REF:'nea-c/Nearly/.github/workflows/release-signed-windows.yml@refs/heads/main',RELEASE_COMMIT:'a'.repeat(40),RELEASE_TAG:'r3.1',RELEASE_MODE:'release',RELEASE_CONFIRM:`release r3.1 ${'a'.repeat(40)}`};
function request(){return contract.parseSignedRequest(env);}
test('signed requests bind manual main workflow, canonical release confirmation and run attempt',()=>{
  assert.equal(request().runAttempt,'2');
  for(const field of ['GITHUB_WORKFLOW_REF','GITHUB_EVENT_NAME','GITHUB_REF','RELEASE_COMMIT','RELEASE_TAG','RELEASE_CONFIRM','GITHUB_RUN_ATTEMPT'])assert.throws(()=>contract.parseSignedRequest({...env,[field]:'wrong'}));
});

test('verification-only signing requires its own exact confirmation and stays distinct from release',()=>{
  const verification={...env,RELEASE_MODE:'verify-signature',RELEASE_CONFIRM:`verify-signature r3.1 ${env.RELEASE_COMMIT}`};
  assert.equal(contract.parseSignedRequest(verification).mode,'verify-signature');
  for(const confirmation of ['',env.RELEASE_CONFIRM,`verify-signature r3.1 ${'c'.repeat(40)}`])assert.throws(()=>contract.parseSignedRequest({...verification,RELEASE_CONFIRM:confirmation}));
});
test('artifact metadata binds immutable ID/digest/repository/controller/run and exact attempt name',()=>{
  const r=request(),expected={id:'41',role:'unsigned',digest:'c'.repeat(64),repositoryId:7};
  const a={id:41,name:'nearly-unsigned-123-2',expired:false,size_in_bytes:100,digest:'sha256:'+'c'.repeat(64),workflow_run:{id:123,repository_id:7,head_repository_id:7,head_branch:'main',head_sha:r.workflowCommit}};
  assert.equal(contract.validateArtifact(a,r,expected),true);
  for(const field of ['id','name','digest','expired'])assert.throws(()=>contract.validateArtifact({...a,[field]:field==='expired'?true:'wrong'},r,expected));
  for(const field of ['id','repository_id','head_repository_id','head_branch','head_sha'])assert.throws(()=>contract.validateArtifact({...a,workflow_run:{...a.workflow_run,[field]:'wrong'}},r,expected));
});
async function unsignedFixture(t,mode='release'){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-signed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bundle=path.join(dir,'unsigned');await fs.mkdir(bundle);
  const r={...request(),mode},f=fixture(),payload=Buffer.alloc(256);payload.write('MZ');payload.writeUInt32LE(64,0x3c);payload.write('PE\0\0',64);payload.writeUInt16LE(0x8664,68);
  const file='Nearly_r3.1_x64-setup.exe',checksum=Buffer.from(`${sha(f.installer)}  ${file}\n`);
  const m={schemaVersion:1,kind:'unsigned-updater',repository:r.repository,commit:r.commit,tree:'d'.repeat(40),tag:r.tag,version:r.version,workflowCommit:r.workflowCommit,runId:r.runId,runAttempt:r.runAttempt,mode:r.mode,publicKeySha256:'2592845a518adb9df5b7773dd58672ea411b3038758bfaf2808a3cb13dcc8695',payload:{name:'Nearly.exe',bytes:payload.length,sha256:sha(payload)},assets:[{name:file,bytes:f.installer.length,sha256:sha(f.installer)},{name:file+'.sha256',bytes:checksum.length,sha256:sha(checksum)}]};
  const bytes=contract.canonical(m);await fs.writeFile(path.join(bundle,'unsigned-manifest.json'),bytes);await fs.writeFile(path.join(bundle,file),f.installer);await fs.writeFile(path.join(bundle,file+'.sha256'),checksum);await fs.writeFile(path.join(bundle,'Nearly.exe'),payload);
  return{dir,bundle,r,m,file,manifestHash:sha(bytes),installer:f.installer};
}
test('unsigned verifier and signing-plan bind final loose payload and immutable artifact identity',async t=>{
  const f=await unsignedFixture(t),options={manifestHash:f.manifestHash,artifactId:'41'};
  const result=await contract.verifyUnsignedBundle(f.bundle,f.r,options);assert.equal(result.manifest.payload.sha256,f.m.payload.sha256);
  const plan=await contract.createSigningPlan(f.bundle,path.join(f.dir,'plan.json'),f.r,options);
  assert.equal(plan.manifest.artifactId,'41');assert.equal(plan.manifest.payloadSha256,f.m.payload.sha256);assert.equal(plan.manifest.updaterProtocol,3);
  await assert.rejects(()=>contract.createSigningPlan(f.bundle,path.join(f.dir,'plan.json'),f.r,options));
  await fs.writeFile(path.join(f.bundle,'Nearly.exe'),Buffer.from('tampered'));
  await assert.rejects(()=>contract.verifyUnsignedBundle(f.bundle,f.r,options));
});
test('unsigned bundle rejects extra files, wrong run/attempt, manifest digest and same-name directories',async t=>{
  const f=await unsignedFixture(t),options={manifestHash:f.manifestHash,artifactId:'41'};
  for(const change of [{runId:'9'},{runAttempt:'1'},{workflowCommit:'e'.repeat(40)},{mode:'verify-signature'}])await assert.rejects(()=>contract.verifyUnsignedBundle(f.bundle,{...f.r,...change},options));
  await assert.rejects(()=>contract.verifyUnsignedBundle(f.bundle,f.r,{...options,manifestHash:'e'.repeat(64)}));
  await fs.writeFile(path.join(f.bundle,'unreviewed.txt'),'x');await assert.rejects(()=>contract.verifyUnsignedBundle(f.bundle,f.r,options));
  await fs.unlink(path.join(f.bundle,'unreviewed.txt'));await fs.unlink(path.join(f.bundle,'Nearly.exe'));await fs.mkdir(path.join(f.bundle,'Nearly.exe'));await assert.rejects(()=>contract.verifyUnsignedBundle(f.bundle,f.r,options));
});
test('signed bundle needs independent valid signature before any publishable bundle is created',async t=>{
  const f=await unsignedFixture(t),options={manifestHash:f.manifestHash,artifactId:'41',toolArtifactId:'42',toolManifestHash:'f'.repeat(64)};
  await fs.writeFile(path.join(f.bundle,f.file+'.sig'),'bad');
  await assert.rejects(()=>contract.createSignedBundle(f.bundle,path.join(f.dir,'signed'),f.r,options));
  assert.equal(await fs.stat(path.join(f.dir,'signed')).then(()=>true,()=>false),false);
});
test('signed bundle contains exactly three public assets and binds every producer job output',async t=>{
  const f=await unsignedFixture(t),proof=fixture({payloadSha256:f.m.payload.sha256});
  const options={manifestHash:f.manifestHash,artifactId:'41',toolArtifactId:'42',toolManifestHash:'f'.repeat(64),trustedPublicRaw:proof.publicRaw};
  await fs.writeFile(path.join(f.bundle,f.file+'.sig'),proof.signature);
  const output=path.join(f.dir,'signed'),result=await contract.createSignedBundle(f.bundle,output,f.r,options);
  const verifyOptions={manifestHash:result.manifestHash,unsignedArtifactId:'41',unsignedManifestHash:f.manifestHash,toolArtifactId:'42',toolManifestHash:options.toolManifestHash,trustedPublicRaw:proof.publicRaw};
  const verified=await contract.verifySignedBundle(output,f.r,verifyOptions);assert.equal(verified.assets.length,3);
  assert.equal(verified.manifest.mode,'release');
  await assert.rejects(()=>contract.verifySignedBundle(output,{...f.r,mode:'verify-signature'},verifyOptions));
  assert.equal((await fs.readdir(output)).includes('Nearly.exe'),false);
  for(const field of ['unsignedArtifactId','unsignedManifestHash','toolArtifactId','toolManifestHash'])await assert.rejects(()=>contract.verifySignedBundle(output,f.r,{...verifyOptions,[field]:'wrong'}));
  await fs.writeFile(path.join(output,f.file+'.sig'),'tampered');await assert.rejects(()=>contract.verifySignedBundle(output,f.r,verifyOptions));
});

test('verification-only signed bundle round-trips with mode bound and cannot be relabelled as release',async t=>{
  const f=await unsignedFixture(t,'verify-signature'),proof=fixture({payloadSha256:f.m.payload.sha256});
  const options={manifestHash:f.manifestHash,artifactId:'41',toolArtifactId:'42',toolManifestHash:'f'.repeat(64),trustedPublicRaw:proof.publicRaw};
  await fs.writeFile(path.join(f.bundle,f.file+'.sig'),proof.signature);
  const output=path.join(f.dir,'signed'),result=await contract.createSignedBundle(f.bundle,output,f.r,options);
  const verifiedOptions={manifestHash:result.manifestHash,unsignedArtifactId:'41',unsignedManifestHash:f.manifestHash,toolArtifactId:'42',toolManifestHash:options.toolManifestHash,trustedPublicRaw:proof.publicRaw};
  assert.equal((await contract.verifySignedBundle(output,f.r,verifiedOptions)).manifest.mode,'verify-signature');
  await assert.rejects(()=>contract.verifySignedBundle(output,{...f.r,mode:'release'},verifiedOptions));
});

test('final packaging adapter binds real build metadata and rejects drift before output creation',async t=>{
  const f=await unsignedFixture(t),root=path.join(f.dir,'source');
  await fs.mkdir(path.join(root,'build'),{recursive:true});await fs.mkdir(path.join(root,'src-tauri/src'),{recursive:true});await fs.mkdir(path.join(root,'.github'));
  for(const file of ['.github/updater-public-key.pub','src-tauri/src/update_package.rs','src-tauri/src/startup_update.rs'])await fs.copyFile(new URL('../'+file,import.meta.url),path.join(root,file));
  await fs.writeFile(path.join(root,'version.json'),JSON.stringify({version:f.r.version}));
  await fs.copyFile(path.join(f.bundle,f.file),path.join(root,'build',f.file));
  const meta={version:f.r.version,displayVersion:f.r.tag,identifier:'local.syncfiles.native',payloadArchitecture:'x64',installMode:'currentUser',settingsIncluded:false,adjacentSettingsPreserved:true,updaterInstallationEnabled:true,updaterProtocol:3,signed:false,bytes:f.installer.length,sha256:sha(f.installer),embeddedApplicationSha256:f.m.payload.sha256};
  const info=path.join(root,'build/installer-build-info.json'),options={payloadPath:path.join(f.bundle,'Nearly.exe'),tree:f.m.tree};
  await fs.writeFile(info,JSON.stringify(meta));
  const output=path.join(f.dir,'packaged'),result=await contract.createUnsignedBundle(root,output,f.r,options);
  await contract.verifyUnsignedBundle(output,f.r,{manifestHash:result.manifestHash,artifactId:'41'});
  for(const change of [{updaterProtocol:2},{signed:true},{updaterInstallationEnabled:false},{embeddedApplicationSha256:'f'.repeat(64)},{sha256:'f'.repeat(64)}]){
    await fs.writeFile(info,JSON.stringify({...meta,...change}));
    const rejected=path.join(f.dir,'rejected');await assert.rejects(()=>contract.createUnsignedBundle(root,rejected,f.r,options));
    assert.equal(await fs.stat(rejected).then(()=>true,()=>false),false);
  }
});

test('signing-plan rejects a QA-marked payload even with consistent manifest hashes',async t=>{
 const f=await unsignedFixture(t),payload=await fs.readFile(path.join(f.bundle,'Nearly.exe'));
 payload.write('NEARLY-INSTALLER-QA-ONLY-v1',128);f.m.payload.sha256=sha(payload);
 await fs.writeFile(path.join(f.bundle,'Nearly.exe'),payload);
 const bytes=contract.canonical(f.m);await fs.writeFile(path.join(f.bundle,'unsigned-manifest.json'),bytes);
 await assert.rejects(()=>contract.createSigningPlan(f.bundle,path.join(f.dir,'qa-plan.json'),f.r,{manifestHash:sha(bytes),artifactId:'41'}),/QA-only/);
 assert.equal(await fs.stat(path.join(f.dir,'qa-plan.json')).then(()=>true,()=>false),false);
});
