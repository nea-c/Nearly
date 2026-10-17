import {chromium,expect} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';

const identifier='local.syncfiles.native.dragwindowqa';
assert.equal(process.env.NEARLY_QA_IDENTIFIER,identifier);
assert.ok(process.env.NEARLY_QA_EXE&&/^[a-f0-9]{64}$/i.test(process.env.NEARLY_QA_SHA256??''));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const source=path.resolve(process.env.NEARLY_QA_EXE),expectedHash=process.env.NEARLY_QA_SHA256.toLowerCase();
assert.equal(hash(await fs.readFile(source)),expectedHash);
const output=path.resolve('test-results/native-drag-launch-'+Date.now());
const config=path.join(output,'config'),program=path.join(output,'program'),cwd=path.join(output,'different-cwd');
const local=path.join(output,'generated-local'),other=path.join(output,'generated-other');
for(const folder of [config,program,cwd,local,other])await fs.mkdir(folder,{recursive:true});
const exe=path.join(program,'Nearly.exe');await fs.copyFile(source,exe);
await fs.writeFile(path.join(local,'initial.txt'),'generated initial bytes');
await fs.writeFile(path.join(local,'excluded.tmp'),'generated excluded bytes');
await fs.mkdir(path.join(local,'empty'));await fs.mkdir(path.join(local,'nested'));
await fs.writeFile(path.join(local,'nested','owned.txt'),'generated nested bytes');
const fixture=await createFixture(path.join(output,'generated-endpoint'));
const remote='/upload/retained',remoteDisk=path.join(fixture.remote,'upload','retained');
await fs.mkdir(path.join(fixture.remote,'other'),{recursive:true});await fs.mkdir(remoteDisk);await fs.writeFile(path.join(remoteDisk,'server-only.txt'),'generated pre-existing remote-only content');
const profile={id:'retained-generated',name:'Generated retained sync QA',host:'127.0.0.1',port:fixture.port,user:'fixture',auth:'key',mode:'sftp',keyFile:fixture.ppk3,hostKey:fixture.fingerprint};
const connectionKey=JSON.stringify([profile.id,profile.mode,profile.host,profile.port,profile.user,profile.hostKey]);
const columns={order:['name','size','type','modified'],hidden:[],widths:{name:280,size:100,type:100,modified:170}};
const settings={schemaVersion:1,revision:1,
  connections:{profiles:[profile],history:{},tree:{version:1,nodes:[{kind:'profile',id:profile.id,profileId:profile.id,parentId:null}]}},
  appearance:{theme:'dark',language:'en',compactExplorer:false,localPaneRatio:0.5,localTreeRatio:0.28,remoteTreeRatio:0.28},
  explorer:{folderBookmarks:[],folderPairHistory:[],paneColumns:{local:columns,remote:{...columns,order:[...columns.order,'permissions','owner'],hidden:['permissions','owner']}},bookmarkTree:{version:1,nodes:[]}},
  browse:{browseLocations:{[connectionKey]:{local,remote}},paneSorts:{local:{column:'name',direction:'ascending'},remote:{column:'name',direction:'ascending'}}},
  sync:{exclusions:{},syncOptions:{},syncPresets:[{id:"generated-sync-preset",name:"Generated own preset",exclusionRules:"*.tmp",deleteRemoved:true,recursive:true}],retainedSyncs:[{id:"multi-a",ownerTabId:"multi-owner-a",ownerTabClosed:false,profile,local,remote,exclusionRules:"*.tmp",deleteRemoved:true,recursive:true,presetId:"generated-sync-preset",pendingState:"unknown"},{id:"multi-b",ownerTabId:"multi-owner-b",ownerTabClosed:false,profile,local:other,remote:"/other",exclusionRules:"owner-b/",deleteRemoved:false,recursive:false,pendingState:"unknown"},{id:"multi-closed",ownerTabId:"multi-owner-closed",ownerTabClosed:true,profile,local:other,remote:"/other",exclusionRules:"closed/",deleteRemoved:false,recursive:true,pendingState:"unknown"}]},trust:{version:1,pins:{[JSON.stringify([profile.host,profile.port])]:'SHA256:'+fixture.fingerprint.split(' ').at(-1)}}};
await fs.writeFile(path.join(config,'settings.json'),JSON.stringify(settings,null,2));
// This runner owns its generated config, endpoint, executable copy and CDP listener.
// Every invoke below crosses the real WebView/Tauri boundary; no IPC is replaced.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const A='multi-owner-a',B='multi-owner-b';
const evidence=[],lifecycle=[],snapshots=[],pageErrors=[],transferEvidence=[],screenshots=[];
const failureViews=[];
let proc,browser,sourcePage,port,cdp,jobId,launchIndex=0,exited=true,pass=false,error;
const secondaryProcesses=[],secondaryHandles=[];
function processSnapshot(){const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  '@(Get-Process -Name Nearly -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{id=$_.Id;path=$_.Path;started=$_.StartTime.ToUniversalTime().ToString("o")} }) | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}).trim();return raw?[].concat(JSON.parse(raw)):[];}
const baseline=processSnapshot();
function preserveBaseline(){const current=processSnapshot();for(const before of baseline)assert.deepEqual(current.find(p=>p.id===before.id),before,'Pre-existing process preserved');return current;}
const invoke=(page,command,args={})=>page.evaluate(({command,args})=>window.__TAURI__.core.invoke(command,args),{command,args});
const bootstrap=page=>invoke(page,'register_window');
const saved=async()=>JSON.parse(await fs.readFile(path.join(config,'settings.json'),'utf8'));
const counts=()=>({connections:fixture.totalConnections,authentication:fixture.authenticationRequests,writes:fixture.writeRequests});
const tabs=page=>page.locator('[role=tab][data-tab]').evaluateAll(nodes=>nodes.map(n=>n.dataset.tab));
const pages=()=>browser?.contexts().flatMap(c=>c.pages()).filter(p=>!p.isClosed())??[];
async function occupied(){if(!port)return false;return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});const finish=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(500,()=>finish(true));});}
const responds=()=>cdp?fetch(cdp+'/json/version',{signal:AbortSignal.timeout(600)}).then(r=>r.ok).catch(()=>false):false;
async function checkNoSecrets(){for(const name of await fs.readdir(config)){if(!name.endsWith('.json'))continue;const raw=await fs.readFile(path.join(config,name),'utf8');assert.ok(!raw.includes(fixture.passphrase),'Generated passphrase must not persist');assert.doesNotMatch(raw,/BEGIN [A-Z ]*PRIVATE KEY|Private-Lines:|Private-MAC:/);}}
async function observe(page){page.on('pageerror',e=>pageErrors.push(String(e)));await page.evaluate(async()=>{window.qaTransfers=[];await window.__TAURI__.event.listen('workspace-transfer',e=>window.qaTransfers.push(e.payload));});}
async function launch(){
  preserveBaseline();const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});port=probe.address().port;await new Promise(resolve=>probe.close(resolve));cdp='http://127.0.0.1:'+port;
  assert.equal(await occupied(),false,'Refuse pre-existing CDP listener');assert.equal(hash(await fs.readFile(exe)),expectedHash);
  const index=++launchIndex;proc=spawn(exe,[],{cwd,windowsHide:true,env:{...process.env,SYNCFILES_CONFIG_DIR:config,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'generated-webview-'+index),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  const owned=proc;exited=false;lifecycle.push({event:'spawn',pid:owned.pid,index,identifier,port});owned.once('exit',(code,signal)=>{exited=true;lifecycle.push({event:'exit',pid:owned.pid,index,code,signal});});owned.once('error',e=>{error=String(e);exited=true;});
  await expect.poll(async()=>{if(exited)throw Error(error??'Owned QA process exited before CDP');return responds();},{timeout:30000}).toBe(true);
  browser=await chromium.connectOverCDP(cdp);sourcePage=pages()[0];assert.ok(sourcePage);await expect(sourcePage.locator('#connect-form')).toBeVisible();assert.equal(await sourcePage.evaluate(()=>window.__TAURI__.app.getIdentifier()),identifier);await observe(sourcePage);assert.equal((await bootstrap(sourcePage)).label,'main');preserveBaseline();
}
async function idle(page){for(const side of ['local','remote'])await expect(page.locator('[data-pane="'+side+'"]').first()).toHaveAttribute('aria-busy','false');}
async function connect(page){await expect(page.locator('#connect-form')).toBeVisible();await page.locator('[data-connection-select="'+profile.id+'"]').click();await page.locator('#connect-form [name="passphrase"]').fill(fixture.passphrase);await page.locator('#connect-form .primary').click();await expect(page.locator('#connect-form')).toHaveCount(0,{timeout:25000});await idle(page);}
async function runtimeId(page){if(!await page.locator('.sync-roots[data-sync-id]').count())await page.locator('#toggle-logs').click();const id=await page.locator('.sync-roots[data-sync-id]').first().getAttribute('data-sync-id');assert.ok(id);if(await page.locator('#close-logs').count())await page.locator('#close-logs').click();return id;}
async function status(page){const s=await invoke(page,'sync_status',{id:jobId});snapshots.push({jobId,status:s.status,pending:s.pending,sent:s.sent,errorCount:s.errorCount});return s;}
async function rejected(page,command,args,pattern){let failure;try{await invoke(page,command,args);}catch(e){failure=String(e);}assert.ok(failure,command+' must reject in unrelated window');assert.match(failure,pattern);return failure;}
async function screenshot(page,name){const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});screenshots.push({name,path:file});return file;}
async function childDecorations(page){const result=await page.evaluate(async()=>{try{const w=window.__TAURI__.window.getCurrentWindow();if(typeof w.isDecorated!=='function')return {available:false,reason:'Tauri isDecorated API unavailable'};return {available:true,decorated:await w.isDecorated()};}catch(e){return {available:false,reason:String(e)};}});if(result.available)assert.equal(result.decorated,false,'Child native window must use custom undecorated titlebar');else assert.match(result.reason,/unavailable|not allowed|permission|not found|denied/i);return result;}
async function assertSingleOwners(ids){const all=await Promise.all(pages().map(bootstrap));for(const id of ids)assert.equal(all.filter(s=>s.ownedWorkspaceIds.includes(id)).length,1,'Exactly one native owner for '+id);return all;}
async function closePage(page){if(!page.isClosed())try{await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().close());}catch(e){if(!/Target.*closed|Execution context was destroyed/i.test(String(e)))throw e;}}
async function cleanup(){
  if(browser&&!exited){for(const page of pages()){const state=await bootstrap(page).catch(()=>null);for(const job of state?.jobs??[])await invoke(page,'stop_sync',{id:job.id}).catch(()=>{});}for(const page of pages())await closePage(page).catch(()=>{});}
  if(proc)await expect.poll(()=>exited,{timeout:20000}).toBe(true);if(browser)await browser.close().catch(()=>{});browser=undefined;
  await expect.poll(occupied,{timeout:10000}).toBe(false);await expect.poll(()=>fixture.connectionCount,{timeout:15000}).toBe(0);preserveBaseline();
}

// Secondary invocations are actual processes of this hash-checked, owned EXE.
// All pages must appear on the owner's CDP listener after each client exits.
async function invokeAgain(number=1){
  const before=new Set(pages()),beforeCounts=counts(),beforeStates=await Promise.all([...before].map(bootstrap));
  const beforeTabOrders=await Promise.all([...before].map(tabs));
  const clients=Array.from({length:number},()=>{
    const child=spawn(exe,[],{cwd,windowsHide:true,env:{...process.env,SYNCFILES_CONFIG_DIR:config,
      WEBVIEW2_USER_DATA_FOLDER:path.join(output,'generated-webview-1'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
    const record={pid:child.pid,code:null,signal:null,exited:false};secondaryProcesses.push(record);
    secondaryHandles.push({child,record});
    child.once('error',e=>{record.error=String(e);record.exited=true;});
    child.once('exit',(code,signal)=>Object.assign(record,{code,signal,exited:true}));
    return record;
  });
  await expect.poll(()=>clients.every(c=>c.exited),{timeout:20000}).toBe(true);
  for(const client of clients){assert.equal(client.error,undefined);assert.equal(client.code,0);assert.equal(client.signal,null);}
  await expect.poll(()=>pages().filter(p=>!before.has(p)).length,{timeout:30000}).toBe(number);
  const fresh=pages().filter(p=>!before.has(p));
  for(const page of fresh){
    await expect(page.locator('#connect-form')).toBeVisible();await observe(page);
    assert.equal(await page.evaluate(()=>window.__TAURI__.app.getIdentifier()),identifier);
    const state=await bootstrap(page),ids=await tabs(page);
    assert.notEqual(state.label,'main');assert.equal(ids.length,1);
    assert.deepEqual(state.ownedWorkspaceIds,ids);assert.equal(state.jobs.length,0);
    assert.ok(state.workspaces.every(w=>!w.connection));assert.ok(!ids.includes(A)&&!ids.includes(B));
    // The profile picker proves a fresh window is interactive without connecting.
    await page.locator('[data-connection-select="'+profile.id+'"]').click();
    await expect(page.locator('#connect-form [name="passphrase"]')).toBeVisible();
  }
  assert.deepEqual(counts(),beforeCounts,'EXE invocation must not authenticate, browse, start or clone work');
  const afterStates=await Promise.all([...before].map(bootstrap));
  for(let i=0;i<beforeStates.length;i++){
    assert.equal(afterStates[i].label,beforeStates[i].label);
    assert.deepEqual(await tabs([...before][i]),beforeTabOrders[i],'Existing visible tab order must remain unchanged');
    // Registry ownership is a HashMap-backed set; UI order is checked separately.
    assert.deepEqual([...afterStates[i].ownedWorkspaceIds].sort(),[...beforeStates[i].ownedWorkspaceIds].sort());
    assert.deepEqual(afterStates[i].jobs.map(j=>[j.id,j.workspaceId]).sort(),beforeStates[i].jobs.map(j=>[j.id,j.workspaceId]).sort());
  }
  const all=await Promise.all(pages().map(bootstrap));
  assert.equal(new Set(all.map(s=>s.label)).size,all.length);
  assert.equal(new Set(all.flatMap(s=>s.ownedWorkspaceIds)).size,all.flatMap(s=>s.ownedWorkspaceIds).length);
  const running=preserveBaseline();assert.ok(running.some(p=>p.id===proc.pid));
  for(const c of clients)assert.ok(!running.some(p=>p.id===c.pid),'Secondary EXE must exit; owner backend hosts all CDP windows');
  evidence.push({check:'Actual secondary EXE processes exit 0 and each add one usable blank window to the original backend',pass:true,clients,ownerPid:proc.pid,labels:all.map(s=>s.label),counts:counts()});
  return fresh;
}
async function settingsRace(leftPage,rightPage){
  const [left,right]=await Promise.all([invoke(leftPage,'load_settings'),invoke(rightPage,'load_settings')]);
  left.theme='forest';right.compactExplorer=!right.compactExplorer;
  await Promise.all([invoke(leftPage,'save_settings',{data:left}),invoke(rightPage,'save_settings',{data:right})]);
  let merged=await invoke(leftPage,'load_settings');assert.equal(merged.theme,'forest');assert.equal(merged.compactExplorer,right.compactExplorer);
  const [a,b]=await Promise.all([invoke(leftPage,'load_settings'),invoke(rightPage,'load_settings')]);a.theme='mint';b.theme='midnight';
  await invoke(leftPage,'save_settings',{data:a});await rejected(rightPage,'save_settings',{data:b},/conflict|changed|stale/i);
  merged=await invoke(rightPage,'load_settings');assert.equal(merged.theme,'mint');assert.equal(merged.compactExplorer,right.compactExplorer);
  evidence.push({check:'Two actual native windows preserve independent stale settings edits and reject conflicting stale edits',pass:true});

}
try{
  await launch();assert.deepEqual(await tabs(sourcePage),[A,B]);assert.equal(fixture.totalConnections,0);
  const originals=(await saved()).sync.retainedSyncs;
  const first=(await invokeAgain())[0];
  for(let i=0;i<2;i++)await invokeAgain(); // Three sequential real second-process launches.
  await invokeAgain(2); // Two simultaneous real second-process launches.
  assert.deepEqual((await saved()).sync.retainedSyncs,originals);await assertSingleOwners([A,B]);
  let current=await invoke(first,'load_settings');assert.equal(current.theme,'dark');assert.equal(current.language,'en');
  current=await invoke(first,'load_settings');const expectedAppearance={theme:current.theme,language:current.language,compactExplorer:current.compactExplorer};
  await screenshot(sourcePage,'retained-main-before-close');await screenshot(first,'secondary-blank-before-main-close');
  // Main has no job. Closing it must leave the backend and every secondary usable.
  assert.equal((await bootstrap(sourcePage)).jobs.length,0);await closePage(sourcePage);
  await expect.poll(()=>sourcePage.isClosed(),{timeout:15000}).toBe(true);assert.equal(exited,false);
  const postMain=(await invokeAgain())[0];
  assert.ok(!(await Promise.all(pages().map(bootstrap))).some(s=>s.label==='main'));
  const afterMain=await invoke(postMain,'load_settings');for(const [key,value] of Object.entries(expectedAppearance))assert.equal(afterMain[key],value);
  evidence.push({check:'Original main closes without a job; a later EXE invocation creates a new blank window in the still-running owner backend with main label absent and appearance preserved',pass:true,ownerPid:proc.pid});

  const worker=postMain; // Fresh UI client, separate from direct native settings probes.
  // Start an actual independent job in a secondary workspace, using only the
  // generated localhost fixture and explicit UI authentication/start actions.
  await connect(worker);
  await worker.locator('#remote-path').fill(remote);await worker.locator('#remote-path').press('Enter');await idle(worker);
  await worker.locator('#prepare').click();await expect(worker.locator('#start-form')).toBeVisible();
  await expect(worker.locator('#delete-removed')).not.toBeChecked();
  await worker.locator('#start-form [name="local"]').fill(local);
  await worker.locator('#exclusion-details summary').click();
  await worker.locator('#exclusion-rules').fill('*.tmp');await worker.locator('#recursive-sync').check();
  await worker.locator('#start-form .primary').click();await expect(worker.locator('#start-form')).toHaveCount(0,{timeout:25000});
  jobId=await runtimeId(worker);await expect.poll(async()=>{const s=await status(worker);return s.sent>=2&&s.pending===0&&s.errorCount===0;},{timeout:30000}).toBe(true);
  const owner=await bootstrap(worker),ownerId=(await tabs(worker))[0];assert.equal(owner.jobs.find(j=>j.id===jobId).workspaceId,ownerId);
  await invokeAgain();assert.equal(await runtimeId(worker),jobId);assert.equal((await status(worker)).status,'running');
  for(const page of pages().filter(p=>p!==worker)){
    assert.equal((await bootstrap(page)).jobs.length,0);await rejected(page,'stop_sync',{id:jobId},/(?:Job|Workspace) belongs to another window/);
  }
  await closePage(first);await expect.poll(()=>first.isClosed(),{timeout:15000}).toBe(true);
  assert.equal((await status(worker)).status,'running');
  await fs.writeFile(path.join(local,'after-blank-close.txt'),'generated main-closed backend survival bytes');
  await expect.poll(()=>fs.readFile(path.join(remoteDisk,'after-blank-close.txt'),'utf8').catch(()=>null),{timeout:30000}).toBe('generated main-closed backend survival bytes');
  await assert.rejects(fs.stat(path.join(remoteDisk,'excluded.tmp')),{code:'ENOENT'});
  const records=(await saved()).sync.retainedSyncs;
  for(const record of originals){const kept=records.find(r=>r.id===record.id);assert.ok(kept);for(const key of ['id','ownerTabId','profile','local','remote','exclusionRules','deleteRemoved','recursive','presetId'])assert.deepEqual(kept[key],record[key]);}
  await screenshot(worker,'secondary-running-after-main-and-blank-close');await checkNoSecrets();
  evidence.push({check:'Secondary-owned real SFTP job survives later EXE launch and unrelated blank close; existing retained IDs/roots/options preserved and generated live bytes arrive',pass:true,jobId,workspaceId:ownerId,counts:counts()});
  await worker.locator('#prepare').click();await expect.poll(async()=>(await bootstrap(worker)).jobs.some(j=>j.id===jobId&&j.job),{timeout:20000}).toBe(false);jobId=undefined;
  // Keep deliberate stale native probes in otherwise unused blank windows.
  const probes=pages().filter(p=>p!==worker);assert.ok(probes.length>=2);
  await settingsRace(probes[0],probes[1]);
  assert.deepEqual(pageErrors,[]);pass=true;
}catch(e){error=String(e.stack??e);process.exitCode=1;for(const page of pages()){try{failureViews.push({label:(await bootstrap(page)).label,text:(await page.locator('body').innerText()).slice(0,12000)});await screenshot(page,'failure-'+failureViews.length);}catch{}}}
finally{
  for(const {child,record} of secondaryHandles)if(!record.exited){record.forcedCleanup=true;child.kill();pass=false;process.exitCode=1;}
  await cleanup().catch(async e=>{pass=false;error=(error??'')+'\nCleanup: '+e;process.exitCode=1;if(proc&&!exited){lifecycle.push({event:'forced-cleanup-owned-child',pid:proc.pid});proc.kill();await expect.poll(()=>exited,{timeout:10000}).toBe(true).catch(()=>{});}if(browser)await browser.close().catch(()=>{});});
  await fixture.close().catch(e=>{pass=false;error=(error??'')+'\nFixture cleanup: '+e;process.exitCode=1;});
  const remaining=preserveBaseline(),ownedPids=[...lifecycle.filter(e=>e.event==='spawn').map(e=>e.pid),...secondaryProcesses.map(p=>p.pid)];
  const ownedProcessesRemaining=remaining.filter(p=>ownedPids.includes(p.id));if(ownedProcessesRemaining.length){pass=false;process.exitCode=1;}
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({pass,error,failureViews,output,source,sha256:expectedHash,sourceHashAfter:hash(await fs.readFile(source)),identifier,evidence,lifecycle,secondaryProcesses,snapshots,screenshots,pageErrors,requests:fixture.requestCounts,baselineProcesses:baseline,remainingProcesses:remaining,ownedProcessesRemaining,cdpResponding:await responds(),provenance:{mocked:[],native:'Actual hash-checked EXE process launches, owner CDP windows, native scoped IPC and close; generated localhost SFTP authentication/write',physicalDrag:'UNVERIFIED: no legitimate physical mouse input tool is exposed; no cross-window gesture is simulated or claimed',secrets:'Generated config checked for passphrase and private-key markers; generated key/trust only',desktop:'Owned WebView CDP screenshots only; pre-existing Nearly processes preserved'}},null,2));
  console.log(JSON.stringify({pass,output,error}));
}

