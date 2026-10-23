import test from 'node:test';
import assert from 'node:assert/strict';
import {collectTests,validatePartition,validateExecution,projectEnvironment} from '../scripts/ui-shard-test.mjs';
import path from 'node:path';

const report=(ids,{status='passed',expectedStatus='passed',errors=[]}={})=>({errors,suites:[{specs:ids.map(id=>({id,tests:[{projectId:'',expectedStatus,results:status==='listed'?[]:[{status}],status:status==='passed'?'expected':status}]}))}],stats:{unexpected:0,flaky:0,skipped:0}});
test('UI shard partition covers every planned case exactly once',()=>{
 const all=collectTests(report(['a','b','c'],{status:'listed'}));
 const a=collectTests(report(['a','c'],{status:'listed'})),b=collectTests(report(['b'],{status:'listed'}));
 assert.equal(validatePartition(all,[a,b]),3);
 assert.throws(()=>validatePartition(all,[a,a]),/duplicate|overlap/);
 assert.throws(()=>validatePartition(all,[a]),/coverage/);
 assert.throws(()=>validatePartition(all,[a,collectTests(report(['b','foreign']))]),/coverage/);
 assert.throws(()=>collectTests(report(['a','a'])),/duplicate/i);
});
test('UI shard success requires the exact executed planned cases without skipped or hidden failed attempts',()=>{
 const planned=collectTests(report(['a','b'],{status:'listed'}));
 assert.equal(validateExecution(planned,report(['a','b'])),2);
 for(const status of ['skipped','failed','timedOut','interrupted'])assert.throws(()=>validateExecution(planned,report(['a','b'],{status})),/passed|successful/);
 assert.throws(()=>validateExecution(planned,report(['a'])),/coverage/);
 assert.throws(()=>validateExecution(planned,report(['a','b','c'])),/coverage/);
 const retry=report(['a','b']);retry.suites[0].specs[0].tests[0].results.unshift({status:'failed'});
 assert.throws(()=>validateExecution(planned,retry),/passed|successful/);
 assert.throws(()=>validateExecution(planned,report(['a','b'],{errors:[{message:'setup failed'}]})),/error/);
 const skip=report(['a','b']);skip.stats.skipped=1;assert.throws(()=>validateExecution(planned,skip),/skipped/);
 assert.throws(()=>validateExecution(planned,report(['a','b'],{expectedStatus:'failed'})),/passed|successful/);
});
test('direct Playwright invocation retains npm local-tool lookup for production preview',()=>{
 const original={Path:'existing-tools',KEEP:'yes'};
 const env=projectEnvironment('/project',original);
 assert.equal(env.PATH,path.join('/project','node_modules','.bin')+path.delimiter+'existing-tools');
 assert.equal(env.Path,undefined);assert.equal(env.KEEP,'yes');assert.equal(original.Path,'existing-tools');
});
