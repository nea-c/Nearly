import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {instrumentCandidatePolicyDiagnostics,decodeCandidateFailureTrace,decodeCandidateShortcutTrace} from '../../scripts/installer-qa.mjs';
const e=process.env;
const enabled=e.NEARLY_NSIS_READONLY_QA==='1'&&e.GITHUB_ACTIONS==='true'&&e.RUNNER_OS==='Windows'&&e.RUNNER_ENVIRONMENT==='github-hosted'&&e.GITHUB_REPOSITORY==='nea-c/Nearly'&&e.GITHUB_EVENT_NAME==='workflow_dispatch'&&['refs/heads/main','refs/heads/codex/private-install-directory'].includes(e.GITHUB_REF)&&/^[a-f0-9]{40}$/.test(e.QA_CONTROLLER_SHA??'')&&e.GITHUB_SHA===e.QA_CONTROLLER_SHA&&e.GITHUB_WORKFLOW_SHA===e.QA_CONTROLLER_SHA&&e.QA_CONFIRMATION==='installer-qa '+e.QA_CONTROLLER_SHA;
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const original=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const q=s=>s.replaceAll('$',()=> '$$');
function fixture(name){
 const parent=path.join(project,'test-results');fs.mkdirSync(parent,{recursive:true});
 const base=fs.mkdtempSync(path.join(parent,`qa-${name}-`));
 const root=path.join(base,`nearly-installer-qa-${e.GITHUB_RUN_ID}-${e.GITHUB_RUN_ATTEMPT}`);fs.mkdirSync(root);
 const trace=path.join(root,'candidate-failure.jsonl');
 const observed=instrumentCandidatePolicyDiagnostics(original,trace);
 const writer=observed.match(/Function \$\{prefix\}NearlyQaRecordFailure\n[\s\S]*?FunctionEnd/)[0].replaceAll('${prefix}','');
 return {root,trace,observed,writer};
}
function run(f,body,extra=''){
 const nsis=e.NEARLY_NSIS_ROOT,exe=path.join(f.root,'TRACEONLY-GENERATED-QA.exe');assert.ok(nsis);
 const script=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${q(exe)}"\n!include LogicLib.nsh\n!include "Win\\COM.nsh"\n!define MAINBINARYNAME "Nearly"\nVar NearlyQaFailureStage\nVar NearlyQaFailureCode\nVar NearlyQaFailureResult\nVar QaLoop\n${f.writer}\n${extra}\nSection\n${body}\nSetErrorLevel 0\nSectionEnd\n`;
 assert.doesNotMatch(script,/^\s*(?:WriteReg|DeleteReg|SetSecurity|Set-Acl|Exec|RMDir)/im);
 const file=path.join(f.root,'fixture.nsi');fs.writeFileSync(file,script);
 const compile=spawnSync(path.join(nsis,'Bin/makensis.exe'),['/V2','/INPUTCHARSET','UTF8',file],{encoding:'utf8',windowsHide:true,env:{...e,NSISDIR:nsis},timeout:30000});
 assert.equal(compile.status,0,compile.stderr||compile.stdout);
 const result=spawnSync(exe,[],{windowsHide:true,timeout:30000});
 if(result.status!==0){
  for(const file of ['candidate-failure.jsonl','candidate-shortcuts.jsonl'])if(fs.existsSync(path.join(f.root,file))){const bytes=fs.readFileSync(path.join(f.root,file));console.log(JSON.stringify(file.includes('shortcuts')?decodeCandidateShortcutTrace(bytes):decodeCandidateFailureTrace(bytes)));}
 }
 assert.equal(result.status,0,'Generated native diagnostic fixture failed; bounded observations above');
}
test('hosted diagnostic writer preserves pre-set error flags and the first failure',{skip:!enabled},()=>{
 const f=fixture('writer');
 run(f,String.raw`StrCpy $NearlyQaFailureStage "registration"
StrCpy $NearlyQaFailureCode 0
StrCpy $NearlyQaFailureResult 0
SetErrors
Call NearlyQaRecordFailure
${'${IfNot}'} ${'${Errors}'}
 SetErrorLevel 91
 Quit
${'${EndIf}'}
StrCpy $NearlyQaFailureStage "shortcuts"
ClearErrors
Call NearlyQaRecordFailure
${'${If}'} ${'${Errors}'}
 SetErrorLevel 92
 Quit
${'${EndIf}'}
StrCpy $NearlyQaFailureStage "shortcut-load"
StrCpy $NearlyQaFailureResult -2147467259
SetErrors
Call NearlyQaRecordFailure
${'${IfNot}'} ${'${Errors}'}
 SetErrorLevel 93
 Quit
${'${EndIf}'}
StrCpy $NearlyQaFailureStage "shortcut-getpath"
StrCpy $NearlyQaFailureResult 1
ClearErrors
Call NearlyQaRecordFailure`);
 assert.deepEqual(decodeCandidateFailureTrace(fs.readFileSync(f.trace)),{stage:'registration',result:0,code:0});
 const rows=decodeCandidateShortcutTrace(fs.readFileSync(path.join(f.root,'candidate-shortcuts.jsonl')));assert.equal(rows.length,2);assert.equal(rows[0].result,-2147467259);assert.equal(rows[1].result,1);
});
test('hosted actual shortcut classifier handles present, absent and foreign targets repeatedly',{skip:!enabled},()=>{
 for(const name of ['Plain','日本語 Space']){
  const f=fixture('shortcut'),app=path.join(f.root,name),target=path.join(app,'Nearly.exe'),foreign=path.join(f.root,'outside-sentinel.bin'),link=path.join(f.root,'generated.lnk');
  fs.mkdirSync(app);fs.writeFileSync(target,'generated non-executable fixture');fs.writeFileSync(foreign,'outside sentinel');
  const macro=f.observed.match(/!macro NearlyIsShortcutTarget shortcut\n[\s\S]*?!macroend/)[0];
  const check=(expected,code)=>`StrCpy $QaLoop 0\nloop_${code}:\n!insertmacro NearlyIsShortcutTarget "${q(link)}"\nPop $0\nStrCmp $0 ${expected} +3\n SetErrorLevel ${code}\n Quit\nIntOp $QaLoop $QaLoop + 1\nIntCmp $QaLoop 128 done_${code} loop_${code} done_${code}\ndone_${code}:\n`;
  run(f,`StrCpy $INSTDIR "${q(app)}"\nCreateShortcut "${q(link)}" "${q(target)}"\n${check(1,81)}Delete "${q(target)}"\n${check(1,82)}CreateShortcut "${q(link)}" "${q(foreign)}"\n${check(0,83)}`,macro);
  assert.equal(fs.readFileSync(foreign,'utf8'),'outside sentinel');
 }
});
