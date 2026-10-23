import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function collectTests(report){
 const tests=new Map();
 function visit(suites){for(const suite of suites||[]){
  for(const spec of suite.specs||[])for(const item of spec.tests||[]){
   if(typeof spec.id!=='string'||!spec.id||typeof item.projectId!=='string')throw Error('Invalid UI test identity');
   const id=JSON.stringify([spec.id,item.projectId]);
   if(tests.has(id))throw Error('Duplicate UI test identity');tests.set(id,item);
  }
  visit(suite.suites);
 }}
 visit(report.suites);return tests;
}
export function validatePartition(all,groups){
 if(!all.size||groups.length!==2||groups.some(g=>!g.size))throw Error('UI coverage requires two nonempty shards');
 const union=new Set();for(const group of groups)for(const id of group.keys()){
  if(union.has(id))throw Error('UI shard overlap/duplicate');union.add(id);
 }
 if(union.size!==all.size||[...union].some(id=>!all.has(id)))throw Error('UI shard coverage differs from the full suite');
 return all.size;
}
export function validateExecution(planned,report){
 if(report.errors?.length)throw Error('UI report contains an error');
 for(const name of ['unexpected','flaky','skipped'])if(report.stats?.[name]!==0)throw Error(`UI report has unsuccessful ${name} cases`);
 const actual=collectTests(report);
 if(!planned.size||actual.size!==planned.size||[...actual.keys()].some(id=>!planned.has(id)))throw Error('UI execution coverage differs from plan');
 for(const item of actual.values())if(item.expectedStatus!=='passed'||item.status!=='expected'||item.results?.length!==1||item.results[0].status!=='passed')throw Error('Every UI case must have one successful passed attempt');
 return actual.size;
}
export function projectEnvironment(root,original=process.env){
 const env={...original,PATH:path.join(root,'node_modules','.bin')+path.delimiter+(original.PATH??original.Path??'')};
 for(const key of Object.keys(env))if(key.toUpperCase()==='PATH'&&key!=='PATH')delete env[key];
 return env;
}

export async function runShard(index){
 if(!['1','2'].includes(String(index)))throw Error('Exactly shard 1 or 2 is required');
 const {Processes,cancellation}=await import('./native-test-process.mjs');
 const processes=new Processes(),dispose=cancellation(processes);
 const root=fileURLToPath(new URL('../',import.meta.url));
 await fs.mkdir(path.join(root,'test-results'),{recursive:true});
 const output=await fs.mkdtemp(path.join(root,'test-results',`ui-shard-${index}-`));
 const cli=path.join(root,'node_modules/@playwright/test/cli.js');
 async function playwright(name,args,list=false){
  const reportFile=path.join(output,`${name}.json`);
  await processes.run(process.execPath,[cli,'test',...args,`--reporter=${list?'json':'line,json'}`],
   {cwd:root,env:{...projectEnvironment(root),PLAYWRIGHT_JSON_OUTPUT_FILE:reportFile}});
  const stat=await fs.stat(reportFile);if(stat.size>32*1024*1024)throw Error('UI report exceeds bound');
  return JSON.parse(await fs.readFile(reportFile,'utf8'));
 }
 try{
  const all=collectTests(await playwright('full-plan',['--list'],true));
  const groups=[];for(const n of [1,2])groups.push(collectTests(await playwright(`shard-${n}-plan`,['--list',`--shard=${n}/2`],true)));
  const total=validatePartition(all,groups);
  const actual=await playwright('execution',[`--shard=${index}/2`,'--workers=2',`--output=${path.join(output,'browser')}`]);
  const passed=validateExecution(groups[Number(index)-1],actual);
  let productionPassed=0;
  if(String(index)==='1'){
   const command=process.platform==='win32'?'cmd.exe':'npm';
   const args=process.platform==='win32'?['/d','/s','/c','npm run build']:['run','build'];
   await processes.run(command,args,{cwd:root,env:process.env});
   const productionPlan=collectTests(await playwright('production-plan',['--config=playwright.production.config.ts','--list'],true));
   productionPassed=validateExecution(productionPlan,await playwright('production-execution',['--config=playwright.production.config.ts','--workers=2',`--output=${path.join(output,'production')}`]));
  }
  const summary={shard:Number(index),shards:2,total,passed,productionPassed};
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  console.log('UI_SHARD_RESULT',JSON.stringify(summary));return summary;
 }finally{await processes.stop();dispose();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 runShard(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
}
