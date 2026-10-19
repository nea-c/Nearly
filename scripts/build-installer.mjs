import {assertProductionDefaults,assertProductionPayload} from './production-build-policy.mjs';
import {readInstallationGate} from '../.github/scripts/release-trust.mjs';
import {checkVersions,displayVersion} from './version.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {buildOptions,buildPaths} from './build-windows.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const exists=async(f,io=fs)=>{try{await io.access(f);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

export function validateInstallerPolicy(config){
  const b=config.bundle,n=b?.windows?.nsis;
  if(config.identifier!=='local.syncfiles.native'||config.productName!=='Nearly'||config.mainBinaryName!=='Nearly')throw Error('Unexpected application identity');
  const label=displayVersion(config.version);
  if(b?.active!==true||JSON.stringify(b.targets)!=='["nsis"]'||n?.installMode!=='currentUser'||n.template!=='windows/installer.nsi')throw Error('Use the reviewed per-user NSIS template only');
  if(b.createUpdaterArtifacts!==false)throw Error('Signed updater artifacts remain disabled pending signing approval');
  if(b.windows.webviewInstallMode?.type!=='skip')throw Error('Do not download or install an additional WebView runtime automatically');
  return `Nearly_${label}_x64-setup.exe`;
}

export async function requireCachedTools(localAppData,io=fs){
  if(!localAppData)throw Error('LOCALAPPDATA is unavailable; refusing to fetch installer tools');
  const base=path.join(localAppData,'tauri','NSIS');
  // Match every auto-fetch condition in the pinned tauri-cli-v2.12.3 bundler.
  for(const relative of ['makensis.exe','Bin/makensis.exe','Stubs/lzma-x86-unicode','Stubs/lzma_solid-x86-unicode','Plugins/x86-unicode/additional/nsis_tauri_utils.dll','Include/MUI2.nsh','Include/FileFunc.nsh','Include/x64.nsh','Include/nsDialogs.nsh','Include/WinMessages.nsh','Include/Win/COM.nsh','Include/Win/Propkey.nsh','Include/Win/RestartManager.nsh']){
    if(!await exists(path.join(base,relative),io))throw Error(`Missing cached NSIS build tool: ${relative}. No tool was downloaded; arrange approval before installing additional tools.`);
  }
  for(const [relative,expected] of [['NSIS.exe','6d45d4e8ccf18fe1fdac9164058f356102a2ecf2'],['Plugins/x86-unicode/additional/nsis_tauri_utils.dll','75197fee3c6a814fe035788d1c34ead39349b860']]){
    const actual=createHash('sha1').update(await io.readFile(path.join(base,relative))).digest('hex');
    if(actual!==expected)throw Error(`Cached ${relative} does not match pinned Tauri requirements. Refusing automatic tool replacement; approval is required.`);
  }
  return base;
}

function pe(bytes){
  if(bytes.length<68||bytes.readUInt16LE(0)!==0x5a4d)throw Error('Installer output is not a PE executable');
  const offset=bytes.readUInt32LE(0x3c);
  if(offset<64||offset+4>bytes.length||bytes.readUInt32LE(offset)!==0x4550)throw Error('Installer PE signature is invalid');
}

/** Publish the installer/manifest only. Never install, run, or modify settings. */
export async function publishInstaller(project,artifact,metadata,io=fs){
  if(Object.hasOwn(metadata,'updaterProtocol')&&metadata.updaterProtocol!==3)throw Error('Invalid updater protocol: this build requires protocol 3');
  let label;
  try{label=displayVersion(metadata.version);}catch{throw Error('Invalid installer output name');}
  const name=`Nearly_${label}_x64-setup.exe`;
  const binary=await io.readFile(artifact);pe(binary);
  // Trusted-build input to the offline signer, not independent native trust or
  // proof that the actual NSIS staging path has completed qualification.
  const info={...metadata,updaterProtocol:3,displayVersion:label,builtAt:new Date().toISOString(),bytes:binary.length,sha256:hash(binary),signed:false};
  const output=path.join(project,'build'),stage=path.join(output,'.installer-staging-'+randomUUID());
  const backup=path.join(output,'previous','installer-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID());
  await io.mkdir(stage,{recursive:true});
  await io.writeFile(path.join(stage,name),binary,{flag:'wx'});
  await io.writeFile(path.join(stage,'installer-build-info.json'),JSON.stringify(info,null,2)+'\n',{flag:'wx'});
  const names=[name,'installer-build-info.json'],backed=[],installed=[];
  try{
    for(const item of names)if(await exists(path.join(output,item),io)){await io.mkdir(backup,{recursive:true});await io.rename(path.join(output,item),path.join(backup,item));backed.push(item);}
    for(const item of names){await io.rename(path.join(stage,item),path.join(output,item));installed.push(item);}
  }catch(error){
    const rollbackErrors=[];
    for(const item of installed)try{await io.rename(path.join(output,item),path.join(stage,item));}catch(e){rollbackErrors.push(String(e));}
    for(const item of backed)try{if(!await exists(path.join(output,item),io))await io.rename(path.join(backup,item),path.join(output,item));}catch(e){rollbackErrors.push(String(e));}
    throw Error(`Installer publication failed; staged and backup files preserved: ${error.message}${rollbackErrors.length?' / rollback: '+rollbackErrors.join('; '):''}`);
  }
  return {...info,path:path.join(output,name),backup:backed.length?backup:null};
}

async function execute(args,env){
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(Error(`Installer build failed (${signal??code}); no installation was attempted`)));
  });
}

export async function runInstallerBuild(args=process.argv.slice(2)){
  await checkVersions();
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('This installer target requires a Windows x64 build host');
  const options=buildOptions(args);
  await assertProductionDefaults(root);
  const updaterInstallationEnabled=await readInstallationGate(root);
  if(options.target&&options.target!=='x86_64-pc-windows-msvc')throw Error('The reviewed installer currently targets Windows x64 only');
  const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
  validateInstallerPolicy(config);
  const cliPackage=JSON.parse(await fs.readFile(path.join(root,'node_modules/@tauri-apps/cli/package.json'),'utf8'));
  if(cliPackage.version!=='2.12.3')throw Error('Review tool-cache preflight before using a different Tauri CLI version');
  await requireCachedTools(process.env.LOCALAPPDATA);
  const paths=buildPaths(root,options),env={...process.env,CARGO_TARGET_DIR:paths.targetDir};
  // No key/certificate is configured, generated, or silently consumed by this local build.
  for(const key of Object.keys(env))if(/^TAURI_(SIGNING_|PRIVATE_KEY|WINDOWS_CERTIFICATE)/.test(key))delete env[key];
  const target=options.target?['--target',options.target]:[];
  await execute([paths.cli,'build','--no-bundle','--no-sign','--ci',...target,'--','--locked',...(options.offline?['--offline']:[])],env);
  assertProductionPayload(await fs.readFile(paths.artifact));
  // Keep the installed payload byte-identical to the independently pinned EXE.
  // Our protocol-3 updater does not use Tauri's per-bundle-type updater marker.
  await execute([paths.cli,'bundle','--bundles','nsis','--no-binary-patching','--no-sign','--ci',...target],env);
  // Tauri's intermediate bundle uses its numeric package version. Only the
  // published deliverable uses the public release label; bytes are unchanged.
  const artifact=path.join(paths.targetDir,...(options.target?[options.target]:[]),'release/bundle/nsis',`Nearly_${config.version}_x64-setup.exe`);
  const result=await publishInstaller(root,artifact,{version:config.version,identifier:config.identifier,
    payloadArchitecture:'x64',installMode:'currentUser',installDirectory:'$LOCALAPPDATA\\Nearly',
    uninstaller:'$LOCALAPPDATA\\Nearly\\uninstall.exe',shortcutsIndependent:true,settingsIncluded:false,
    adjacentSettingsPreserved:true,updaterInstallationEnabled,embeddedApplicationSha256:hash(await fs.readFile(paths.artifact))});
  console.log(`Built installer ${result.path} (${result.sha256})`);return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runInstallerBuild().catch(error=>{console.error(error.message);process.exitCode=1;});
