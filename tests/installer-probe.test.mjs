import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const modelTimeoutMs=60_000;
const probe=await import('../scripts/installer-ui-probe.mjs').catch(()=>({}));
const template=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
const paths={runRoot:'D:\\temp\\nearly-installer-qa-123-1',tools:'C:\\local\\tauri\\NSIS',icon:'C:\\source\\src-tauri\\icons\\icon.ico'};
test('mock lifecycle selects only desktop while the independent boundary keeps both shortcuts disabled',()=>{
  assert.deepEqual(probe.probeShortcutChoices('lifecycle'),{start:0,desktop:1});
  assert.deepEqual(probe.probeShortcutChoices('boundary'),{start:0,desktop:0});
  assert.throws(()=>probe.probeShortcutChoices('other'));
});
test('shortcut path diagnostics remain finite booleans and invalid metadata never activates a reader',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$null,[ref]$null)
foreach($name in @('Get-ShortcutPathObservation','Assert-Path','Assert-Regular','Assert-Choices')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if($fn.Count -ne 1){throw 'Metadata diagnostic function missing'}
 Invoke-Expression $fn[0].Extent.Text
}
$Boundary=$false;$preferences='generated';$startShortcut='C:\generated\start.lnk';$desktopShortcut='C:\generated\Nearly.lnk';$script:mode='regular';$script:reads=0;$script:activated=0
function Write-ProbeGate {}
function Observe-Shortcut {$script:activated++}
function Get-ItemProperty {param($LiteralPath)return [pscustomobject]@{StartMenuShortcut=0;DesktopShortcut=1}}
function Test-Path {param($LiteralPath)if($LiteralPath -ceq $startShortcut){return $false};if($LiteralPath -ceq $desktopShortcut -and $script:mode -eq 'missing'){return $false};return $true}
function Get-Item {
 param($LiteralPath,[switch]$Force)
 $script:reads++
 if($LiteralPath -ceq $desktopShortcut){
  if($script:mode -in @('throw','missing')){throw 'C:\sentinel-private-path'}
  return [pscustomobject]@{PSIsContainer=($script:mode -eq 'directory');Attributes=$(if($script:mode -eq 'reparse'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Archive});Length=$(if($script:mode -eq 'oversized'){67108865}else{256})}
 }
 return [pscustomobject]@{PSIsContainer=$true;Attributes=$(if($script:mode -eq 'ancestor' -and $LiteralPath -ceq 'C:\generated'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Directory})}
}
$expectedKeys=@('absoluteLocal','canonicalExact','hasForwardSlash','hasExtraColon','exists','leafRegular','leafReparse','ancestorsSafe','lengthPositive','lengthBounded')
foreach($mode in @('regular','directory','reparse','ancestor','oversized','missing','throw')){
 $script:mode=$mode;$record=Get-ShortcutPathObservation $desktopShortcut
 if((($record.Keys | Sort-Object) -join ',') -cne (($expectedKeys | Sort-Object) -join ',')){throw 'Unexpected diagnostic fields'}
 foreach($value in $record.Values){if($value -isnot [bool]){throw 'Nonboolean metadata output'}}
 $json=ConvertTo-Json -InputObject $record -Compress
 if($json.Contains('sentinel') -or $json.Contains('C:')){throw 'Private metadata leaked'}
 if($mode -eq 'regular') {if(!$record.leafRegular -or !$record.ancestorsSafe -or !$record.lengthPositive -or !$record.lengthBounded){throw 'Regular link metadata lost'};continue}
 $before=$script:activated;$rejected=$false;try{Assert-Choices}catch{$rejected=$true}
 if(!$rejected -or $script:activated -ne $before){throw 'Invalid metadata reached shortcut reader'}
}
$script:reads=0
foreach($path in @('relative.lnk','C:\generated\..\Nearly.lnk','C:/generated/Nearly.lnk','C:\generated\Nearly.lnk:stream')){
 $record=Get-ShortcutPathObservation $path
 if($record.exists -or $record.leafRegular -or $record.ancestorsSafe){throw 'Unsafe path metadata inspected'}
}
if($script:reads -ne 0){throw 'Unsafe path reached metadata provider'}
'Inert shortcut metadata diagnostic passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Inert shortcut metadata diagnostic passed/);assert.doesNotMatch(result.stdout,/sentinel-private-path/);
});
test('mock gate diagnostics expose only fixed stage/event enums',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$null,[ref]$null)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-ProbeGate'},$true)
if($fn.Count -ne 1){throw 'Gate validator missing'}
Invoke-Expression $fn[0].Extent.Text
$record=New-ProbeGate 'desktop-link' 'start'
if($record.stage -cne 'desktop-link' -or $record.event -cne 'start'){throw 'Fixed stage lost'}
foreach($bad in @(@('C:\private\sentinel','failure'),@('payload','COM exception body'))){$rejected=$false;try{New-ProbeGate $bad[0] $bad[1]|Out-Null}catch{$rejected=$true};if(!$rejected){throw 'Arbitrary diagnostic accepted'}}
'Fixed gate model passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Fixed gate model passed/);
});
test('wide shortcut diagnostics compare exact Unicode strings and existing file identities without native or COM calls',{skip:process.platform!=='win32'},async()=>{
  const guestSource=await fs.readFile(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url),'utf8');
  let csharp=guestSource.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];assert.ok(csharp);
  assert.match(csharp,/000214F9-0000-0000-C000-000000000046/);assert.match(csharp,/GetPath\(path,path\.Capacity,IntPtr\.Zero,4\)/);
  csharp=csharp.replace('public static class NearlyProbeShortcut {','public static class NearlyProbeShortcut { public static int Opens=0,Closes=0;public static bool Unsafe=false;');
  const native=(name,code)=>{const expression=new RegExp(String.raw`\[DllImport\("kernel32\.dll"[^\]]*\)\]\s*static extern [^\n;]+ ${name}\([^;]*\);`);assert.match(csharp,expression);csharp=csharp.replace(expression,code);};
  native('CreateFileW','static IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template){if(access!=0x80||share!=7||disposition!=3||flags!=0x200000)throw new Exception("Unexpected open policy");Opens++;return path.Contains("missing")?(IntPtr)(-1):path.Contains("different")?(IntPtr)2:(IntPtr)1;}');
  native('GetFileInformationByHandle','static bool GetFileInformationByHandle(IntPtr file,out Info info){info=new Info{Attributes=Unsafe?0x400u:0u,Volume=1,IndexLow=(uint)file.ToInt64()};return true;}');
  native('CloseHandle','static bool CloseHandle(IntPtr file){Closes++;return true;}');
  const readWide=/public static string ReadWide\(string shortcut\) \{[\s\S]*?\r?\n  \}/;assert.match(csharp,readWide);
  csharp=csharp.replace(readWide,'public static string ReadWide(string shortcut){return @"C:\\generated\\日本語 space\\Nearly.exe";}');
  assert.doesNotMatch(csharp,/DllImport|\bextern\b|Activator\.CreateInstance|\.Load\(shortcut/);
  const source=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString('base64')}')))\n`+String.raw`
$expected='C:\generated\日本語 space\Nearly.exe'
$checks=[NearlyProbeShortcut]::Compare($expected,$expected,'C:\generated\alias\Nearly.exe')
if(!$checks[0] -or $checks[1] -or $checks[2] -or !$checks[3] -or !$checks[4]){throw 'Alias diagnostic did not distinguish string and identity'}
$checks=[NearlyProbeShortcut]::Compare($expected,'C:\generated\different\Nearly.exe',$expected)
if($checks[0] -or $checks[3] -or !$checks[4]){throw 'Foreign target identity accepted'}
[NearlyProbeShortcut]::Unsafe=$true
if(([NearlyProbeShortcut]::Compare($expected,$expected,$expected))[3]){throw 'Reparse target accepted'}
[NearlyProbeShortcut]::Unsafe=$false
if(([NearlyProbeShortcut]::Compare($expected,'\\foreign\share\Nearly.exe',$expected))[3]){throw 'UNC target accepted'}
if([NearlyProbeShortcut]::Opens -ne [NearlyProbeShortcut]::Closes){throw 'Read-only handles leaked'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$tokens,[ref]$errors)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Observe-Shortcut'},$true)
Invoke-Expression $fn[0].Extent.Text
function New-Object {param([string]$ComObject)if($ComObject -cne 'WScript.Shell'){throw 'Unexpected COM request'};$shell=[pscustomobject]@{};$shell | Add-Member ScriptMethod CreateShortcut {param($path)return [pscustomobject]@{TargetPath='C:\generated\alias\Nearly.exe'}};return $shell}
function Write-ProbeGate {}
$exe=$expected;$desktopShortcut='C:\generated\desktop.lnk'
Observe-Shortcut
'Inert wide shortcut model passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Inert wide shortcut model passed/);
  const line=result.stdout.split(/\r?\n/).find(line=>line.startsWith('Mock shortcut: '));assert.ok(line);
  const record=JSON.parse(line.slice('Mock shortcut: '.length));assert.equal(record.wideMatchesExpected,true);assert.equal(record.wshMatchesExpected,false);assert.equal(record.wideIdentityMatchesExpected,true);assert.ok(Object.values(record).every(value=>typeof value==='boolean'));assert.doesNotMatch(line,/C:|Nearly\.exe|日本語/);
});
test('mock desktop selection is retained after uninstall while both shortcut files must be absent',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$null,[ref]$null)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-Choices'},$true)
Invoke-Expression $fn[0].Extent.Text
$Boundary=$false;$preferences='generated';$startShortcut='start';$desktopShortcut='desktop';$script:exists=$true;$script:desktop=1;$script:observed=0
function Get-ItemProperty {param($LiteralPath)return [pscustomobject]@{StartMenuShortcut=0;DesktopShortcut=$script:desktop}}
function Assert-Path {}
function Assert-Regular {}
function Observe-Shortcut {$script:observed++}
function Write-ProbeGate {}
function Get-ShortcutPathObservation {return [ordered]@{exists=$script:exists}}
function Test-Path {param($LiteralPath)return $LiteralPath -ceq 'desktop' -and $script:exists}
Assert-Choices
if($script:observed -ne 1){throw 'Selected installed shortcut was not observed'}
$script:exists=$false;Assert-Choices $false
if($script:observed -ne 1){throw 'Removed shortcut was read after uninstall'}
$Boundary=$true;$script:desktop=0;Assert-Choices
$script:desktop=1;$rejected=$false;try{Assert-Choices}catch{$rejected=$true};if(!$rejected){throw 'Boundary preferences changed from 00'}
'Inert retained shortcut preference model passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Inert retained shortcut preference model passed/);
});
test('mock payload is exactly the non-executable UTF8 shell-link control with no MZ or PE header',()=>{
  const bytes=probe.mockPayload(),expected=Buffer.from('non-executable generated shell-link control','utf8');
  assert.equal(bytes.length,43);assert.deepEqual(bytes,expected);assert.equal(bytes.toString('utf8'),'non-executable generated shell-link control');
  assert.notEqual(bytes.readUInt16LE(0),0x5a4d);assert.equal(bytes.includes(Buffer.from([0x50,0x45,0,0])),false);
});
test('guest requires the exact 43-byte control and rejects malformed PE, altered bytes and trailing newline',{skip:process.platform!=='win32'},()=>{
  const source=String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$null,[ref]$null)
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-MockBytes'},$true)
if($fn.Count -ne 1){throw 'Exact fixture validator missing'}
Invoke-Expression $fn[0].Extent.Text
$expected=[Text.Encoding]::UTF8.GetBytes('non-executable generated shell-link control')
Assert-MockBytes $expected
$altered=[byte[]]$expected.Clone();$altered[0]=[byte]78
$old=[byte[]]::new(80);$old[0]=77;$old[1]=90
foreach($bad in @($altered,$old,[Text.Encoding]::UTF8.GetBytes("non-executable generated shell-link control"+[char]10),[byte[]]::new(0))){
 $rejected=$false;try{Assert-MockBytes $bad}catch{$rejected=$true};if(!$rejected){throw 'Inexact fixture accepted'}
}
'Exact plaintext fixture model passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Exact plaintext fixture model passed/);
});
test('strict rendering retains actual pages, ownership guards and independent shortcut code',()=>{
  const rendered=probe.renderProbeTemplate(template,paths);
  assert.doesNotMatch(rendered,/\{\{/);assert.match(rendered,/!define VERSION "1\.9\.0"/);
  for(const name of ['NearlyDirectoryLeave','NearlyShortcutPage','NearlyShortcutPageLeave'])assert.ok(rendered.includes(`Function ${name}`),name);
  for(const name of ['NearlyPinRoot','NearlyRejectRoot'])assert.ok(rendered.includes('Function ${prefix}'+name),name);
  assert.match(rendered,/!insertmacro MUI_PAGE_DIRECTORY/);assert.match(rendered,/File .*oname=/);
  assert.equal(rendered.split(/\r?\n/).length,template.split(/\r?\n/).length);
});
test('unknown, missing, repeated structural fields and NSIS path injection fail closed',()=>{
  for(const source of [template+'{{unknown}}',template.replace('{{product_name}}','Nearly'),template.replace('{{#if resources}}','{{#if unknown}}'),template+'{{#if resources}}{{/if}}'])assert.throws(()=>probe.renderProbeTemplate(source,paths));
  for(const value of ['D:\\bad$TEMP','D:\\bad"','D:\\bad\n','D:\\temp\\..\\foreign','\\\\host\\share','D:/forward'])assert.throws(()=>probe.renderProbeTemplate(template,{...paths,runRoot:value}),value);
});
test('navigation and public summary cannot claim full qualification',()=>{
  for(const mode of ['Click','Command'])assert.equal(probe.validateNavigation(mode),mode);
  for(const mode of [undefined,'','command','Click\n'])assert.throws(()=>probe.validateNavigation(mode));
  const summary=probe.probeSummary({controllerSha:'a'.repeat(40)},'Click',true,true);
  assert.equal(summary.passed,false);assert.equal(summary.destinationKind,'custom');assert.equal(summary.cases[0].case,'diagnostic-mock-click-not-qualification');assert.equal(summary.cases[0].passed,true);
  assert.equal(probe.probeSummary({controllerSha:'a'.repeat(40)},'Click',true,false).cases[0].passed,false);
  assert.equal(probe.probeSummary({controllerSha:'a'.repeat(40)},'Click',false,true).cases[0].passed,false);
  const boundary=probe.probeSummary({controllerSha:'a'.repeat(40)},'Command',true,false,'boundary');
  assert.equal(boundary.passed,false);assert.equal(boundary.cases[0].passed,true);assert.equal(boundary.cases[0].case,'diagnostic-mock-command-boundary-not-qualification');
  assert.equal(probe.probeSummary({controllerSha:'a'.repeat(40)},'Command',false,false,'boundary').cases[0].passed,false);
  assert.throws(()=>probe.probeSummary({controllerSha:'a'.repeat(40)},'Click',true,false,'boundary'));
});
test('lifecycle diagnostics accept only fixed phase/event enums and bounded numeric exit codes',{skip:process.platform!=='win32'},()=>{
  const script=`$ErrorActionPreference='Stop'
  $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$null,[ref]$errors)
  if($errors.Count -ne 0){throw 'Probe guest parse failed'}
  $function=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-ProbeEvent'},$true))
  if($function.Count -ne 1){throw 'Pure lifecycle event validator missing'}
  . ([scriptblock]::Create($function[0].Extent.Text))
  $record=New-ProbeEvent 'reinstall' 'exit' 5
  if($record.phase -cne 'reinstall' -or $record.event -cne 'exit' -or $record.code -ne 5){throw 'Exact failed operation lost'}
  foreach($bad in @(@('C:\\private','exit',5),@('reinstall','secret',0),@('reinstall','exit',65536),@('reinstall','exit',-2))){
    $refused=$false;try{New-ProbeEvent $bad[0] $bad[1] $bad[2] | Out-Null}catch{$refused=$true};if(!$refused){throw 'Unsafe diagnostic accepted'}
  }
  'Pure lifecycle diagnostics passed'`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Pure lifecycle diagnostics passed/);
});
test('silent reinstall exit 5 is identified before failure using an inert fake process',{skip:process.platform!=='win32'},()=>{
  const script=`$ErrorActionPreference='Stop'
  $ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_PROBE_GUEST,[ref]$null,[ref]$null)
  $function=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Phase'},$true))
  if($function.Count -ne 1){throw 'Phase runner missing'}
  . ([scriptblock]::Create($function[0].Extent.Text))
  function Assert-NoApp {}
  function Assert-Regular([string]$Path) {}
  $script:records=@();$script:exitCode=5;$script:started=0
  function Write-ProbeEvent([string]$Phase,[string]$Event,[int]$Code=-1){$script:records+=($Phase+':'+$Event+':'+$Code)}
  function Start-Process {
    param($FilePath,$ArgumentList,[switch]$PassThru,$WindowStyle)
    if($FilePath -cne 'inert-setup' -or $ArgumentList.Count -ne 1 -or $ArgumentList[0] -cne '/S' -or $WindowStyle -cne 'Hidden'){throw 'Unexpected process invocation'}
    $script:started++
    $fake=[pscustomobject]@{ExitCode=$script:exitCode}
    $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($Milliseconds) return $true}
    return $fake
  }
  $refused=$false;try{Invoke-Phase 'reinstall' 'inert-setup'}catch{$refused=$true}
  if(!$refused -or $script:started -ne 1 -or ($script:records -join ',') -cne 'reinstall:start:-1,reinstall:exit:5'){throw 'Exact reinstall failure was lost'}
  $script:records=@();$script:exitCode=0
  Invoke-Phase 'uninstall' 'inert-setup'
  if(($script:records -join ',') -cne 'uninstall:start:-1,uninstall:exit:0'){throw 'Uninstall launcher phase was lost'}
  'Inert phase regression passed'`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QA_PROBE_GUEST:fileURLToPath(new URL('../scripts/installer-ui-probe-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:modelTimeoutMs});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Inert phase regression passed/);
});
test('probe requires exact main SHA confirmation and explicit diagnostic custom context before effects',()=>{
  const sha='a'.repeat(40),e={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RUNNER_OS:'Windows',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:'D:\\a\\_temp',LOCALAPPDATA:'C:\\qa-user\\AppData\\Local',QA_CONTROLLER_SHA:sha,QA_CONFIRMATION:`installer-qa ${sha}`,QA_UI_PROBE:'navigation-only',QA_PROBE_NAVIGATION:'Command',QA_PROBE_KIND:'lifecycle',QA_DESTINATION:'custom',QA_SCENARIO:'success'};
  const {plan,navigation}=probe.createProbeContext(e,'win32');assert.equal(navigation,'Command');assert.equal(plan.destinationKind,'custom');assert.ok(plan.installRoot.includes('日本語 space'));
  for(const key of Object.keys(e)){const bad={...e};delete bad[key];assert.throws(()=>probe.createProbeContext(bad,'win32'),undefined,key);}
  for(const [key,value]of [['GITHUB_WORKFLOW_SHA','b'.repeat(40)],['QA_DESTINATION','default'],['QA_UI_PROBE','qualification'],['RUNNER_ENVIRONMENT','self-hosted'],['QA_SCENARIO','health-failure']])assert.throws(()=>probe.createProbeContext({...e,[key]:value},'win32'));
  assert.throws(()=>probe.createProbeContext(e,'linux'));
  assert.equal(probe.createProbeContext({...e,QA_PROBE_KIND:'boundary'},'win32').kind,'boundary');
  assert.throws(()=>probe.createProbeContext({...e,QA_PROBE_KIND:'boundary',QA_PROBE_NAVIGATION:'Click'},'win32'));
  for(const kind of ['','Boundary','both'])assert.throws(()=>probe.createProbeContext({...e,QA_PROBE_KIND:kind},'win32'));
});
test('diagnostic workflow is exact-SHA manual hosted only and uploads only sanitized evidence',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/installer-ui-probe-windows.yml',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/timeout-minutes: 15/);assert.match(workflow,/include:/);assert.match(workflow,/QA_DESTINATION: custom/);
  assert.equal((workflow.match(/kind: lifecycle/g)||[]).length,2);assert.equal((workflow.match(/kind: boundary/g)||[]).length,1);
  assert.match(workflow,/QA_PROBE_KIND: \$\{\{ matrix\.kind \}\}/);assert.match(workflow,/name: \$\{\{ matrix\.label \}\}/);
  assert.match(workflow,/github\.workflow_sha/);assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/contents: read/);assert.match(workflow,/installer-qa-evidence\.mjs/);assert.match(workflow,/public-evidence/);
  assert.doesNotMatch(workflow,/npm ci|cargo |rustup |actions: read|contents: write|secrets\.|pull_request:|push:/);
  for(const action of ['checkout','setup-node','upload-artifact'])assert.match(workflow,new RegExp(`actions/${action}@[a-f0-9]{40}`));
});
