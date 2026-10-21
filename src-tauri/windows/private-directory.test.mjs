import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const body=name=>source.match(new RegExp(`Function ${name}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1]??'';
// Execute the actual browse callback, replacing only external inspection calls.
// No installer, filesystem mutation or UI process is run by this model.
function browse(refusal=''){
 const events=[];const vars={INSTDIR:'D:\\Nearly'};
 for(const raw of body('NearlyDirectoryLeave').split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith(';'))continue;
  const [op,...a]=line.split(/\s+/);
  if(op==='StrCpy'){vars[a[0].slice(1)]=vars[a[1].slice(1)];continue;}
  assert.equal(op,'Call','Browsing must not acquire mutation instructions');
  events.push(a[0]);if(a[0]===refusal)return {events,vars,refused:true};
 }
 return {events,vars,refused:false};
}
test('ordinary D destination browsing only inspects and releases without preparation or mutation',()=>{
 const r=browse();assert.equal(r.refused,false);assert.equal(r.vars.NearlyRequestedRoot,'D:\\Nearly');
 assert.deepEqual(r.events,['NearlyReleaseGuards','NearlyValidatePath','NearlyPinRoot','NearlyCheckInstallOwnership','NearlyRequireFreshContents','NearlyReleaseGuards']);
});
test('path, namespace, ownership or foreign-content refusal cannot advance browse acceptance',()=>{
 for(const stage of ['NearlyValidatePath','NearlyPinRoot','NearlyCheckInstallOwnership','NearlyRequireFreshContents']){
  const r=browse(stage);assert.equal(r.refused,true);assert.equal(r.events.at(-1),stage);
 }
});
test('actual creation and write probe remain after Install, and known settings are never recursively removed',()=>{
 const section=source.slice(source.indexOf('Section Install'),source.indexOf('SectionEnd',source.indexOf('Section Install')));
 assert.ok(section.indexOf('CreateDirectory "$INSTDIR"')<section.indexOf('Call NearlyWritePayloads'));
 assert.match(section,/CreateFileW[^\n]*0x40010000[^\n]*i 1, i 0x04000100/);
 assert.doesNotMatch(body('NearlyDirectoryLeave'),/CreateDirectory|File |WriteUninstaller|WriteReg|nsExec|Consent/);
 const uninstall=source.slice(source.indexOf('Section Uninstall'));
 assert.doesNotMatch(uninstall,/RMDir \/r|Delete[^\n]*\.json/);
});
test('retired preparation CLI is QA-only and standard installer never launches it',()=>{
 const main=fs.readFileSync(new URL('../src/main.rs',import.meta.url),'utf8');
 assert.match(main,/#\[cfg\(any\(test, feature="installer-qa"\)\)\]\s+mod install_prepare;/);
 assert.match(main,/#\[cfg\(feature="installer-qa"\)\]\s+if let Some\(code\)=install_prepare::dispatch/);
 assert.doesNotMatch(source,/NearlyEnsurePolicyHelper|NearlyPrepareFreshRoot|--nearly-install-(?:check|prepare)/);
});
