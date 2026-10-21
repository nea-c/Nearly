import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const env=process.env;
const enabled=env.NEARLY_NSIS_READONLY_QA==='1'&&env.GITHUB_ACTIONS==='true'&&env.RUNNER_OS==='Windows'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.GITHUB_REPOSITORY==='nea-c/Nearly'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&['refs/heads/main','refs/heads/codex/private-install-directory'].includes(env.GITHUB_REF)&&/^[a-f0-9]{40}$/.test(env.QA_CONTROLLER_SHA??'')&&env.GITHUB_SHA===env.QA_CONTROLLER_SHA&&env.GITHUB_WORKFLOW_SHA===env.QA_CONTROLLER_SHA&&env.QA_CONFIRMATION==='installer-qa '+env.QA_CONTROLLER_SHA;
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const fn=name=>source.match(new RegExp('Function '+name+'\\r?\\n[\\s\\S]*?FunctionEnd'))?.[0]??'';
test('hosted generated native payload handles preserve unrelated bytes across copy, collisions, links and deletion',{skip:!enabled},()=>{
 const parent=path.join(project,'test-results');fs.mkdirSync(parent,{recursive:true});
 const root=fs.mkdtempSync(path.join(parent,'payload-handles-'));
 const nsis=env.NEARLY_NSIS_ROOT;assert.ok(nsis);
 const declaration=source.match(/^Var .+$/gm).join('\n');
 const rootMacro=source.match(/!macro NearlyRootFunctions prefix\r?\n[\s\S]*?!macroend/)[0];
 const ioMacro=source.match(/!macro NearlyIoFunctions prefix\r?\n[\s\S]*?!macroend/)[0];
 const deletion=fn('\\$\\{prefix\\}NearlyIoDelete').replaceAll('${prefix}','');
 const openSource=fn('NearlyOpenCopySource');
 const payload=Buffer.alloc(131079,0x6b),foreign=Buffer.from('Generated unrelated bytes; never overwrite or delete.');
 for(const name of ['copy-new','copy-existing','late-hardlink','new-collision','reparse-refusal','held-destination','delete-held','empty-source','empty-new-cleanup']){
  const dir=path.join(root,name);fs.mkdirSync(dir);
  const src=path.join(dir,'source.bin'),dst=path.join(dir,'owned.bin'),sentinel=path.join(dir,'unrelated.bin'),alias=path.join(dir,'alias.bin');
  fs.writeFileSync(src,name.startsWith('empty-')?Buffer.alloc(0):payload,{flag:'wx'});fs.writeFileSync(sentinel,foreign,{flag:'wx'});
  const fresh=['copy-new','new-collision','empty-new-cleanup'].includes(name);
  if(!fresh&&name!=='reparse-refusal')fs.writeFileSync(dst,foreign,{flag:'wx'});
  if(name==='reparse-refusal'){const target=path.join(dir,'unrelated-directory');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'keep.bin'),foreign,{flag:'wx'});fs.symlinkSync(target,dst,'junction');}
  let prepare=name==='reparse-refusal'?'StrCpy $NearlyIoExpected "an-existing-object"':`StrCpy $NearlyPayload "${dst}"\nCall NearlyValidatePayload\nStrCpy $NearlyIoExpected $NearlySnapshot`;
  if(name==='late-hardlink')prepare+=`\nSystem::Call 'kernel32::DeleteFileW(w "${dst}") i.r0'\nStrCmp $0 1 +3\n SetErrorLevel 91\n Quit\nSystem::Call 'kernel32::CreateHardLinkW(w "${dst}", w "${sentinel}", p 0) i.r0'\nStrCmp $0 1 +3\n SetErrorLevel 92\n Quit`;
  if(name==='new-collision')prepare+=`\nSystem::Call 'kernel32::CreateHardLinkW(w "${dst}", w "${sentinel}", p 0) i.r0'\nStrCmp $0 1 +3\n SetErrorLevel 92\n Quit`;
  prepare+=`\nStrCpy $NearlyPayload "${dst}"\nCall NearlyIoOpenDestination\nStrCpy $NearlyIoMain $NearlyIoDest\nStrCpy $NearlyIoMainNew $NearlyIoDestNew\nStrCpy $NearlyIoDest 0\nStrCpy $NearlyIoDestNew 0`;
  // A metadata-only link API may add an alias despite data-sharing locks.
  // Either refusal is safe, or the held-object pre-write link check must fail.
  if(name==='held-destination')prepare+=`\nSystem::Call 'kernel32::CreateHardLinkW(w "${alias}", w "${dst}", p 0) i.r0'\nSystem::Call 'kernel32::DeleteFileW(w "${dst}") i.r0'\nStrCmp $0 0 +3\n SetErrorLevel 94\n Quit`;
  let action=`StrCpy $NearlyPayload "${src}"\nCall NearlyOpenCopySource\nStrCpy $NearlyIoWriteHandle $NearlyIoMain\nCall NearlyIoCopy`;
  if(name==='delete-held')action='StrCpy $NearlyIoWriteHandle $NearlyIoMain\nCall NearlyIoDelete';
  const exe=path.join(dir,'TESTONLY-PAYLOAD-QA.exe');
  const script=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\n!define MAINBINARYNAME "Nearly"\nLoadLanguageFile "${nsis}\\Contrib\\Language files\\English.nlf"\nLangString NearlyCannotWrite 1033 "Fixture namespace rejected"\nLangString NearlyPayloadError 1033 "Fixture payload rejected"\n${declaration}\n${rootMacro}\n!insertmacro NearlyRootFunctions ""\n${ioMacro}\n!insertmacro NearlyIoFunctions ""\n${deletion}\n${openSource}\nSection\nStrCpy $NearlyGuardHead 0\nStrCpy $NearlyHandle 0\nStrCpy $NearlyPendingBuffer 0\nStrCpy $NearlyEnum 0\nStrCpy $NearlyFindData 0\nCall NearlyIoInit\n${prepare}\n${action}\nCall NearlyIoCleanup\nSetErrorLevel 0\nSectionEnd\n`;
  assert.doesNotMatch(script,/^\s*(?:File |WriteUninstaller|WriteReg|DeleteReg|CreateShortcut|Exec)/im);
  const file=path.join(dir,'fixture.nsi');fs.writeFileSync(file,script);
  const compile=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',file],{encoding:'utf8',windowsHide:true,env:{...env,NSISDIR:nsis},timeout:30000});assert.equal(compile.status,0,compile.stderr||compile.stdout);
  const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
  const linkedWhileHeld=name==='held-destination'&&fs.existsSync(alias);
  const refused=linkedWhileHeld||['late-hardlink','new-collision','reparse-refusal','empty-source','empty-new-cleanup'].includes(name);
  assert.equal(run.status,refused?6:0,name+': '+(run.error?.message??''));
  assert.deepEqual(fs.readFileSync(sentinel),foreign,name+' changed unrelated file');
  if(['copy-new','copy-existing','held-destination'].includes(name))assert.deepEqual(fs.readFileSync(dst),linkedWhileHeld?foreign:payload,name);
  if(name==='delete-held'||name==='empty-new-cleanup')assert.equal(fs.existsSync(dst),false,name);
  if(name==='empty-source')assert.deepEqual(fs.readFileSync(dst),foreign,name+' truncated before checking empty source');
  if(name==='reparse-refusal')assert.deepEqual(fs.readFileSync(path.join(dir,'unrelated-directory','keep.bin')),foreign);
 }
});
