import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),yaml=require('prettier/plugins/yaml');
function value(n){if(!n)return null;if(['root','document','documentBody','mappingKey','mappingValue','sequenceItem','flowSequenceItem'].includes(n.type))return value(n.children.find(c=>c.type!=='documentHead'));if(['mapping','flowMapping'].includes(n.type)){const o={};for(const item of n.children){const[k,v]=item.children,key=value(k);assert.equal(Object.hasOwn(o,key),false);o[key]=value(v);}return o;}if(['sequence','flowSequence'].includes(n.type))return n.children.map(value);if(n.type==='plain'&&['true','false'].includes(n.value))return n.value==='true';if(Object.hasOwn(n,'value'))return n.value;throw Error('Unsupported YAML node');}
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const w=value(yaml.parsers.yaml.parse(read('.github/workflows/candidate-windows.yml')));

test('candidate builds exact branch SHA and uploads unsigned artifacts without write/sign/release permission',()=>{
 assert.deepEqual(w.on.push.branches,['codex/r33-candidate']);
 assert.deepEqual(Object.keys(w.on),['push','workflow_dispatch']);
 assert.deepEqual(w.permissions,{});
 assert.equal(w.env.CANDIDATE_SHA,'${{ github.sha }}');assert.equal(w.env.RELEASE_COMMIT,'${{ github.sha }}');assert.equal(w.env.RELEASE_MODE,'validate');assert.equal(w.env.RELEASE_TAG,'r3.3');
 assert.deepEqual(Object.keys(w.jobs),['policy','browser-ui','unsigned-build','validation-result']);
 for(const job of ['browser-ui','unsigned-build']){
  assert.equal(w.jobs[job].needs,'policy');assert.deepEqual(w.jobs[job].permissions,{contents:'read'});
  const source=w.jobs[job].steps.find(s=>s.with?.path==='source');
  assert.equal(source.with.ref,'${{ github.sha }}');assert.equal(source.with['persist-credentials'],false);assert.equal(source.with['fetch-depth'], '0');
 }
 const text=read('.github/workflows/candidate-windows.yml');
 assert.doesNotMatch(text,/secrets\.|contents: write|environment:|pull_request_target|download-artifact|release\.mjs publish|sign --ci|actions\/cache/);
 const upload=w.jobs['unsigned-build'].steps.find(s=>s.id==='upload');
 assert.match(upload.uses,/^actions\/upload-artifact@[a-f0-9]{40}$/);assert.equal(upload.with.overwrite,false);assert.equal(upload.with['if-no-files-found'],'error');assert.equal(upload.with.path,'${{ runner.temp }}/nearly-unsigned/*');
 assert.deepEqual(w.jobs['validation-result'].needs,['browser-ui','unsigned-build']);
 assert.match(w.jobs['validation-result'].steps[0].run,/BROWSER_RESULT.*BUILD_RESULT.*BROWSER_SOURCE.*BUILD_SOURCE.*MANIFEST_SHA256/s);
});

test('parallel candidate jobs retain every production check and native standard-user adapter',()=>{
 const ui=w.jobs['browser-ui'].steps.map(s=>s.run||'').join('\n');
 assert.match(ui,/npm run test:ui\s/);assert.match(ui,/npm run test:ui:production/);
 const native=w.jobs['unsigned-build'].steps.map(s=>s.run||'').join('\n');
 for(const required of ['npm ci','npm test','npm run test:installer','scripts/ppk-fixtures.mjs','cargo +1.97.1 fetch --locked','cargo +1.97.1 test --offline --locked','candidate-native-admission.ps1','sync_difference_generated_localhost','directory_deletion_generated_localhost','npm run build:installer -- --offline --locked','candidate-build.mjs package'])assert.ok(native.includes(required),required);
 assert.ok(native.indexOf('prepare-windows.ps1')<native.indexOf('npm test'));
 assert.ok(native.indexOf('npm run build:installer -- --offline --locked')<native.indexOf('candidate-build.mjs package'));
 for(const step of w.jobs['unsigned-build'].steps.filter(s=>s.uses))assert.match(step.uses,/@[a-f0-9]{40}$/);
});

test('candidate adapter preserves release handle pins, token launcher and exact-test body',()=>{
 const release=read('scripts/release-native-admission.ps1'),adapter=read('.github/scripts/candidate-native-admission.ps1');
 const contextStart=release.indexOf('$context=@{}'),contextEnd=release.indexOf('$head=& git -C $root rev-parse HEAD');
 const expected=release.slice(release.indexOf('function Assert-AdmissionResult'),contextStart)
  +'$root=[IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE \'source\'))\n'
  +'$context=@{RELEASE_COMMIT=$env:RELEASE_COMMIT}\n'
  +'if((Get-Location).ProviderPath -cne $root) { throw \'Exact reviewed candidate source required\' }\n'
  +release.slice(contextEnd).replace("(Join-Path $PSScriptRoot 'installer-qa-standard-user.cs')","(Join-Path $root 'scripts/installer-qa-standard-user.cs')");
 assert.equal(adapter.slice(adapter.indexOf('function Assert-AdmissionResult')).replaceAll('\r\n','\n'),expected.replaceAll('\r\n','\n'));
 assert.match(adapter,/candidate-build\.mjs'\) admission.*GITHUB_WORKSPACE 'source'/);
 assert.ok(adapter.indexOf('candidate-build.mjs')<adapter.indexOf('Add-Type'));
 assert.doesNotMatch(adapter,/Assert-ReleaseNativeContext|Set-Acl|RunAs|LogonUser|Remove-Item|SetEnvironmentVariable\('GITHUB_/i);
 assert.match(release,/GITHUB_REF','refs\/heads\/main'/);
});
