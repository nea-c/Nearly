import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createFixture} from './sftp-fixture.mjs';
import {runFixtureTest} from './native-test-process.mjs';

// Generated loopback data only. No cargo fallback: parent owns native builds.
const root = path.resolve('test-results/parallel-copy-20261111');
const finalManifest = process.env.NEARLY_NATIVE_TEST_MANIFEST;
assert.ok(finalManifest && fs.existsSync(finalManifest), 'Set NEARLY_NATIVE_TEST_MANIFEST to the final native executable manifest');
const baselineManifest = path.join(root, 'baseline-manifest.json');
const suite = process.env.NEARLY_PARALLEL_SUITE ?? process.argv[2] ?? 'safety,benchmark';
fs.mkdirSync(root, {recursive:true});
const results = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const started = performance.now();
  while (!predicate()) { if (performance.now()-started > 20000) throw Error('Timeout: '+description); await pause(5); }
}
async function run(label, {benchmark=false, manifest=finalManifest, fileBytes=131072, copyData=false, mode='success', advertisedOpenHandles, rejectLimits=false, rejectCopyData=false, maxReadLength=65536}={}) {
  const out = fs.mkdtempSync(path.join(root,label+'-'));
  const pending = new Map(), events = [], closed = new Set();
  let started, ended, peak = 0, peakReads = 0, peakWrites = 0, peakTransfers = 0, writeAcks=0, copyRequests=0, copyAcks=0;
  const folder = mode.startsWith('folder');
  const target = i => folder ? `/bench/copy/source${i}` : `/bench/copy${i}`;
  const source = i => folder ? `/bench/source/source${i}` : `/bench/source${i}`;
  const fixture = await createFixture(out, {
    responseDelayMs:15, holdLargeWrites:false, copyData, advertisedOpenHandles, rejectLimits, rejectCopyData, maxReadLength,
    mapReadDir:folder?(_p,entries)=>[...entries].sort((a,b)=>b.filename.localeCompare(a.filename)):undefined,
    beforeClose(p) { if ([target(0),target(2),target(3)].includes(p)) closed.add(p); },
    async beforeCopyData() {
      copyRequests++;
      if (mode==='large-server-unsupported' && copyRequests===2) { assert.equal(copyAcks,1); return 8; }
      if (mode==='large-server-cancel' && copyRequests===2) {
        assert.equal(copyAcks,1);
        fs.writeFileSync(path.join(out,'mutation-held'),'generated');
        await until(()=>fs.existsSync(path.join(out,'mutation-release')),'native server cancellation');
      }
    },
    async beforeWrite(p,offset) {
      if (mode==='large-relay-failure' && p===target(0) && offset>=1048576) { await until(()=>writeAcks>=32,'first MiB WRITE acknowledgements'); return 4; }
      if (mode.endsWith('failure') && p===target(1)) { await until(()=>closed.size===3,'successful sibling closes'); return 4; }
    },
    async beforeRead(p,offset) {
      if (mode==='large-relay-cancel' && p===source(0) && offset>=1048576) {
        await until(()=>writeAcks>=32,'first MiB WRITE acknowledgements');
        fs.writeFileSync(path.join(out,'mutation-held'),'generated');
        await until(()=>fs.existsSync(path.join(out,'mutation-release')),'native relay cancellation');
      }
      if (mode==='cancel' && p===source(1)) {
        await until(()=>closed.size===3,'successful sibling closes before cancellation');
        fs.writeFileSync(path.join(out,'mutation-held'),'generated');
        await until(()=>fs.existsSync(path.join(out,'mutation-release')),'native cancellation');
      }
    },
    observeRequest(op,id,connection,p) {
      // First source/ancestor LSTAT begins the operation, after SSH auth and SFTP setup/limits.
      if (started===undefined && op==='LSTAT') started=performance.now();
      if (started===undefined) return;
      const now=performance.now(); pending.set(`${connection}:${id}`,op);
      events.push({kind:'request',ms:now-started,op,id,connection,...(typeof p==='string'?{path:p}:{})});
      const values=[...pending.values()]; peak=Math.max(peak,values.length);
      peakReads=Math.max(peakReads,values.filter(x=>x==='READ').length);
      peakWrites=Math.max(peakWrites,values.filter(x=>x==='WRITE').length);
      peakTransfers=Math.max(peakTransfers,values.filter(x=>x==='READ'||x==='WRITE').length);
    },
    observeResponse(data,connection) {
      if (started===undefined || data.length<9) return;
      const id=data.readUInt32BE(5), key=`${connection}:${id}`,op=pending.get(key);
      if (!op) return;
      ended=performance.now(); pending.delete(key);
      if (op==='WRITE' && data[4]===101 && data.readUInt32BE(9)===0) writeAcks++;
      if (op==='EXTENDED' && data[4]===101 && data.readUInt32BE(9)===0) copyAcks++;
      events.push({kind:'response',ms:ended-started,op,id,connection,type:data[4]});
    },
  });
  try {
    const fixtureManifest=path.join(out,'fixture.json');
    fs.writeFileSync(fixtureManifest,JSON.stringify({generatedOnly:true,mode:benchmark?'copy':mode,baseline:false,fileBytes,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
    process.env.NEARLY_NATIVE_TEST_MANIFEST=manifest;
    const code=await runFixtureTest(benchmark?'remote_operation_tests::remote_selection_fixture':'parallel_copy_tests::parallel_copy_fixture',{[benchmark?'NEARLY_OPERATION_FIXTURE':'NEARLY_PARALLEL_COPY_FIXTURE']:fixtureManifest},out);
    assert.equal(code,0,label);
    assert.equal(pending.size,0,'Every operation request settled');
    assert.equal(fixture.openFileHandles,0,'All file handles closed');
    assert.equal(fixture.openDirectoryHandles,0,'All directory handles closed');
    assert.equal(fixture.totalConnections,1,'Same session');
    if (benchmark) for(let i=0;i<5;i++) assert.deepEqual(fs.readFileSync(path.join(fixture.remote,`bench/copy${i}`)),Buffer.alloc(fileBytes,65+i));
    if (!benchmark && advertisedOpenHandles!==undefined && !rejectLimits) assert.ok(fixture.maxOpenFileHandles<=advertisedOpenHandles,'Advertised handle budget');
    if (!benchmark && rejectLimits) assert.ok(fixture.maxOpenFileHandles<=2,'Rejected limits use serial fallback');
    if (!benchmark && mode==='limit-one') assert.equal(fixture.requestCounts.OPEN??0,0,'Refuse before opening when two handles cannot fit');
    if (!benchmark && ['success','zero','folder','failure','cancel','folder-failure'].includes(mode)) assert.ok(fixture.maxOpenFileHandles<=8,'At most four file pairs');
    if (!benchmark && mode!=='limit-one' && !mode.startsWith('large-') && advertisedOpenHandles===undefined && !rejectLimits) assert.ok(fixture.maxOpenFileHandles>2,'Small siblings overlap');
    if (mode.startsWith('large-')) {
      assert.equal(fixture.maxOpenFileHandles,2,'Only the first large selected file is admitted');
      assert.equal(fixture.requestCounts.OPEN,2);
      if (mode.startsWith('large-server-')) {
        assert.equal(copyRequests,2,'No chunk after the interrupted second request');
        assert.equal(fixture.requestCounts.READ??0,0,'Never relay after acknowledged server-side copy');
        assert.equal(fixture.requestCounts.WRITE??0,0);
      } else {
        assert.equal(writeAcks,32,'Only first MiB committed');
        assert.ok(fixture.requestCounts.READ<=64,'No new READ beyond admitted second window');
        if (mode==='large-relay-cancel') assert.equal(fixture.requestCounts.WRITE,32,'No WRITE after cancellation');
      }
    }
    if (label.startsWith('boundary-')) assert.equal(fixture.maxOpenFileHandles,fileBytes<=262144?8:2,'256KiB is the small-file concurrency boundary');
    assert.ok(peakTransfers*32768<=1048576,'Conservative outstanding relay payload <=1 MiB');
    const measurement={label,mode,benchmark,manifest,fileBytes,copyData,responseHoldMs:15,extraLargeWriteHold:false,wireMilliseconds:ended-started,peakInflight:peak,peakReads,peakWrites,peakTransfers,requests:fixture.requestCounts,maxFileHandles:fixture.maxOpenFileHandles,maxDirectoryHandles:fixture.maxOpenDirectoryHandles,openFileHandles:fixture.openFileHandles,totalConnections:fixture.totalConnections,verified:true,out};
    fs.writeFileSync(path.join(out,'measurement.json'),JSON.stringify(measurement,null,2));
    fs.writeFileSync(path.join(out,'wire-events.json'),JSON.stringify(events,null,2));
    results.push(measurement); console.log('PARALLEL_COPY_RESULT',JSON.stringify(measurement));
  } catch(error) {
    fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({label,error:String(error.stack??error),requests:fixture.requestCounts,maxFileHandles:fixture.maxOpenFileHandles,openFileHandles:fixture.openFileHandles,pending:[...pending],requestPaths:fixture.requestPaths},null,2));
    fs.writeFileSync(path.join(out,'wire-events.json'),JSON.stringify(events,null,2));
    throw error;
  } finally { process.env.NEARLY_NATIVE_TEST_MANIFEST=finalManifest; await fixture.close(); }
}
if (suite.split(',').includes('safety')) {
  for(const mode of ['success','failure','cancel','folder','folder-failure','zero']) await run('safety-'+mode,{mode});
  for(const cap of [1,2,4,8]) await run('safety-limit-'+cap,{mode:cap===1?'limit-one':'success',advertisedOpenHandles:cap});
  await run('safety-unsupported-limits',{advertisedOpenHandles:8,rejectLimits:true});
  await run('safety-unsupported-copy-data',{copyData:true,rejectCopyData:true});
  await run('safety-server-copy',{copyData:true});
  await run('safety-short-read',{maxReadLength:4093});
}
if (suite.split(',').includes('boundary')) {
  for (const fileBytes of [262144,262145]) await run(`boundary-${fileBytes}`,{benchmark:true,fileBytes});
}
if (suite.split(',').includes('large-safety')) {
  for (const mode of ['large-relay-failure','large-relay-cancel','large-server-unsupported','large-server-cancel']) await run(mode,{mode,copyData:mode.startsWith('large-server-'),fileBytes:12582912});
}
if (suite.split(',').includes('benchmark')) {
  assert.ok(fs.existsSync(baselineManifest),'Baseline manifest missing');
  for(const size of ['small','large']) for(const method of ['relay','server']) for(let trial=1;trial<=3;trial++) {
    // Reverse every other trial to reduce systematic warmup/order bias.
    for(const version of trial%2?['baseline','final']:['final','baseline']) await run(`${size}-${method}-${trial}-${version}`,{benchmark:true,manifest:version==='baseline'?baselineManifest:finalManifest,fileBytes:size==='small'?131072:8388608,copyData:method==='server'});
  }
}
fs.writeFileSync(path.join(root,`results-${suite.replaceAll(',','-')}.json`),JSON.stringify(results,null,2));
if (suite.split(',').includes('benchmark')) {
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const summary=[];
  for(const size of ['small','large']) for(const method of ['relay','server']) {
    const rows=results.filter(row=>row.label.startsWith(`${size}-${method}-`));
    const baseline=rows.filter(row=>row.label.endsWith('-baseline')).map(row=>row.wireMilliseconds);
    const final=rows.filter(row=>row.label.endsWith('-final')).map(row=>row.wireMilliseconds);
    summary.push({size,method,baselineMilliseconds:baseline,finalMilliseconds:final,baselineMedian:median(baseline),finalMedian:median(final),speedup:median(baseline)/median(final),reductionPercent:100*(1-median(final)/median(baseline))});
  }
  fs.writeFileSync(path.join(root,'benchmark-summary.json'),JSON.stringify({methodology:'Generated localhost SFTP fixture; 15ms response hold, no extra large WRITE hold; 5 files per selection, 128KiB or 8MiB each; first operation LSTAT through final matched response; three alternating trials, excludes auth/setup; not a WAN bandwidth simulation.',summary},null,2));
  console.log('PARALLEL_COPY_SUMMARY',JSON.stringify(summary));
}
