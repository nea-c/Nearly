// Generated localhost and owned Explorer windows only. OS input is never used for tab/window dragging.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {expect} from '@playwright/test';
const powershell=await fs.readFile(new URL('./native-explorer-download.ps1',import.meta.url),'utf8');
async function ps(root,mode,data){
 const config=path.join(root,'explorer-'+mode+'-'+Date.now()+'.json');await fs.writeFile(config,JSON.stringify({...data,mode,root,generatedOnly:true}));
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',powershell],{windowsHide:true,env:{...process.env,NEARLY_EXPLORER_QA_CONFIG:config},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 await fs.writeFile(config+'.log',JSON.stringify({pid:child.pid,code,stdout,stderr},null,2));
 assert.equal(code,0,'Owned Explorer '+mode+' failed: '+stderr);return JSON.parse(stdout.trim());
}
async function go(page,side,folder){await page.locator('#'+side+'-path').fill(folder);await page.locator('#'+side+'-path').press('Enter');await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');}
async function pointer(page,from,to){
 await expect(from).toBeInViewport();await expect(to).toBeInViewport();
 let previous,a,b;
 await expect.poll(async()=>{a=await from.boundingBox();b=await to.boundingBox();const next=JSON.stringify([a,b]),stable=!!a&&!!b&&next===previous;previous=next;return stable;}).toBe(true);
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();
 try {await page.mouse.move(b.x+12,b.y+b.height/2,{steps:12});}finally{await page.mouse.up();}
}
export async function verifyNativeDownloads(page,{local,remote,remoteDisk,output,fixture,pid,evidence,screenshot}){
 const root=path.join(output,'download-qa'),receive=path.join(root,'explorer-received');await fs.mkdir(receive,{recursive:true});
 const source=remote+'/native-export',disk=path.join(remoteDisk,'native-export'),expectedOne='generated native stream bytes '.padEnd(392,'.');
 await fs.mkdir(path.join(disk,'folder','nested'),{recursive:true});await fs.mkdir(path.join(disk,'folder','empty'));await fs.writeFile(path.join(disk,'one.txt'),expectedOne);await fs.writeFile(path.join(disk,'folder','nested','日本語.txt'),'actual recursive virtual content');await fs.writeFile(path.join(disk,'cancel.txt'),'cancel source retained');
 const localDestination=path.join(local,'native-download-target');await fs.mkdir(localDestination);await fs.writeFile(path.join(localDestination,'one.txt'),'old local sentinel');
 await go(page,'local',local);await go(page,'remote',source);
 // CDP mouse events do not assert physical LBUTTON. Native OLE requires a guarded OS gesture.
 await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().unminimize());await page.bringToFront();
 const sourceBox=await page.locator('[data-list=remote] [data-name="one.txt"] [data-entry-icon]').boundingBox(),targetBox=await page.locator('[data-list=local] [data-name="native-download-target"]').boundingBox();assert.ok(sourceBox&&targetBox);
 const appBounds=await page.evaluate(async()=>{const w=window.__TAURI__.window.getCurrentWindow();return{position:await w.outerPosition(),size:await w.outerSize()};});
 const appInput=await ps(root,'appdrag',{pid,bounds:appBounds,folder:receive,manualForeground:process.env.NEARLY_QA_MANUAL_FOREGROUND==='1',scale:await page.evaluate(()=>devicePixelRatio),css:{x:sourceBox.x+sourceBox.width/2,y:sourceBox.y+sourceBox.height/2},targetCss:{x:targetBox.x+20,y:targetBox.y+targetBox.height/2}});
 evidence.push({check:'Guarded physical remote-to-own-local gesture',...appInput});
 await expect(page.locator('#download-confirm')).toBeVisible();await page.locator('#download-confirm').click();await expect(page.locator('#transfer-conflict')).toBeVisible({timeout:20000});await expect(page.locator('#transfer-conflict')).toContainText(localDestination);await page.locator('#transfer-conflict [data-choice=overwrite]').click();
 await expect.poll(()=>fs.readFile(path.join(localDestination,'one.txt'),'utf8'),{timeout:20000}).toBe(expectedOne);await expect(page.locator('.operation-feedback').last()).toContainText(/Completed|完了/);assert.equal(await fs.readFile(path.join(disk,'one.txt'),'utf8'),expectedOne);
 evidence.push({check:'Actual native remote-to-app-local download with confirmed existing-file replacement',pass:true,sourceRetained:true,local:localDestination});await screenshot(page,'native-internal-download-confirmed-replacement');
 const completedCard=page.locator('.operation-feedback').last();await expect(completedCard).toContainText('1 item');await expect(completedCard).toContainText('392 bytes');await expect(completedCard).not.toContainText('1 / 392');
 await expect(page.locator('.operation-feedback')).toHaveCount(0,{timeout:8000});
 evidence.push({check:'Actual native completed byte/item units and success toast expiry',pass:true,items:1,bytes:392,expiryMs:5000});
 async function ownGesture(targetSelector,cancel=false){
  await page.bringToFront();const a=await page.locator('[data-list=remote] [data-name="one.txt"] [data-entry-icon]').boundingBox(),b=await page.locator(targetSelector).boundingBox();assert.ok(a&&b);
  const bounds=await page.evaluate(async()=>{const w=window.__TAURI__.window.getCurrentWindow();return{position:await w.outerPosition(),size:await w.outerSize()};});
  return ps(root,'appdrag',{pid,bounds,folder:receive,manualForeground:process.env.NEARLY_QA_MANUAL_FOREGROUND==='1',scale:await page.evaluate(()=>devicePixelRatio),css:{x:a.x+a.width/2,y:a.y+a.height/2},targetCss:{x:b.x+20,y:b.y+b.height/2},cancel});
 }
 await page.evaluate(()=>{window.qaUnexpectedUpload=false;new MutationObserver(()=>{if(document.querySelector('#upload-confirm'))window.qaUnexpectedUpload=true;}).observe(document.body,{childList:true,subtree:true});});
 for(const [name,target,cancel]of [['return-remote','[data-list=remote] [data-name="folder"]',false],['escape','[data-list=local] [data-name="native-download-target"]',true]]){
  const start=fixture.requestPaths.length,reads=fixture.requestCounts.READ??0,input=await ownGesture(target,cancel);
  if(cancel){const card=page.locator('.operation-feedback').last();await expect(card).toContainText(/Cancelled|キャンセル/,{timeout:20000});await expect(page.locator('.operation-feedback')).toHaveCount(0,{timeout:8000});}
  else await expect(page.locator('.operation-feedback')).toHaveCount(0,{timeout:20000});
  await expect(page.locator('#upload-confirm,#download-confirm')).toHaveCount(0);assert.equal(await page.evaluate(()=>window.qaUnexpectedUpload),false);
  assert.equal(fixture.requestCounts.READ??0,reads,'Cancelled own gesture must not fetch contents');
  assert.ok(!fixture.requestPaths.slice(start).some(r=>['WRITE','REMOVE','RMDIR','RENAME','MKDIR'].includes(r.operation)));
  assert.equal(await fs.readFile(path.join(disk,'one.txt'),'utf8'),expectedOne);assert.equal(await fs.readFile(path.join(localDestination,'one.txt'),'utf8'),expectedOne);
  evidence.push({check:'Actual native own return or Escape, no upload/content fetch/source change',pass:true,name,input,cancelNoticeExpiryMs:cancel?5000:null});
 }

 if(process.env.NEARLY_SKIP_EXPLORER_QA==='1'){
  evidence.push({check:'Actual Windows Explorer virtual-file COPY',skipped:true,verified:false,reason:'Explicit isolated lifecycle-only qualification; desktop foreground coordination remains pending. No Explorer input or output claimed.'});return;
 }
 await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().unminimize());await page.bringToFront();
 const bounds=await page.evaluate(async()=>{const w=window.__TAURI__.window.getCurrentWindow();return{position:await w.outerPosition(),size:await w.outerSize()};});
 const common={pid,bounds,manualForeground:process.env.NEARLY_QA_MANUAL_FOREGROUND==='1',folder:receive,openState:path.join(root,'explorer-open-state.json')};let explorer;
 try {
  explorer=await ps(root,'open',common);evidence.push({check:'Owned separate Explorer window opened',...explorer});
  for(const [name,cancel]of [['one.txt',false],['folder',false],['cancel.txt',true]]){
   await go(page,'remote',source);await page.bringToFront();
   const row=page.locator('[data-list=remote] [data-name='+JSON.stringify(name)+'] [data-entry-icon]');await expect(row).toBeVisible();let prior,rectangle;
   await expect.poll(async()=>{const b=await row.boundingBox();const next=JSON.stringify(b);const stable=next===prior;prior=next;rectangle=b;return stable;}).toBe(true);
   const scale=await page.evaluate(()=>devicePixelRatio),start=fixture.requestPaths.length,reads=fixture.requestCounts.READ??0;
   const downSignal=path.join(root,name+'.down'),heldSignal=path.join(root,name+'.held'),releaseSignal=path.join(root,name+'.release');
   let inputError;const input=ps(root,'drag',{...common,...explorer,scale,css:{x:rectangle.x+rectangle.width/2,y:rectangle.y+rectangle.height/2},cancel,immediate:!cancel,downSignal,heldSignal,releaseSignal}).catch(error=>{inputError=error;return null;});
   let inputResult;
   try {
    await expect.poll(async()=>{if(inputError)throw inputError;return fs.stat(heldSignal).then(()=>true,()=>false);},{timeout:20000}).toBe(true);
    if(cancel){
    const needed=name==='folder'?[source+'/folder',source+'/folder/nested',source+'/folder/nested/日本語.txt',source+'/folder/empty']:[source+'/'+name];let stable=0,last='';
    await expect.poll(async()=>{if(inputError)throw inputError;const requests=fixture.requestPaths.slice(start),all=needed.every(p=>requests.some(r=>r.operation==='LSTAT'&&r.path===p));const current=JSON.stringify(fixture.requestCounts);stable=all&&current===last?stable+1:0;last=current;return stable>=2;},{timeout:20000,intervals:[100]}).toBe(true);
    assert.equal(fixture.requestCounts.READ??0,reads,'No content bytes fetched before Explorer accepts the drop');
    await fs.writeFile(releaseSignal,'owned-release');inputResult=await input;if(inputError)throw inputError;
    }else{inputResult=await input;if(inputError)throw inputError;assert.equal(inputResult.immediate,true);}
    await fs.writeFile(path.join(root,'post-drop-'+name+'.json'),JSON.stringify({input:inputResult,feedback:await page.locator('.operation-feedback').allTextContents(),requests:fixture.requestPaths.slice(start),readRequests:(fixture.requestCounts.READ??0)-reads},null,2));
    if(cancel){assert.equal(inputResult.escapeDownObserved,true);assert.equal(inputResult.escapeHoldMs,1200);await expect(page.locator('.operation-feedback').last()).toContainText(/Cancelled|キャンセル/,{timeout:20000});await assert.rejects(fs.stat(path.join(receive,name)),{code:'ENOENT'});}
    else {
     const target=name==='folder'?path.join(receive,'folder','nested','日本語.txt'):path.join(receive,name),expected=name==='folder'?'actual recursive virtual content':expectedOne;
     await expect.poll(()=>fs.readFile(target,'utf8').catch(()=>null),{timeout:30000}).toBe(expected);
     if(name==='folder')assert.equal((await fs.stat(path.join(receive,'folder','empty'))).isDirectory(),true);
     await expect(page.locator('.operation-feedback').last()).toContainText(/Completed|完了/,{timeout:30000});
    }
    const requests=fixture.requestPaths.slice(start);assert.ok(!requests.some(r=>['REMOVE','RMDIR','RENAME','WRITE','MKDIR'].includes(r.operation)),'External drag never mutates remote sources');assert.equal(await fs.readFile(path.join(disk,name==='folder'?'folder/nested/日本語.txt':name),'utf8'),name==='folder'?'actual recursive virtual content':name==='cancel.txt'?'cancel source retained':expectedOne);
    evidence.push({check:'Actual Windows Explorer virtual-file COPY or cancellation',pass:true,name,cancel,input:inputResult,readRequests:(fixture.requestCounts.READ??0)-reads,sourceRetained:true,remoteMutations:0,metadataOnlyBeforeRelease:cancel,immediateRelease:!cancel,waitedForMetadataBeforeRelease:cancel});
   } finally {await fs.writeFile(releaseSignal,'cleanup-release');await input;}
  }
  await screenshot(page,'native-actual-explorer-download-results');
 } finally {
  const owner=explorer??await fs.readFile(common.openState,'utf8').then(JSON.parse,()=>undefined);
  if(owner){const cleanup=await ps(root,'close',{...common,...owner});evidence.push({check:'Owned Explorer cleanup verified',...cleanup});}
 }
}
