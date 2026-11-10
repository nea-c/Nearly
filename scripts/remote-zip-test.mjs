// Generated loopback SSH protocol tests. The fake executor NEVER executes shell/Python.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
const modes=['exec-denied','windows','missing-python','pre-cancel','unknown','disconnect','mismatch','success','cancel-dispatched','decreasing-result','missing-safe-publish','cancel-namespace'];
const results=[];
for(const mode of modes){
  const out=fixtureDirectory('remote-zip-'+mode);
  // Private generated copy: preserve the shared fixture and its existing callers.
  let source=fs.readFileSync(new URL('./sftp-fixture.mjs',import.meta.url),'utf8');
  const option='firstHandle = 1,';const insertion='const session = accept();';
  assert.equal(source.split(option).length,2);assert.equal(source.split(insertion).length,2);
  source=source.replace(option,'onExec, firstHandle = 1,').replace(insertion,insertion+'\n        session.on("exec", (accept, reject, info) => onExec ? onExec({accept,reject,info,client,remote,session}) : reject());');
  const copy=path.join(out,'generated-sftp-fixture.mjs');fs.writeFileSync(copy,source);
  const {createFixture}=await import(pathToFileURL(copy).href);
  const commands=[];const answers=[];let scripts=0;let failure;
  const frame=(stream,value)=>stream.write('NEARLY_ZIP '+JSON.stringify(value)+'\n');
  const finish=(stream,status=0)=>{stream.exit(status);stream.end();};
  const f=await createFixture(out,{async beforeStat(_operation,p){
    if(mode==='cancel-namespace'&&p.endsWith('/namespace')){
      fs.writeFileSync(path.join(out,'dispatched'),'generated');const start=Date.now();
      while(!fs.existsSync(path.join(out,'cancelled'))){assert.ok(Date.now()-start<20000,'native cancellation checkpoint');await new Promise(r=>setTimeout(r,5));}
    }
  },onExec({accept,reject,info,client,remote,session}){
    try{
      commands.push(info.command);
      if(mode==='exec-denied'){reject();return;}
      const stream=accept();stream.on('error',()=>{});
      if(info.command==='uname -s'){stream.write(mode==='windows'?'':'Linux\n');finish(stream,mode==='windows'?1:0);return;}
      if(info.command==='cmd.exe /d /c ver'){assert.equal(mode,'windows');stream.write('Microsoft Windows [Version 10.0.26100]\r\n');finish(stream);return;}
      if(info.command.startsWith("python3 -c '")){stream.write(mode==='missing-python'?'':mode==='missing-safe-publish'?'NEARLY_ZIP_NO_SAFE_PUBLISH\n':'NEARLY_ZIP_PYTHON3\n');finish(stream,mode==='missing-python'?127:0);return;}
      const match=info.command.match(/^python3 -u -c 'import sys;exec\(compile\(sys\.stdin\.buffer\.read\((\d+)\),"nearly-remote-zip","exec"\)\)'$/);
      assert.ok(match,'only fixed bootstrap may execute');const length=Number(match[1]);assert.ok(length>100&&length<1024*1024);
      scripts++;let buffer=Buffer.alloc(0);let received=false;let ended=false;
      const endError=code=>{if(ended)return;ended=true;frame(stream,{type:'error',code,committed:false});finish(stream,1);};
      session.on('signal',(acceptSignal,_reject,signal)=>{if(acceptSignal)acceptSignal();if(mode==='cancel-dispatched'){assert.equal(signal.name,'TERM');endError('cancelled');}});
      stream.on('data',chunk=>{
        try{
          buffer=Buffer.concat([buffer,chunk]);
          if(!received&&buffer.length>=length){
            const script=buffer.subarray(0,length).toString('utf8');buffer=buffer.subarray(length);received=true;
            const payload=script.match(/^NEARLY_REQUEST = '([A-Za-z0-9+/=]+)'\n/);assert.ok(payload);
            const request=JSON.parse(Buffer.from(payload[1],'base64').toString('utf8'));
            assert.deepEqual(request.sources,["/bench/odd '$(x)&.txt"]);assert.equal(request.action,'compress');
            assert.ok(!info.command.includes('odd'));assert.ok(script.includes('import '));
            if(mode==='unknown'){frame(stream,{type:'invented'});finish(stream,1);return;}
            if(mode==='disconnect'){client.end();return;}
            if(mode==='cancel-dispatched'){fs.writeFileSync(path.join(out,'dispatched'),'generated');return;}
            const stage='/bench/.nearly-zip-'+String(scripts).padStart(32,'0');const token='b'.repeat(64);
            fs.mkdirSync(path.join(remote,stage.slice(1)),{recursive:true});fs.writeFileSync(path.join(remote,stage.slice(1),'namespace'),mode==='mismatch'?'c'.repeat(64):token);
            frame(stream,{type:'namespace',stagePath:stage,path:stage+'/namespace',token});
          }
          if(received&&buffer.includes(10)){
            const answer=buffer.toString('utf8');buffer=Buffer.alloc(0);answers.push(answer);
            assert.equal(answer,['mismatch','cancel-namespace'].includes(mode)?'NEARLY_REJECT\n':'NEARLY_CONFIRM\n');
            if(mode==='mismatch'){endError('remote_path_mismatch');return;}if(mode==='cancel-namespace'){endError('cancelled');return;}
            frame(stream,{type:'progress',entries:1,bytes:mode==='decreasing-result'?8:7});frame(stream,{type:'result',entries:1,bytes:7});finish(stream);
          }
        }catch(error){failure=error;stream.destroy();}
      });
    }catch(error){failure=error;client.end();}
  }});
  fs.mkdirSync(path.join(f.remote,'bench'),{recursive:true});fs.writeFileSync(path.join(f.remote,"bench/odd '$(x)&.txt"),'fixture');
  const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,mode:mode==='decreasing-result'?'unknown':mode,remote:f.remote,port:f.port,key:f.ppk3,passphrase:f.passphrase,fingerprint:f.fingerprint}));
  try{
    assert.equal(await runFixtureTest('remote_zip_tests::remote_zip_transport_fixture',{NEARLY_REMOTE_ZIP_FIXTURE:manifest},out),0,mode);
    if(failure)throw failure;
    assert.equal(f.totalConnections,mode==='pre-cancel'?1:2,'one browse plus one operation connection; never reconnect/replay');
    assert.equal(commands.filter(c=>c==='uname -s').length,mode==='pre-cancel'?0:1);
    if(mode==='windows')assert.deepEqual(commands,['uname -s','cmd.exe /d /c ver']);
    assert.equal(scripts,['exec-denied','windows','missing-python','missing-safe-publish','pre-cancel'].includes(mode)?0:mode==='success'?2:1);
    assert.equal(answers.length,mode==='success'?2:['mismatch','decreasing-result','cancel-namespace'].includes(mode)?1:0);
    const result={mode,commands,scripts,answers,connections:f.totalConnections,coverage:'mocked SSH transport; no archive execution'};results.push(result);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  }finally{await f.close();}
}
fs.writeFileSync('test-results/remote-zip-transport-results.json',JSON.stringify(results,null,2));console.log('REMOTE_ZIP_TRANSPORT_OK',results.length);
