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
test('read-only native System ABI harness exercises ordinary namespaces and image integrity', {skip:process.platform!=='win32'||process.env.NEARLY_NSIS_READONLY_QA!=='1'},()=>{
 const output=path.join(root,'test-results','nsis-readonly-root');fs.mkdirSync(output,{recursive:true});
 const nsis=process.env.NEARLY_NSIS_ROOT;
 assert.ok(nsis,'Use the existing cached compiler only');
 const compiler=path.join(nsis,'Bin','makensis.exe');
 const declarations=source.match(/^Var .+$/gm).join('\n');
 const macro=source.match(/!macro NearlyRootFunctions prefix\r?\n([\s\S]*?)!macroend/)[1];
 for(const [name,mode,mask,sddl,expected] of [
  ['existing-payload-metadata','payload',0,'',0],
  ['pinned-ancestors','path',0,'',0],
  ['image-current','image',0,'',0],
  ['image-exact-copy','image',0,'',0],
  ['image-stale-bytes','image',0,'',5],
  ['image-truncated','image',0,'',5],
  ['image-missing','image',0,'',5],
 ]){
  const exe=path.join(output,`${name}-READONLY-ROOT-TEST.exe`);
  let functions=macro;

  let target='';
  if(mode==='payload'){
   target=path.join(output,'generated-existing-payload-READONLY.bin');
   fs.writeFileSync(target,Buffer.from('Generated metadata fixture; never executable.'));
  }
  if(mode==='image'){
   target=name==='image-current'?exe:path.join(output,name+'-comparison-READONLY.bin');
   const imageFunctions=source.slice(source.indexOf('Function un.NearlyImageCleanup'),source.indexOf('Function un.onInit')).replaceAll('un.Nearly','Nearly').replace('StrCpy $NearlyPayload "$INSTDIR\\uninstall.exe"', 'StrCpy $NearlyPayload "'+target+'"');
   functions+='\n'+imageFunctions;
  }
  const section=mode==='payload'?`  StrCpy $NearlyPayload "${target}"\n  Call NearlyValidatePayload`:mode==='image'?'  Call NearlyVerifyUninstallerImage\n  Call NearlyImageCleanup':String.raw`  StrCpy $INSTDIR "C:\Windows\Nearly-readonly-root-test-nonexistent"
  Call NearlyPinRoot
  StrCmp $NearlyRootMissing 1 +3
    SetErrorLevel 9
    Quit
  Call NearlyReleaseGuards`;
  const script=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\n!define MAINBINARYNAME "Nearly"\nLoadLanguageFile "${nsis}\\Contrib\\Language files\\English.nlf"\nLangString NearlyCannotWrite 1033 "Read-only guard rejected test input"\n${declarations}\n!macro Harness prefix\n${functions}\n!macroend\n!insertmacro Harness ""\nSection\n  StrCpy $NearlyGuardHead 0\n  StrCpy $NearlyLeafNode 0\n  StrCpy $NearlyHandle 0\n  StrCpy $NearlyPendingBuffer 0\n  StrCpy $NearlyEnum 0\n  StrCpy $NearlyFindData 0\n${section}\n  SetErrorLevel 0\nSectionEnd\n`;
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

test('temporary plugin namespace uses ordinary OS access without private-ACL admission', {skip:process.platform!=='win32'||process.env.NEARLY_NSIS_READONLY_QA!=='1'},()=>{
 const output=path.join(root,'test-results','nsis-readonly-plugin');fs.mkdirSync(output,{recursive:true});
 const nsis=process.env.NEARLY_NSIS_ROOT;assert.ok(nsis,'Use existing pinned NSIS tools');
 const declarations=source.match(/^Var .+$/gm).join('\n');
 let functions=source.match(/!macro NearlyRootFunctions prefix\r?\n([\s\S]*?)!macroend/)[1];
 functions=functions.replace(/Function \$\{prefix\}NearlyRejectRoot\r?\n[\s\S]*?FunctionEnd/,'Function ${prefix}NearlyRejectRoot\n  IntOp $0 $R9 << 16\n  IntOp $0 $0 | $NearlyIndex\n  SetErrorLevel $0\n  Quit\nFunctionEnd');
 for(const [label,code]of [['path',13],['pin',14],['root',15],['payload',16]])functions=functions.replace(`nearly_${label}_bad:`,`nearly_${label}_bad:\n  StrCpy $R9 ${code}`);
 const exe=path.join(output,'TEMP-PLUGIN-READONLY-GUARD.exe');
 const script=`Unicode true\nRequestExecutionLevel user\nSilentInstall silent\nOutFile "${exe}"\n!define MAINBINARYNAME "Nearly"\n${declarations}\n!macro Harness prefix\n${functions}\n!macroend\n!insertmacro Harness ""\nSection\n  StrCpy $NearlyGuardHead 0\n  StrCpy $NearlyLeafNode 0\n  StrCpy $NearlyHandle 0\n  StrCpy $NearlyPendingBuffer 0\n  StrCpy $NearlyEnum 0\n  StrCpy $NearlyFindData 0\n  StrCpy $NearlyIndex 0\n  StrCpy $R9 17\n  InitPluginsDir\n  System::Call 'kernel32::GetLongPathNameW(w "$PLUGINSDIR", w .r0, i 1024) i.r1'\n  StrCmp $1 0 0 +3\n    SetErrorLevel 1179648\n    Quit\n  StrCpy $INSTDIR $0\n  Call NearlyPinRoot\n  Call NearlyReleaseGuards\n  SetErrorLevel 0\nSectionEnd\n`;
 assert.doesNotMatch(script,/^\s*(?:File|Delete|RMDir|CreateDirectory|CreateShortcut|WriteReg\w*|DeleteReg\w*|WriteUninstaller|Exec\w*|SetOutPath)\s/im);
 assert.doesNotMatch(script,/::(?:CreateDirectory|DeleteFile|SetSecurity|SetNamedSecurity|MoveFile|ReplaceFile|CreateProcess|ShellExecute)/i);
 const nsi=path.join(output,'temporary-plugin-readonly.nsi');fs.writeFileSync(nsi,script);
 const compile=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',nsi],{encoding:'utf8',windowsHide:true,env:{...process.env,NSISDIR:nsis},timeout:30000});
 fs.writeFileSync(path.join(output,'compile.log'),`${compile.stdout}\n${compile.stderr}`);assert.equal(compile.status,0,compile.stderr||compile.stdout);
 const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
 const result={status:run.status,stage:run.status===null?null:run.status>>>16,pathIndex:run.status===null?null:run.status&65535,error:run.error?.message};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
 console.log('Read-only NSIS temporary guard: '+JSON.stringify(result));
 if(run.status!==0){
  const query=String.raw`$ErrorActionPreference='Stop'
try {
 $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 function Kind($sid) {
  if($sid.Value -eq $me){return 'currentUser'}
  switch($sid.Value){'S-1-5-18'{return 'system'} 'S-1-5-32-544'{return 'administrators'} 'S-1-3-0'{return 'creatorOwner'} 'S-1-3-4'{return 'ownerRights'} 'S-1-1-0'{return 'everyone'} 'S-1-5-11'{return 'authenticatedUsers'}}
  if($sid.IsAccountSid()){return 'otherAccount'}
  if($sid.Value.StartsWith('S-1-15-')){return 'appContainer'}
  return 'other'
 }
 $records=@();$path=[IO.Path]::GetFullPath($env:TEMP)
 for($depth=0;$depth -lt 16 -and $path;$depth++){
  $acl=Get-Acl -LiteralPath $path
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Select-Object -First 64|ForEach-Object{
   [ordered]@{principal=(Kind $_.IdentityReference);mask=[int]$_.FileSystemRights;type=[string]$_.AccessControlType;inherit=[int]$_.InheritanceFlags;propagate=[int]$_.PropagationFlags}
  })
  $records+=@([ordered]@{depth=$depth;pathLength=$path.Length;owner=(Kind ($acl.GetOwner([Security.Principal.SecurityIdentifier])));rules=$rules})
  $parent=Split-Path -Parent $path;if($parent -eq $path){break};$path=$parent
 }
 ConvertTo-Json -InputObject $records -Depth 6 -Compress
}catch{ '[]' }`;
  const diagnostic=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(query,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:32768});
  if(diagnostic.status===0)try{const records=JSON.parse(diagnostic.stdout);console.log('Read-only temporary ACL classes: '+JSON.stringify(records));}catch{}
 }
 assert.equal(run.status,0,'Ordinary temporary plugin namespace must be usable: '+JSON.stringify(result));
});
