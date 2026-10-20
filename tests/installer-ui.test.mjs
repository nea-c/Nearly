import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/installer-qa-ui.ps1',import.meta.url));
// Bound cold PowerShell/C# startup on shared hosted Windows independently of
// the actual installer's 30/120-second UI waits and all model assertions.
const modelTimeoutMs=60_000;
test('read-only text failures re-enumerate only generic failure or timeout within the existing wait deadline',{skip:process.platform!=='win32'},()=>{
 let csharp=fs.readFileSync(script,'utf8').match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
 assert.ok(csharp,'owned interop source missing');
 csharp=csharp.replace('public delegate bool EnumProc',`public static int ModelError=0, ModelLastError=999, ModelFailures=0, ModelReads=0, ModelInputs=0; public static uint ModelFailMessage=14;
  public delegate bool EnumProc`);
 csharp=csharp.replace(/\[DllImport\("user32\.dll"[^\]]*\)\]\s*static extern uint GetWindowThreadProcessId\([^;]*\);/,'static uint GetWindowThreadProcessId(IntPtr h,out uint pid){pid=h==(IntPtr)1?7u:9u;return 1;}');
 csharp=csharp.replace(/\[DllImport\("kernel32\.dll"[^\]]*\)\]\s*static extern void SetLastError\([^;]*\);/,'static void SetLastError(uint error){ModelLastError=(int)error;}');
 csharp=csharp.replace(/\[DllImport\("user32\.dll"[^\]]*\)\]\s*static extern IntPtr SendMessageTimeout\([^;]*\);/,`static IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result){
    if(h!=(IntPtr)1||flags!=2||timeout!=2000)throw new Exception("Unexpected message contract");
    if(msg==13||msg==14)ModelReads++;else ModelInputs++;
    result=IntPtr.Zero;
    if(msg==ModelFailMessage&&ModelFailures-->0){if(ModelError!=0)ModelLastError=ModelError;return IntPtr.Zero;}
    if(msg==14)result=(IntPtr)3;
    if(msg==13){Marshal.Copy(new char[]{'Y','e','s','\\0'},0,l,4);result=(IntPtr)3;}
    return (IntPtr)1;
  }`);
 csharp=csharp.replaceAll('Marshal.GetLastWin32Error()','ModelLastError');
 csharp=csharp.replace(/\[DllImport\([^\]]+\)\]\s*((?:public )?static) extern ([^\n;]+);/g,'$1 $2 {throw new Exception("Unmodeled native call");}');
 assert.doesNotMatch(csharp,/DllImport|\bextern\b/,'every native API must be replaced before model execution');
 const source=`$ErrorActionPreference='Stop'\nSet-StrictMode -Version Latest\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString('base64')}')))\n`+String.raw`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Wait-Ui'},$true)
Invoke-Expression $fn[0].Extent.Text
$script:identityChecks=0;$script:enumerations=0
function Assert-Process {$script:identityChecks++}
function Controls {$script:enumerations++;return [IntPtr]1}
foreach($message in @(14,13)){
 foreach($errorCode in @(0,1460)){
  [NearlyOwnedUi]::ModelFailMessage=$message;[NearlyOwnedUi]::ModelError=$errorCode;[NearlyOwnedUi]::ModelFailures=1;[NearlyOwnedUi]::ModelInputs=0
  $script:identityChecks=0;$script:enumerations=0
  $result=Wait-Ui {foreach($control in @(Controls)){if([NearlyOwnedUi]::Text($control,7) -ceq 'Yes'){return $true}}} 2
  if(!$result -or $script:enumerations -ne 2 -or $script:identityChecks -ne 2 -or [NearlyOwnedUi]::ModelInputs -ne 0){throw 'Read failure was not re-enumerated without input'}
 }
}
foreach($errorCode in @(5,87,1234)){
 [NearlyOwnedUi]::ModelFailMessage=14;[NearlyOwnedUi]::ModelError=$errorCode;[NearlyOwnedUi]::ModelFailures=50;$script:enumerations=0
 $failure=$null;try{Wait-Ui {foreach($control in @(Controls)){[NearlyOwnedUi]::Text($control,7)}} 2}catch{$failure=$_.Exception.GetBaseException()}
 if($null -eq $failure -or $failure.GetType().Name -cne 'ControlMessageFailureException' -or $failure.NativeError -ne $errorCode -or $script:enumerations -ne 1){throw 'Nontransient read failure was retried or lost its code'}
}
foreach($errorCode in @(0,1460,5)){
 [NearlyOwnedUi]::ModelFailMessage=12;[NearlyOwnedUi]::ModelError=$errorCode;[NearlyOwnedUi]::ModelFailures=50;[NearlyOwnedUi]::ModelInputs=0
 $failure=$null;try{Wait-Ui {[NearlyOwnedUi]::SetText([IntPtr]1,7,'target');return $true} 2}catch{$failure=$_.Exception.GetBaseException()}
 if($null -eq $failure -or $failure.GetType().Name -cne 'ControlMessageFailureException' -or $failure.NativeError -ne $errorCode -or [NearlyOwnedUi]::ModelInputs -ne 1){throw 'Input failure was wrapped or retried'}
}
foreach($errorCode in @(0,1460)){
 [NearlyOwnedUi]::ModelFailMessage=14;[NearlyOwnedUi]::ModelError=$errorCode;[NearlyOwnedUi]::ModelFailures=100000;$script:enumerations=0
 $clock=[Diagnostics.Stopwatch]::StartNew();$failure=$null
 try{Wait-Ui {foreach($control in @(Controls)){[NearlyOwnedUi]::Text($control,7)}} 1}catch{$failure=$_.Exception}
 if($null -eq $failure -or $failure.Message -cne 'Bounded owned installer UI wait timed out' -or $clock.ElapsedMilliseconds -gt 2500 -or $script:enumerations -lt 2 -or $script:enumerations -gt 8){throw 'Persistent transient read escaped the original deadline'}
}
# With no native error set, reset must prevent stale error999 being reported.
[NearlyOwnedUi]::ModelLastError=999;[NearlyOwnedUi]::ModelFailMessage=14;[NearlyOwnedUi]::ModelError=0;[NearlyOwnedUi]::ModelFailures=1
$failure=$null;try{[NearlyOwnedUi]::Text([IntPtr]1,7)}catch{$failure=$_.Exception.GetBaseException()}
if($failure.GetType().Name -cne 'ReadUnavailableException' -or $failure.NativeError -ne 0){throw 'Generic failure misclassified as timeout or stale error'}
$before=[NearlyOwnedUi]::ModelReads;$failure=$null
try{[NearlyOwnedUi]::Text([IntPtr]2,7)}catch{$failure=$_.Exception.GetBaseException()}
if($failure.GetType().Name -cne 'WindowChangedException' -or [NearlyOwnedUi]::ModelReads -ne $before){throw 'Foreign control reached native read'}
'Read-only transient message policy passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','& ([scriptblock]::Create([Console]::In.ReadToEnd()))'],{input:source,encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Read-only transient message policy passed/);
});
test('directory selection skips an exact existing target and verifies every requested edit',{skip:process.platform!=='win32'},()=>{
 assert.match(fs.readFileSync(script,'utf8'),/Set-VerifiedDirectorySelection \$edit\r?\n  Screenshot 'directory'/);
 const source=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
class NearlyOwnedUi {
 static [string]$Current='D:\Owned\Nearly'
 static [int]$Writes=0
 static [int]$Reads=0
 static [bool]$Refuse=$false
 static [bool]$ForbidWrite=$false
 static [string] Text([IntPtr]$h,[int]$pidValue){if($h -ne 19 -or $pidValue -ne 7){throw 'Foreign directory queried'};[NearlyOwnedUi]::Reads++;return [NearlyOwnedUi]::Current}
 static [void] SetText([IntPtr]$h,[int]$pidValue,[string]$value){if($h -ne 19 -or $pidValue -ne 7 -or $value -cne 'D:\Owned\Nearly'){throw 'Foreign directory edit'};if([NearlyOwnedUi]::ForbidWrite){throw 'Redundant exact-target edit'};[NearlyOwnedUi]::Writes++;if(![NearlyOwnedUi]::Refuse){[NearlyOwnedUi]::Current=$value}}
}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Set-VerifiedDirectorySelection'},$true)
if($fn.Count -ne 1){throw 'Directory selection implementation missing'}
Invoke-Expression $fn[0].Extent.Text
$ownedProcess=[pscustomobject]@{Id=7};$InstallRoot='D:\Owned\Nearly'
[NearlyOwnedUi]::ForbidWrite=$true
Set-VerifiedDirectorySelection ([IntPtr]19)
if([NearlyOwnedUi]::Writes -ne 0 -or [NearlyOwnedUi]::Reads -ne 2){throw 'Exact target must skip writing and verify readback'}
[NearlyOwnedUi]::ForbidWrite=$false
foreach($initial in @('D:\Other\Nearly','d:\Owned\Nearly','D:\Owned\NEARLY','D:\Owned\.\Nearly')){
 [NearlyOwnedUi]::Current=$initial;[NearlyOwnedUi]::Writes=0;[NearlyOwnedUi]::Reads=0
 Set-VerifiedDirectorySelection ([IntPtr]19)
 if([NearlyOwnedUi]::Writes -ne 1 -or [NearlyOwnedUi]::Reads -ne 2 -or [NearlyOwnedUi]::Current -cne $InstallRoot){throw 'Mismatch must write the exact target once and verify'}
}
[NearlyOwnedUi]::Current='D:\Other\Nearly';[NearlyOwnedUi]::Refuse=$true
$rejected=$false;try{Set-VerifiedDirectorySelection ([IntPtr]19)}catch{$rejected=$true}
if(!$rejected){throw 'Failed target readback accepted'}
'Verified directory selection passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Verified directory selection passed/);
});
test('known rejection dialogs select the actual owned OK control and await dismissal without guessing ID',{skip:process.platform!=='win32'},()=>{
 const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public sealed class WindowChangedException:Exception{}
 public sealed class ReadUnavailableException:Exception{}
 public static string Mode="ok";public static int Id=2,Inputs=0,Queries=0;public static bool Gone=false;
 public static string Class(IntPtr h,int pid){if(pid!=7)throw new Exception("Foreign PID");if(Gone&&h==(IntPtr)1)throw new Exception("Destroyed modal queried");if(Mode=="race"&&Queries++==0)throw new WindowChangedException();return h==(IntPtr)10?"#32770":h==(IntPtr)1?(Mode=="dialog"?"Edit":"#32770"):h==(IntPtr)2?"Static":"Button";}
 public static string Text(IntPtr h,int pid){return h==(IntPtr)2?(Mode=="message"?"untrusted path secret":"known rejection"):Mode=="caption"?"Delete":Mode=="amp"?"&OK":"OK";}
 public static IntPtr Parent(IntPtr h,int pid){return Mode=="parent"?(IntPtr)9:(IntPtr)1;}
 public static int GetDlgCtrlID(IntPtr h){return Id;}
 public static bool IsWindowVisible(IntPtr h){return Mode!="hidden";}
 public static bool IsWindowEnabled(IntPtr h){return true;}
 public static void Command(IntPtr parent,IntPtr button,int pid,int id){Input(parent,button,pid,id);}
 public static void ClickDirect(IntPtr parent,IntPtr button,int pid,int id){Input(parent,button,pid,id);}
 static void Input(IntPtr parent,IntPtr button,int pid,int id){if(parent!=(IntPtr)1||button!=(IntPtr)3||pid!=7||id!=Id||id<1||id>2)throw new Exception("Unapproved input");Inputs++;Gone=true;}
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
foreach($name in @('Get-RejectionButton','Dismiss-Rejection','Wait-Ui')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if($fn.Count -ne 1){throw 'Rejection helper missing'}
 Invoke-Expression $fn[0].Extent.Text
}
function Assert-Process {}
function Controls([IntPtr]$Parent){if($Parent -eq [IntPtr]::Zero){if(![NearlyOwnedUi]::Gone){return [IntPtr]1};$script:postQueries++;if($script:postQueries -eq 1){return [IntPtr]1};return};if([NearlyOwnedUi]::Mode -eq 'duplicate'){return @([IntPtr]2,[IntPtr]3,[IntPtr]4)};return @([IntPtr]2,[IntPtr]3)}
function Failure-ControlSnapshot {return @(@{kind='button';id=2;enabled=$true})}
function Write-UiObservation {}
$ownedProcess=[pscustomobject]@{Id=7};$captions=@{Reject='known rejection'};$main=[IntPtr]10;$NavigationMode='Command'
foreach($mode in @('caption','message','dialog','duplicate','hidden','parent')){
 [NearlyOwnedUi]::Mode=$mode
 if($null -ne (Get-RejectionButton ([IntPtr]1))){throw ('Unsafe modal accepted: '+$mode)}
}
[NearlyOwnedUi]::Mode='ok';[NearlyOwnedUi]::Id=6
if($null -ne (Get-RejectionButton ([IntPtr]1))){throw 'Foreign button ID accepted'}
foreach($mode in @('ok','amp','race')){
 [NearlyOwnedUi]::Mode=$mode;[NearlyOwnedUi]::Id=2;[NearlyOwnedUi]::Gone=$false;$script:postQueries=0
 Dismiss-Rejection ([IntPtr]1)
 if($script:postQueries -lt 2){throw 'Modal disappearance was not awaited'}
}
[NearlyOwnedUi]::Mode='ok';[NearlyOwnedUi]::Id=1;[NearlyOwnedUi]::Gone=$false;$NavigationMode='Click';$script:postQueries=0
Dismiss-Rejection ([IntPtr]1)
if([NearlyOwnedUi]::Inputs -ne 4){throw 'Known OK button not selected exactly once per dismissal'}
'Known rejection modal model passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Known rejection modal model passed/);assert.doesNotMatch(r.stdout,/untrusted path secret/);
});
test('ordinary cancellation keeps exit1 while an observed destination refusal preserves exit5',{skip:process.platform!=='win32'},()=>{
 const source=String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Cancel-Setup'},$true)
Invoke-Expression $fn[0].Extent.Text
$main=[IntPtr]1;$ownedProcess=[pscustomobject]@{HasExited=$true;ExitCode=1}
function Click-Id {param($parent,$id)if($parent -ne [IntPtr]1 -or $id -ne 2){throw 'Unexpected fake cancel target'}}
Cancel-Setup
$ownedProcess.ExitCode=5;$rejected=$false;try{Cancel-Setup}catch{$rejected=$true}
if(!$rejected){throw 'Ordinary cancellation wrongly accepted refusal code'}
Cancel-Setup -ExpectedExitCode 5
$ownedProcess.ExitCode=0;$rejected=$false;try{Cancel-Setup -ExpectedExitCode 5}catch{$rejected=$true}
if(!$rejected){throw 'Refusal must not accept success exit'}
'Distinct cancellation outcomes passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Distinct cancellation outcomes passed/);
});
test('completed installation advances with Next only after progress and localized enabled navigation',{skip:process.platform!=='win32'},()=>{
 const source=String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public static string Kind="msctls_progress32", Caption="&Next >";public static bool Enabled=false;
 public static string Class(IntPtr h,int pid){return Kind;}
 public static string Text(IntPtr h,int pid){return Caption;}
 public static bool IsWindowEnabled(IntPtr h){return Enabled;}
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-InstallNavigation'},$true)
if($fn.Count -ne 1){throw 'Completion navigation predicate missing'}
Invoke-Expression $fn[0].Extent.Text
function Controls {return [IntPtr]2}
function ById {return [IntPtr]3}
$main=[IntPtr]1;$ownedProcess=[pscustomobject]@{Id=7};$Language='en'
if($null -ne (Get-InstallNavigation)){throw 'Disabled Next was accepted during extraction'}
[NearlyOwnedUi]::Enabled=$true
if((Get-InstallNavigation).kind -cne 'next'){throw 'Observed completed InstFiles Next not accepted'}
[NearlyOwnedUi]::Kind='Button'
if($null -ne (Get-InstallNavigation)){throw 'Next outside InstFiles was accepted'}
[NearlyOwnedUi]::Caption='&Finish'
if((Get-InstallNavigation).kind -cne 'finish'){throw 'Direct Finish not accepted'}
[NearlyOwnedUi]::Caption='Install';if($null -ne (Get-InstallNavigation)){throw 'Install was accepted as completion'}
$Language='ja';[NearlyOwnedUi]::Kind='msctls_progress32';[NearlyOwnedUi]::Caption='次へ(&N) >'
if((Get-InstallNavigation).kind -cne 'next'){throw 'Japanese Next not accepted'}
[NearlyOwnedUi]::Caption='完了(&F)'
if((Get-InstallNavigation).kind -cne 'finish'){throw 'Japanese Finish not accepted'}
'Completed installation navigation model passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Completed installation navigation model passed/);
});
test('install transition requires a visible progress control or localized Finish, not absent shortcuts',{skip:process.platform!=='win32'},()=>{
 const source=String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public static string Kind="none", Caption="";
 public static string Class(IntPtr h,int pid){return Kind;}
 public static string Text(IntPtr h,int pid){return Caption;}
 public static bool IsWindowEnabled(IntPtr h){return true;}
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-InstallTransition'},$true)
if($fn.Count -ne 1){throw 'Positive transition predicate missing'}
Invoke-Expression $fn[0].Extent.Text
function Controls {return [IntPtr]2}
function ById {return [IntPtr]3}
$main=[IntPtr]1;$ownedProcess=[pscustomobject]@{Id=7};$Language='en'
if(Test-InstallTransition){throw 'Absence alone must not prove page transition'}
[NearlyOwnedUi]::Caption='Install';if(Test-InstallTransition){throw 'Still on shortcut page'}
[NearlyOwnedUi]::Kind='msctls_progress32';if(!(Test-InstallTransition)){throw 'Visible real progress fingerprint missing'}
[NearlyOwnedUi]::Kind='Button';[NearlyOwnedUi]::Caption='&Finish';if(!(Test-InstallTransition)){throw 'Fast completion fingerprint missing'}
'Positive page transition model passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Positive page transition model passed/);
});
test('navigation command probe targets only an enabled owned direct dialog button',{skip:process.platform!=='win32'},()=>{
  let csharp=fs.readFileSync(script,'utf8').match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];assert.ok(csharp);
  csharp=csharp.replace('public delegate bool EnumProc',`public static int ModelPosts=0; public static bool ModelEnabled=true,ModelResult=true; public static IntPtr ModelParent=(IntPtr)1;
  public delegate bool EnumProc`);
  const native=(name,code)=>{const re=new RegExp(String.raw`\[DllImport\("user32\.dll"[^\]]*\)\]\s*(?:public )?static extern [^\n;]+ ${name}\([^;]*\);`);assert.match(csharp,re);csharp=csharp.replace(re,code);};
  native('GetWindowThreadProcessId','static uint GetWindowThreadProcessId(IntPtr h,out uint pid){pid=h==(IntPtr)1||h==(IntPtr)2?7u:9u;return 1;}');
  native('GetParent','static IntPtr GetParent(IntPtr h){return ModelParent;}');
  native('GetDlgCtrlID','public static int GetDlgCtrlID(IntPtr h){return 1;}');
  native('IsWindowVisible','public static bool IsWindowVisible(IntPtr h){return true;}');
  native('IsWindowEnabled','public static bool IsWindowEnabled(IntPtr h){return ModelEnabled;}');
  native('PostMessage','static bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l){if(h!=(IntPtr)1||msg!=273||w!=(IntPtr)1||l!=(IntPtr)2)throw new Exception("Incorrect direct dialog notification");ModelPosts++;return ModelResult;}');
  csharp=csharp.replace(/\[DllImport\([^\]]+\)\]\s*((?:public )?static) extern ([^\n;]+);/g,'$1 $2 {throw new Exception("Unmodeled native call");}');
  assert.doesNotMatch(csharp,/DllImport|\bextern\b/);
  const source=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString('base64')}')))\n`+String.raw`
[NearlyOwnedUi]::Command([IntPtr]1,[IntPtr]2,7,1)
if([NearlyOwnedUi]::ModelPosts -ne 1){throw 'Command not queued once'}
foreach($case in @('foreign','parent','disabled','id')){
 $before=[NearlyOwnedUi]::ModelPosts;$rejected=$false
 [NearlyOwnedUi]::ModelParent=$(if($case -eq 'parent'){[IntPtr]8}else{[IntPtr]1})
 [NearlyOwnedUi]::ModelEnabled=$case -ne 'disabled'
 try{[NearlyOwnedUi]::Command([IntPtr]1,$(if($case -eq 'foreign'){[IntPtr]3}else{[IntPtr]2}),7,$(if($case -eq 'id'){2}else{1}))}catch{$rejected=$true}
 if(!$rejected -or [NearlyOwnedUi]::ModelPosts -ne $before){throw "Unsafe command accepted: $case"}
}
[NearlyOwnedUi]::ModelParent=[IntPtr]1;[NearlyOwnedUi]::ModelEnabled=$true;[NearlyOwnedUi]::ModelResult=$false
$rejected=$false;try{[NearlyOwnedUi]::Command([IntPtr]1,[IntPtr]2,7,1)}catch{$rejected=$true}
if(!$rejected){throw 'Queue failure ignored'}
'Owned navigation command model passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','& ([scriptblock]::Create([Console]::In.ReadToEnd()))'],{input:source,encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Owned navigation command model passed/);
});
test('failure inventory emits only bounded IDs and known control kinds, never window text',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public sealed class WindowChangedException:Exception{}
 public sealed class ReadUnavailableException:Exception{}
 public static string Class(IntPtr h,int pid){if(h==(IntPtr)3)throw new WindowChangedException();return h==(IntPtr)2?"Button":"sensitive arbitrary class";}
 public static int GetDlgCtrlID(IntPtr h){return h==(IntPtr)2?1001:int.MaxValue;}
 public static bool IsWindowEnabled(IntPtr h){return true;}
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Failure-ControlSnapshot'},$true)
Invoke-Expression $fn[0].Extent.Text
function Controls {return @([IntPtr]2,[IntPtr]3,[IntPtr]4)}
$ownedProcess=[pscustomobject]@{Id=7}
$records=@(Failure-ControlSnapshot ([IntPtr]1))
if($records.Count -ne 2 -or $records[0].kind -cne 'button' -or $records[0].id -ne 1001 -or $records[1].kind -cne 'other' -or $null -ne $records[1].id){throw 'Unsafe or incorrect control inventory'}
$json=ConvertTo-Json -InputObject $records -Compress
if($json.Contains('sensitive') -or $json.Contains('text')){throw 'Arbitrary control text leaked'}
'Bounded control inventory passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Bounded control inventory passed/);
});
test('UI wait distinguishes Boolean readiness, zero handles and transition records',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Wait-Ui'},$true)
Invoke-Expression $fn[0].Extent.Text
function Assert-Process {}
$ready=Wait-Ui {$true} 1
if($ready -isnot [bool] -or !$ready){throw 'Boolean true was not accepted'}
$script:probes=0
$handle=Wait-Ui {$script:probes++;if($script:probes -eq 1){return [IntPtr]::Zero};return [IntPtr]7} 1
if($handle -ne [IntPtr]7 -or $script:probes -ne 2){throw 'Zero handle was accepted'}
$script:probes=0
$ready=Wait-Ui {$script:probes++;return $script:probes -gt 1} 1
if(!$ready -or $script:probes -ne 2){throw 'Boolean false was accepted'}
$transition=Wait-Ui {@{kind='accepted'}} 1
if($transition.kind -cne 'accepted'){throw 'Transition record was lost'}
$rejected=$false;try{Wait-Ui {'unexpected string'} 1}catch{$rejected=$_.Exception.Message -match 'Unsupported owned UI wait result type'}
if(!$rejected){throw 'Unexpected wait result type was accepted'}
'Typed UI wait readiness passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Typed UI wait readiness passed/);
});
test('read-only UI waits re-enumerate a control that expires during page transition',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public sealed class WindowChangedException:Exception{}
 public sealed class ReadUnavailableException:Exception{}
 public static int Queries=0;
 public static string Class(IntPtr h,int pid){Queries++;if(Queries==1)throw new WindowChangedException();return "Button";}
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Wait-Ui'},$true)
Invoke-Expression $fn[0].Extent.Text
function Assert-Process {}
function Controls {return [IntPtr]2}
$ownedProcess=[pscustomobject]@{Id=7};$main=[IntPtr]1
Wait-Ui { $all=@(Controls $main | Where-Object {[NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Button'});if($all.Count -eq 1){return $true} } | Out-Null
if([NearlyOwnedUi]::Queries -lt 2){throw 'Expired control was not re-enumerated'}
$rejected=$false;try{Wait-Ui {throw 'Unrelated failure'} 1}catch{$rejected=$_.Exception.Message -match 'Unrelated failure'}
if(!$rejected){throw 'Unrelated errors must not be retried or swallowed'}
$rejected=$false;try{Wait-Ui {throw [NearlyOwnedUi+WindowChangedException]::new()} 1}catch{$rejected=$_.Exception.Message -match 'Bounded owned installer UI wait timed out'}
if(!$rejected){throw 'Persistent ownership loss must time out, never pass'}
'Page-transition control lifetime contract passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Page-transition control lifetime contract passed/);
});
test('owned visibility avoids the initial hidden startup override without repositioning windows',{skip:process.platform!=='win32'},()=>{
  // Exercise the actual C# wrapper with native declarations replaced by a
  // pure API-contract model. No user32 method or desktop is invoked.
  let csharp=fs.readFileSync(script,'utf8').match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert.ok(csharp,'owned interop source missing');
  csharp=csharp.replace('public delegate bool EnumProc',`public static bool ModelVisible=true, ModelResult=true, ModelFirstShow=true; public static int ModelPositionCalls=0, ModelForegroundCalls=0;
  public delegate bool EnumProc`);
  const substitute=(name,definition,required=false)=>{
    const pattern=new RegExp(String.raw`\[DllImport\("user32\.dll"[^\]]*\)\]\s*(?:public )?static extern (?:bool|uint) ${name}\([^;]*\);`);
    if(required)assert.match(csharp,pattern,`native model declaration missing: ${name}`);
    csharp=csharp.replace(pattern,definition);
  };
  substitute('GetWindowThreadProcessId','static uint GetWindowThreadProcessId(IntPtr h,out uint pid){pid=h==(IntPtr)1?7u:9u;return 1;}',true);
  substitute('ShowWindow','static bool ShowWindow(IntPtr h,int command){ModelVisible=ModelFirstShow?false:command!=0;ModelFirstShow=false;return true;}');
  substitute('SetForegroundWindow','static bool SetForegroundWindow(IntPtr h){if(h!=(IntPtr)1)throw new Exception("Foreign activation");ModelForegroundCalls++;return true;}',true);
  substitute('SetWindowPos','static bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags){if(h!=(IntPtr)1||after!=IntPtr.Zero||x!=0||y!=0||width!=0||height!=0||flags!=0x4057u)throw new Exception("Unsafe window positioning flags");ModelPositionCalls++;ModelVisible=ModelResult;return ModelResult;}');
  // Every other imported API becomes a throwing fake as well. A future wrapper
  // refactor must never turn this unit test into a real desktop operation.
  csharp=csharp.replace(/\[DllImport\([^\]]+\)\]\s*((?:public )?static) extern ([^\n;]+);/g,'$1 $2 {throw new Exception("Unmodeled native call");}');
  assert.doesNotMatch(csharp,/DllImport|\bextern\b/,'native declarations must all be replaced');
  const source=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString('base64')}')))\n`+String.raw`
[NearlyOwnedUi]::Show([IntPtr]1,7)
if(![NearlyOwnedUi]::ModelVisible -or [NearlyOwnedUi]::ModelPositionCalls -ne 1){throw 'Owned dialog must remain visible without startup ShowWindow override'}
$before=[NearlyOwnedUi]::ModelPositionCalls;$rejected=$false
try{[NearlyOwnedUi]::Show([IntPtr]2,7)}catch{$rejected=$true}
if(!$rejected -or [NearlyOwnedUi]::ModelPositionCalls -ne $before){throw 'Foreign window was not rejected before visibility change'}
[NearlyOwnedUi]::ModelResult=$false;$rejected=$false
try{[NearlyOwnedUi]::Show([IntPtr]1,7)}catch{$rejected=$true}
if(!$rejected){throw 'Native visibility failure was ignored'}
'Owned visibility API contract passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','& ([scriptblock]::Create([Console]::In.ReadToEnd()))'],{input:source,encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Owned visibility API contract passed/);
});
test('language selector waits for its owned combo after the dialog becomes visible',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Pure fake handles only: no drawing loader, user32 or desktop calls.
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public static int Queries=0;
 public static IntPtr[] Windows(int pid,IntPtr parent){Queries++;return Queries==1?new IntPtr[0]:new[]{(IntPtr)2};}
 public static string Class(IntPtr h,int pid){return "ComboBox";}
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
foreach($name in @('Wait-Ui','Controls','One-Control')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 Invoke-Expression $fn[0].Extent.Text
}
function Assert-Process {}
$ownedProcess=[pscustomobject]@{Id=7};$languageWindow=[IntPtr]1
$assignment=$ast.FindAll({param($n)$n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$combo'},$true)
if($assignment.Count -ne 1){throw 'Exact language combo assignment required'}
Invoke-Expression $assignment[0].Extent.Text
if($combo -ne [IntPtr]2 -or [NearlyOwnedUi]::Queries -lt 2){throw 'Transient owned control was not awaited'}
'Transient owned combo awaited'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Transient owned combo awaited/);
});
test('hosted UI driver exists with a parseable, testable fail-closed policy', {skip:process.platform!=='win32'},()=>{
  assert.equal(fs.existsSync(script),true,'missing guarded installer UI driver');
  // Load ONLY pure functions from the parsed AST. Never execute the entrypoint,
  // load user32, launch setup or inspect this machine\'s desktop in unit tests.
  const source=String.raw`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach($name in @('Assert-UiContext','Get-UiCaptions','Assert-UiSelection')) {
  $fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
  if($fn.Count -ne 1) { throw 'Pure policy function missing or duplicated' }
  Invoke-Expression $fn[0].Extent.Text
}
function Must-Reject([scriptblock]$Action,[string]$Label='selection') { $rejected=$false; try { & $Action | Out-Null } catch { $rejected=$true }; if(!$rejected) { throw "Unsafe input accepted: $Label" } }
$sha='a'*40
$context=@{GITHUB_ACTIONS='true';RUNNER_OS='Windows';RUNNER_ENVIRONMENT='github-hosted';GITHUB_REPOSITORY='nea-c/Nearly';GITHUB_EVENT_NAME='workflow_dispatch';GITHUB_REF='refs/heads/main';GITHUB_SHA=$sha;GITHUB_WORKFLOW_SHA=$sha;QA_CONTROLLER_SHA=$sha;QA_CONFIRMATION="installer-qa $sha";GITHUB_RUN_ID='123';GITHUB_RUN_ATTEMPT='1';RUNNER_TEMP='C:\qa-temp';LOCALAPPDATA='C:\qa-user\AppData\Local'}
$root=Assert-UiContext $context
$branch=$context.Clone();$branch.GITHUB_REF='refs/heads/codex/private-install-directory';if((Assert-UiContext $branch) -cne $root){throw 'Reviewed QA branch rejected'}
if($root -cne 'C:\qa-temp\nearly-installer-qa-123-1') { throw 'Incorrect owned root' }
foreach($key in @($context.Keys)) { $copy=$context.Clone(); $copy.Remove($key); Must-Reject { Assert-UiContext $copy } $key }
foreach($pair in @(@('RUNNER_ENVIRONMENT','self-hosted'),@('GITHUB_EVENT_NAME','push'),@('GITHUB_REF','refs/heads/other'),@('QA_CONFIRMATION',("installer-qa $sha"+[char]10)),@('GITHUB_WORKFLOW_SHA',('b'*40)),@('GITHUB_RUN_ID','01'),@('RUNNER_TEMP','C:\qa-temp\..\other'),@('SYNCFILES_CONFIG_DIR',''))) { $copy=$context.Clone();$copy[$pair[0]]=$pair[1];Must-Reject {Assert-UiContext $copy} $pair[0] }
foreach($lang in @('en','ja')) { $c=Get-UiCaptions $lang; if(!$c.Start -or !$c.Desktop -or $c.Start -ceq $c.Desktop) { throw 'Independent captions required' } }
Must-Reject { Get-UiCaptions 'other' }
Assert-UiSelection @(1,1) @(1,1)
Assert-UiSelection @(1,0) @(1,0)
Assert-UiSelection @(0,1) @(0,1)
Must-Reject { Assert-UiSelection @(1,0) @(0,1) }
Must-Reject { Assert-UiSelection @(2,1) @(2,1) }
Must-Reject { Assert-UiSelection @(1) @(1) }
'Pure UI policy and parse checks passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Pure UI policy and parse checks passed/);
});

test('interop declarations compile without invoking user32 or the script entrypoint',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if($errors.Count) {throw 'UI driver parse error'}
$commands=$ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)
if($commands.Count -ne 2) {throw 'Expected only drawing loader and owned interop declarations'}
foreach($command in $commands) {Invoke-Expression $command.Extent.Text}
'Interop compiled without desktop calls'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Interop compiled without desktop calls/);
});

test('exact UI selectors agree with all English and Japanese installer captions',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-UiCaptions'},$true)
Invoke-Expression $fn[0].Extent.Text
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
@{en=(Get-UiCaptions 'en');ja=(Get-UiCaptions 'ja')} | ConvertTo-Json -Compress
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  const actual=JSON.parse(r.stdout);
  const template=fs.readFileSync(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
  for(const [lang,nsis]of [['en','ENGLISH'],['ja','JAPANESE']])for(const [key,id]of [['Start','NearlyStartMenuText'],['Desktop','NearlyDesktopText'],['Reject','NearlyCannotWrite'],['ProtectNew','NearlyProtectNew'],['ProtectExisting','NearlyProtectExisting']]){
    const expected=template.split('\n').find(line=>line.startsWith(`LangString ${id} \${LANG_${nsis}} `))?.match(/"(.*)"/)?.[1];
    assert.ok(expected,`${lang} ${id} caption missing`);
    assert.equal(actual[lang][key],expected,`${lang} ${id} selector differs`);
  }
});

test('protection consent matches exact localized target and sibling scope, including new-folder and empty-folder plans',{skip:process.platform!=='win32'},()=>{
 const source=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
foreach($name in @('Get-UiCaptions','Get-ProtectionSpec')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if($fn.Count -ne 1){throw 'Protection helper missing'};Invoke-Expression $fn[0].Extent.Text
}
$target='D:\Nearly QA generated';$saved='D:\.Nearly-preserved-'+('a'*32)
foreach($lang in @('en','ja')){
 $c=Get-UiCaptions $lang
 $new=$c.ProtectNew.Replace('$\r$\n',([char]13).ToString()+[char]10).Replace('$INSTDIR',$target)
 $empty=$c.ProtectExisting.Replace('$\r$\n',([char]13).ToString()+[char]10).Replace('$INSTDIR',$target).Replace('$NearlyPreservedRoot',$saved)
 if((Get-ProtectionSpec $new $target $lang).kind -cne 'New'){throw 'New plan not matched'}
 if((Get-ProtectionSpec $empty $target $lang).kind -cne 'Existing'){throw 'Existing plan not matched'}
 $badCases=@();$badCases+=$new.Replace($target,'D:\Foreign');$badCases+=($new+'!');$badCases+=$empty.Replace($saved,('C:\.Nearly-preserved-'+('a'*32)));$badCases+=$empty.Replace($saved,'D:\.Nearly-preserved-invalid')
 foreach($bad in $badCases){if($null -ne (Get-ProtectionSpec $bad $target $lang)){throw 'Wrong target or scope accepted'}}
}
'Exact consent plan model passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Exact consent plan model passed/);
});

test('consent selector and transition policy reject wrong ownership scope, default Yes and re-prompt',{skip:process.platform!=='win32'},()=>{
 const source=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
class NearlyOwnedUi {
 static [string]$Mode='ok'
 static [string]$Message=''
 static [string]$ModalCaption='Nearly Setup'
 static [string]$MainCaption='Nearly Setup '
 static [int]$Inputs=0
 static [int]$LastChoice=0
 static [bool]$Gone=$false
 static [void] Command([IntPtr]$parent,[IntPtr]$button,[int]$pidValue,[int]$id){if($parent -ne 1 -or $button -ne $id -or $pidValue -ne 7 -or $id -notin @(6,7)){throw 'Unexpected consent input'};[NearlyOwnedUi]::Inputs++;[NearlyOwnedUi]::LastChoice=$id;[NearlyOwnedUi]::Gone=$true}
 static [void] ClickConsent([IntPtr]$parent,[IntPtr]$button,[int]$pidValue,[int]$id){[NearlyOwnedUi]::Command($parent,$button,$pidValue,$id)}
 static [string] Class([IntPtr]$h,[int]$pidValue){if($pidValue -ne 7){throw 'Foreign PID'};if($h -eq 1 -or $h -eq 10){return '#32770'};if($h -eq 2){return 'Static'};return 'Button'}
 static [string] Text([IntPtr]$h,[int]$pidValue){if($h -eq 2){if([NearlyOwnedUi]::Mode -eq 'message'){return 'arbitrary sensitive text'};return [NearlyOwnedUi]::Message};if($h -eq 10){return [NearlyOwnedUi]::MainCaption};if($h -eq 1){if([NearlyOwnedUi]::Mode -eq 'caption'){return 'Foreign'};return [NearlyOwnedUi]::ModalCaption};if([NearlyOwnedUi]::Mode -eq 'button'){return 'Delete'};if($h -eq 6){return '&Yes'};return '&No'}
 static [int] GetDlgCtrlID([IntPtr]$h){return [int]$h}
 static [IntPtr] Parent([IntPtr]$h,[int]$pidValue){if([NearlyOwnedUi]::Mode -eq 'parent'){return [IntPtr]9};return [IntPtr]1}
 static [bool] IsWindowVisible([IntPtr]$h){return [NearlyOwnedUi]::Mode -ne 'hidden'}
 static [bool] IsWindowEnabled([IntPtr]$h){return [NearlyOwnedUi]::Mode -ne 'disabled'}
 static [bool] DefaultButton([IntPtr]$h,[int]$pidValue){if([NearlyOwnedUi]::Mode -eq 'default'){return $h -eq 6};return $h -eq 7}
}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
foreach($name in @('Get-UiCaptions','Get-ProtectionSpec','Get-ProtectionDialog','Assert-ConsentTransition','Answer-Protection','Wait-Ui')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $fn[0].Extent.Text
}
function Controls([IntPtr]$Parent) {if($Parent -eq [IntPtr]::Zero){if(![NearlyOwnedUi]::Gone){return [IntPtr]1};return};if([NearlyOwnedUi]::Mode -eq 'duplicate'){return @([IntPtr]2,[IntPtr]2,[IntPtr]6,[IntPtr]7)};return @([IntPtr]2,[IntPtr]6,[IntPtr]7)}
$ownedProcess=[pscustomobject]@{Id=7};$main=[IntPtr]10;$InstallRoot='D:\Nearly QA generated';$Language='en'
$c=Get-UiCaptions 'en';[NearlyOwnedUi]::Message=$c.ProtectNew.Replace('$\r$\n',([char]13).ToString()+[char]10).Replace('$INSTDIR',$InstallRoot)
if((Get-ProtectionDialog ([IntPtr]1)).kind -cne 'New'){throw 'Known protection dialog not recognized'}
foreach($lang in @('en','ja')){
 $Language=$lang;$labels=Get-UiCaptions $lang
 foreach($kind in @('New','Existing')){
  [NearlyOwnedUi]::Message=$labels.('Protect'+$kind).Replace('$\r$\n',(([char]13).ToString()+[char]10)).Replace('$INSTDIR',$InstallRoot).Replace('$NearlyPreservedRoot',('D:\.Nearly-preserved-'+('a'*32)))
  if((Get-ProtectionDialog ([IntPtr]1)).kind -cne $kind){throw 'Actual directory-caption consent not recognized'}
  foreach($bad in @('Foreign','Nearly Setup!','Nearly Setup ',('Nearly Setup'+[char]10),'Nearly Setup  ')){
   [NearlyOwnedUi]::ModalCaption=$bad
   if($null -ne (Get-ProtectionDialog ([IntPtr]1))){throw 'Near or foreign modal caption accepted'}
  }
  [NearlyOwnedUi]::ModalCaption='Nearly Setup'
 }
}
$Language='en';[NearlyOwnedUi]::Message=$c.ProtectNew.Replace('$\r$\n',(([char]13).ToString()+[char]10)).Replace('$INSTDIR',$InstallRoot)
foreach($bad in @('Nearly Setup','Nearly Setup  ',('Nearly Setup '+[char]10),'Foreign ')){
 [NearlyOwnedUi]::MainCaption=$bad
 if($null -ne (Get-ProtectionDialog ([IntPtr]1))){throw 'Unexpected main caption accepted'}
}
[NearlyOwnedUi]::MainCaption='Nearly Setup '
foreach($mode in @('message','caption','button','parent','hidden','disabled','duplicate')){[NearlyOwnedUi]::Mode=$mode;if($null -ne (Get-ProtectionDialog ([IntPtr]1))){throw ('Unsafe consent accepted: '+$mode)}}
[NearlyOwnedUi]::Mode='default';$rejected=$false;try{Get-ProtectionDialog ([IntPtr]1)}catch{$rejected=$true};if(!$rejected){throw 'Default Yes accepted'}
Assert-ConsentTransition 'Existing' 'Existing' 'No' $false
Assert-ConsentTransition 'New' 'Auto' 'Yes' $false
Assert-ConsentTransition 'None' 'Auto' 'Yes' $true
foreach($case in @(@('None','New','Yes',$false),@('New','None','Yes',$false),@('Existing','New','Yes',$false),@('None','Auto','No',$false),@('New','Auto','Yes',$true))){$rejected=$false;try{Assert-ConsentTransition $case[0] $case[1] $case[2] $case[3]}catch{$rejected=$true};if(!$rejected){throw 'Unexpected consent transition accepted'}}
[NearlyOwnedUi]::Mode='ok'
function Assert-Process {}
function Screenshot {}
$script:mutationChecks=0
function Assert-NoInstallMutation {$script:mutationChecks++}
$events=[Collections.Generic.List[object]]::new();$NavigationMode='Command'
foreach($decision in @('No','Yes')){
 [NearlyOwnedUi]::Gone=$false;$dialog=Get-ProtectionDialog ([IntPtr]1)
 Answer-Protection $dialog $decision
 if([NearlyOwnedUi]::LastChoice -ne $(if($decision -eq 'Yes'){6}else{7})){throw 'Wrong explicit consent choice'}
 $NavigationMode='Click'
}
if([NearlyOwnedUi]::Inputs -ne 2 -or $mutationChecks -ne 4 -or $events.Count -ne 2){throw 'Consent decisions or pre-Install checks missing'}
'Consent selector model passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Consent selector model passed/);assert.doesNotMatch(r.stdout,/arbitrary sensitive text/);
});
