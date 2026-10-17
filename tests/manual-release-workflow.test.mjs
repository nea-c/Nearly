import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(process.env.NEARLY_TEST_DEPENDENCY_ROOT||root,'package.json'));
const yaml=require('prettier/plugins/yaml'); // Existing pinned dependency; no parser download.
function value(node){
  if(!node)return null;
  if(['root','document','documentBody','mappingKey','mappingValue','sequenceItem','flowSequenceItem'].includes(node.type))return value(node.children.find(c=>c.type!=='documentHead'));
  if(['mapping','flowMapping'].includes(node.type)){const result={};for(const item of node.children){const [key,val]=item.children;const name=value(key);assert.equal(Object.hasOwn(result,name),false,'no duplicate YAML keys');result[name]=value(val);}return result;}
  if(['sequence','flowSequence'].includes(node.type))return node.children.map(value);
  if(node.type==='plain'&&['true','false'].includes(node.value))return node.value==='true';
  if(node.type==='plain'&&/^[0-9]+$/.test(node.value))return Number(node.value);
  if(Object.hasOwn(node,'value'))return node.value;
  throw Error('Unexpected YAML node '+node.type);
}
const text=fs.readFileSync(path.join(root,'.github/workflows/release-windows.yml'),'utf8');
const workflow=value(yaml.parsers.yaml.parse(text));
test('workflow is valid YAML with manual-only trigger, default validation and no broad permissions',()=>{
  assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default,'validate');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options,['validate','release']);
  assert.deepEqual(workflow.permissions,{});
  assert.equal(workflow.concurrency['cancel-in-progress'],false);
  assert.deepEqual(workflow.jobs.build.permissions,{contents:'read'});
  assert.deepEqual(workflow.jobs.publish.permissions,{contents:'write'});
  assert.match(workflow.jobs.build.if,/github\.ref == 'refs\/heads\/main'/);
});
test('all actions are official and pinned to reviewed immutable SHAs with no persisted Git credentials',()=>{
  const pins={'actions/checkout':'d23441a48e516b6c34aea4fa41551a30e30af803','actions/setup-node':'249970729cb0ef3589644e2896645e5dc5ba9c38','actions/upload-artifact':'b7c566a772e6b6bfb58ed0dc250532a479d7789f','actions/download-artifact':'37930b1c2abaa49bbe596cd826c3c89aef350131'};
  for(const job of Object.values(workflow.jobs))for(const step of job.steps){if(step.uses){const [name,sha]=step.uses.split('@');assert.equal(sha,pins[name]);if(name==='actions/checkout')assert.equal(step.with['persist-credentials'],false);}assert.equal(step['continue-on-error'],undefined);if(step.run)assert.doesNotMatch(step.run,/\$\{\{\s*inputs\./);}
  assert.doesNotMatch(text,/secrets\.|id-token:|pull_request_target|workflow_run/);
});
test('write job consumes only same-run artifact ID plus bound digest and never executes target source',()=>{
  const publish=workflow.jobs.publish;
  assert.equal(publish.needs,'build');assert.match(publish.if,/inputs\.mode == 'release'.*needs\.build\.result == 'success'/);
  const checkouts=publish.steps.filter(s=>s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length,1);assert.equal(checkouts[0].with.path,'control');assert.equal(checkouts[0].with.ref,'${{ github.workflow_sha }}');
  const download=publish.steps.find(s=>s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'],'${{ needs.build.outputs.artifact-id }}');assert.equal(download.with['run-id'],undefined);
  const write=publish.steps.at(-1);assert.equal(write.env.RELEASE_MANIFEST_SHA256,'${{ needs.build.outputs.manifest-sha256 }}');assert.equal(write.env.GH_TOKEN,'${{ github.token }}');
  for(const s of publish.steps.filter(s=>s.run))assert.match(s.run,/^node control\/\.github\/scripts\/manual-release\.mjs publish /);
  assert.equal(workflow.env.GITHUB_WORKFLOW_SHA,undefined,'do not overwrite protected default GitHub environment variables');
});
test('tests and source audits gate packaging; validation uploads nothing and release uploads three explicit audited files',()=>{
  const steps=workflow.jobs.build.steps,commands=steps.map(s=>s.run||'');
  for(const cmd of ['npm test','npm run test:installer','npm run test:ui','npm run test:ui:production','npm run build:installer -- --offline --locked'])assert.ok(commands.includes(cmd),cmd);
  assert.ok(commands.some(c=>c.includes('cargo test --offline --locked')&&c.endsWith('--test-threads=1')));
  assert.equal(commands.filter(c=>c.includes('node scripts/sync-difference-test.mjs')).length,2);
  const upload=steps.at(-1);assert.match(upload.uses,/^actions\/upload-artifact@/);assert.equal(upload.with.overwrite,false);assert.equal(upload.with['if-no-files-found'],'error');
  assert.equal(upload.if,"inputs.mode == 'release'");
  assert.deepEqual(upload.with.path.trim().split('\n'),['${{ runner.temp }}/nearly-release/Nearly_${{ inputs.version }}_x64-setup.exe','${{ runner.temp }}/nearly-release/Nearly_${{ inputs.version }}_x64-setup.exe.sha256','${{ runner.temp }}/nearly-release/manifest.json']);
  assert.ok(steps.findIndex(s=>s.id==='package')>steps.findIndex(s=>s.run==='npm run build:installer -- --offline --locked'));
});
test('hosted preparation uses pinned portable build tools, existing cached-tool validation and no installer execution',()=>{
  const ps=fs.readFileSync(path.join(root,'.github/scripts/prepare-windows.ps1'),'utf8');
  assert.match(ps,/nsis-3\.13\/nsis-3\.13\.zip/);assert.match(ps,/nsis_tauri_utils-v0\.5\.3/);assert.equal((ps.match(/Get-FileHash.*SHA256/g)||[]).length,2);
  assert.match(ps,/requireCachedTools/);assert.match(ps,/--remap-path-prefix=/);assert.match(ps,/\/experimental:deterministic/);assert.match(ps,/\/pathmap:/);
  assert.doesNotMatch(ps,/Start-Process|choco|winget|Set-Acl|Remove-Item|\.\/.*setup\.exe/);
});
