import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unpackSettings} from '../scripts/storage-fixture.mjs';
const qa = await import('../scripts/installer-qa.mjs').catch(() => ({}));
const sha='a'.repeat(40);
const env=()=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RUNNER_OS:'Windows',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:'D:\\a\\_temp',LOCALAPPDATA:'C:\\Users\\runneradmin\\AppData\\Local',QA_CONTROLLER_SHA:sha,QA_CONFIRMATION:`installer-qa ${sha}`});
test('guest JSON comparison normalizes empty objects without running a guest action',{skip:process.platform!=='win32'},()=>{
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./installer-qa-normalize.ps1',import.meta.url)),'-Source',fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Pure generated JSON normalization passed/);
});
test('fixture copy excludes generated roots while retaining dependency distribution files',()=>{
  assert.equal(typeof qa.copyFixturePath,'function');
  for(const name of ['','src/app.ts','node_modules/vite/dist/node/cli.js','node_modules/example/build/index.js','src-tauri/vendor/example/target.rs'])assert.equal(qa.copyFixturePath(name),true,name);
  for(const name of ['.git/config','dist/index.html','build/Nearly.exe','.test-build/api.js','test-results/report.json','src-tauri/target/release/Nearly.exe','.codex/config.toml'])assert.equal(qa.copyFixturePath(name),false,name);
  assert.equal(qa.copyFixturePath('node_modules\\vite\\dist\\node\\cli.js'),true);
  assert.equal(qa.copyFixturePath('src-tauri\\target\\release\\Nearly.exe'),false);
});
test('manual controller SHA, hosted Windows and explicit confirmation are mandatory',()=>{
  assert.equal(typeof qa.validateContext,'function');
  assert.equal(qa.validateContext(env(),'win32').controllerSha,sha);
  for(const key of Object.keys(env())){const e=env();delete e[key];assert.throws(()=>qa.validateContext(e,'win32'),undefined,key);}
  for(const [key,value]of [['GITHUB_SHA','b'.repeat(40)],['GITHUB_EVENT_NAME','push'],['RUNNER_ENVIRONMENT','self-hosted'],['QA_CONFIRMATION',`installer-qa ${sha}\n`],['RUNNER_TEMP','D:\\a\\..\\temp'],['RUNNER_TEMP','D:\\a:alternate'],['SYNCFILES_CONFIG_DIR',''],['GITHUB_RUN_ID','01']])assert.throws(()=>qa.validateContext({...env(),[key]:value},'win32'));
  assert.throws(()=>qa.validateContext(env(),'linux'));
});
test('plan fixes source provenance and refuses path overrides',()=>{
  assert.equal(typeof qa.validatePlan,'function');
  const c=qa.validateContext(env(),'win32'),p=qa.createPlan(c);
  assert.equal(p.runId,'123');assert.equal(p.runAttempt,'1');
  assert.equal(qa.validatePlan(p,c),true);
  for(const [key,value]of [['runRoot','D:\\foreign'],['sourceVersion','2.0.0'],['targetVersion','3.0.0'],['artifactId','1'],['installerSha256','0'.repeat(64)],['runAttempt','2']])assert.throws(()=>qa.validatePlan({...p,[key]:value},c));
  assert.throws(()=>qa.validatePlan({...p,extra:true},c));
});
test('a guest selects exactly one explicit scenario and reports only that lifecycle case',()=>{
  assert.equal(typeof qa.validateScenario,'function');
  for(const scenario of ['success','health-failure'])assert.equal(qa.validateScenario(scenario),scenario);
  for(const scenario of [undefined,null,'','both','success,health-failure','SUCCESS','success\n',['success']])assert.throws(()=>qa.validateScenario(scenario));
  assert.match(qa.formatSummary('success'),/native update\/restart passed/);
  assert.doesNotMatch(qa.formatSummary('success'),/rollback passed/);
  assert.match(qa.formatSummary('health-failure'),/deliberate failed-health rollback passed/);
  assert.doesNotMatch(qa.formatSummary('health-failure'),/update\/restart passed/);
  assert.throws(()=>qa.formatSummary('both'));
});
test('sequential fixture builds reuse dependencies and retain distinct setup snapshots',()=>{
  assert.equal(typeof qa.fixtureBuildPaths,'function');
  const p=qa.createPlan(qa.validateContext(env(),'win32'));
  const source=qa.fixtureBuildPaths(p,'1.9.0'),target=qa.fixtureBuildPaths(p,'2.0.0');
  assert.equal(source.targetDir,target.targetDir);
  assert.notEqual(source.sourceDir,target.sourceDir);assert.notEqual(source.setupPath,target.setupPath);
  assert.match(source.setupPath,/Nearly_1\.9\.0_x64-setup\.exe$/);
  assert.match(target.setupPath,/Nearly_2\.0\.0_x64-setup\.exe$/);
  assert.throws(()=>qa.fixtureBuildPaths(p,'3.0.0'));
});
test('historical artifact checks reject expiration and mismatched run/digest without network',()=>{
  assert.equal(typeof qa.validatePinnedArtifact,'function');
  const artifact={id:12158897824,name:'nearly-signed-39185149137-1',expired:false,size_in_bytes:100,digest:'sha256:e8baf6d70cdfe9278e8ad162d75c989a434226cec9da04b62b9a691895ec9526',workflow_run:{id:39185149137,repository_id:123,head_repository_id:123,head_branch:'main',head_sha:'b56f01ddff9698ef316dfa775c1e8a441965674f'}};
  assert.equal(qa.validatePinnedArtifact(artifact,123),true);
  for(const change of [{expired:true},{digest:'sha256:'+'0'.repeat(64)},{id:12158897825},{workflow_run:{...artifact.workflow_run,head_sha:'0'.repeat(40)}}])assert.throws(()=>qa.validatePinnedArtifact({...artifact,...change},123));
});
test('fixture key stays in memory and generated minisign proof verifies exact bytes',()=>{
  assert.equal(typeof qa.createFixtureSigner,'function');
  const signer=qa.createFixtureSigner(),bytes=Buffer.alloc(128);bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.writeUInt32LE(0x4550,64);bytes.writeUInt16LE(0x14c,68);
  assert.equal(signer.publicRaw.subarray(0,10).toString(),'Edqa-only!');
  assert.deepEqual(Object.keys(signer).sort(),['publicRaw','sign']);
  const proof=signer.sign(bytes,'f'.repeat(64));
  assert.equal(qa.verifyFixture(bytes,proof,signer.publicRaw,'f'.repeat(64)),true);
  const changed=Buffer.from(bytes);changed[100]=1;
  assert.throws(()=>qa.verifyFixture(changed,proof,signer.publicRaw,'f'.repeat(64)));
  assert.throws(()=>qa.verifyFixture(bytes,proof,signer.publicRaw,'e'.repeat(64)));
});
test('five settings fixtures carry complete manifests and generated offline data only',()=>{
  assert.equal(typeof qa.settingsFixture,'function');
  const files=qa.settingsFixture(),aggregate=unpackSettings(files);
  assert.deepEqual(aggregate.connections.profiles,[]);assert.deepEqual(aggregate.trust.pins,{});
  assert.equal(aggregate.appearance.theme,'dark');assert.equal(aggregate.appearance.language,'en');
  assert.equal(Object.keys(files).length,5);
  for(const bytes of Object.values(files))assert.equal(JSON.parse(bytes).metadata.installerQa,'generated-offline-fixture');
  assert.throws(()=>unpackSettings({...files,'history.json':files['history.json']+' '}),/manifest/);
});
test('bounded outcome validation rejects timeouts, wrong version and failed recovery',()=>{
  assert.equal(typeof qa.validateOutcome,'function');
  assert.equal(qa.validateOutcome({schemaVersion:1,scenario:'success',phase:'succeeded',version:'2.0.0'},'success'),true);
  assert.equal(qa.validateOutcome({schemaVersion:1,scenario:'health-failure',phase:'rolledBack',version:'1.9.0'},'health-failure'),true);
  for(const o of [null,{}, {schemaVersion:1,scenario:'success',phase:'failed',version:'2.0.0'}, {schemaVersion:1,scenario:'health-failure',phase:'succeeded',version:'2.0.0'}])assert.throws(()=>qa.validateOutcome(o,'success'));
});
test('wait deadline fails closed with inert injected clock and no setup execution',async()=>{
  assert.equal(typeof qa.waitForOutcome,'function');let now=0;
  await assert.rejects(qa.waitForOutcome('unused','success',{timeoutMs:30,now:()=>now,sleep:async()=>{now+=10;},read:async()=>{throw Object.assign(Error(),{code:'ENOENT'});}}),/timed out/);
  await assert.rejects(qa.waitForOutcome('unused','success',{timeoutMs:30,read:async()=>Buffer.alloc(9000)}),/bounded/);
});
test('QA trace decoding accepts fixed fields and never returns credential or unknown values',()=>{
  assert.equal(typeof qa.decodeQaTrace,'function');
  const row={event:'startup',code:'source',version:'1.9.0',pid:42};
  const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
  assert.deepEqual(qa.decodeQaTrace(encode(row),42),[row]);
  for(const change of [{event:'ghp_exampleCredential'},{code:'a'.repeat(64)},{token:'secret'},{path:'C:\\secret'},{version:'3.0.0'},{pid:0},{pid:4294967296},{pid:43},{event:'unknownEvent'},{code:'unknownCode'}])assert.throws(()=>qa.decodeQaTrace(encode({...row,...change}),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from('{"event":"startup","event":"frontendReady","version":"1.9.0","pid":42}\n'),42));
});
test('QA trace bounds and incomplete final-line handling fail closed',()=>{
  const row=JSON.stringify({event:'startup',version:'2.0.0',pid:42});
  assert.deepEqual(qa.decodeQaTrace(Buffer.from(row+'\n{"event":"start'),42),[JSON.parse(row)]);
  assert.deepEqual(qa.decodeQaTrace(Buffer.from(row),42),[JSON.parse(row)]);
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{"event":"start\n'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\nnotJson'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{"event" false'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{"token":"secret'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.alloc(16385),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from((row+'\n').repeat(65)),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{}\n'),42));
});
test('QA file-user hints accept four fixed codes and reject raw process, service and path names',()=>{
  for(const code of ['scannerHint','webviewHint','childIdentityMismatch','unknown']){
    const row={event:'fileUserHint',code,version:'2.0.0',pid:42};
    assert.deepEqual(qa.decodeQaTrace(Buffer.from(JSON.stringify(row)+'\n'),42),[row]);
  }
  for(const code of ['MsMpEng','WinDefend','msedgewebview2','C:\\Windows\\System32\\scanner.exe','scanner.exe','scannerHint\n','a'.repeat(65)]){
    assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event:'fileUserHint',code,version:'2.0.0',pid:42})+'\n'),42));
  }
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event:'fileUserHint',code:'scannerHint',version:'2.0.0',pid:42,process:'scanner.exe'})+'\n'),42));
});
test('QA peer and supervisor diagnostics accept only their fixed event-specific codes',()=>{
  const mapping={peerObservation:['pathQueryFailed','exitAfterPathFailure'],supervisorError:['parent','commit','child','worker','fileUsers','idle','tuple','exitRequest']};
  for(const [event,codes]of Object.entries(mapping))for(const code of codes){
    const row={event,code,version:'2.0.0',pid:42};
    assert.deepEqual(qa.decodeQaTrace(Buffer.from(JSON.stringify(row)+'\n'),42),[row]);
  }
  for(const [event,code]of [['peerObservation','parent'],['supervisorError','pathQueryFailed'],['peerObservation','unknown'],['supervisorError','ERROR_ACCESS_DENIED'],['supervisorError','C:\\private\\Nearly.exe'],['peerObservation','app.exe'],['supervisorError','a'.repeat(65)]]){
    assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event,code,version:'2.0.0',pid:42})+'\n'),42));
  }
});
test('QA trace collection reads at most eight exact PID files with a fixed size limit',async()=>{
  assert.equal(typeof qa.collectQaTraces,'function');
  const files=['authorization.json','qa-trace-0.jsonl','qa-trace-01.jsonl','qa-trace-4294967296.jsonl','qa-trace-42.jsonl\n','../qa-trace-42.jsonl',...Array.from({length:10},(_,i)=>`qa-trace-${i+1}.jsonl`)];
  const read=[];
  const records=await qa.collectQaTraces('owned-root',{list:async()=>files,read:async(file,limit)=>{read.push({file,limit});const pid=Number(/qa-trace-([0-9]+)\.jsonl$/.exec(file)[1]);return Buffer.from(JSON.stringify({event:'startup',version:'1.9.0',pid})+'\n');}});
  assert.equal(records.length,8);assert.equal(read.length,8);assert.ok(read.every(r=>r.limit===16384));
  const rejected=await qa.collectQaTraces('owned-root',{list:async()=>['qa-trace-42.jsonl'],read:async()=>Buffer.from('{"token":"neverLogThis"}\n')});
  assert.deepEqual(rejected,[]);
  let unexpectedReads=0;
  assert.deepEqual(await qa.collectQaTraces('owned-root',{list:async()=>['qa-trace-42.jsonl\n','authorization.json','../qa-trace-42.jsonl','qa-trace-042.jsonl'],read:async()=>{unexpectedReads++;throw Error('must not read');}}),[]);
  assert.equal(unexpectedReads,0);
});
test('workflow remains manual, read-only, pinned and publishes no QA artifact',async()=>{
  const text=await fs.readFile(new URL('../.github/workflows/installer-qa-windows.yml',import.meta.url),'utf8');
  assert.match(text,/workflow_dispatch:/);assert.match(text,/controller_sha:/);assert.match(text,/confirmation:/);
  assert.doesNotMatch(text,/secrets\.|contents: write|actions: write|upload-artifact|pull_request:|push:/);
  assert.match(text,/github\.workflow_sha/);assert.match(text,/installer-qa\.mjs run/);
  assert.match(text,/fail-fast: false/);assert.match(text,/scenario: \[success, health-failure\]/);
  assert.match(text,/QA_SCENARIO: \$\{\{ matrix\.scenario \}\}/);
});
