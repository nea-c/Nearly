import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {Processes,cancellation} from '../../scripts/native-test-process.mjs';

export const order=['baseline','candidate','candidate','baseline'];
const allowed=new Set(['npm','command:ci','reify','reify:unpack','reify:audit','reify:build','build','build:deps','build:run:install','build:run:postinstall','build:run:install:node_modules/ssh2','build:run:install:node_modules/cpu-features','build:run:postinstall:node_modules/esbuild']);
export function npmTimers(text){return Object.fromEntries([...text.matchAll(/npm timing (\S+) Completed in (\d+)ms/g)].filter(m=>allowed.has(m[1])).map(m=>[m[1],Number(m[2])]));}
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export async function main(baseline,candidate,output){
  if(process.platform!=='win32'||process.version!=='v22.23.4')throw Error('Pinned Windows Node22.23.4 required');
  if(process.env.NODE_OPTIONS)throw Error('Unexpected inherited NODE_OPTIONS');
  baseline=path.resolve(baseline);candidate=path.resolve(candidate);output=path.resolve(output);
  fs.mkdirSync(output,{recursive:false});
  const npmRoot=path.join(path.dirname(process.execPath),'node_modules','npm');
  const npm=path.join(npmRoot,'bin','npm-cli.js');
  const version=JSON.parse(fs.readFileSync(path.join(npmRoot,'package.json'),'utf8')).version;
  const bundled=JSON.parse(fs.readFileSync(path.join(npmRoot,'node_modules','node-gyp','package.json'),'utf8')).version;
  if(version!=='10.9.9'||bundled!=='11.5.0')throw Error('Baseline npm/node-gyp version mismatch');
  const preload=fileURLToPath(new URL('./node-install-observer.cjs',import.meta.url));
  const cache=path.join(output,'npm-cache'),headers=path.join(output,'node-headers');
  const result={source:'cc0a659d56a998ca69976955d986539b87f2da9a',controller:process.env.GITHUB_SHA??null,node:process.version,npm:version,bundledGyp:bundled,cores:os.availableParallelism(),image:process.env.ImageVersion??null,order,passes:[],allPassed:false};
  const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  save();
  const processes=new Processes(),dispose=cancellation(processes);
  try{
    for(const [index,variant] of order.entries()){
      if(processes.cancelled)throw Error('Diagnostic cancelled');
      const source=variant==='baseline'?baseline:candidate;
      const cwd=path.join(output,`pass-${index+1}`),trace=path.join(cwd,'trace');
      fs.mkdirSync(cwd);fs.mkdirSync(trace);
      for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(cwd,file));
      const pkg=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8'));
      if(pkg.devDependencies['node-gyp']!==(variant==='candidate'?'13.1.0':undefined))throw Error('Unexpected candidate tool pin');
      const row={pass:index+1,variant,packageHash:hash(path.join(cwd,'package.json')),lockHash:hash(path.join(cwd,'package-lock.json')),cacheExisted:fs.existsSync(cache),headersExisted:fs.existsSync(path.join(headers,'22.23.4','installVersion')),exit:0,qualification:false};
      result.passes.push(row);save();
      const log=path.join(cwd,'npm-ci.log'),start=Date.now();
      try{
        await processes.run(process.execPath,[npm,'ci','--timing','--cache',cache,'--logs-dir',path.join(cwd,'npm-logs')],{cwd,log,capture:true,env:{...process.env,NODE_OPTIONS:`--require="${preload.replaceAll('\\','/')}"`,NEARLY_INSTALL_TRACE:trace,npm_config_devdir:headers,CI_CHECK_FAIL:'ssh2'}});
      }catch(error){row.exit=error.exitCode??-1;}
      row.wallMs=Date.now()-start;
      if(fs.existsSync(log))row.npmTimers=npmTimers(fs.readFileSync(log,'utf8'));
      const events=fs.readdirSync(trace).filter(f=>/^\d+\.jsonl$/.test(f)).flatMap(f=>fs.readFileSync(path.join(trace,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
      row.gypVersions=[...new Set(events.map(e=>e.gypVersion).filter(Boolean))];
      const expected=variant==='candidate'?'13.1.0':'11.5.0';
      row.toolVersionVerified=row.gypVersions.length===1&&row.gypVersions[0]===expected;
      for(const event of events.sort((a,b)=>a.at-b.at))fs.appendFileSync(path.join(output,'trace.jsonl'),JSON.stringify({pass:index+1,variant,...event})+'\n');
      row.tools=events.filter(e=>e.kind==='tool-end').map(({addon,tool,method,ms,code,error})=>({addon,tool,method,ms,code,error}));
      row.phaseMarkers=events.filter(e=>e.kind==='phase').map(({at,addon,phase})=>({elapsedMs:at-start,addon,phase}));
      try{
        const require=createRequire(path.join(cwd,'package.json'));
        row.nativeCrypto=require('ssh2/lib/protocol/crypto.js').bindingAvailable===true;
        row.nativeCpu=typeof require('cpu-features')().arch==='string';
        row.qualification=row.nativeCrypto&&row.nativeCpu&&row.toolVersionVerified;
      }catch(error){row.qualificationError=error.code??error.name;}
      save();console.log(JSON.stringify(row));
    }
    result.allPassed=result.passes.length===4&&result.passes.every(r=>r.exit===0&&r.qualification);
    save();if(!result.allPassed)throw Error('One or more install/qualification passes failed; do not treat as a successful comparison');
  }finally{await processes.stop();dispose();save();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(...process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
