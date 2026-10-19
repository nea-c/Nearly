import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateInstallerPolicy, requireCachedTools, publishInstaller} from '../scripts/build-installer.mjs';
import {createPackage,verifyPackage} from '../.github/scripts/release-contract.mjs';

const config = JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
const pe = Buffer.alloc(80); pe.write('MZ'); pe.writeUInt32LE(64,60); pe.writeUInt32LE(0x4550,64);
test('only reviewed per-user unsigned installer policy is accepted',()=>{
  assert.equal(validateInstallerPolicy(config),'Nearly_r3.0_x64-setup.exe');
  for(const [version,label] of [['1.10.0','r1.10'],['2.0.0','r2.0']]) assert.equal(validateInstallerPolicy({...config,version}),`Nearly_${label}_x64-setup.exe`);
  for(const version of ['1.0.1','r1.0','1.0.0-beta','1.0.0+build']) assert.throws(()=>validateInstallerPolicy({...config,version}));
  for(const change of [c=>c.bundle.windows.nsis.installMode='perMachine', c=>c.bundle.createUpdaterArtifacts=true,c=>c.bundle.windows.webviewInstallMode.type='downloadBootstrapper']){
    const c=structuredClone(config);change(c);assert.throws(()=>validateInstallerPolicy(c));
  }
});
test('missing cached compiler fails without fetching tools',async()=>{
  await assert.rejects(requireCachedTools('missing',{access:async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});}}),/No tool was downloaded/);
});
test('outdated cached tool hashes are refused before the CLI can replace them',async()=>{
  await assert.rejects(requireCachedTools('cached',{access:async()=>{},readFile:async()=>Buffer.from('outdated')}),/Refusing automatic tool replacement/);
});
async function fixture(){
  const base=process.env.NEARLY_BUILD_TEST_TEMP || path.resolve('test-results/installer-script-fixtures');
  await fs.mkdir(base,{recursive:true});
  const dir=await fs.mkdtemp(path.join(base,'nearly-installer-test-'));
  await fs.mkdir(path.join(dir,'build'));await fs.writeFile(path.join(dir,'artifact.exe'),pe);
  await fs.writeFile(path.join(dir,'build/settings.json'),'preserve settings');
  await fs.writeFile(path.join(dir,'build/Nearly.exe'),'preserve application');
  return dir;
}
test('publication backs previous pair up and leaves app/settings untouched',async()=>{
  const dir=await fixture(), name='Nearly_r1.0_x64-setup.exe';
  await fs.writeFile(path.join(dir,'build',name),'previous installer');
  await fs.writeFile(path.join(dir,'build/installer-build-info.json'),'previous manifest');
  const result=await publishInstaller(dir,path.join(dir,'artifact.exe'),{version:'1.0.0'});
  assert.deepEqual(await fs.readFile(result.path),pe);
  assert.equal(await fs.readFile(path.join(result.backup,name),'utf8'),'previous installer');
  assert.equal(await fs.readFile(path.join(dir,'build/settings.json'),'utf8'),'preserve settings');
  assert.equal(await fs.readFile(path.join(dir,'build/Nearly.exe'),'utf8'),'preserve application');
  assert.equal(result.signed,false);
  assert.equal(result.version,'1.0.0');
  assert.equal(result.displayVersion,'r1.0');
  assert.equal(result.updaterProtocol,3);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'build/installer-build-info.json'),'utf8')).updaterProtocol,3);
  assert.equal(path.basename(result.path),'Nearly_r1.0_x64-setup.exe');
});
test('publication rejects a conflicting protocol before writing any output',async()=>{
  for(const updaterProtocol of [2,'3',null,0,4]){
    const dir=await fixture();
    await assert.rejects(publishInstaller(dir,path.join(dir,'artifact.exe'),{version:'1.0.0',updaterProtocol}),/updater protocol/);
    assert.deepEqual((await fs.readdir(path.join(dir,'build'))).sort(),['Nearly.exe','settings.json']);
  }
});
test('protocol3 manifest publication leaves retained r2 release bytes immutable',async()=>{
  const dir=await fixture(),name='Nearly_r2.0_x64-setup.exe';
  await fs.writeFile(path.join(dir,'build',name),'published r2 installer');
  const result=await publishInstaller(dir,path.join(dir,'artifact.exe'),{version:'2.1.0',updaterProtocol:3});
  assert.equal(result.updaterProtocol,3);
  assert.equal(await fs.readFile(path.join(dir,'build',name),'utf8'),'published r2 installer');
});
test('protocol3 build metadata remains compatible with the disabled unsigned release controller',async()=>{
  const dir=await fixture(),binary=Buffer.alloc(160);
  binary.write('MZ');binary.writeUInt32LE(64,60);binary.writeUInt32LE(0x4550,64);binary.writeUInt16LE(0x14c,68);
  await fs.writeFile(path.join(dir,'artifact.exe'),binary);
  const payload=Buffer.from(binary);payload.writeUInt16LE(0x8664,68);
  const payloadPath=path.join(dir,'payload.exe');await fs.writeFile(payloadPath,payload);
  await fs.mkdir(path.join(dir,'src-tauri/src'),{recursive:true});
  await fs.writeFile(path.join(dir,'version.json'),'{"version":"1.0.0"}');
  await fs.writeFile(path.join(dir,'src-tauri/src/update_package.rs'),'fn production_key() -> Option<TrustedKey> { None }');
  await fs.writeFile(path.join(dir,'src-tauri/src/startup_update.rs'),'const HANDOFF_RELEASE_VALIDATED: bool = false;');
  const built=await publishInstaller(dir,path.join(dir,'artifact.exe'),{version:'1.0.0',identifier:'local.syncfiles.native',payloadArchitecture:'x64',installMode:'currentUser',settingsIncluded:false,adjacentSettingsPreserved:true,updaterInstallationEnabled:false,embeddedApplicationSha256:createHash('sha256').update(payload).digest('hex')});
  assert.equal(built.updaterProtocol,3);assert.equal(built.signed,false);
  const request={repository:'nea-c/Nearly',commit:'a'.repeat(40),tag:'r1.0',version:'1.0.0',mode:'validate',workflowCommit:'b'.repeat(40),runId:'123'};
  const output=path.join(dir,'release-output');
  const packaged=await createPackage(dir,output,request,{payloadPath,tree:'c'.repeat(40)});
  const checked=await verifyPackage(output,request,{manifestHash:packaged.manifestHash});
  assert.equal(checked.manifest.schemaVersion,1);
  assert.deepEqual((await fs.readdir(output)).sort(),['Nearly_r1.0_x64-setup.exe','Nearly_r1.0_x64-setup.exe.sha256','manifest.json']);
});
test('failed manifest publication restores previous installer and manifest',async()=>{
  const dir=await fixture(), name='Nearly_r1.0_x64-setup.exe';
  await fs.writeFile(path.join(dir,'build',name),'previous installer');
  await fs.writeFile(path.join(dir,'build/installer-build-info.json'),'previous manifest');
  let failed=false;
  const io={...fs,rename:async(a,b)=>{
    if(!failed&&a.includes('.installer-staging-')&&b.endsWith('installer-build-info.json')){failed=true;throw Error('injected write failure');}
    return fs.rename(a,b);
  }};
  await assert.rejects(publishInstaller(dir,path.join(dir,'artifact.exe'),{version:'1.0.0'},io),/publication failed/);
  assert.equal(await fs.readFile(path.join(dir,'build',name),'utf8'),'previous installer');
  assert.equal(await fs.readFile(path.join(dir,'build/installer-build-info.json'),'utf8'),'previous manifest');
  assert.equal(await fs.readFile(path.join(dir,'build/settings.json'),'utf8'),'preserve settings');
});
test('invalid executable and path-shaped version are refused before publication',async()=>{
  const dir=await fixture();await fs.writeFile(path.join(dir,'bad.exe'),'bad');
  await assert.rejects(publishInstaller(dir,path.join(dir,'bad.exe'),{version:'1.0.0'}),/PE executable/);
  await assert.rejects(publishInstaller(dir,path.join(dir,'artifact.exe'),{version:'../escape'}),/output name/);
});
