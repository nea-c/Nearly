import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {runStage} from './stage-interpreter.mjs';
const template=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const nonce='a'.repeat(32);
const command=(pid='123',created='134000000000000001',n=nonce)=>`/NEARLYSTAGE /NEARLYPROTOCOL=3 /NEARLYHELPER=${pid} /NEARLYCREATED=${created} /NEARLYNONCE=${n}`;

test('actual stage function and section write exactly two candidate files and return before live effects',()=>{
  const r=runStage(template,command());assert.equal(r.aborted,false);assert.equal(r.errorLevel,0);assert.equal(r.writes.length,2);
  for(const write of r.writes)assert.match(write.path,/\\\.Nearly-update-state\\[a-f0-9]{32}\\candidate\\(?:Nearly|uninstall)\.exe$/);
});
test('actual stage parser rejects decimal aliases and overflow before opening helper',()=>{
  for(const pid of ['0','0123','+123','00000000123','4294967296','999999999999999999999999999999','1e2']){
    const r=runStage(template,command(pid),{pid});assert.equal(r.aborted,true,pid);assert.equal(r.writes.length,0);
    assert.equal(r.effects.some(e=>e.call?.includes('::OpenProcess(')),false,'numeric validation precedes native PID parsing');
  }
  for(const created of ['0','0134000000000000001','+134000000000000001','18446744073709551616','9'.repeat(40)]){
    const r=runStage(template,command('123',created),{created});assert.equal(r.aborted,true,created);assert.equal(r.writes.length,0);
  }
});
test('actual stage parser rejects nonce aliases, duplicate or mixed modes and extra arguments',()=>{
  for(const n of ['a'.repeat(31),'a'.repeat(33),'A'.repeat(32),'../'+'a'.repeat(29)]){
    const r=runStage(template,command('123','134000000000000001',n),{nonce:n});assert.equal(r.aborted,true,n);assert.equal(r.writes.length,0);
  }
  for(const input of [command()+' /D=C:\\other',command()+' /NEARLYPROTOCOL=3',command().replace('PROTOCOL=3','PROTOCOL=2'),command()+' /NEARLYUPDATE',command().replace('/NEARLYCREATED=134000000000000001 ','')]){
    const r=runStage(template,input);assert.equal(r.aborted,true,input);assert.equal(r.writes.length,0);
  }
});
test('actual stage authentication refuses wrong or dead helper, stale events, redirected worker and reparse candidates',()=>{
  for(const facts of [{pid:'124'},{created:'134000000000000009'},{helperPath:'C:\\Foreign\\previous-image.exe'},{helperLive:false},{authorize:false},{readyFresh:false},{eventWorkerPid:'999'},{eventWorkerCreated:'134000000000000009'},{candidateAttributes:0x410},{candidateAttributes:0xffffffff},{setReadyFails:true}]){
    const r=runStage(template,command(),facts);assert.equal(r.aborted,true,JSON.stringify(facts));assert.equal(r.writes.length,0);
  }
});
test('actual extraction failures retain candidate output without entering normal setup',()=>{
  for(const facts of [{payloadFailure:true},{uninstallerFailure:true}]){
    const r=runStage(template,command(),facts);assert.equal(r.aborted,true);assert.equal(r.errorLevel,6);
    assert.equal(r.writes.length,facts.payloadFailure?1:2);assert.ok(r.writes.every(w=>w.path.includes('\\candidate\\')));
  }
});
test('actual stage waits boundedly for its exact worker authorization and refuses dead helper',()=>{
  for(const facts of [{eventMissingAttempts:3},{authorizeDelayWaits:3}]){
    const r=runStage(template,command(),facts);assert.equal(r.aborted,false);assert.equal(r.writes.length,2);
    assert.equal(r.effects.filter(e=>e.op==='Sleep').length,3);
  }
  for(const facts of [{eventMissingAttempts:100},{authorizeDelayWaits:100},{eventMissingAttempts:5,helperExitAfterWaits:3}]){
    const r=runStage(template,command(),facts);assert.equal(r.aborted,true);assert.equal(r.writes.length,0);
    assert.ok(r.effects.filter(e=>e.op==='Sleep').length<=99,'strictly bounded 5-second discovery');
  }
});
test('actual extraction rejects output-directory failure before either file write',()=>{
  const r=runStage(template,command(),{setOutPathFailure:true});
  assert.equal(r.aborted,true);assert.equal(r.errorLevel,6);assert.equal(r.writes.length,0);
});
test('interpreter derives actual File destination from current OUTDIR and oname operands',()=>{
  const moved=template.replace('SetOutPath "$NearlyStageDirectory"','SetOutPath "$INSTDIR"');
  const wrongDirectory=runStage(moved,command());assert.ok(wrongDirectory.writes[0].path.endsWith('\\Nearly\\Nearly.exe'));
  assert.ok(!wrongDirectory.writes[0].path.includes('\\candidate\\'));
  const renamed=template.replace('File "/oname=${MAINBINARYNAME}.exe"','File "/oname=Wrong.exe"');
  assert.ok(runStage(renamed,command()).writes[0].path.endsWith('\\Wrong.exe'));
});
test('actual stage rejects generated process-query/wait failures and missing Ready without writes',()=>{
  for(const facts of [{helperTimesFailure:true},{workerTimesFailure:true},{queryImageFailure:true},{helperWaitFailure:true},{authorizeWaitFailure:true},{missingReady:true},{helperExitAfterWaits:2}]){
    const r=runStage(template,command(),facts);assert.equal(r.aborted,true,JSON.stringify(facts));assert.equal(r.writes.length,0);
  }
});
