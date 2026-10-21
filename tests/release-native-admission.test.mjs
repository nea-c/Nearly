import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
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
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('SOURCE'))
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
`.replace('SOURCE',Buffer.from(source).toString('base64'));
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
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',script.pathname.slice(1)],{env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8',windowsHide:true,timeout:30000});
 assert.notEqual(r.status,0);assert.match(r.stderr,/Exact hosted release environment required/);
});
