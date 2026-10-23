import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {order,sourceSHA,npmTimers,verifySummary,runPair} from './native-pair-diagnostic.mjs';
const summary=(n,ignored=0,filtered=0)=>`test result: ok. ${n} passed; 0 failed; ${ignored} ignored; 0 measured; ${filtered} filtered out;`;
test('fixed source and ABBA keep both orders without weakening exact group counts',()=>{
 assert.equal(sourceSHA,'cc0a659d56a998ca69976955d986539b87f2da9a');assert.deepEqual(order,['serial','parallel','parallel','serial']);
 verifySummary(summary(588,53,2),588,53,2);
 for(const text of [summary(0),summary(587,53,2),summary(588,52,2),summary(588,53,1),'test result: FAILED. 588 passed; 1 failed;'])assert.throws(()=>verifySummary(text,588,53,2));
});
test('npm evidence contains numeric timers only, never metadata credentials URLs or environment',()=>{
 const input={metadata:{secret:'DO-NOT-COPY'},timers:{'command:ci':52,'reify:unpack':21,'https://host/token':1,'authToken':1,'env\nsecret':2,'not-number':'secret'}};
 assert.deepEqual(npmTimers([input]),[{timers:{'command:ci':52,'reify:unpack':21}}]);
});
test('same manifest and complete group arguments run serially or overlap with isolated output',async()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nearly-pair-unit-'));
 // Only files created in this unique synthetic fixture are removed.
 try{for(const mode of ['serial','parallel']){
  const output=path.join(parent,mode),calls=[];let active=0,max=0;
  const context={mainExecutable:'main.exe',executables:['main.exe','resource.exe'],cwd:parent,env:{PATH:'runtime',CARGO_PKG_VERSION:'3.6.0',TOKEN:'DO-NOT-SERIALIZE'}};
  const args=['--skip','a','--skip','b','--test-threads=1'];
  const processes={async run(command,argv,options){calls.push({command,argv,options});max=Math.max(max,++active);await new Promise(r=>setTimeout(r,5));active--;if(command==='main.exe')return summary(588,53,2);if(command==='resource.exe')return summary(3);return summary([6,8,9,9][Number(argv[1])]);},async stop(){throw Error('No failure expected');}};
  const result=await runPair({context,root:parent,output,processes,mode,standardArgs:args,fixtureCommands:[['fixture','0'],['fixture','1'],['fixture','2'],['fixture','3']]});
  const isHarness=c=>['main.exe','resource.exe'].includes(c.command);
  assert.equal(result.success,true);assert.equal(calls.length,6);assert.deepEqual(calls.filter(isHarness).map(c=>c.argv),[args,args]);
  assert.equal(max,mode==='serial'?1:2);
  const fixture=calls.filter(c=>!isHarness(c));assert.deepEqual(fixture.map(c=>c.argv[1]),['0','1','2','3']);
  for(const c of fixture){assert.equal(c.options.env.NEARLY_NATIVE_PARALLEL,'1');assert.equal(c.options.ipc,true);}
  assert.ok(!fs.readFileSync(path.join(output,'test-executables.json'),'utf8').includes('DO-NOT-SERIALIZE'));
 }}finally{fs.rmSync(parent,{recursive:true,force:true});}
});
test('failed comparison stops owned work and cannot return a successful pass',async()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nearly-pair-fail-'));let stopped=0;
 try{await assert.rejects(runPair({context:{executables:['main'],mainExecutable:'main',cwd:parent,env:{}},root:parent,output:parent,mode:'parallel',standardArgs:[],fixtureCommands:[['fixture']],processes:{async run(){throw Error('failure');},async stop(){stopped++;}}}));assert.ok(stopped);assert.equal(JSON.parse(fs.readFileSync(path.join(parent,'events.json'),'utf8')).success,false);}finally{fs.rmSync(parent,{recursive:true,force:true});}
});
test('one-shot branch workflow restores only and cannot sign publish merge or change the release workflow',()=>{
 const text=fs.readFileSync(new URL('../workflows/native-pair-diagnostic.yml',import.meta.url),'utf8');
 assert.match(text,/branches: \[codex\/native-pair-diagnostic\]/);assert.match(text,/github\.event\.created == true/);
 assert.doesNotMatch(text,/workflow_dispatch|actions\/cache@(?!restore)|actions\/cache\/save|dependency-cache\.mjs save|secrets\.|contents: write|actions: write|environment:/);
 assert.equal((text.match(/runs-on:/g)||[]).length,1);assert.match(text,/contents: read/);
 assert.match(text,/node source\/\.github\/scripts\/dependency-cache\.mjs prepare native-debug/);
 assert.match(text,/ref: cc0a659d56a998ca69976955d986539b87f2da9a/);
 assert.match(text,/npm ci --timing/);assert.match(text,/npm test/);assert.match(text,/node scripts\/ppk-fixtures.mjs/);
 assert.match(text,/source-commit|native-pair-diagnostic\.mjs source/);
 assert.doesNotMatch(text,/release-signed-windows\.yml.*(?:>|Set-Content)|git push|\/dispatches|releases\/|tags\//);
 for(const ref of text.matchAll(/uses: ([^\s]+)@([^\s]+)/g))assert.match(ref[2],/^[a-f0-9]{40}$/);
});
