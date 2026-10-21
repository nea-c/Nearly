import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {instrumentCandidatePolicyDiagnostics,decodeCandidateFailureTrace} from '../scripts/installer-qa.mjs';

test('candidate QA uses the exact standard installer without private-helper instrumentation',async()=>{
 const original=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
 assert.equal(instrumentCandidatePolicyDiagnostics(original),original);
 for(const bad of [null,'',original+'\nNEARLY_QA_POLICY_OLD',original+'\nNearlyEnsurePolicyHelper',original.replace('Function NearlyDirectoryLeave','Function missing')])assert.throws(()=>instrumentCandidatePolicyDiagnostics(bad));
});

test('ordinary nonempty refusal remains the product refusal without extra QA modals',async()=>{
 const original=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
 const observed=instrumentCandidatePolicyDiagnostics(original);
 assert.doesNotMatch(observed,/NEARLY_QA_POLICY_|--nearly-install-(?:check|prepare)/);
 const body=observed.match(/Function NearlyRequireFreshContents\r?\n([\s\S]*?)FunctionEnd/)[1];
 assert.match(body,/SetErrorLevel 7\s+IfSilent \+2\s+MessageBox MB_ICONSTOP\|MB_OK "\$\(NearlyExistingFiles\)"\s+Abort "\$\(NearlyExistingFiles\)"/);
});

test('candidate failure tracing preserves original decisions and API access flags without rerunning setup',async()=>{
 const original=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
 const target=String.raw`D:\a\_temp\nearly-installer-qa-123-1\candidate-failure.jsonl`;
 const observed=instrumentCandidatePolicyDiagnostics(original,target);
 assert.notEqual(observed,original);
 assert.match(observed,/Function \$\{prefix\}NearlyQaRecordFailure/);
 assert.match(observed,/FileOpen \$R8 "D:\\a\\_temp\\nearly-installer-qa-123-1\\candidate-failure\.jsonl" w/);
 assert.match(observed,/IfFileExists .* nearly_qa_trace_done/);
 assert.match(observed,/IfErrors 0 \+2\n    StrCpy \$R9 1\n  ClearErrors/);
 assert.match(observed,/nearly_qa_trace_done:\n  ClearErrors\n  StrCmp \$R9 1 0 \+2\n    SetErrors/);
 assert.ok(instrumentCandidatePolicyDiagnostics(original,target.replace('D:\\a\\','D:\\$TEMP\\')).includes('FileOpen $R8 "D:\\$$TEMP\\'));
 const repeated=target.replace('D:\\a\\','D:\\candidate-failure.jsonl\\');
 assert.ok(instrumentCandidatePolicyDiagnostics(original,repeated).includes(`FileOpen $R8 "${repeated.replace(/candidate-failure\.jsonl$/,'candidate-shortcuts.jsonl')}" a`));
 for(const stage of ['registration','shortcuts','extract','uninstaller-generate'])assert.ok(observed.includes(`"${stage}"`));
 // Remove inserted diagnostics and undo only the explicit last-error capture.
 // The remaining original instructions, including handles/flags/guards/abort,
 // must be byte-identical after newline normalization.
 const restored=observed.replace(/; NEARLY_QA_TRACE_BEGIN\n[\s\S]*?; NEARLY_QA_TRACE_END\n/g,'')
  .replace(/; NEARLY_QA_NATIVE_CAPTURE_BEGIN\n[\s\S]*?; NEARLY_QA_NATIVE_CAPTURE_END\n/g,'')
  .replace(/ \?e'\n; NEARLY_QA_CAPTURE_BEGIN\n[\s\S]*?; NEARLY_QA_CAPTURE_END\n/g,"'\n");
 assert.equal(restored,original.replaceAll('\r\n','\n'));
 for(const bad of ['D:\\outside.jsonl',target.replace('123-1','0-1'),target.replace('candidate-failure','other'),target+'\n'])assert.throws(()=>instrumentCandidatePolicyDiagnostics(original,bad));
});

test('candidate tracing restores native last-error stack values before the product consumes them',async()=>{
 const original=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
 const observed=instrumentCandidatePolicyDiagnostics(original,String.raw`D:\a\_temp\nearly-installer-qa-123-1\candidate-failure.jsonl`);
 const open=observed.match(/Function \$\{prefix\}NearlyIoOpenDestination\n[\s\S]*?FunctionEnd/)[0];
 assert.match(open,/"nearlyioopendestination-createfilew"/);
 assert.match(open,/CreateFileW\([^\n]+p\.r0 \?e'\n; NEARLY_QA_NATIVE_CAPTURE_BEGIN\n\s+Pop \$NearlyQaFailureCode\n\s+StrCpy \$NearlyQaFailureResult \$0\n\s+Push \$NearlyQaFailureCode\n; NEARLY_QA_NATIVE_CAPTURE_END\n\s+Pop \$NearlyIoOpenError/);
});

test('candidate trace decoding emits only a fixed stage and bounded numeric observations',()=>{
 const row={stage:'nearlyioopendestination-createfilew',result:-1,code:32};
 const encode=value=>Buffer.from(JSON.stringify(value)+'\r\n');
 assert.deepEqual(decodeCandidateFailureTrace(encode(row)),row);
 for(const bad of [{...row,stage:'private-user'}, {...row,path:'D:\\private'}, {...row,code:-1}, {...row,code:4294967296}, {...row,result:'secret'}])assert.throws(()=>decodeCandidateFailureTrace(encode(bad)));
 assert.throws(()=>decodeCandidateFailureTrace(Buffer.alloc(8193)));
 assert.throws(()=>decodeCandidateFailureTrace(Buffer.concat([encode(row),encode(row)])));
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
function Get-ProductionWriteProbe {param($File) if($File -ceq $exe){return 32};if($File -ceq $uninstaller){return 0};throw 'Unexpected probe target'}
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
  assert.match(r.stdout,/"payloadWriteOpenError":32/);assert.match(r.stdout,/"uninstallerWriteOpenError":0/);
});

test('write-access diagnosis has no write/delete API and rejects every other target before native access',{skip:process.platform!=='win32'},async()=>{
 const source=await fs.readFile(new URL('../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
 const code=source.match(/function Get-ProductionWriteProbe[\s\S]*?Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 assert.match(code,/CreateFileW\(path,0x40000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero\)/);
 assert.doesNotMatch(code,/WriteFile|DeleteFile|SetFile|SetSecurity|MoveFile|CREATE_ALWAYS|TRUNCATE_EXISTING/);
 const script=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(code.replaceAll('NearlyQaWriteProbe','NearlyQaWriteProbeDeclarationsOnly')).toString('base64')}')))\n$source=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))).toString('base64')}')))\n`+String.raw`
class NearlyQaWriteProbe {static [int]$Calls=0;static [int]Read([string]$path){[NearlyQaWriteProbe]::Calls++;return 32}}
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-ProductionWriteProbe'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
function Assert-Regular {param($File) if($File -cnotin @('owned.exe','uninstall.exe')){throw 'Unexpected file'}}
$exe='owned.exe';$uninstaller='uninstall.exe';$Action='production'
if((Get-ProductionWriteProbe $exe) -ne 32 -or (Get-ProductionWriteProbe $uninstaller) -ne 32){throw 'Numeric denial lost'}
foreach($kind in @('foreign','phase')){
 $Action='production';$file='foreign.exe';if($kind -ceq 'phase'){$Action='ui';$file=$exe}
 $refused=$false;try{Get-ProductionWriteProbe $file}catch{$refused=$true};if(!$refused){throw 'Unowned probe accepted'}
}
if([NearlyQaWriteProbe]::Calls -ne 2){throw 'Native access escaped exact files'}
'Only mock probes executed; native declarations compiled'
`;
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(r.status,0,r.stderr||r.error?.message);
});
