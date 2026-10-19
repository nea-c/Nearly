import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/installer-qa-ui.ps1',import.meta.url));
test('failure inventory emits only bounded IDs and known control kinds, never window text',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type @'
using System;
public static class NearlyOwnedUi {
 public sealed class WindowChangedException:Exception{}
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
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
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  const actual=JSON.parse(r.stdout);
  const template=fs.readFileSync(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
  for(const [lang,nsis]of [['en','ENGLISH'],['ja','JAPANESE']])for(const [key,id]of [['Start','NearlyStartMenuText'],['Desktop','NearlyDesktopText'],['Reject','NearlyCannotWrite']]){
    const expected=template.split('\n').find(line=>line.startsWith(`LangString ${id} \${LANG_${nsis}} `))?.match(/"(.*)"/)?.[1];
    assert.ok(expected,`${lang} ${id} caption missing`);
    assert.equal(actual[lang][key],expected,`${lang} ${id} selector differs`);
  }
});
