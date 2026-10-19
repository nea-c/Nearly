import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const modelTimeoutMs=60_000;
const probe=await import('../scripts/installer-ui-probe.mjs').catch(()=>({}));
const template=await fs.readFile(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
const paths={runRoot:'D:\\temp\\nearly-installer-qa-123-1',tools:'C:\\local\\tauri\\NSIS',icon:'C:\\source\\src-tauri\\icons\\icon.ico'};
test('mock payload has only bounded PE headers and cannot be mistaken for an application',()=>{
  const bytes=probe.mockPayload();assert.equal(bytes.length,80);assert.equal(bytes.readUInt16LE(0),0x5a4d);assert.equal(bytes.readUInt32LE(60),64);assert.equal(bytes.readUInt32LE(64),0x4550);assert.equal(bytes.readUInt16LE(68),0x8664);
  assert.equal(bytes.readUInt16LE(70),0);assert.ok(bytes.length<64+24,'even the full PE file header is absent');
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
