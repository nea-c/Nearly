import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

// Every child belongs to this invocation. Never enumerate or terminate by image name.
export class Processes {
  children = new Set();
  cancelled = false;
  stopping;
  stop() {
    this.cancelled = true;
    return this.stopping??=Promise.all([...this.children].map(async entry => {
      const {child, done} = entry;
      if (child.connected) child.send({type:'native-test-cancel'},()=>{});
      else await terminate(child);
      let timer;
      await Promise.race([done.catch(()=>{}), new Promise(resolve => {timer=setTimeout(resolve,5000);})]);
      clearTimeout(timer);
      if (this.children.has(entry)) await terminate(child);
      await done.catch(()=>{});
    })).then(()=>{});
  }
  run(command,args,{cwd,env=process.env,log,capture=false,ipc=false}={}) {
    if(this.cancelled) return Promise.reject(Error('Native tests cancelled'));
    const child=spawn(command,args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe',...(ipc?['ipc']:[])]});
    let output='';
    const stream=log?fs.createWriteStream(log):null;
    for(const source of [child.stdout,child.stderr])source.on('data',data=>{
      if(capture && source===child.stdout)output+=data;
      if(capture!==true || source===child.stderr)(source===child.stderr?process.stderr:process.stdout).write(data);
      stream?.write(data);
    });
    const entry={child};this.children.add(entry);
    entry.done=new Promise((resolve,reject)=>{
      let error;child.on('error',value=>{error=value;});
      child.on('close',async(code,signal)=>{
        this.children.delete(entry);
        if(stream)await new Promise(r=>stream.end(r));
        if(error)reject(error);else if(code!==0){const failure=Error(`${command} exited ${code ?? signal}`);failure.exitCode=code;reject(failure);}else resolve(output);
      });
    });
    return entry.done;
  }
}
async function terminate(child) {
  if(!child.pid || child.exitCode!==null || child.signalCode!==null)return;
  if(process.platform==='win32') {
    await new Promise((resolve,reject)=>{
      let output='';
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      for(const stream of [killer.stdout,killer.stderr])stream.on('data',data=>{output+=data;});
      killer.on('error',reject);killer.on('close',code=>{
        if(code!==0 && child.exitCode===null && child.signalCode===null)reject(Error(`Cannot terminate owned PID ${child.pid}: ${output}`));else resolve();
      });
    });
  }else {try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
}

export function assertHarnessResult(output) {
  const summaries=[...output.matchAll(/test result: ok\. (\d+) passed; (\d+) failed;/g)];
  if(!summaries.some(match=>Number(match[1])>0 && Number(match[2])===0))throw Error('Native harness did not report any passing tests');
}

export function cancellation(processes) {
  const stop=()=>{process.exitCode=1;void processes.stop().catch(error=>console.error(error));};
  const message=value=>{if(value?.type==='native-test-cancel')stop();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('message',message);
  // An abruptly lost owning runner must not leave its fixture child running.
  if(process.connected)process.on('disconnect',stop);
  return ()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);process.off('message',message);process.off('disconnect',stop);};
}

export function fixtureDirectory(prefix) {
  const parent=path.resolve('test-results');fs.mkdirSync(parent,{recursive:true});
  return fs.mkdtempSync(path.join(parent,prefix+'-'));
}

export async function runFixtureTest(filter,extraEnv,output) {
  const processes=new Processes();const dispose=cancellation(processes);
  try {
    const filename=process.env.NEARLY_NATIVE_TEST_MANIFEST;
    if(process.env.NEARLY_NATIVE_PARALLEL==='1' && !filename)throw Error('Parallel native test manifest required');
    if(filename) {
      const context=JSON.parse(fs.readFileSync(filename,'utf8'));
      const executable=context.mainExecutable;
      if(!path.isAbsolute(executable) || !context.executables.includes(executable) || !fs.statSync(executable).isFile() || !path.isAbsolute(context.cwd))throw Error('Invalid native test executable manifest');
      const result=await processes.run(executable,[filter,'--ignored','--nocapture','--test-threads=1'],{cwd:context.cwd,env:{...process.env,...context.env,...extraEnv},log:path.join(output,'native.log'),capture:'tee'});
      assertHarnessResult(result);
    }else {
      await processes.run('cargo',['test','--offline','--locked','--manifest-path','src-tauri/Cargo.toml',filter,'--','--ignored','--nocapture','--test-threads=1'],{env:{...process.env,...extraEnv},log:path.join(output,'native.log')});
    }
    if(processes.cancelled)throw Error('Native fixture cancelled');
    return 0;
  }catch(error){if(Number.isInteger(error.exitCode)&&error.exitCode!==0)return error.exitCode;throw error;
  }finally{await processes.stop();dispose();}
}
