import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/installer-qa-passive-observer.ps1',import.meta.url));
const text=fs.readFileSync(script,'utf8');
function model(body){
 const prefix=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('__SCRIPT__',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Observer parse error'}
function Load-Function([string]$Name){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $Name},$true)
 if($fn.Count -ne 1){throw 'Missing observer function'};Invoke-Expression ($fn[0].Extent.Text.Replace('function '+$Name,'function global:'+$Name))
}
`.replace('__SCRIPT__',script.replaceAll("'","''"));
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prefix+body,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60_000});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 return result.stdout;
}

test('passive classifier accepts only exact current English abort messages',{skip:process.platform!=='win32'},()=>{
 const template=fs.readFileSync(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
 for(const message of [
  'Setup could not replace Nearly.exe. Close Nearly and try again. Your settings have not been removed.',
  'Setup could not finish per-user registration. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.',
  'Setup could not finish shortcut preferences. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.',
 ])assert.ok(template.includes(message),'Current source message changed; update the exact classifier deliberately');
 const stdout=model(String.raw`
Load-Function 'Get-NearlyPassiveClassification'
$cases=@(
 @('Setup could not replace Nearly.exe. Close Nearly and try again. Your settings have not been removed.','payload-write'),
 @('Setup could not finish per-user registration. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.','registration'),
 @('Setup could not finish shortcut preferences. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.','shortcuts')
)
foreach($case in $cases){
 if((Get-NearlyPassiveClassification $case[0]) -cne $case[1]){throw 'Known message not classified'}
 foreach($bad in @($case[0].ToUpperInvariant(),(' '+$case[0]),($case[0]+[char]10),('private-user-path '+$case[0]))){if((Get-NearlyPassiveClassification $bad) -cne 'unknown'){throw 'Approximate match accepted'}}
}
foreach($bad in @('', 'private-user-path secret settings', 'Error', 'Nearly.exe')){if((Get-NearlyPassiveClassification $bad) -cne 'unknown'){throw 'Unknown message accepted'}}
'Exact passive classifier passed'
`);
 assert.match(stdout,/Exact passive classifier passed/);
 assert.doesNotMatch(stdout,/private-user-path|secret settings/);
});

test('observer uses only bounded PID-owned read APIs and declarations compile without executing them',{skip:process.platform!=='win32'},()=>{
 const imports=[...text.matchAll(/\[DllImport\([^\]]+\)\]\s*static extern \w+ (\w+)\(/g)].map(m=>m[1]);
 assert.deepEqual(imports,['EnumWindows','EnumChildWindows','GetWindowThreadProcessId','GetClassName','GetDlgCtrlID','SendMessageTimeout']);
 assert.equal((text.match(/SendMessageTimeout\(window,13,/g)||[]).length,1);
 assert.equal((text.match(/SendMessageTimeout\(window,14,/g)||[]).length,1);
 assert.match(text,/Owned\(control,pid\)\|\|GetDlgCtrlID\(control\)!=1006/);
 assert.match(text,/Owned\(window,pid\)\|\|SendMessageTimeout/);
 assert.match(text,/sample\.WindowCount>=64/);assert.match(text,/children>256/);assert.match(text,/sample\.StatusCount>=4/);
 assert.doesNotMatch(text,/IsWindowVisible|Start-Process|Stop-Process|TerminateProcess|PostMessage|SetForegroundWindow|Set-Acl|Write-Host|Write-Output|WriteFile|WM_COMMAND/);
 const stdout=model(String.raw`
$commands=$ast.FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)
if($commands.Count -ne 1){throw 'Unexpected native loader'}
Invoke-Expression $commands[0].Extent.Text
$watch=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Watch-NearlyPassiveInstaller'},$true)[0]
$timeout=$watch.Body.ParamBlock.Parameters | Where-Object {$_.Name.VariablePath.UserPath -ceq 'TimeoutSeconds'}
if($timeout.DefaultValue.Extent.Text -cne '30' -or $timeout.Extent.Text -notmatch 'ValidateRange\(1,120\)'){throw 'Observer deadline must be bounded'}
'Read-only observer declarations compiled'
`);
 assert.match(stdout,/Read-only observer declarations compiled/);
});

test('managed observer fixtures cover immediate abort, identity, exit, timeout and sanitized failure without desktop calls',{skip:process.platform!=='win32'},()=>{
 const stdout=model(String.raw`
class NearlyPassiveObserverNative {
 static [object]$Sample
 static [bool]$Throw=$false
 static [int]$Reads=0
 static [object] Read([int]$OwnedPid){if($OwnedPid -ne 7){throw 'Foreign PID'};[NearlyPassiveObserverNative]::Reads++;if([NearlyPassiveObserverNative]::Throw){throw 'private-user-path secret UI'};return [NearlyPassiveObserverNative]::Sample}
}
Load-Function 'Get-NearlyPassiveClassification'
Load-Function 'Watch-NearlyPassiveInstaller'
function global:Initialize-NearlyPassiveObserverNative {}
$script:fake=$null
function global:Get-Process {param($Id,$ErrorAction)if($Id -ne 7){throw 'Foreign PID queried'};return $script:fake}
function New-Fake {
 $script:fake=[pscustomobject]@{Path='D:\Fixture\setup.exe';StartTime=[datetime]'2026-01-01T00:00:00Z';HasExited=$false;ExitCode=6;Disposed=$false;Refreshes=0;ThrowAfterFirstRefresh=$false}
 $script:fake | Add-Member ScriptMethod Refresh {$this.Refreshes++;if($this.ThrowAfterFirstRefresh -and $this.Refreshes -gt 1){throw 'private-user-path exit race'}}
 $script:fake | Add-Member ScriptMethod Dispose {$this.Disposed=$true}
 [NearlyPassiveObserverNative]::Reads=0
}
$ticks=([datetime]'2026-01-01T00:00:00Z').ToUniversalTime().Ticks
$args=@{OwnedProcessId=7;ExpectedImage='D:\Fixture\setup.exe';ExpectedStartTimeUtcTicks=$ticks;TimeoutSeconds=1}
[NearlyPassiveObserverNative]::Sample=[pscustomobject]@{Texts=@('Setup could not finish shortcut preferences. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.');WindowCount=1;StatusCount=1;ErrorCode=0;Truncated=$false}
New-Fake;$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'abort-observed' -or $r.observation -cne 'shortcuts' -or $r.exited -or $r.sampleCount -ne 1 -or !$fake.Disposed){throw 'Immediate owned abort observation incorrect'}
New-Fake;$fake.ThrowAfterFirstRefresh=$true;$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'abort-observed' -or $r.observation -cne 'shortcuts' -or !$fake.Disposed){throw 'Known abort lost to optional exit-query race'}
New-Fake;$fake.Path='D:\Foreign\setup.exe';$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'identity-mismatch' -or [NearlyPassiveObserverNative]::Reads -ne 0 -or !$fake.Disposed){throw 'Foreign image was inspected'}
New-Fake;$fake.StartTime=$fake.StartTime.AddSeconds(1);$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'identity-mismatch' -or [NearlyPassiveObserverNative]::Reads -ne 0){throw 'Reused PID was inspected'}
New-Fake;$fake.HasExited=$true;$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'exited' -or !$r.exited -or $r.exitCode -ne 6 -or [NearlyPassiveObserverNative]::Reads -ne 0){throw 'Exit observation incorrect'}
New-Fake;[NearlyPassiveObserverNative]::Sample.Texts=@('private-user-path secret UI');$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'timeout' -or !$r.timedOut -or $r.observation -cne 'unknown' -or $r.sampleCount -lt 1 -or $r.sampleCount -gt 5){throw 'Timeout/poll bound incorrect'}
if((ConvertTo-Json $r -Compress) -match 'private-user-path|secret UI|Texts|Fixture'){throw 'Raw UI or image leaked'}
New-Fake;[NearlyPassiveObserverNative]::Throw=$true;$r=Watch-NearlyPassiveInstaller @args
if($r.state -cne 'unavailable' -or (ConvertTo-Json $r -Compress) -match 'private-user-path|secret UI'){throw 'Failure was not sanitized'}
'Managed passive observer fixtures passed'
`);
 assert.match(stdout,/Managed passive observer fixtures passed/);
 assert.doesNotMatch(stdout,/private-user-path|secret UI/);
});
