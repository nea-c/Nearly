import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/installer-qa-ui.ps1',import.meta.url));
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
