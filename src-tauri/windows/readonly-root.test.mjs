import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

test('default destination calculation accepts an absent generated leaf without creating it', {skip:process.platform!=='win32'||process.env.NEARLY_NSIS_READONLY_QA!=='1'},()=>{
 const output=path.join(root,'test-results','nsis-readonly-default');fs.mkdirSync(output,{recursive:true});
 const parent=path.join(output,'generated parent 日本語');fs.mkdirSync(parent,{recursive:true});
 const target=path.join(parent,'absent Nearly');assert.equal(fs.existsSync(target),false);
 const nsis=process.env.NEARLY_NSIS_ROOT;assert.ok(nsis,'Use the existing cached compiler only');
 const calc=source.match(/Function NearlySetDefaultRoot\r?\n([\s\S]*?)FunctionEnd/);
 assert.ok(calc,'Actual default calculation required');
 const original=calc[1];
 const needle='$LOCALAPPDATA\\${PRODUCTNAME}';assert.equal(original.split(needle).length,2);
 const body=original.replace(needle,target);
 const exe=path.join(output,'DEFAULT-READONLY-TEST.exe');
 const script=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\nVar NearlyDefaultRoot\nFunction NearlyRejectRoot\n SetErrorLevel 5\n Quit\nFunctionEnd\nFunction NearlySetDefaultRoot\n${body}\nFunctionEnd\nSection\n Call NearlySetDefaultRoot\n StrCmp $NearlyDefaultRoot "${target}" +3\n  SetErrorLevel 9\n  Quit\n SetErrorLevel 0\nSectionEnd\n`;
 assert.doesNotMatch(script,/^\s*(?:File|Delete|RMDir|CreateDirectory|CreateShortcut|WriteReg\w*|DeleteReg\w*|WriteUninstaller|Exec\w*|SetOutPath)\s/im);
 const nsi=path.join(output,'default-readonly.nsi');fs.writeFileSync(nsi,script);
 const compile=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',nsi],{encoding:'utf8',windowsHide:true,env:{...process.env,NSISDIR:nsis},timeout:30000});
 fs.writeFileSync(path.join(output,'compile.log'),`${compile.stdout}\n${compile.stderr}`);assert.equal(compile.status,0,compile.stderr||compile.stdout);
 // The generated program only computes a path and exits. Never setup/uninstall.
 const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({status:run.status,error:run.error?.message},null,2));
 assert.equal(run.status,0,run.error?.message||'An absent default must retain its exact nonempty path');
 assert.equal(fs.existsSync(target),false,'Path calculation must not create the default installation');
});
test('read-only native System ABI harness exercises pinned ancestors and inherited ACL rejection', {skip:process.platform!=='win32'||process.env.NEARLY_NSIS_READONLY_QA!=='1'},()=>{
 const output=path.join(root,'test-results','nsis-readonly-root');fs.mkdirSync(output,{recursive:true});
 const nsis=process.env.NEARLY_NSIS_ROOT;
 assert.ok(nsis,'Use the existing cached compiler only');
 const compiler=path.join(nsis,'Bin','makensis.exe');
 const declarations=source.match(/^Var .+$/gm).join('\n');
 const macro=source.match(/!macro NearlyRootFunctions prefix\r?\n([\s\S]*?)!macroend/)[1];
 for(const [name,mode,mask,sddl,expected] of [
  ['existing-payload-metadata','payload',0,'',0],
  ['pinned-ancestors','path',0,'',0],
  ['private-root','acl','0x500D0156','O:SYD:(A;;FA;;;SY)',0],
  ['foreign-inherit-only-root','acl','0x500D0156','O:SYD:(A;OICIIO;FA;;;WD)(A;;FA;;;SY)',5],
  ['foreign-inherit-only-parent','acl','0x500D0040','O:SYD:(A;OICIIO;FA;;;WD)(A;;FA;;;SY)',0],
  ['creator-inherit-only-root','acl','0x500D0156','O:SYD:(A;OICIIO;FA;;;CO)(A;;FA;;;SY)',0],
  ['creator-effective-root','acl','0x500D0156','O:SYD:(A;;FA;;;CO)(A;;FA;;;SY)',5],
  ['image-current','image',0,'',0],
  ['image-exact-copy','image',0,'',0],
  ['image-stale-bytes','image',0,'',5],
  ['image-truncated','image',0,'',5],
  ['image-missing','image',0,'',5],
  ['foreign-write-root','acl','0x500D0156','O:SYD:(A;;FA;;;WD)(A;;FA;;;SY)',5],
 ]){
  const exe=path.join(output,`${name}-READONLY-ROOT-TEST.exe`);
  let functions=macro;

  if(mode==='acl')functions=functions.replace(/  StrCpy \$NearlySecurity 0\r?\n  System::Call 'advapi32::GetSecurityInfo[^\n]+\n  StrCpy \$NearlyOwnerSid \$1\r?\n  StrCpy \$NearlyDacl \$2\r?\n  StrCpy \$NearlySecurity \$3/,String.raw`  System::Call 'advapi32::GetSecurityDescriptorOwner(p $NearlySecurity, *p .r1, *i .r2) i.r0'
  StrCmp $0 1 0 nearly_acl_bad
  StrCpy $NearlyOwnerSid $1
  System::Call 'advapi32::GetSecurityDescriptorDacl(p $NearlySecurity, *i .r1, *p .r2, *i .r3) i.r0'
  StrCmp $0 1 0 nearly_acl_bad
  StrCmp $1 1 0 nearly_acl_bad
  StrCpy $NearlyDacl $2
  StrCpy $0 0`);
  let target='';
  if(mode==='payload'){
   target=path.join(output,'generated-existing-payload-READONLY.bin');
   fs.writeFileSync(target,Buffer.from('Generated metadata fixture; never executable.'));
   // Isolate the real existing-file metadata ABI from this checkout's ACL.
   // The production ACL function is unchanged and tested independently above.
   const acl=/Function \$\{prefix\}NearlyCheckAcl\r?\n[\s\S]*?FunctionEnd/;
   assert.match(functions,acl);
   functions=functions.replace(acl,'Function ${prefix}NearlyCheckAcl\n  StrCpy $R8 1\n  Return\nFunctionEnd');
  }
  if(mode==='image'){
   target=name==='image-current'?exe:path.join(output,name+'-comparison-READONLY.bin');
   const imageFunctions=source.slice(source.indexOf('Function un.NearlyImageCleanup'),source.indexOf('Function un.onInit')).replaceAll('un.Nearly','Nearly').replace('StrCpy $NearlyPayload "$INSTDIR\\uninstall.exe"', 'StrCpy $NearlyPayload "'+target+'"');
   functions+='\n'+imageFunctions;
  }
  const section=mode==='payload'?`  StrCpy $NearlyPayload "${target}"\n  StrCpy $R8 0\n  Call NearlyValidatePayload\n  StrCmp $R8 1 +3\n    SetErrorLevel 9\n    Quit`:mode==='image'?'  Call NearlyVerifyUninstallerImage\n  Call NearlyImageCleanup':mode==='path'?String.raw`  StrCpy $INSTDIR "C:\Windows\Nearly-readonly-root-test-nonexistent"
  Call NearlyPinRoot
  StrCmp $NearlyRootMissing 1 +3
    SetErrorLevel 9
    Quit
  Call NearlyReleaseGuards`:String.raw`  Call NearlyInitSids
  System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "SDDL", i 1, *p .s, p 0) i.r0'
  Pop $NearlySecurity
  StrCmp $0 1 +3
    SetErrorLevel 9
    Quit
  StrCpy $NearlyMask MASK
  Call NearlyCheckAcl`.replace('SDDL',sddl).replace('MASK',mask);
  const script=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\n!define MAINBINARYNAME "Nearly"\nLoadLanguageFile "${nsis}\\Contrib\\Language files\\English.nlf"\nLangString NearlyCannotWrite 1033 "Read-only guard rejected test input"\n${declarations}\n!macro Harness prefix\n${functions}\n!macroend\n!insertmacro Harness ""\nSection\n  StrCpy $NearlyUserSid 0\n  StrCpy $NearlyGuardHead 0\n  StrCpy $NearlyLeafNode 0\n  StrCpy $NearlyHandle 0\n  StrCpy $NearlyPendingBuffer 0\n  StrCpy $NearlyEnum 0\n  StrCpy $NearlyFindData 0\n${section}\n  SetErrorLevel 0\nSectionEnd\n`;
  assert.doesNotMatch(script,/^\s*(?:File|Delete|RMDir|CreateDirectory|CreateShortcut|WriteReg\w*|DeleteReg\w*|WriteUninstaller|Exec\w*|SetOutPath)\s/im,'No installation, payload, filesystem or registry mutations in this harness');
  assert.doesNotMatch(script,/::(?:CreateDirectory|DeleteFile|SetSecurity|SetNamedSecurity|MoveFile|ReplaceFile|CreateProcess|ShellExecute)/i);
  const nsi=path.join(output,name+'.nsi');fs.writeFileSync(nsi,script);
  const compile=spawnSync(compiler,['/V2','/INPUTCHARSET','UTF8',nsi],{encoding:'utf8',windowsHide:true,env:{...process.env,NSISDIR:nsis},timeout:30000});
  fs.writeFileSync(path.join(output,name+'.compile.log'),`${compile.stdout}\n${compile.stderr}`);
  assert.equal(compile.status,0,`${compile.error??''}\n${compile.stdout}\n${compile.stderr}`);
  if(mode==='image'&&name!=='image-current'&&name!=='image-missing'){
   const bytes=fs.readFileSync(exe);
   if(name==='image-stale-bytes')bytes[bytes.length-1]^=1;
   fs.writeFileSync(target,name==='image-truncated'?bytes.subarray(0,bytes.length-1):bytes);
  }
  // This executable contains read-only guard calls only: it is NOT setup/uninstall.
  const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
  fs.writeFileSync(path.join(output,name+'.result.json'),JSON.stringify({expected,status:run.status,error:run.error?.message},null,2));
  assert.equal(run.status,expected,`${name}: ${run.error??run.stderr} ${run.stdout}`);
 }
});
