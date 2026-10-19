import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  const summary=probe.probeSummary({controllerSha:'a'.repeat(40)},'Click',true);
  assert.equal(summary.passed,false);assert.equal(summary.destinationKind,'custom');assert.equal(summary.cases[0].case,'diagnostic-mock-click-not-qualification');assert.equal(summary.cases[0].passed,true);
});
test('probe requires exact main SHA confirmation and explicit diagnostic custom context before effects',()=>{
  const sha='a'.repeat(40),e={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RUNNER_OS:'Windows',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:'D:\\a\\_temp',LOCALAPPDATA:'C:\\qa-user\\AppData\\Local',QA_CONTROLLER_SHA:sha,QA_CONFIRMATION:`installer-qa ${sha}`,QA_UI_PROBE:'navigation-only',QA_PROBE_NAVIGATION:'Command',QA_DESTINATION:'custom',QA_SCENARIO:'success'};
  const {plan,navigation}=probe.createProbeContext(e,'win32');assert.equal(navigation,'Command');assert.equal(plan.destinationKind,'custom');assert.ok(plan.installRoot.includes('日本語 space'));
  for(const key of Object.keys(e)){const bad={...e};delete bad[key];assert.throws(()=>probe.createProbeContext(bad,'win32'),undefined,key);}
  for(const [key,value]of [['GITHUB_WORKFLOW_SHA','b'.repeat(40)],['QA_DESTINATION','default'],['QA_UI_PROBE','qualification'],['RUNNER_ENVIRONMENT','self-hosted'],['QA_SCENARIO','health-failure']])assert.throws(()=>probe.createProbeContext({...e,[key]:value},'win32'));
  assert.throws(()=>probe.createProbeContext(e,'linux'));
});
test('diagnostic workflow is exact-SHA manual hosted only and uploads only sanitized evidence',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/installer-ui-probe-windows.yml',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/timeout-minutes: 15/);assert.match(workflow,/navigation: \[Click, Command\]/);assert.match(workflow,/QA_DESTINATION: custom/);
  assert.match(workflow,/github\.workflow_sha/);assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/contents: read/);assert.match(workflow,/installer-qa-evidence\.mjs/);assert.match(workflow,/public-evidence/);
  assert.doesNotMatch(workflow,/npm ci|cargo |rustup |actions: read|contents: write|secrets\.|pull_request:|push:/);
  for(const action of ['checkout','setup-node','upload-artifact'])assert.match(workflow,new RegExp(`actions/${action}@[a-f0-9]{40}`));
});
