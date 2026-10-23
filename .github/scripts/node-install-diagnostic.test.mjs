import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {order,npmTimers} from './node-install-diagnostic.mjs';
const preload=fileURLToPath(new URL('./node-install-observer.cjs',import.meta.url));

test('comparison reverses order and allows only named numeric npm timers',()=>{
  assert.deepEqual(order,['baseline','candidate','candidate','baseline']);
  assert.deepEqual(npmTimers('npm timing npm Completed in 123ms\nnpm timing private-data Completed in 42ms'),{npm:123});
});

test('one-shot diagnostic has no signing, publication or cache writer path',()=>{
  const yaml=fs.readFileSync(new URL('../workflows/node-install-diagnostic.yml',import.meta.url),'utf8');
  assert.match(yaml,/github\.event\.created == true/);
  assert.match(yaml,/contents: read/);
  assert.match(yaml,/package-manager-cache: false/);
  assert.match(yaml,/ref: cc0a659d56a998ca69976955d986539b87f2da9a/);
  assert.ok(!/actions\/cache|secrets\.|environment:|workflow_dispatch:|signed-release|publish|git push|contents: write/.test(yaml));
});

test('observer preserves sync and callback execution and records no command arguments',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nearly-install-observer-'));
  const code=`const cp=require('node:child_process');const assert=require('node:assert/strict');assert.equal(cp.spawnSync(process.execPath,['-e','console.log("private-dummy-argument")'],{encoding:'utf8'}).status,0);cp.execFile(process.execPath,['-e','console.log("private-dummy-argument")'],{encoding:'utf8'},(error,stdout)=>{assert.ifError(error);assert.equal(stdout.trim(),'private-dummy-argument');});`;
  const run=spawnSync(process.execPath,['--require',preload,'-e',code],{encoding:'utf8',env:{...process.env,NEARLY_INSTALL_TRACE:dir}});
  assert.equal(run.status,0,run.stderr);
  const raw=fs.readdirSync(dir).map(f=>fs.readFileSync(path.join(dir,f),'utf8')).join('');
  assert.ok(!raw.includes('private-dummy-argument'));
  const rows=raw.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(r=>r.kind==='tool-end').length,2);
  assert.ok(rows.every(r=>Number.isFinite(r.at)));
});

test('observer preserves promisified execFile result and callback errors',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nearly-install-observer-'));
  const code=`const cp=require('node:child_process');const util=require('node:util');const assert=require('node:assert/strict');(async()=>{const r=await util.promisify(cp.execFile)(process.execPath,['-e','console.log(42)']);assert.equal(r.stdout.trim(),'42');cp.execFile('not-a-real-nearly-tool',e=>assert.ok(e));})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const run=spawnSync(process.execPath,['--require',preload,'-e',code],{encoding:'utf8',env:{...process.env,NEARLY_INSTALL_TRACE:dir}});
  assert.equal(run.status,0,run.stderr);
});
