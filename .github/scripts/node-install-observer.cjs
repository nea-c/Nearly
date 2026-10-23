'use strict';
// Diagnostic preload only. Never records command arguments or inherited environment.
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const dir=process.env.NEARLY_INSTALL_TRACE;
if(dir){
  let serial=0;
  const file=path.join(dir,`${process.pid}.jsonl`);
  const addon=/[\\/]cpu-features(?:[\\/]|$)/.test(process.cwd())?'cpu-features':/[\\/]ssh2(?:[\\/]|$)/.test(process.cwd())?'ssh2':'other';
  const emit=row=>fs.appendFileSync(file,JSON.stringify({at:Date.now(),pid:process.pid,ppid:process.ppid,addon,...row})+'\n');
  const classify=exe=>{
    const name=path.win32.basename(String(exe)).toLowerCase();
    return /^(?:powershell|pwsh)(?:\.exe)?$/.test(name)?'powershell':/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(name)?'python':/^msbuild(?:\.exe)?$/.test(name)?'msbuild':/^(?:cl|clang|gcc|cc|g\+\+)(?:\.exe)?$/.test(name)?'compiler':/^cmake(?:\.exe)?$/.test(name)?'cmake':/^node(?:\.exe)?$/.test(name)?'node':/^cmd(?:\.exe)?$/.test(name)?'cmd':'other';
  };
  let gypVersion;
  if(/[\\/]node-gyp[\\/]bin[\\/]node-gyp\.js$/.test(process.argv[1]??'')){
    gypVersion=JSON.parse(fs.readFileSync(path.resolve(path.dirname(process.argv[1]),'..','package.json'),'utf8')).version;
  }
  emit({kind:'process-start',gypVersion});
  process.once('exit',code=>emit({kind:'process-end',code}));
  for(const method of ['spawn','execFile','spawnSync','execFileSync','execSync']){
    const original=cp[method];
    const wrapped=function(...args){
      const id=++serial,start=Date.now(),tool=classify(args[0]);
      emit({kind:'tool-start',id,tool,method});
      let result;
      try{result=Reflect.apply(original,this,args);}
      catch(error){emit({kind:'tool-end',id,tool,method,ms:Date.now()-start,error:true});throw error;}
      if(method.endsWith('Sync'))emit({kind:'tool-end',id,tool,method,ms:Date.now()-start,code:result?.status??0,error:!!result?.error});
      else result.once('close',(code,signal)=>emit({kind:'tool-end',id,tool,method,ms:Date.now()-start,code,signal}));
      return result;
    };
    // Preserve execFile's promisify behavior and other API descriptors.
    Object.defineProperties(wrapped,Object.getOwnPropertyDescriptors(original));
    cp[method]=wrapped;
  }
  const write=process.stderr.write;
  process.stderr.write=function(chunk,...args){
    const text=String(chunk).replace(/\x1b\[[0-9;]*m/g,'');
    let phase;
    if(/http.*\bGET\b/.test(text))phase='download-start';
    else if(/http.*\b200\b/.test(text))phase='download-response';
    else if(/find VS.*using VS/.test(text))phase='visual-studio-selected';
    else if(/find Python.*using Python/.test(text))phase='python-selected';
    else if(/gyp info ok/.test(text))phase='gyp-success';
    else if(/gyp ERR!/.test(text))phase='gyp-error';
    if(phase)emit({kind:'phase',phase});
    return Reflect.apply(write,this,[chunk,...args]);
  };
}
