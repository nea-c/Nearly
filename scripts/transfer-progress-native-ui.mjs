// Real isolated QA EXE/WebView/native IPC and generated localhost files only.
// The QA bridge triggers native commands; this does not claim qualification of OS drag gestures.
import {chromium, expect} from '@playwright/test';
import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {packSettings} from './storage-fixture.mjs';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory} from './native-test-process.mjs';

const identifier='local.nearly.editorwindow.qa20261029';
const exe=path.resolve(process.env.NEARLY_TRANSFER_QA_EXE??'src-tauri/target/text-editor-qa/debug/Nearly.exe');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const exeHash=hash(await fs.readFile(exe));
const output=fixtureDirectory('transfer-progress-native-ui');
const config=path.join(output,'config'), local=path.join(output,'local-samples'), webview=path.join(output,'webview');
for (const directory of [config,local,webview]) await fs.mkdir(directory,{recursive:true});
const first=Buffer.alloc(100000,17), second=Buffer.alloc(70000,23), total=first.length+second.length;
const sourceFiles=[['first.bin',first],['second.bin',second]];
for (const [name,bytes] of sourceFiles) await fs.writeFile(path.join(local,name),bytes);

let scenario;
const gate=async (active, kind) => {
  let timer;
  const result=await new Promise(resolve => {
    active.gates[kind]={reached:true,release:()=>{clearTimeout(timer);resolve(false);}};
    timer=setTimeout(()=>{active.timedOut=kind;resolve(true);},60000);
  });
  return result;
};
const fixture=await createFixture(path.join(output,'endpoint'),{
  async beforeWrite(p,offset,data) {
    const active=scenario;
    if (!active || active.direction!=='upload' || !p.startsWith(active.destination+'/')) return;
    active.requestedBytes+=data.length;
    if (offset===32768 && !active.gates.packet) {
      if (await gate(active,'packet')) return 4;
      if (active.mode==='failure') return 4;
    }
  },
  async beforeRead(p,offset,length) {
    const active=scenario;
    if (!active || active.direction!=='download' || !p.startsWith(active.remoteSource+'/')) return;
    active.requestedBytes+=Math.min(length,(p.endsWith('/first.bin')?first.length:second.length)-offset);
    if (offset===32768 && !active.gates.packet && await gate(active,'packet')) return 4;
  },
  async beforeStat(_op,p) {
    const active=scenario;
    if (!active || active.mode!=='success' || active.requestedBytes<total || active.gates.finalizing) return;
    const last=active.direction==='upload'?active.destination+'/second.bin':active.remoteSource+'/second.bin';
    if (p===last && await gate(active,'finalizing')) return 4;
  },
});
await fs.mkdir(path.join(fixture.remote,'qa'),{recursive:true});
for (const theme of ['light','dark']) {
  await fs.mkdir(path.join(fixture.remote,'qa','upload-'+theme));
  const source=path.join(fixture.remote,'qa','download-'+theme);
  await fs.mkdir(source);
  for (const [name,bytes] of sourceFiles) await fs.writeFile(path.join(source,name),bytes);
}
await fs.mkdir(path.join(fixture.remote,'qa','upload-failure'));
const cancelSource=path.join(fixture.remote,'qa','download-cancel'); await fs.mkdir(cancelSource);
for (const [name,bytes] of sourceFiles) await fs.writeFile(path.join(cancelSource,name),bytes);
const profile={id:'transfer-fixture',name:'Generated localhost',host:'127.0.0.1',port:fixture.port,user:'fixture',auth:'key',mode:'sftp',keyFile:fixture.ppk3,hostKey:fixture.fingerprint};
const profileKey=JSON.stringify([profile.id,profile.mode,profile.host,profile.port,profile.user,profile.hostKey]);
const settings={schemaVersion:1,revision:1,
  connections:{profiles:[profile],history:{},lastSelectedProfileId:profile.id,tree:{version:1,nodes:[{kind:'profile',id:profile.id,profileId:profile.id,parentId:null}]}},
  appearance:{theme:'light',language:'en',compactExplorer:false,localPaneRatio:.5,localTreeRatio:.25,remoteTreeRatio:.25},
  explorer:{folderBookmarks:[],folderPairHistory:[],bookmarkTree:{version:1,nodes:[]},paneColumns:{
    local:{order:['name','size','type','modified'],hidden:[],widths:{name:280,size:100,type:100,modified:170}},
    remote:{order:['name','size','type','modified','permissions','owner'],hidden:['permissions','owner'],widths:{name:280,size:100,type:100,modified:170}},
  }},
  browse:{browseLocations:{[profileKey]:{local,remote:'/qa'}},paneSorts:{
    local:{column:'name',direction:'ascending'},remote:{column:'name',direction:'ascending'},
  }},
  sync:{exclusions:{},syncOptions:{},syncPresets:[],retainedSyncs:[]},
  trust:{version:1,pins:{[JSON.stringify([profile.host,profile.port])]:'SHA256:'+profile.hostKey.split(' ').at(-1)}},
};
const packedSettings=packSettings(settings), settingsEnvelope=JSON.parse(packedSettings['settings.json']);
assert.ok(settingsEnvelope.paneColumns?.local && settingsEnvelope.paneColumns?.remote,'Generated settings require both paneColumns entries');
assert.ok(settingsEnvelope.paneSorts?.local && settingsEnvelope.paneSorts?.remote,'Generated settings require both paneSorts entries');
for (const [name,text] of Object.entries(packedSettings)) await fs.writeFile(path.join(config,name),text);
const socket=net.createServer(); await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
const cdp='http://127.0.0.1:'+port, proxyRequests=[];
const proxy=net.createServer(socket=>socket.once('data',data=>{
  proxyRequests.push(data.toString().split('\r\n')[0]);
  socket.end('HTTP/1.1 502 Generated QA blocks external networking\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}));
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const proxyUrl='http://127.0.0.1:'+proxy.address().port;
const proc=spawn(exe,[],{cwd:output,windowsHide:true,env:{...process.env,
  HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,ALL_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,all_proxy:proxyUrl,
  NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',SYNCFILES_CONFIG_DIR:config,WEBVIEW2_USER_DATA_FOLDER:webview,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port+' --proxy-server='+proxyUrl+' --proxy-bypass-list=*.localhost;127.0.0.1;localhost',
},stdio:['ignore','pipe','pipe']});
let browser,page,passed=false,failure,stdout='',stderr='',spawnError;
proc.stdout.on('data',bytes=>stdout+=bytes);proc.stderr.on('data',bytes=>stderr+=bytes);proc.on('error',error=>spawnError=String(error));
const evidence=[];
const idle=async()=>{for (const side of ['local','remote']) await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');};
const state=()=>page.evaluate(()=>window.__nearlyTransferQa.state());
const snapshot=()=>page.evaluate(()=>window.__nearlyTransferQa.snapshot());
async function capture(name,detail) {
  const file=path.join(output,name+'.png');
  await page.screenshot({path:file});
  const card=page.locator('.operation-feedback').last();
  const cardFile=path.join(output,name+'-card.png'); await card.screenshot({path:cardFile});
  evidence.push({image:file,cardImage:cardFile,...detail});
}
async function theme(value) {
  await page.locator('#settings-toggle').click();
  await page.locator('#theme-select').selectOption(value);
  await page.locator('#settings-close').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',value);
}
async function run(direction, selectedTheme, mode='success') {
  await theme(selectedTheme);
  const name=direction+'-'+(mode==='success'?selectedTheme:mode);
  const remoteSource='/qa/download-'+(mode==='cancel'?'cancel':selectedTheme);
  const destination=direction==='upload'?'/qa/upload-'+(mode==='failure'?'failure':selectedTheme):path.join(output,name);
  if (direction==='download') await fs.mkdir(destination);
  scenario={direction,mode,destination,remoteSource,requestedBytes:0,gates:{}};
  const sources=direction==='upload'?sourceFiles.map(([name])=>path.join(local,name)):sourceFiles.map(([name])=>remoteSource+'/'+name);
  const sessionId=await page.locator('[data-tab][role=tab]').first().getAttribute('data-tab');
  assert.ok(sessionId);
  const id=await page.evaluate(request=>window.__nearlyTransferQa.run(request),{direction,sessionId,sources,destination});
  await expect.poll(()=>!!scenario.gates.packet,{timeout:30000}).toBe(true);
  const gauge=page.locator('.operation-feedback progress').last();
  await expect(gauge).toHaveAttribute('max',String(total));
  await expect(gauge).toHaveAttribute('value','32768');
  const intermediate=await snapshot();
  assert.equal(intermediate.done,32768);assert.equal(intermediate.total,total);
  assert.equal(intermediate.phase,direction==='upload'?'uploading':'downloading');
  await capture(name+'-progress',{id,direction,theme:selectedTheme,mode,nativeSnapshot:intermediate,source:'Actual native command and loopback SFTP acknowledgements; product operationFeedback renderer'});
  if (mode==='cancel') {
    await page.locator('#qa-transfer-cancel').click();
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  scenario.gates.packet.release();
  if (mode==='success') {
    await expect.poll(()=>!!scenario.gates.finalizing,{timeout:30000}).toBe(true);
    await expect(gauge).not.toHaveAttribute('value');
    await expect(page.locator('.operation-progress-label').last()).toContainText('Finalizing');
    const finalizing=await snapshot();
    assert.equal(finalizing.done,total);assert.equal(finalizing.total,total);assert.equal(finalizing.phase,'finalizing');
    assert.equal((await state()).finished,false,'Acknowledged bytes are not authoritative success');
    await capture(name+'-finalizing',{id,direction,theme:selectedTheme,nativeSnapshot:finalizing});
    scenario.gates.finalizing.release();
  }
  await expect.poll(async()=>(await state()).finished,{timeout:30000}).toBe(true);
  const result=await state();assert.equal(result.error,undefined);assert.equal(result.id,id);
  assert.equal(result.outcome.status,mode==='success'?'completed':mode==='cancel'?'cancelled':'partial');
  assert.equal(result.outcome.transferredBytes,mode==='success'?total:32768);
  assert.equal(result.outcome.bytes,mode==='success'?total:0);
  assert.equal(result.outcome.completed,mode==='success'?2:0);
  await expect(page.locator('.operation-feedback').last()).toHaveAttribute('data-success',String(mode==='success'));
  if (mode==='success') await expect(gauge).toHaveAttribute('value','1');
  else await expect(gauge).not.toHaveAttribute('value');
  await capture(name+'-result',{id,direction,theme:selectedTheme,mode,outcome:result.outcome});
  const verified=[];
  for (const [name,bytes] of sourceFiles) {
    const source=direction==='upload'?path.join(local,name):path.join(fixture.remote,remoteSource.slice(1),name);
    assert.equal(hash(await fs.readFile(source)),hash(bytes),'Generated source retained');
    if (mode==='success') {
      const file=direction==='upload'?path.join(fixture.remote,destination.slice(1),name):path.join(destination,name);
      const produced=await fs.readFile(file);assert.equal(hash(produced),hash(bytes));
      verified.push({file,bytes:produced.length,sha256:hash(produced),sourceSha256:hash(bytes)});
    }
  }
  if (mode!=='success') {
    const directory=direction==='upload'?path.join(fixture.remote,destination.slice(1)):destination;
    assert.deepEqual(await fs.readdir(directory),[],'Ordinary failure/cancel removes owned stage and publishes no file');
  }
  assert.equal(scenario.timedOut,undefined);
  evidence.push({check:name,passed:true,actualNativeOperationId:id,producedBytesVerified:verified,outcome:result.outcome,fullOsGesture:false});
  scenario=undefined;
}
try {
  await expect.poll(async()=>{
    if (spawnError || proc.exitCode!==null) throw Error('Owned QA process failed: '+(spawnError??stderr));
    try {return (await fetch(cdp+'/json/version')).ok;} catch {return false;}
  },{timeout:30000}).toBe(true);
  browser=await chromium.connectOverCDP(cdp);
  await expect.poll(async()=>{
    for (const candidate of browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.isClosed()&&/^https?:\/\/tauri\.localhost\//.test(page.url()))) {
      try {const value=await candidate.evaluate(()=>window.__TAURI__?.app?.getIdentifier());if (value) {assert.equal(value,identifier,'Never operate a production Nearly process');page=candidate;return true;}}
      catch(error) {if (!/context was destroyed|Cannot read|not defined/.test(String(error))) throw error;}
    }
    return false;
  },{timeout:20000}).toBe(true);
  await expect.poll(()=>page.evaluate(()=>window.__nearlyTransferQa?.identifier),{timeout:20000}).toBe(identifier);
  await expect(page.locator('#connect-form')).toBeVisible();
  await page.locator('[data-connection-select="'+profile.id+'"]').click();
  await page.locator('#connect-form [name=passphrase]').fill(fixture.passphrase);
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('#connect-form')).toHaveCount(0,{timeout:30000});
  await idle();await expect(page.locator('#local-path')).toHaveValue(local);await expect(page.locator('#remote-path')).toHaveValue('/qa');
  evidence.push({check:'Actual main UI connection established with generated localhost key/profile/session',fixturePort:fixture.port,bridge:await page.evaluate(()=>window.__nearlyTransferQa.provenance)});
  for (const selectedTheme of ['light','dark']) for (const direction of ['upload','download']) await run(direction,selectedTheme);
  await run('upload','light','failure');await run('download','dark','cancel');
  passed=true;
} catch(error) {
  failure=String(error?.stack??error);
  if (page) await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
} finally {
  for (const held of Object.values(scenario?.gates??{})) held.release();
  await browser?.close().catch(()=>{});
  if (proc.exitCode===null && proc.pid) {
    await new Promise(resolve=>setTimeout(resolve,300));
    if (proc.exitCode===null) execFileSync('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true});
  }
  await Promise.allSettled([fixture.close(),new Promise(resolve=>proxy.close(resolve))]);
  await fs.writeFile(path.join(output,'process.log'),JSON.stringify({pid:proc.pid,exitCode:proc.exitCode,stdout,stderr},null,2));
  const result={passed,failure,identifier,exe,exeHash,output,evidence,requests:fixture.requestCounts,proxyRequests,
    generatedOnly:true,realUserDataTouched:false,installed:false,actualNativeCommands:true,productOperationFeedback:true,
    qaBridgeTrigger:true,fullOsGesture:false,scope:'QA-copy bridge triggers native upload/download and real progress snapshots; OS drag gestures are separately qualified by route tests.'};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
  if (process.env.NEARLY_TRANSFER_UI_RESULT) await fs.writeFile(process.env.NEARLY_TRANSFER_UI_RESULT,JSON.stringify(result,null,2));
  console.log('TRANSFER_PROGRESS_NATIVE_UI_RESULT',output,passed);
  if (!passed) process.exitCode=1;
}
