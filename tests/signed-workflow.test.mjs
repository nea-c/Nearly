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
const commit='a'.repeat(40);
function gate(expression,{mode='release',results={},sources={}}={}){
  return Function('return ('+expression
    .replace(/needs\.([a-z-]+)\.outputs\.source-commit/g,(_,job)=>JSON.stringify(sources[job]??commit))
    .replace(/needs\.([a-z-]+)\.result/g,(_,job)=>JSON.stringify(results[job]??'success'))
    .replace(/inputs\.commit/g,JSON.stringify(commit))
    .replace(/inputs\.mode/g,JSON.stringify(mode))+')')();
}

test('browser checks are independent of the Rust build and expose only a reaudited exact source',()=>{
  const browser=w.jobs['browser-ui'],build=w.jobs['unsigned-build'];
  assert.ok(browser,'browser checks need their own job');
  assert.equal(browser.needs,'policy');assert.equal(build.needs,'policy');
  assert.deepEqual(browser.permissions,{contents:'read'});
  assert.equal(browser.environment,undefined);
  assert.doesNotMatch(JSON.stringify(browser),/secrets\.|upload-artifact|download-artifact/);
  const source=browser.steps.find(s=>s.with?.path==='source');
  assert.equal(source.with.ref,'${{ inputs.commit }}');
  assert.equal(source.with['fetch-depth'],'0');assert.equal(source.with['persist-credentials'],false);
  const checks=browser.steps.findIndex(s=>s.run?.includes('npm run test:ui'));
  assert.ok(checks>=0);assert.match(browser.steps[checks].run,/test:ui:production/);
  const verified=browser.steps.findIndex(s=>s.id==='verified');assert.ok(verified>checks);
  assert.match(browser.steps[verified].run,/signed-release\.mjs preflight source/);
  assert.match(browser.steps[verified].run,/rev-parse HEAD/);
  assert.match(browser.steps[verified].run,/-cne \$env:RELEASE_COMMIT/);
  assert.match(browser.steps[verified].run,/source-commit=.*GITHUB_OUTPUT/s);
  assert.equal(browser.outputs['source-commit'],'${{ steps.verified.outputs.source-commit }}');
  assert.equal(build.outputs['source-commit'],'${{ steps.package.outputs.source-commit }}');
  assert.doesNotMatch(build.steps.map(s=>s.run||'').join('\n'),/npm run test:ui/);
  const packageStep=build.steps.find(s=>s.id==='package');
  assert.match(packageStep.run,/signed-release\.mjs package.*rev-parse HEAD.*-cne \$env:RELEASE_COMMIT.*GITHUB_OUTPUT/s);
});

test('signing and publishing reject failed, cancelled, skipped, missing or mismatched prerequisites',()=>{
  for(const name of ['sign','publish']){
    const job=w.jobs[name];
    const required=['policy','trusted-signer','browser-ui','native-tests','unsigned-build',...(name==='publish'?['sign']:[])];
    assert.deepEqual(job.needs,required);
    for(const mode of ['validate','verify-signature','release','unknown']){
      assert.equal(gate(job.if,{mode}),name==='publish'?mode==='release':['verify-signature','release'].includes(mode));
      for(const prerequisite of required)for(const result of ['failure','cancelled','skipped','']){
        assert.equal(gate(job.if,{mode,results:{[prerequisite]:result}}),false,`${name}/${mode}/${prerequisite}/${result}`);
      }
      for(const producer of ['browser-ui','native-tests','unsigned-build'])for(const sha of ['','b'.repeat(40),'a'.repeat(39),'0'.repeat(40)]){
        assert.equal(gate(job.if,{mode,sources:{[producer]:sha}}),false,`${name}/${mode}/${producer}/${sha}`);
      }
    }
  }
});

test('native verification is independent, secret-free and binds its exact source only after every check',()=>{
  const native=w.jobs['native-tests'];assert.ok(native,'native verification job is required');
  assert.equal(native.needs,'policy');assert.equal(native.if,undefined);assert.equal(w.jobs['unsigned-build'].needs,'policy');
  assert.deepEqual(native.permissions,{contents:'read'});assert.equal(native.environment,undefined);
  assert.doesNotMatch(JSON.stringify(native),/secrets\.|upload-artifact|download-artifact|actions\/cache/);
  const source=native.steps.find(s=>s.with?.path==='source');
  assert.equal(source.with.ref,'${{ inputs.commit }}');assert.equal(source.with['fetch-depth'],'0');assert.equal(source.with['persist-credentials'],false);
  for(const job of [native,w.jobs['unsigned-build']]){
    const commands=job.steps.map(s=>s.run||'').join('\n');
    assert.match(commands,/prepare-windows\.ps1 -SourceRoot \.\/source/);
    assert.match(commands,/rustup toolchain install 1\.97\.1 --profile minimal --target x86_64-pc-windows-msvc/);
    assert.match(commands,/cargo \+1\.97\.1 fetch --locked --manifest-path source\/src-tauri\/Cargo\.toml/);
    assert.equal(job.steps.find(s=>s.uses?.startsWith('actions/setup-node')).with['package-manager-cache'],false);
  }
  const verified=native.steps.findIndex(s=>s.id==='verified');assert.equal(verified,native.steps.length-1);
  for(const step of native.steps)assert.equal(step.if,undefined,'checks and their source binding cannot be conditionally omitted');
  assert.match(native.steps[verified].run,/signed-release\.mjs preflight source.*rev-parse HEAD.*-cne \$env:RELEASE_COMMIT.*source-commit=.*GITHUB_OUTPUT/s);
  assert.equal(native.outputs['source-commit'],'${{ steps.verified.outputs.source-commit }}');
  const ps=fs.readFileSync(path.join(root,'.github/scripts/prepare-windows.ps1'),'utf8');
  assert.match(ps,/CARGO_BUILD_JOBS=2/);
});

test('parallelism keeps all native, localhost, installer and licensing checks',()=>{
  const native=w.jobs['native-tests'];assert.ok(native,'native tests need an independent job');
  const checks=native.steps.map(s=>s.run||'').join('\n');
  const build=w.jobs['unsigned-build'].steps.map(s=>s.run||'').join('\n');
  for(const command of ['npm test','npm run test:installer','scripts/ppk-fixtures.mjs','cargo +1.97.1 test --offline --locked','release-native-admission.ps1','sync_difference_generated_localhost','directory_deletion_generated_localhost','scripts/listing-worker-test.mjs','scripts/listing-existing-pipeline-test.mjs']){assert.ok(checks.includes(command),command);assert.ok(!build.includes(command),`not duplicated in packaging: ${command}`);}
  assert.ok(build.includes('npm run build:installer -- --offline --locked'));
  assert.doesNotMatch(checks,/npm run build:installer/);
  assert.match(checks,/node --test control\/tests\/manual-release\.test\.mjs control\/tests\/manual-release-workflow\.test\.mjs control\/tests\/signed-\*\.test\.mjs/);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  assert.match(pkg.scripts.test,/tests\/\*\.test\.mjs/);
  assert.ok(fs.existsSync(path.join(root,'tests/license.test.mjs')));
  assert.equal(fs.existsSync(path.join(root,'.github/workflows/parallel-release-validation.yml')),false);
});

test('verification-only mode builds/signs/uploads but can never start the contents-write publisher',()=>{
  assert.deepEqual(w.on.workflow_dispatch.inputs.mode.options,['validate','verify-signature','release']);
  const allowed=(expression,mode)=>gate(expression,{mode});
  for(const mode of ['validate','verify-signature','release','unknown']){
    const signs=['verify-signature','release'].includes(mode);
    assert.equal(allowed(w.jobs['trusted-signer'].if,mode),signs);
    assert.equal(allowed(w.jobs.sign.if,mode),signs);
    assert.equal(allowed(w.jobs['unsigned-build'].steps.find(s=>s.id==='upload').if,mode),signs);
    assert.equal(allowed(w.jobs.publish.if,mode),mode==='release');
    for(const job of Object.values(w.jobs))if(job.permissions.contents==='write')assert.equal(allowed(job.if,mode),mode==='release');
  }
});
test('completed local workflow is manual exact-input only, defaults to validation and separates seven jobs',()=>{
  assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);assert.equal(w.on.workflow_dispatch.inputs.mode.default,'validate');assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs).sort(),['mode','commit','version','confirmation'].sort());assert.deepEqual(w.permissions,{});assert.equal(w.concurrency['cancel-in-progress'],false);assert.deepEqual(Object.keys(w.jobs),['policy','trusted-signer','browser-ui','native-tests','unsigned-build','sign','publish']);assert.match(w.jobs.policy.if,/workflow_dispatch.*refs\/heads\/main/);
  assert.deepEqual(w.jobs.publish.permissions,{contents:'write',actions:'read'});assert.equal(w.jobs.publish.environment,undefined);
  for(const[name,job]of Object.entries(w.jobs))if(name!=='publish')assert.notEqual(job.permissions.contents,'write');
});
test('only one protected signing step maps Secrets, all prerequisites finish first, publisher receives none',()=>{
  const secretSteps=[];for(const[name,job]of Object.entries(w.jobs)){assert.equal(job.env?.NEARLY_UPDATER_PRIVATE_KEY,undefined);for(const [index,step]of job.steps.entries())if(JSON.stringify(step).includes('${{ secrets.'))secretSteps.push({name,index,step});}
  assert.equal(secretSteps.length,1);assert.equal(secretSteps[0].name,'sign');assert.equal(w.jobs.sign.environment,'nearly-updater-production');
  const sign=w.jobs.sign.steps,index=secretSteps[0].index;assert.ok(sign.slice(0,index).some(s=>s.run?.includes(' prepare-sign ')));assert.ok(sign.slice(0,index).some(s=>s.run?.includes(' preflight ')));assert.match(secretSteps[0].step.run,/nearly-updater-signer\.exe" sign --ci/);
  for(const s of sign.slice(index+1))assert.doesNotMatch(s.run||'',/npm|cargo|rustup|Invoke-WebRequest|install|Expand-Archive/);
  for(const name of ['trusted-signer','browser-ui','native-tests','unsigned-build','publish'])assert.doesNotMatch(JSON.stringify(w.jobs[name]),/secrets\./);
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

test('runner paths are resolved only in permitted step contexts and both native invocations use the pinned reader',()=>{
  for(const job of Object.values(w.jobs))assert.doesNotMatch(JSON.stringify(job.env||{}),/\$\{\{\s*runner\./);
  const native=w.jobs.sign.steps.filter(s=>s.run?.includes('nearly-updater-signer.exe'));
  assert.equal(native.length,2);
  for(const step of native)assert.equal(step.env.NEARLY_UPDATER_EXTRACTOR,'${{ runner.temp }}/nearly-tools/7z.exe');
});
