import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {instrumentCandidatePolicyDiagnostics} from '../../scripts/installer-qa.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const productSource=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8').replaceAll('\r\n','\n');
const enabled=process.platform==='win32'&&process.env.NEARLY_UNINSTALL_COMPLETION_FIXTURE==='1';
const q=s=>s.replaceAll('$',()=> '$$');
const hash=b=>createHash('sha256').update(b).digest('hex');

// These executables contain only the real completion tail / shortcut macros.
// No installed application, registry key, settings, or user shortcut is used.
test('generated NSIS UI reaches its real progress maximum only on success and reports owned shortcut deletion failures',{skip:!enabled},()=>{
  const parent=path.join(root,'test-results');fs.mkdirSync(parent,{recursive:true});
  const run=fs.mkdtempSync(path.join(parent,'uninstall-completion-'));
  const traced=process.env.NEARLY_COMPLETION_TRACE_FIXTURE==='1';
  const traceRoot=path.join(run,'nearly-installer-qa-123-1');if(traced)fs.mkdirSync(traceRoot);
  const source=traced?instrumentCandidatePolicyDiagnostics(productSource,path.join(traceRoot,'candidate-failure.jsonl')):productSource;
  const writer=traced?source.match(/Function \$\{prefix\}NearlyQaRecordFailure\n[\s\S]*?FunctionEnd/)[0].replaceAll('${prefix}',''):'';
  const nsis=process.env.NEARLY_NSIS_ROOT??path.join(process.env.LOCALAPPDATA,'tauri','NSIS');
  const completion=source.slice(source.indexOf('  nearly_uninstall_success:\n'),source.indexOf('\nSectionEnd',source.indexOf('  nearly_uninstall_success:\n'))).replaceAll('un.Nearly','Nearly');
  assert.ok(completion.includes('SetErrorLevel 0'));
  const classify=source.match(/!macro NearlyIsShortcutTarget shortcut\n[\s\S]*?!macroend/)[0];
  const start=source.indexOf('  nearly_uninstall_remove_registration:\n');
  const finish=source.indexOf('  DeleteRegKey HKCU "${UNINSTKEY}"',start);
  const shortcutSection=source.slice(start,finish).replaceAll('$SMPROGRAMS','$FixtureMenu').replaceAll('$DESKTOP','$FixtureDesktop');
  assert.ok(shortcutSection.includes('NearlyApplyShortcut'));
  const cases=[];
  for(const name of ['progress-success','owned-shortcuts','owned-shortcuts-missing-target','missing-shortcuts','foreign-shortcuts','locked-start','locked-desktop','payload-failure','whole-failure','incoming-error']){
    // Inject before instrumentation so its pre-Delete snapshot must preserve true.
    // Delete itself succeeds; NSIS must retain the pre-existing error flag.
    const raw=name==='incoming-error'?productSource.replace('        Delete "${path}"\n','        SetErrors\n        Delete "${path}"\n'):productSource;
    const caseSource=traced?instrumentCandidatePolicyDiagnostics(raw,path.join(traceRoot,'candidate-failure.jsonl')):raw;
    const apply=caseSource.match(/!macro NearlyApplyShortcut path enabled\n[\s\S]*?!macroend/)[0];
    const dir=path.join(run,name);fs.mkdirSync(dir);
    const app=path.join(dir,'app'),menu=path.join(dir,'menu'),desktop=path.join(dir,'desktop');
    for(const p of [app,menu,path.join(menu,'Nearly'),desktop])fs.mkdirSync(p,{recursive:true});
    const sentinel=path.join(dir,'outside-sentinel.bin');fs.writeFileSync(sentinel,'Generated external sentinel, must remain.');
    fs.writeFileSync(path.join(app,'Nearly.exe'),'Generated non-executable target, never launch.');
    const exe=path.join(dir,'ONLY-GENERATED-COMPLETION-FIXTURE.exe');
    const shortcut=name.includes('shortcuts')||name.startsWith('locked-')||name==='incoming-error';
    const create=name!=='missing-shortcuts'&&shortcut;
    const target=name==='foreign-shortcuts'?sentinel:path.join(app,'Nearly.exe');
    const lock=name==='locked-start'?path.join(menu,'Nearly','Nearly.lnk'):name==='locked-desktop'?path.join(desktop,'Nearly.lnk'):null;
    const init=`StrCpy $INSTDIR "${q(app)}"\nStrCpy $FixtureMenu "${q(menu)}"\nStrCpy $FixtureDesktop "${q(desktop)}"\n`+
      (create?`CreateShortcut "$FixtureMenu\\Nearly\\Nearly.lnk" "${q(target)}"\nCreateShortcut "$FixtureDesktop\\Nearly.lnk" "${q(target)}"\n`:'')+
      (name==='foreign-shortcuts'||lock?`System::Call 'kernel32::CopyFileW(w "$FixtureMenu\\Nearly\\Nearly.lnk", w "${q(path.join(dir,'menu-before.lnk'))}", i 1)'\nSystem::Call 'kernel32::CopyFileW(w "$FixtureDesktop\\Nearly.lnk", w "${q(path.join(dir,'desktop-before.lnk'))}", i 1)'\n`:'')+
      (name==='owned-shortcuts-missing-target'||lock?'Delete "$INSTDIR\\Nearly.exe"\n':'')+
      (lock?`System::Call 'kernel32::CreateFileW(w "${q(lock)}", i 0x80000000, i 1, p 0, i 3, i 0, p 0) p.s'\nPop $LockHandle\nStrCmp $LockHandle -1 0 +3\nSetErrorLevel 90\nQuit\n`:'');
    const entry=name==='payload-failure'?'Goto nearly_uninstall_io_bad':name==='whole-failure'?'Goto nearly_uninstall_whole_bad':shortcut?shortcutSection+'Goto nearly_uninstall_success':'Goto nearly_uninstall_success';
    const script=`Unicode true
RequestExecutionLevel user
Name "Generated completion fixture ${name}"
Caption "Generated completion fixture ${name}"
OutFile "${q(exe)}"
!include LogicLib.nsh
!include "Win\\COM.nsh"
!define PRODUCTNAME "Nearly"
!define MAINBINARYNAME "Nearly"
LoadLanguageFile "${q(nsis)}\\Contrib\\Language files\\English.nlf"
LangString NearlyWholePartial 1033 "Generated registration failure"
LangString NearlyShortcutRemovalError 1033 "Generated owned shortcut deletion failure"
Var LockHandle
Var FixtureMenu
Var FixtureDesktop
${traced?'Var NearlyQaFailureStage\nVar NearlyQaFailureCode\nVar NearlyQaFailureResult':''}
${writer}
${classify}
${apply}
Function .onInit
${init}
FunctionEnd
Function NearlyIoFail
SetErrorLevel 6
Abort "Generated payload deletion failure"
FunctionEnd
Function NearlyWholeFail
SetErrorLevel 9
Abort "Generated whole-tree deletion failure"
FunctionEnd
Page instfiles
Section
${entry}
${completion}
SectionEnd
`;
    assert.doesNotMatch(script,/^\s*(?:WriteReg\w*|DeleteReg\w*|Exec\w*|SetSecurity\w*)\s/im);
    const file=path.join(dir,'fixture.nsi');fs.writeFileSync(file,script);
    const compile=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',file],{encoding:'utf8',windowsHide:true,env:{...process.env,NSISDIR:nsis},timeout:30000});
    assert.equal(compile.status,0,compile.stdout+compile.stderr);
    cases.push({name,exe,dir,expectedFailure:name.startsWith('locked-')||name.endsWith('-failure')||name==='incoming-error'});
  }
  const inventory=path.join(run,'cases.json');fs.writeFileSync(inventory,JSON.stringify(cases));
  const observer=path.join(run,'ONLY-GENERATED-UI-OBSERVER.exe');
  const csc=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const compiled=spawnSync(csc,['/nologo','/target:exe','/out:'+observer,'/r:System.Web.Extensions.dll',path.join(root,'scripts','uninstall-completion-fixture.cs')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const result=spawnSync(observer,[inventory],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:1024*1024});
  fs.writeFileSync(path.join(run,'observer.log'),result.stdout+'\n'+result.stderr);
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const observed=JSON.parse(fs.readFileSync(path.join(run,'observations.json'),'utf8').replace(/^\uFEFF/,''));
  assert.equal(observed.length,cases.length);
  const failures=[];
  for(const c of cases){
    const o=observed.find(x=>x.name===c.name);assert.ok(o);assert.ok(o.maximum>0&&o.minimum===0);
    const expectedCode=c.name==='payload-failure'?6:c.expectedFailure?9:0;
    if(o.exitCode!==expectedCode||o.completed===c.expectedFailure||(!c.expectedFailure&&o.position!==o.maximum)||(c.expectedFailure&&o.position>=o.maximum))failures.push({name:c.name,expectedCode,...o});
    assert.equal(fs.readFileSync(path.join(c.dir,'outside-sentinel.bin'),'utf8'),'Generated external sentinel, must remain.');
    if(c.name==='foreign-shortcuts'||c.name.startsWith('locked-'))assert.ok(fs.existsSync(path.join(c.dir,c.name==='locked-desktop'?'desktop/Nearly.lnk':'menu/Nearly/Nearly.lnk')));
    if(c.name==='foreign-shortcuts'||c.name==='locked-start')assert.equal(hash(fs.readFileSync(path.join(c.dir,'menu/Nearly/Nearly.lnk'))),hash(fs.readFileSync(path.join(c.dir,'menu-before.lnk'))));
    if(c.name==='foreign-shortcuts'||c.name==='locked-desktop')assert.equal(hash(fs.readFileSync(path.join(c.dir,'desktop/Nearly.lnk'))),hash(fs.readFileSync(path.join(c.dir,'desktop-before.lnk'))));
    if(['owned-shortcuts','owned-shortcuts-missing-target','missing-shortcuts'].includes(c.name))for(const link of ['desktop/Nearly.lnk','menu/Nearly/Nearly.lnk'])assert.equal(fs.existsSync(path.join(c.dir,link)),false);
    if(c.name==='incoming-error')assert.equal(fs.existsSync(path.join(c.dir,'menu/Nearly/Nearly.lnk')),false,'Delete succeeds while the incoming error flag remains set');
  }
  console.log(JSON.stringify({run,variant:traced?'traced':'product',observed}));
  assert.deepEqual(failures,[],'Successful completion must reach range maximum; failures must remain aborted/nonzero before maximum');
});
