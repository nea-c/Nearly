// Disposable hosted UI diagnosis with an invalid mock image. Never qualification.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {validateContext,createPlan} from './installer-qa.mjs';
import {requireCachedTools} from './build-installer.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const fail=message=>{throw Error(message);};
export function validateNavigation(value){if(!['Click','Command'].includes(value))fail('Select exactly Click or Command');return value;}
function safePath(value){
  if(typeof value!=='string'||!/^[A-Za-z]:\\/.test(value)||/[\x00-\x1f$"<>|?*]/.test(value)||value.includes('/')||value.slice(2).includes(':')||path.win32.normalize(value)!==value||value.split('\\').some(part=>part==='.'||part==='..'||/[. ]$/.test(part)))fail('Unsafe NSIS probe path');
  return value;
}
export function mockPayload(){
  // No sections, optional header, entry point or executable code: not launchable.
  const bytes=Buffer.alloc(80);bytes.writeUInt16LE(0x5a4d,0);bytes.writeUInt32LE(64,60);bytes.writeUInt32LE(0x4550,64);bytes.writeUInt16LE(0x8664,68);return bytes;
}
export function renderProbeTemplate(template,{runRoot,tools,icon}){
  for(const value of [runRoot,tools,icon])safePath(value);
  const values={compression:'lzma',product_name:'Nearly',main_binary_name:'Nearly',main_binary_path:path.win32.join(runRoot,'mock-payload.exe'),bundle_id:'local.syncfiles.native',version:'1.9.0',version_with_build:'1.9.0.0',manufacturer:'Nearly',copyright:'Nearly diagnostic mock payload - not qualification',arch:'x64',installer_icon:icon,additional_plugins_path:path.win32.join(tools,'Plugins','x86-unicode','additional'),install_mode:'currentUser',install_webview2_mode:'',out_file:path.win32.join(runRoot,'diagnostic-setup.exe'),display_language_selector:'true',estimated_size:'1'};
  if(typeof template!=='string'||template.length>256*1024)fail('Bounded actual installer template required');
  for(const [field,message] of [['resources','Nearly is self-contained; external resources could overwrite user settings.'],['binaries',"Nearly's installer only owns its main EXE and generated uninstaller."]]){
    const expression=new RegExp(`\\{\\{#if ${field}\\}\\}\\r?\\n  !error "${message.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"\\r?\\n\\{\\{/if\\}\\}`,'g');
    let count=0;template=template.replace(expression,block=>{count++;return block.replace(/[^\r\n]/g,'');});
    if(count!==1)fail('Unexpected resource conditional in actual template');
  }
  const seen=new Map();
  const rendered=template.replace(/\{\{([a-z0-9_]+)\}\}/g,(_,field)=>{
    if(!Object.hasOwn(values,field))fail('Unknown installer placeholder');seen.set(field,(seen.get(field)??0)+1);return values[field];
  });
  if(rendered.includes('{{')||rendered.includes('}}')||Object.keys(values).some(field=>seen.get(field)!==(field==='installer_icon'?2:1)))fail('Missing or unsupported installer placeholder');
  return rendered;
}
export function probeSummary(context,navigation,uiSucceeded){
  validateNavigation(navigation);
  return {schemaVersion:2,controllerSha:context.controllerSha,scenario:'success',destinationKind:'custom',passed:false,cases:[{case:`diagnostic-mock-${navigation.toLowerCase()}-not-qualification`,passed:uiSucceeded===true}]};
}
export function createProbeContext(e,platform=process.platform){
  const context=validateContext(e,platform),navigation=validateNavigation(e.QA_PROBE_NAVIGATION);
  if(e.QA_DESTINATION!=='custom'||e.QA_SCENARIO!=='success'||e.QA_UI_PROBE!=='navigation-only')fail('Diagnostic requires the explicitly marked custom fresh guest');
  return {context,navigation,plan:createPlan(context,'custom')};
}
async function execute(command,args,{env=process.env,timeoutMs=120000}={}){
  await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{child.kill();finish(Error('Bounded diagnostic child timed out; retain evidence'));},timeoutMs);
    child.once('error',finish);child.once('exit',(code,signal)=>finish(code===0?null:Error(`Diagnostic child failed (${signal??code})`)));
  });
}
export async function runProbe(e=process.env){
  const {context,navigation,plan}=createProbeContext(e);
  const env={...e};for(const key of Object.keys(env))if(/^(?:GH_TOKEN|GITHUB_TOKEN|TAURI_(?:SIGNING_|PRIVATE_KEY|WINDOWS_CERTIFICATE)|NEARLY_QA_)/.test(key))delete env[key];
  const guest=path.join(root,'scripts','installer-qa-guest.ps1');
  // The existing guard checks fresh filesystem/registry/desktop and exact SHA
  // before either the owned run directory or candidate parent is created.
  await execute('pwsh',['-NoProfile','-NonInteractive','-File',guest,'-Action','preflight','-RunRoot',plan.runRoot],{env});
  await fs.mkdir(plan.runRoot);let uiSucceeded=false;
  try{
    await execute('git',['diff','--exit-code','HEAD','--','src-tauri/windows/installer.nsi'],{env});
    await execute('pwsh',['-NoProfile','-NonInteractive','-Command','if ((git rev-parse HEAD) -cne $env:QA_CONTROLLER_SHA) { throw "Checkout differs from exact controller" }'],{env});
    await fs.writeFile(path.join(plan.runRoot,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
    const tools=await requireCachedTools(e.LOCALAPPDATA);
    const template=await fs.readFile(path.join(root,'src-tauri','windows','installer.nsi'),'utf8');
    const rendered=renderProbeTemplate(template,{runRoot:plan.runRoot,tools,icon:path.join(root,'src-tauri','icons','icon.ico')});
    await fs.writeFile(path.join(plan.runRoot,'mock-payload.exe'),mockPayload(),{flag:'wx'});
    const source=path.join(plan.runRoot,'diagnostic.nsi');await fs.writeFile(source,rendered,{flag:'wx'});
    await execute(path.join(tools,'makensis.exe'),['/INPUTCHARSET','UTF8','/V2',source],{env:{...env,NSISDIR:tools}});
    // Only the deterministic parent is created; destination stays absent so
    // production directory admission sees a genuinely fresh installation.
    await fs.mkdir(path.dirname(plan.installRoot),{recursive:true});
    await execute('pwsh',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts','installer-qa-ui.ps1'),'-RunRoot',plan.runRoot,'-Setup',path.join(plan.runRoot,'diagnostic-setup.exe'),'-InstallRoot',plan.installRoot,'-Language','en','-Start','0','-Desktop','0','-CaseName',`probe-${navigation.toLowerCase()}`,'-Mode','Install','-NavigationMode',navigation],{env,timeoutMs:240000});
    uiSucceeded=true;
  }finally{
    await fs.writeFile(path.join(plan.runRoot,'qa-summary.json'),JSON.stringify(probeSummary(context,navigation,uiSucceeded),null,2)+'\n',{flag:'wx'});
    if(e.GITHUB_STEP_SUMMARY)await fs.appendFile(e.GITHUB_STEP_SUMMARY,`Mock-payload UI diagnostic (${navigation}): UI ${uiSucceeded?'completed':'did not complete'}. This run is not installer/update qualification; its public qualification status is always false.\n`);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3||process.argv[2]!=='run'){console.error('Only an explicitly confirmed hosted diagnostic run is supported');process.exitCode=1;}
  else runProbe().catch(error=>{console.error(error.message);process.exitCode=1;});
}
