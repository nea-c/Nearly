import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(path.join(process.env.NEARLY_TEST_DEPENDENCY_ROOT||root,'package.json'));
const yaml=require('prettier/plugins/yaml');
function value(n){if(!n)return null;if(['root','document','documentBody','mappingKey','mappingValue','sequenceItem','flowSequenceItem'].includes(n.type))return value(n.children.find(c=>c.type!=='documentHead'));if(['mapping','flowMapping'].includes(n.type)){const o={};for(const item of n.children){const[k,v]=item.children,key=value(k);assert.equal(Object.hasOwn(o,key),false);o[key]=value(v);}return o;}if(['sequence','flowSequence'].includes(n.type))return n.children.map(value);if(n.type==='plain'&&['true','false'].includes(n.value))return n.value==='true';if(Object.hasOwn(n,'value'))return n.value;throw Error('Unsupported YAML node');}
const text=fs.readFileSync(path.join(root,'.github/workflows/release-signed-windows.yml'),'utf8'),w=value(yaml.parsers.yaml.parse(text));

test('verification-only mode builds/signs/uploads but can never start the contents-write publisher',()=>{
  assert.deepEqual(w.on.workflow_dispatch.inputs.mode.options,['validate','verify-signature','release']);
  const allowed=(expression,mode)=>Function('return ('+expression.replace(/inputs\.mode/g,JSON.stringify(mode)).replace(/needs\.[a-z-]+\.result/g,"'success'")+')')();
  for(const mode of ['validate','verify-signature','release','unknown']){
    const signs=['verify-signature','release'].includes(mode);
    assert.equal(allowed(w.jobs['trusted-signer'].if,mode),signs);
    assert.equal(allowed(w.jobs.sign.if,mode),signs);
    assert.equal(allowed(w.jobs['unsigned-build'].steps.find(s=>s.id==='upload').if,mode),signs);
    assert.equal(allowed(w.jobs.publish.if,mode),mode==='release');
    for(const job of Object.values(w.jobs))if(job.permissions.contents==='write')assert.equal(allowed(job.if,mode),mode==='release');
  }
});
test('completed local workflow is manual exact-input only, defaults to validation and separates five jobs',()=>{
  assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert.equal(w.on.workflow_dispatch.inputs.mode.default,'validate');assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(),['mode','commit','version','confirmation'].sort());assert.deepEqual(w.permissions,{});assert.equal(w.concurrency['cancel-in-progress'],false);assert.deepEqual(Object.keys(w.jobs),['policy','trusted-signer','unsigned-build','sign','publish']);assert.match(w.jobs.policy.if,/workflow_dispatch.*refs\/heads\/main/);
  assert.deepEqual(w.jobs.publish.permissions,{contents:'write',actions:'read'});assert.equal(w.jobs.publish.environment,undefined);
  for(const[name,job]of Object.entries(w.jobs))if(name!=='publish')assert.notEqual(job.permissions.contents,'write');
});
test('only one protected signing step maps Secrets, all prerequisites finish first, publisher receives none',()=>{
  const secretSteps=[];for(const[name,job]of Object.entries(w.jobs)){assert.equal(job.env?.NEARLY_UPDATER_PRIVATE_KEY,undefined);for(const [index,step]of job.steps.entries())if(JSON.stringify(step).includes('${{ secrets.'))secretSteps.push({name,index,step});}
  assert.equal(secretSteps.length,1);assert.equal(secretSteps[0].name,'sign');assert.equal(w.jobs.sign.environment,'nearly-updater-production');
  const sign=w.jobs.sign.steps,index=secretSteps[0].index;assert.ok(sign.slice(0,index).some(s=>s.run?.includes(' prepare-sign ')));assert.ok(sign.slice(0,index).some(s=>s.run?.includes(' preflight ')));assert.match(secretSteps[0].step.run,/nearly-updater-signer\.exe" sign --ci/);
  for(const s of sign.slice(index+1))assert.doesNotMatch(s.run||'',/npm|cargo|rustup|Invoke-WebRequest|install|Expand-Archive/);
  for(const name of ['trusted-signer','unsigned-build','publish'])assert.doesNotMatch(JSON.stringify(w.jobs[name]),/secrets\./);
  assert.match(w.jobs.sign.if,/mode == 'release'/);assert.match(w.jobs.publish.if,/mode == 'release'.*sign.result == 'success'/);
});
test('all action refs are pinned, downloaded IDs come only from dependencies, no target checkout or build in privileged jobs',()=>{
  const pins={'actions/checkout':'d23441a48e516b6c34aea4fa41551a30e30af803','actions/setup-node':'249970729cb0ef3589644e2896645e5dc5ba9c38','actions/upload-artifact':'b7c566a772e6b6bfb58ed0dc250532a479d7789f','actions/download-artifact':'37930b1c2abaa49bbe596cd826c3c89aef350131'};
  for(const[name,job]of Object.entries(w.jobs))for(const s of job.steps){if(s.uses){const[action,sha]=s.uses.split('@');assert.equal(sha,pins[action]);if(action==='actions/checkout'){assert.equal(s.with['persist-credentials'],false);if(['sign','publish','trusted-signer'].includes(name))assert.equal(s.with.ref,'${{ github.workflow_sha }}');}if(action==='actions/download-artifact'){assert.match(s.with['artifact-ids'],/^\$\{\{ needs\./);assert.equal(s.with.name,undefined);assert.equal(s.with['run-id'],undefined);}}assert.equal(s['continue-on-error'],undefined);assert.doesNotMatch(s.run||'',/\$\{\{\s*(?:inputs|secrets)\./);}
  assert.doesNotMatch(text,/actions\/cache|pull_request_target|workflow_run:|id-token:|cancel-in-progress: true/);
  for(const name of ['sign','publish'])for(const s of w.jobs[name].steps)assert.doesNotMatch(s.run||'',/npm|cargo|rustup|build:installer|working-directory: source/);
});
test('portable tools are pinned before use and the downloaded distribution is never launched',()=>{
  const ps=fs.readFileSync(path.join(root,'.github/scripts/prepare-signing-tools.ps1'),'utf8');assert.match(ps,/bootstrapSha256/);assert.match(ps,/archiveSha256/);assert.match(ps,/7z\.exe.*7z\.dll/);assert.match(ps,/& \$bootstrap e -t7z -spd/);assert.doesNotMatch(ps,/& \$archive|Start-Process|choco|winget|Set-Acl|Remove-Item/);
  const lock=JSON.parse(fs.readFileSync(path.join(root,'.github/signing-dependencies.json'),'utf8'));assert.equal(lock.version,'26.04');for(const h of [lock.archiveSha256,lock.bootstrapSha256,...Object.values(lock.files)])assert.match(h,/^[a-f0-9]{64}$/);
});
