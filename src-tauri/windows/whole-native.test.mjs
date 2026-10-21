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
const functions=['NearlyWholeCleanup','NearlyWholeFail','NearlyWholeInspect','NearlyWholeOpenRoot','NearlyWholeDisposition','NearlyRemoveTree'];
const whole=functions.map(name=>{
 const match=source.match(new RegExp('Function un\\.'+name+'\\r?\\n[\\s\\S]*?FunctionEnd'));
 assert.ok(match,`Missing real whole-tree function ${name}`);
 return match[0].replaceAll('un.Nearly','Nearly').replaceAll('\r\n','\n');
}).join('\n');
test('hosted whole-tree native fixtures keep external data through links, identity replacement, locks and interruption',{skip:!enabled},()=>{
 const parent=path.join(project,'test-results');fs.mkdirSync(parent,{recursive:true});
 const root=fs.mkdtempSync(path.join(parent,'whole-tree-'));
 const nsis=env.NEARLY_NSIS_ROOT;assert.ok(nsis);
 const declarations=source.match(/^Var .+$/gm).join('\n');
 const rootMacro=source.match(/!macro NearlyRootFunctions prefix\r?\n[\s\S]*?!macroend/)[0];
 const foreign=Buffer.from('Generated outside sentinel, never delete or change.');
 for(const name of ['success','hardlink','junction','readonly','locked','root-replaced','late-child','interrupted']){
  const fixture=path.join(root,name),install=path.join(fixture,'app'),outside=path.join(fixture,'outside');
  fs.mkdirSync(install,{recursive:true});fs.mkdirSync(outside);
  const sentinel=path.join(outside,'keep.bin');fs.writeFileSync(sentinel,foreign,{flag:'wx'});
  fs.mkdirSync(path.join(install,'nested'));fs.writeFileSync(path.join(install,'nested','data.json'),'generated');
  fs.mkdirSync(path.join(install,'empty'));fs.writeFileSync(path.join(install,'uninstall.exe'),'byte-proven-placeholder');
  if(name==='hardlink')fs.linkSync(sentinel,path.join(install,'alias.bin'));
  if(name==='junction')fs.symlinkSync(outside,path.join(install,'redirect'),'junction');
  if(name==='readonly'){fs.writeFileSync(path.join(install,'readonly.bin'),'generated');fs.chmodSync(path.join(install,'readonly.bin'),0o444);}
  let before='';
  if(name==='locked')before=`System::Call 'kernel32::CreateFileW(w "${path.join(install,'nested','data.json')}", i 0x80000000, i 1, p 0, i 3, i 0, p 0) p.r9'\nStrCmp $9 -1 0 +3\n SetErrorLevel 90\n Quit`;
  if(name==='root-replaced')before=`Call NearlyReleaseLeaf\nSystem::Call 'kernel32::MoveFileW(w "${install}", w "${install}-preserved") i.r0'\nStrCmp $0 1 +3\n SetErrorLevel 91\n Quit\nCreateDirectory "${install}"`;
  const inject=name==='interrupted'?whole.replace('Function NearlyWholeDisposition\n','Function NearlyWholeDisposition\nSetErrorLevel 73\nQuit\n'):whole;
  const late=name==='late-child'?`System::Call 'kernel32::CreateFileW(w "${path.join(install,'new-after-enumeration.bin')}", i 0x40000000, i 7, p 0, i 1, i 0x80, p 0) p.r0'\nStrCmp $0 -1 0 +3\n SetErrorLevel 92\n Quit\nSystem::Call 'kernel32::CloseHandle(p r0)'`:'';
  const exe=path.join(fixture,'TESTONLY-WHOLE-TREE-QA.exe');
  const script=`Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${exe}"
!define MAINBINARYNAME "Nearly"
LoadLanguageFile "${nsis}\\Contrib\\Language files\\English.nlf"
LangString NearlyCannotWrite 1033 "Fixture namespace rejected"
LangString NearlyWholeRefused 1033 "Fixture whole-tree refused"
LangString NearlyWholePartial 1033 "Fixture partial failure"
${declarations}
${rootMacro}
!insertmacro NearlyRootFunctions ""
${inject}
Section
StrCpy $NearlyGuardHead 0
StrCpy $NearlyLeafNode 0
StrCpy $NearlyHandle 0
StrCpy $NearlyPendingBuffer 0
StrCpy $NearlyEnum 0
StrCpy $NearlyFindData 0
StrCpy $NearlyWholeTop 0
StrCpy $NearlyWholeHandle 0
StrCpy $NearlyWholeInfo 0
StrCpy $NearlyWholeRoot 0
StrCpy $NearlyWholeStarted 0
StrCpy $INSTDIR "${install}"
Call NearlyPinRoot
Call NearlyCaptureRootIdentity
StrCpy $NearlyUninstallRootIdentity $NearlyRootIdentity
${before}
Call NearlyWholeOpenRoot
StrCpy $NearlyWholePath $INSTDIR
StrCpy $NearlyWholeDepth 0
StrCpy $NearlyWholeCount 0
StrCpy $NearlyWholeStarted 1
StrCpy $NearlyWholeHandle $NearlyWholeRoot
StrCpy $NearlyWholeRoot 0
Call NearlyRemoveTree
${late}
System::Call 'kernel32::CreateFileW(w "$INSTDIR\\uninstall.exe", i 0x10081, i 1, p 0, i 3, i 0x00200000, p 0) p.s'
Pop $NearlyWholeHandle
StrCpy $NearlyWholeExpectedKind 0
Call NearlyWholeInspect
Call NearlyWholeDisposition
System::Call '*$NearlyWholeTop(p .r0, p .r1, p .r2, p .r3)'
StrCpy $NearlyWholeHandle $1
IntOp $0 $NearlyWholeTop + 4
System::Call '*$0(p 0)'
Call NearlyWholeDisposition
Call NearlyWholeCleanup
Call NearlyReleaseGuards
SetErrorLevel 0
SectionEnd
`;
  assert.doesNotMatch(script,/^\s*(?:File |WriteUninstaller|WriteReg|DeleteReg|CreateShortcut|Exec|RMDir \/r)/im);
  const file=path.join(fixture,'fixture.nsi');fs.writeFileSync(file,script);
  const compile=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',file],{encoding:'utf8',windowsHide:true,env:{...env,NSISDIR:nsis},timeout:30000});
  assert.equal(compile.status,0,name+': '+(compile.stderr||compile.stdout));
  const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(run.status,name==='success'?0:name==='interrupted'?73:9,name+': '+(run.error?.message??''));
  assert.deepEqual(fs.readFileSync(sentinel),foreign,name+' damaged outside sentinel');
  assert.equal(fs.existsSync(install),name!=='success',name+' root state');
  if(name==='root-replaced')assert.equal(fs.existsSync(path.join(install+'-preserved','nested','data.json')),true);
  if(name==='late-child')assert.equal(fs.existsSync(path.join(install,'new-after-enumeration.bin')),true);
 }
});
