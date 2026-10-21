import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=new URL('../scripts/release-native-admission.ps1',import.meta.url);
const names=['ordinary_inherited_namespace_is_admitted_by_production_validation','generated_custom_root_payload_current_identity_and_namespace_guards'].map(n=>'install_root::native::tests::'+n);
test('release retains all Rust tests and explicitly runs both standard-user admission tests',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/release-signed-windows.yml',import.meta.url),'utf8');
 for(const name of names)assert.ok(workflow.includes('--skip '+name),name);
 assert.match(workflow,/name: Standard-user installation admission tests\s+working-directory: source\s+run: \.\/scripts\/release-native-admission\.ps1/);
});
test('native admission wrapper refuses other environments and demands each exact positive result',{skip:process.platform!=='win32'},()=>{
 const source=fs.readFileSync(script,'utf8');
 const ps=String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE')))
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
foreach($name in @('Assert-ReleaseNativeContext','Assert-AdmissionResult')){$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true);if(!$fn){throw 'Pure gate missing'};. ([scriptblock]::Create($fn.Extent.Text))}
$sha='a'*40
$context=@{GITHUB_ACTIONS='true';RUNNER_OS='Windows';RUNNER_ENVIRONMENT='github-hosted';GITHUB_REPOSITORY='nea-c/Nearly';GITHUB_EVENT_NAME='workflow_dispatch';GITHUB_REF='refs/heads/main';GITHUB_SHA=$sha;GITHUB_WORKFLOW_SHA=$sha;RELEASE_COMMIT=$sha;RELEASE_MODE='release';RELEASE_TAG='r3.2';RELEASE_CONFIRM="release r3.2 $sha";GITHUB_RUN_ID='123';GITHUB_RUN_ATTEMPT='1'}
Assert-ReleaseNativeContext $context
foreach($mode in @('validate','verify-signature')){$valid=$context.Clone();$valid.RELEASE_MODE=$mode;$valid.RELEASE_CONFIRM=if($mode -ceq 'validate'){''}else{"verify-signature r3.2 $sha"};Assert-ReleaseNativeContext $valid}
foreach($key in @($context.Keys)){$bad=$context.Clone();$bad[$key]='invalid';$rejected=$false;try{Assert-ReleaseNativeContext $bad}catch{$rejected=$true};if(!$rejected){throw "Invalid context admitted: $key"}}
$name='install_root::native::tests::ordinary_inherited_namespace_is_admitted_by_production_validation'
$ok="test $name ... ok"+[char]10+'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 570 filtered out; finished in 0.1s'
Assert-AdmissionResult $name 0 $ok
foreach($output in @($ok.Replace('1 passed','0 passed'),$ok.Replace('0 ignored','1 ignored'),$ok.Replace($name,'another-test'),$ok.Replace('0 failed','1 failed'))){$rejected=$false;try{Assert-AdmissionResult $name 0 $output}catch{$rejected=$true};if(!$rejected){throw 'Missing exact execution admitted'}}
$rejected=$false;try{Assert-AdmissionResult $name 1 $ok}catch{$rejected=$true};if(!$rejected){throw 'Nonzero execution admitted'}
'Only inert context/result checks ran'
`.replace('SOURCE',Buffer.from(fileURLToPath(script)).toString('base64'));
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Only inert context/);
});
test('release admission uses only the existing constrained launcher and fixed offline tests',()=>{
 const source=fs.readFileSync(script,'utf8');
 for(const name of names)assert.ok(source.includes(name));
 assert.ok(source.indexOf('Assert-ReleaseNativeContext $context')<source.indexOf('Add-Type'));
 assert.match(source,/installer-qa-standard-user\.cs/);assert.match(source,/\[NearlyQaStandardUser\]::Run/);assert.match(source,/--offline --locked/);assert.match(source,/--exact/);assert.match(source,/\$PSCommandPath/);
 assert.match(source,/git -C \$root rev-parse HEAD/);assert.match(source,/\$head -cne \$context\.RELEASE_COMMIT/);
 assert.doesNotMatch(source,/Set-Acl|SetNamedSecurityInfo|SetFileSecurity|LogonUser|RunAs|Remove-Item|\bInvoke-Expression\b|secrets\./i);
});
test('the complete admission entrypoint refuses local execution before native launch',{skip:process.platform!=='win32'},()=>{
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',fileURLToPath(script)],{env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8',windowsHide:true,timeout:30000});
 assert.notEqual(r.status,0);assert.match(r.stderr,/Exact hosted release environment required/);
});

test('Cargo JSON selects exactly the built test harness and runtime paths without executing it',{skip:process.platform!=='win32'},()=>{
 const source=fs.readFileSync(script,'utf8');
 const ps=String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE'))),[ref]$null,[ref]$null)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Resolve-AdmissionBuild'},$true);if(!$fn){throw 'Build parser missing'};. ([scriptblock]::Create($fn.Extent.Text))
$target='D:\generated-target';$exe=$target+'\debug\deps\nearly-0123456789abcdef.exe'
$artifact=@{reason='compiler-artifact';target=@{name='nearly';kind=@('bin')};profile=@{test=$true};executable=$exe}
$linked=@{reason='build-script-executed';linked_paths=@('native=D:\generated-target\debug\build\fixture\out','native=D:\outside')}
$finish=@{reason='build-finished';success=$true}
$rows=@($linked,$artifact,$finish)|ForEach-Object{ConvertTo-Json -InputObject $_ -Depth 8 -Compress}
$result=Resolve-AdmissionBuild ($rows -join [char]10) 0 $target
if($result.Executable -cne $exe -or $result.RuntimePaths.Count -ne 3 -or $result.RuntimePaths -contains 'D:\outside'){throw 'Exact artifact/runtime scope lost'}
foreach($kind in @('none','duplicate','failed','exit','escape','not-test')){$bad=$artifact.Clone();$bad.profile=@{test=$true};$items=@($linked,$bad,$finish);$code=0;switch($kind){none{$items=@($finish)}duplicate{$items=@($artifact,$artifact,$finish)}failed{$items=@($artifact,@{reason='build-finished';success=$false})}exit{$code=1}escape{$bad.executable='D:\outside\nearly-0123456789abcdef.exe'}not-test{$bad.profile.test=$false}};$json=($items|ForEach-Object{ConvertTo-Json -InputObject $_ -Depth 8 -Compress}) -join [char]10;$rejected=$false;try{Resolve-AdmissionBuild $json $code $target|Out-Null}catch{$rejected=$true};if(!$rejected){throw "Bad build admitted: $kind"}}
'Cargo metadata parsed without launch or cache access'
`.replace('SOURCE',Buffer.from(fileURLToPath(script)).toString('base64'));
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/without launch or cache access/);
});
test('medium guest executes only the pinned harness from a fresh fixture and never reopens Cargo cache',()=>{
 const source=fs.readFileSync(script,'utf8'),guest=source.slice(source.indexOf('if($Guest) {'),source.indexOf("$metadata=",source.indexOf('if($Guest) {')));
 assert.doesNotMatch(guest,/& cargo|cargo-build-lock/);assert.match(guest,/& \$binary --exact \$name --test-threads=1/);assert.match(guest,/Push-Location \$fixture/);assert.match(source,/\[IO.FileShare\]::Read/);assert.match(source,/Get-FileHash -InputStream \$pin/);
});

test('the held test image denies write/delete and is hashed through the same read handle',{skip:process.platform!=='win32'},()=>{
 const ps=String.raw`
$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE')))
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Open-AdmissionBinary'},$true);. ([scriptblock]::Create($fn.Extent.Text))
$root=Join-Path ([IO.Path]::GetTempPath()) ('nearly-pin-model-'+[Guid]::NewGuid().ToString('N'))
$dir=Join-Path $root 'debug\deps';[IO.Directory]::CreateDirectory($dir)|Out-Null
$file=Join-Path $dir 'nearly-0123456789abcdef.exe';[IO.File]::WriteAllText($file,'Generated non-executable pin fixture; never launch.')
$pin=Open-AdmissionBinary $file $root
try{$before=(Get-FileHash -InputStream $pin).Hash;foreach($operation in @('write','delete')){$refused=$false;try{if($operation -ceq 'write'){[IO.File]::WriteAllText($file,'must not change')}else{[IO.File]::Delete($file)}}catch{$refused=$true};if(!$refused){throw 'Pinned image was mutable'}};$pin.Position=0;if((Get-FileHash -InputStream $pin).Hash -cne $before){throw 'Pinned bytes changed'}}finally{$pin.Dispose()}
'Generated bytes pinned without executing any image'
`.replace('SOURCE',Buffer.from(fileURLToPath(script)).toString('base64'));
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/without executing any image/);
});
