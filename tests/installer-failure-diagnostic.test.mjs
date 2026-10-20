import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {instrumentCandidatePolicyDiagnostics} from '../scripts/installer-qa.mjs';

test('disposable candidate diagnostics change only the two exact failure boundaries',async()=>{
 const original=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
 const observed=instrumentCandidatePolicyDiagnostics(original);
 assert.equal(observed.replace('\n  MessageBox MB_ICONSTOP|MB_OK "NEARLY_QA_POLICY_HELPER"','').replace('\n  MessageBox MB_ICONSTOP|MB_OK "NEARLY_QA_POLICY_EXIT=$0"',''),original);
 for(const bad of [observed,original.replace('  nearly_plan_bad:','  missing:'),original+'\n  nearly_policy_bad:',null])assert.throws(()=>instrumentCandidatePolicyDiagnostics(bad));
});

test('candidate UI diagnostic classifier emits only anchored fixed stage or bounded exit code',{skip:process.platform!=='win32'},()=>{
 const script=`$ErrorActionPreference='Stop'\n$source=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fileURLToPath(new URL('../scripts/installer-qa-ui.ps1',import.meta.url))).toString('base64')}')))\n`+String.raw`
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-CandidatePolicyDiagnostic'},$true)
if(!$fn){throw 'Classifier missing'};. ([scriptblock]::Create($fn.Extent.Text))
if((Get-CandidatePolicyDiagnostic 'NEARLY_QA_POLICY_HELPER') -cne 'helper-namespace'){throw 'Helper stage lost'}
foreach($code in @('0','5','10','78','-1','error','timeout')){if((Get-CandidatePolicyDiagnostic ('NEARLY_QA_POLICY_EXIT='+$code)) -cne ('helper-exit-'+$code)){throw 'Bounded exit lost'}}
foreach($text in @('prefixNEARLY_QA_POLICY_EXIT=78','NEARLY_QA_POLICY_EXIT=12345678901',('NEARLY_QA_POLICY_EXIT=78'+[char]10),'NEARLY_QA_POLICY_EXIT=secret-token','nearly_qa_policy_exit=78','NEARLY_QA_POLICY_HELPER suffix')){if(Get-CandidatePolicyDiagnostic $text){throw 'Untrusted text accepted'}}
'Bounded diagnostic classification passed'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(r.status,0,r.stderr||r.error?.message);
});

test('production failure diagnostic is one-shot, exact-artifact only and never replaces the original failure',{skip:process.platform!=='win32'},async()=>{
  const script=`$ErrorActionPreference='Stop'\n$source=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))).toString('base64')}')))\n`+String.raw`
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
foreach($name in @('Write-ProductionFailureDiagnostic','Invoke-Bounded')) {
 $fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
 if(!$fn){throw 'Missing diagnostic function'}
 . ([scriptblock]::Create($fn.Extent.Text))
}
$script:launches=0;$script:observations=0;$script:passiveDiagnosticsAttempted=$false
$Setup='owned-setup.exe';$Action='production';$exe='owned.exe';$uninstaller='uninstall.exe';$registration='owned-registry';$startShortcut='owned-start';$desktopShortcut='owned-desktop'
function Assert-Regular {}
function Assert-UnderRun {}
function Test-Path {return $true}
function Get-FileHash {return @{Hash='fc65ec21d586227172f2d8f99ce055e2b2c394db675c59444f47129cae5551dc'}}
function Start-Process {
 param($FilePath,$ArgumentList,[switch]$PassThru,$WindowStyle)
 if($FilePath -cne $Setup -or $WindowStyle -cne 'Hidden'){throw 'Unexpected launch scope'}
 $script:launches++
 if($ArgumentList -ceq '/P'){return @{Id=123;StartTime=[datetime]'2026-10-20T00:00:00Z'}}
 $p=[pscustomobject]@{ExitCode=6};$p|Add-Member ScriptMethod WaitForExit {param($ms) return $true};return $p
}
function Watch-NearlyPassiveInstaller {param($OwnedProcessId,$ExpectedImage,$ExpectedStartTimeUtcTicks,$TimeoutSeconds) $script:observations++;throw 'private sentinel must not replace original'}
# Dot-source resolves to the test observer instead of loading native UI code.
function Invoke-DiagnosticObserver {param($Process,$Image) Watch-NearlyPassiveInstaller -OwnedProcessId $Process.Id -ExpectedImage $Image -ExpectedStartTimeUtcTicks $Process.StartTime.ToUniversalTime().Ticks -TimeoutSeconds 30}
foreach($actionValue in @('ui','drive','uninstall')){
 $Action=$actionValue;Write-ProductionFailureDiagnostic $Setup 6
}
$Action='production';Write-ProductionFailureDiagnostic 'foreign-setup.exe' 6;Write-ProductionFailureDiagnostic $Setup 5
if($script:launches -ne 0){throw 'Invalid diagnostic scope launched setup'}
$caught='';try{Invoke-Bounded $Setup @('/S')}catch{$caught=$_.Exception.Message}
if($caught -cne 'Installer exited with 6' -or $script:launches -ne 2 -or $script:observations -ne 1){throw 'Diagnostic replaced failure or did not observe exact setup'}
Write-ProductionFailureDiagnostic $Setup 6
if($script:launches -ne 2){throw 'Diagnostic retried'}
'Original failure retained; diagnostic bounded to one exact artifact'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Original failure retained/);
  assert.doesNotMatch(r.stdout,/private sentinel/);
});
