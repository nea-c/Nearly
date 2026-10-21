import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const text=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const body=n=>text.match(new RegExp('Function '+n.replaceAll('.','\\.')+'\\r?\\n([\\s\\S]*?)FunctionEnd'))?.[1]??'';
test('whole-folder option starts OFF and silent uninstall retains data',()=>{
 const init=body('un.onInit');assert.match(init,/StrCpy \$NearlyRemoveAll 0/);
 assert.match(text,/UninstPage custom un\.NearlyRemovePage un\.NearlyRemovePageLeave/);
 assert.doesNotMatch(init,/\/REMOVEALL|\/DELETEALL|\/PURGE/i);
});
test('whole-folder confirmation is path bound and defaults to No',()=>{
 assert.match(body('un.NearlyRemovePage'),/NSD_CreateCheckbox/);
 const leave=body('un.NearlyRemovePageLeave');
 assert.match(leave,/NSD_GetState/);assert.match(leave,/MB_DEFBUTTON2/);assert.match(leave,/NearlyWholeConfirm/);
 assert.match(text,/LangString NearlyWholeConfirm \$\{LANG_ENGLISH\}[^\n]*\$INSTDIR/);
 assert.match(text,/LangString NearlyWholeConfirm \$\{LANG_JAPANESE\}[^\n]*\$INSTDIR/);
});
test('actual hosted option driver uses the reviewed control ABI and product caption',()=>{
 const guest=fs.readFileSync(new URL('../../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
 const ui=guest.slice(guest.indexOf('function Invoke-UninstallOptionUi'),guest.indexOf('function New-SharedEmptyDriveFixture'));
 assert.doesNotMatch(ui,/GetDlgCtrlID\([^)]*,/);
 const caption=text.match(/LangString NearlyRemoveLabel \$\{LANG_ENGLISH\} "([^"]+)"/)[1];
 assert.ok(caption.includes('ALL its contents'));
 assert.match(ui,/Contains\('ALL its contents'\)/);
 assert.match(ui,/DefaultButton\(\$no,\$p.Id\)/);
 assert.match(ui,/ProcessImage\(\$p\) -cne \$copy/);
 assert.match(ui,/Mode -ceq 'Decline'[\s\S]*Assert-Payload/);
});
test('whole-folder authority requires persisted root identity and protected-area validation before deletion',()=>{
 assert.match(text,/WriteRegStr HKCU "\$\{UNINSTKEY\}" "NearlyRootIdentity"/);
 const validate=body('un.NearlyWholeValidate');assert.ok(validate,'Whole-root validator missing');
 assert.match(validate,/ReadRegStr[^\n]*NearlyRootIdentity/);
 for(const root of ['$WINDIR','$PROGRAMFILES','$PROFILE'])assert.ok(validate.includes(root),root);
 const section=text.slice(text.indexOf('Section Uninstall'));
 assert.ok(section.indexOf('Call un.NearlyWholeValidate')<section.indexOf('Call un.NearlyRemoveTree'));
});
test('whole-folder removal never uses path recursive deletion or process escape',()=>{
 const tree=body('un.NearlyRemoveTree');assert.ok(tree,'Same-handle tree remover missing');
 assert.doesNotMatch(tree,/RMDir \/r|Delete \"|Exec|powershell|cmd\.exe/i);
 assert.match(tree,/NearlyWhole/);
});

// Interpret the real separator-boundary policy with generated strings only.
function refusesProtected(target,protectedPath,descendants){
 const vars={INSTDIR:target,NearlyWholeProtected:protectedPath,NearlyWholeExpectedKind:String(descendants)};
 const lines=body('un.NearlyWholeCheckProtected').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith(';'));
 const labels=new Map(lines.flatMap((s,i)=>s.endsWith(':')?[[s.slice(0,-1),i]]:[]));
 const expand=s=>s.replace(/^"|"$/g,'').replace(/\$(\w+)/g,(_,key)=>vars[key]??'');
 let pc=0;
 const jump=label=>{if(!label||label==='0')return;assert.ok(labels.has(label),label);pc=labels.get(label);};
 for(let count=0;pc<lines.length&&count<100;count++){
  const line=lines[pc++];if(line.endsWith(':'))continue;
  const tokens=line.match(/"[^"]*"|\S+/g),op=tokens.shift();
  if(op==='Return')return false;
  if(op==='Call'){assert.equal(tokens[0],'un.NearlyWholeRefuse');return true;}
  if(op==='System::Call'){
   assert.ok(line.includes('GetLongPathNameW'));
   vars['2']=protectedPath;vars['0']=String(protectedPath.length);continue;
  }
  if(op==='IntCmp'){
   const left=Number(expand(tokens[0])),right=tokens[1]==='${NSIS_MAX_STRLEN}'?1024:Number(expand(tokens[1]));
   jump(left===right?tokens[2]:left<right?tokens[3]:tokens[4]);continue;
  }
  if(op==='StrLen'){vars[tokens[0].slice(1)]=String(expand(tokens[1]).length);continue;}
  if(op==='StrCpy'){
   const value=expand(tokens[1]),start=tokens[3]?Number(expand(tokens[3])):0;
   vars[tokens[0].slice(1)]=tokens[2]?value.slice(start,start+Number(expand(tokens[2]))):value;continue;
  }
  if(op==='StrCmp'){jump(expand(tokens[0]).toLowerCase()===expand(tokens[1]).toLowerCase()?tokens[2]:tokens[3]);continue;}
  assert.fail('Unmodeled actual policy instruction '+line);
 }
 assert.fail('Policy did not terminate');
}
test('actual protected-area policy rejects ancestors and separators while allowing dedicated D/E and profile children',()=>{
 for(const target of ['C:\\Windows','c:\\WINDOWS\\Temp\\App','C:\\Program Files\\Nearly','C:\\Users','C:\\Users\\Fixture']){
  const protectedPath=target.toLowerCase().includes('windows')?'C:\\Windows':target.includes('Program Files')?'C:\\Program Files':'C:\\Users\\Fixture';
  assert.equal(refusesProtected(target,protectedPath,1),true,target);
 }
 for(const target of ['D:\\Nearly','E:\\Nearly','C:\\WindowsAppsOwned','C:\\Users\\Fixture\\AppData\\Local\\Nearly']){
  assert.equal(refusesProtected(target,'C:\\Windows',1),false,target);
  assert.equal(refusesProtected(target,'C:\\Users\\Fixture',0),false,target);
 }
 assert.equal(refusesProtected('C:\\Users\\Fixture','C:\\Users\\Fixture\\AppData\\Local',0),true);
 assert.equal(refusesProtected('C:\\Users\\Fixture2','C:\\Users\\Fixture',0),false);
});
