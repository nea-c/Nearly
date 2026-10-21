import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {instrumentCandidatePolicyDiagnostics,decodeCandidateFailureTrace} from '../../scripts/installer-qa.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const original=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const q=s=>s.replaceAll('$',()=> '$$');
test('generated native payload sharing retries keep exclusive identity checks and preserve final error32',{skip:process.platform!=='win32'||process.env.NEARLY_PAYLOAD_SHARING_FIXTURE!=='1'},()=>{
 const parent=path.join(project,'test-results');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'payload-sharing-'));
 const nsis=process.env.NEARLY_NSIS_ROOT??path.join(process.env.LOCALAPPDATA,'tauri','NSIS');
 const payload=Buffer.alloc(131079,0x6b),foreign=Buffer.from('Generated unrelated bytes; preserve.'),replacement=Buffer.from('Generated replacement object; do not overwrite.');
 const cases=[];
 for(const name of ['transient','persistent','replacement','collision']){
  const dir=path.join(root,name);fs.mkdirSync(dir);const traceRoot=path.join(dir,'nearly-installer-qa-123-1');fs.mkdirSync(traceRoot);const trace=path.join(traceRoot,'candidate-failure.jsonl');
  const source=instrumentCandidatePolicyDiagnostics(original,trace);
  const declaration=source.match(/^Var .+$/gm).join('\n'),rootMacro=source.match(/!macro NearlyRootFunctions prefix\n[\s\S]*?!macroend/)[0];
  const ioMacro=source.match(/!macro NearlyIoFunctions prefix\n[\s\S]*?!macroend/)[0].replace('Abort "$(NearlyPayloadError)"','Call FixtureRecord\n  Abort "$(NearlyPayloadError)"').replace('  Sleep 100\n','  Call FixtureRetryObserved\n  Sleep 100\n');
  const openSource=source.match(/Function NearlyOpenCopySource\n[\s\S]*?FunctionEnd/)[0];
  const dest=path.join(dir,'owned.bin'),src=path.join(dir,'source.bin');fs.writeFileSync(dest,foreign);fs.writeFileSync(src,payload);fs.writeFileSync(path.join(dir,'outside.bin'),foreign);fs.writeFileSync(path.join(dir,'replacement.bin'),replacement);
  const result=path.join(dir,'result.json'),ready=path.join(dir,'ready.txt'),exe=path.join(dir,'ONLY-GENERATED-PAYLOAD-SHARING-FIXTURE.exe');
  const script=`Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${q(exe)}"
!define MAINBINARYNAME "Nearly"
LoadLanguageFile "${q(nsis)}\\Contrib\\Language files\\English.nlf"
LangString NearlyCannotWrite 1033 "Generated namespace refused"
LangString NearlyPayloadError 1033 "Generated payload refused"
${declaration}
${rootMacro}
!insertmacro NearlyRootFunctions ""
${ioMacro}
!insertmacro NearlyIoFunctions ""
${openSource}
Function FixtureRetryObserved
FileOpen $9 "${q(path.join(dir,'retry.txt'))}" w
FileWrite $9 "generated-retry-observed"
FileClose $9
FunctionEnd
Function FixtureRecord
FileOpen $8 "${q(result)}" w
FileWrite $8 '{"remaining":$NearlyIoOpenRetries,"error":$NearlyIoOpenError}'
FileClose $8
FunctionEnd
Section
Call NearlyIoInit
StrCpy $NearlyGuardHead 0
StrCpy $NearlyPayload "${q(dest)}"
Call NearlyValidatePayload
StrCpy $NearlyIoExpected ${name==='collision'?'""':'$NearlySnapshot'}
FileOpen $9 "${q(ready)}" w
FileWrite $9 "generated"
FileClose $9
Call NearlyIoOpenDestination
StrCpy $NearlyIoMain $NearlyIoDest
StrCpy $NearlyIoMainNew $NearlyIoDestNew
StrCpy $NearlyIoDest 0
StrCpy $NearlyIoDestNew 0
StrCpy $NearlyPayload "${q(src)}"
Call NearlyOpenCopySource
StrCpy $NearlyIoWriteHandle $NearlyIoMain
Call NearlyIoCopy
Call NearlyIoCleanup
Call FixtureRecord
SetErrorLevel 0
SectionEnd
`;
  assert.doesNotMatch(script,/^\s*(?:WriteReg|DeleteReg|Exec|SetSecurity|CreateShortcut|RMDir)/im);
  const file=path.join(dir,'fixture.nsi');fs.writeFileSync(file,script);
  const compiled=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',file],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,NSISDIR:nsis}});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  cases.push({name,dir});
 }
 const inventory=path.join(root,'cases.json');fs.writeFileSync(inventory,JSON.stringify(cases));const driver=path.join(root,'ONLY-GENERATED-SHARING-DRIVER.exe');
 const compiled=spawnSync(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:exe','/out:'+driver,'/r:System.Web.Extensions.dll',path.join(project,'scripts','payload-sharing-fixture.cs')],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 const run=spawnSync(driver,[inventory],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(run.status,0,run.stdout+run.stderr);
 const rows=JSON.parse(fs.readFileSync(path.join(root,'observations.json'),'utf8'));
 for(const c of cases){const observation=rows.find(r=>r.name===c.name);assert.equal(observation.exitCode,c.name==='transient'?0:6);const counters=JSON.parse(fs.readFileSync(path.join(c.dir,'result.json'),'utf8'));
  assert.deepEqual(fs.readFileSync(path.join(c.dir,'outside.bin')),foreign);
  if(c.name==='transient'){assert.deepEqual(fs.readFileSync(path.join(c.dir,'owned.bin')),payload);assert.ok(counters.remaining<20&&counters.remaining>0);}
  else if(c.name==='replacement'){assert.deepEqual(fs.readFileSync(path.join(c.dir,'owned.bin')),replacement);assert.deepEqual(fs.readFileSync(path.join(c.dir,'original.bin')),foreign);assert.ok(counters.remaining<20&&counters.remaining>0);const trace=decodeCandidateFailureTrace(fs.readFileSync(path.join(c.dir,'nearly-installer-qa-123-1','candidate-failure.jsonl')));assert.equal(trace.stage,'nearlyioinspect-getfileinformationbyhandle');assert.equal(trace.result,1,'The replacement must have been acquired before identity refusal');}
  else {assert.deepEqual(fs.readFileSync(path.join(c.dir,'owned.bin')),foreign);assert.equal(counters.remaining,c.name==='persistent'?0:20);}
  if(c.name==='persistent'){assert.equal(counters.error,32);assert.deepEqual(decodeCandidateFailureTrace(fs.readFileSync(path.join(c.dir,'nearly-installer-qa-123-1','candidate-failure.jsonl'))),{stage:'nearlyioopendestination-createfilew',result:-1,code:32});}
  Object.assign(observation,counters);
 }
 console.log(JSON.stringify({generatedOnly:true,observed:rows}));
});
