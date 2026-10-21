import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {validationRequest} from '../.github/scripts/parallel-release-validation.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(process.env.NEARLY_TEST_DEPENDENCY_ROOT||root,'package.json'));
const yaml=require('prettier/plugins/yaml');
function value(n){if(!n)return null;if(['root','document','documentBody','mappingKey','mappingValue','sequenceItem','flowSequenceItem'].includes(n.type))return value(n.children.find(c=>c.type!=='documentHead'));if(['mapping','flowMapping'].includes(n.type)){const o={};for(const item of n.children){const[k,v]=item.children,key=value(k);assert.equal(Object.hasOwn(o,key),false);o[key]=value(v);}return o;}if(['sequence','flowSequence'].includes(n.type))return n.children.map(value);if(n.type==='plain'&&['true','false'].includes(n.value))return n.value==='true';if(Object.hasOwn(n,'value'))return n.value;throw Error('Unsupported YAML node');}
const parse=p=>value(yaml.parsers.yaml.parse(fs.readFileSync(path.join(root,p),'utf8')));
const env={GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/43/merge',GITHUB_WORKFLOW_REF:'nea-c/Nearly/.github/workflows/parallel-release-validation.yml@refs/pull/43/merge',GITHUB_WORKFLOW_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',VALIDATION_HEAD_REPOSITORY:'nea-c/Nearly',VALIDATION_HEAD_BRANCH:'codex/parallel-release-ui-local',RELEASE_COMMIT:'b'.repeat(40),RELEASE_MODE:'validate',RELEASE_TAG:'r3.2',RELEASE_CONFIRM:''};
test('validation context accepts only this same-repository PR and exact base/controller identities, never production modes',()=>{
  const r=validationRequest(env,'3.2.0');assert.equal(r.commit,env.RELEASE_COMMIT);assert.equal(r.mode,'validate');assert.equal(r.workflowCommit,env.GITHUB_WORKFLOW_SHA);
  for(const [key,bad]of Object.entries({GITHUB_REPOSITORY:'other/Nearly',GITHUB_EVENT_NAME:'pull_request_target',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'wrong',GITHUB_WORKFLOW_SHA:'bad',GITHUB_RUN_ID:'0',GITHUB_RUN_ATTEMPT:'0',VALIDATION_HEAD_REPOSITORY:'fork/Nearly',VALIDATION_HEAD_BRANCH:'main',RELEASE_COMMIT:'bad',RELEASE_MODE:'release',RELEASE_TAG:'r3.3',RELEASE_CONFIRM:'release'}))assert.throws(()=>validationRequest({...env,[key]:bad},'3.2.0'),key);
  assert.throws(()=>validationRequest({...env,RELEASE_MODE:'verify-signature'},'3.2.0'));
});
test('PR measurement uses the same exact checks and build steps as production, without privileged jobs or binary publication',()=>{
  const production=parse('.github/workflows/release-signed-windows.yml'),w=parse('.github/workflows/parallel-release-validation.yml');
  assert.deepEqual(Object.keys(w.on),['pull_request']);assert.deepEqual(w.on.pull_request.branches,['main']);assert.deepEqual(w.permissions,{});
  assert.deepEqual(Object.keys(w.jobs),['policy','browser-ui','unsigned-build','validation-result']);
  for(const name of ['browser-ui','unsigned-build']){
    const expected=structuredClone(production.jobs[name]);
    if(name==='unsigned-build'){
      expected.steps=expected.steps.filter(s=>s.id!=='upload');
      expected.outputs={'manifest-sha256':'${{ steps.package.outputs.manifest-sha256 }}'};
    }
    for(const s of expected.steps){
      if(s.with?.path==='source')s.with.ref='${{ github.event.pull_request.base.sha }}';
      if(s.run)s.run=s.run.replaceAll('signed-release.mjs preflight','parallel-release-validation.mjs preflight').replaceAll('signed-release.mjs package','parallel-release-validation.mjs package');
    }
    assert.deepEqual(w.jobs[name],expected,name+' preserves checks, pinning, source SHA checkout and build commands');
  }
  const text=fs.readFileSync(path.join(root,'.github/workflows/parallel-release-validation.yml'),'utf8');
  assert.doesNotMatch(text,/secrets\.|contents: write|environment:|upload-artifact|download-artifact|\sprepare-sign\s|sign --ci|workflow_dispatch|pull_request_target|actions\/cache/);
  assert.equal(w.env.RELEASE_COMMIT,'${{ github.event.pull_request.base.sha }}');
  assert.deepEqual(w.jobs['validation-result'].needs,['browser-ui','unsigned-build']);
  assert.equal(w.jobs['validation-result'].if,`always() && (${w.jobs.policy.if})`,'unrelated PRs must skip the result check as well');
  assert.match(w.jobs['validation-result'].steps[0].run,/BROWSER_RESULT.*BUILD_RESULT.*BROWSER_SOURCE.*RELEASE_COMMIT/s);
});
