import { expandTreePath } from './tree-expansion';
import {test,expect} from '@playwright/test';
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await info.attach('refresh-fixture-failure',{body:JSON.stringify(await page.evaluate(()=>({boots:sessionStorage.getItem('refresh-boot'),watch:window.refreshFixture?.watch,calls:window.refreshFixture?.calls.slice(-60),connected:!document.querySelector('#connect-form')})).catch(()=>null),null,2),contentType:'application/json'});});
async function boot(page){
 await page.addInitScript(()=>{
  sessionStorage.setItem('refresh-boot',String(Number(sessionStorage.getItem('refresh-boot')??0)+1));
  const entries=()=>[{name:'folder',dir:true,size:0},...Array.from({length:70},(_,i)=>({name:`file${String(i).padStart(2,'0')}.txt`,dir:false,size:i+1}))];
  const profile={id:'refresh',name:'Refresh fixture',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',keyFile:'generated.ppk',hostKey:'SHA256:fixture'};
  window.refreshFixture={calls:[],local:{'C:\\root':entries(),'C:\\root\\folder':[{name:'new-path.txt',dir:false,size:1}],'C:\\':[{name:'root',dir:true,size:0}]},remote:{'/':entries(),'/folder':[]},watch:undefined,holdLocal:false,releaseLocal:undefined,journal:{revision:0,records:[],truncated:false},sent:0};
  window.__TAURI__={core:{invoke:async(cmd,args={})=>{
   const f=window.refreshFixture;f.calls.push({cmd,args});
   if(cmd === 'request_text_editor_origin_close') return true;
          if(cmd==='load_settings')return{version:1,settingsRevision:0,language:'en',profiles:[profile],history:{}};
   if(cmd==='save_settings')return{...args.data,settingsRevision:(args.data.settingsRevision??0)+1};
   if(cmd==='default_folder')return'C:\\root';
   if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
   if(cmd==='connect_session')return{path:'/',entries:structuredClone(f.remote['/'])};
   if(cmd==='list_local'){
    const result=structuredClone(f.local[args.path]??[]);
    if(f.holdLocal&&args.path==='C:\\root'){f.holdLocal=false;await new Promise(resolve=>f.releaseLocal=resolve);}
    return result;
   }
   if(cmd==='list_remote'){if(f.missingRemotePaths?.includes(args.path))throw 'Generated directory not found';return structuredClone(f.remote[args.path]??[]);}
   if(cmd==='watch_local_directory'){f.watch={token:args.token,revision:0,path:args.path};return{...f.watch};}
   if(cmd==='local_watch_status')return f.watch?{...f.watch}:undefined;
   if(cmd==='unwatch_local_directory'){if(f.watch?.token===args.token){f.watch=undefined;return true;}return false;}
   if(cmd==='sync_status')return{status:'running',pending:f.partialFailure?1:0,sent:f.sent,speed:0,latency:0,errorCount:f.partialFailure?1:0,logs:f.partialFailure?['generated separate transfer failed']:[],remoteChanges:structuredClone(f.journal)};
   if(cmd==='run_file_operation'||cmd==='run_local_archive')throw Error('Unexpected mutating command in automatic refresh test');
   // prepare/start/stop/disconnect are fixture acknowledgements only.
   return undefined;
  }}};
 });
 await page.goto('/');await page.locator('#connect-form .primary').click();
 await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
 await expect(page.locator('[data-list=local] [data-name="file00.txt"]')).toBeVisible();
}
const row=(page,name,side='local')=>page.locator(`[data-list=${side}] [data-name="${name}"]`);
const treeToggle=(page,path)=>page.locator(`[data-tree-toggle=local][data-tree-path=${JSON.stringify(path)}]`);
const countReads=(page,side='local',path='C:\\root')=>page.evaluate(({side,path})=>window.refreshFixture.calls.filter(c=>c.cmd===`list_${side}`&&c.args.path===path).length,{side,path});
async function bump(page,edit){await page.evaluate(edit);await page.evaluate(()=>{if(!window.refreshFixture.watch)throw Error('No live local watch');window.refreshFixture.watch.revision++;});}

test('external local changes refresh create edit delete rename without explicit refresh',async({page})=>{
 await boot(page);
 await expect.poll(()=>page.evaluate(()=>!!window.refreshFixture.watch)).toBe(true);
 await bump(page,()=>window.refreshFixture.local['C:\\root'].push({name:'external.txt',dir:false,size:123}));
 await expect(row(page,'external.txt')).toBeAttached();
 const beforeEdit=await row(page,'external.txt').innerText();
 await bump(page,()=>window.refreshFixture.local['C:\\root'].find(e=>e.name==='external.txt').size=98765);
 await expect(row(page,'external.txt')).not.toHaveText(beforeEdit);
 await bump(page,()=>window.refreshFixture.local['C:\\root'].find(e=>e.name==='external.txt').name='renamed.txt');
 await expect(row(page,'renamed.txt')).toBeAttached();await expect(row(page,'external.txt')).toHaveCount(0);
 await bump(page,()=>window.refreshFixture.local['C:\\root']=window.refreshFixture.local['C:\\root'].filter(e=>e.name!=='renamed.txt'));
 await expect(row(page,'renamed.txt')).toHaveCount(0);
 expect(await page.evaluate(()=>window.refreshFixture.calls.some(c=>['run_file_operation','run_local_archive'].includes(c.cmd)))).toBe(false);
});

test('quiet watcher polling does no scans and a burst preserves DOM selection focus scroll and tree expansion',async({page})=>{
 await boot(page);await expect.poll(()=>page.evaluate(()=>!!window.refreshFixture.watch)).toBe(true);
 await page.waitForTimeout(1200);const initial=await countReads(page);await page.waitForTimeout(1800);expect(await countReads(page)).toBe(initial);
 await expandTreePath(page,'local','C:\\root');
  await treeToggle(page,'C:\\root\\folder').click();
 await row(page,'file30.txt').scrollIntoViewIfNeeded();await row(page,'file30.txt').click();await row(page,'file30.txt').focus();
 const captured=await page.evaluate(()=>{
  window.refreshNodes={app:document.querySelector('#app'),pane:document.querySelector('[data-pane=local]'),list:document.querySelector('[data-list=local]'),path:document.querySelector('#local-path')};
  return{top:window.refreshNodes.list.scrollTop,expanded:[...document.querySelectorAll('[data-tree-toggle=local]')].find(n=>n.dataset.treePath==='C:\\root\\folder').closest('[role=treeitem]').getAttribute('aria-expanded')};
 });
 const before=await countReads(page);
 await bump(page,()=>{for(let i=0;i<35;i++)window.refreshFixture.local['C:\\root'].push({name:`burst${i}.txt`,dir:false,size:i});window.refreshFixture.watch.revision+=34;});
 await expect(row(page,'burst34.txt')).toBeAttached();
 expect((await countReads(page))-before).toBeLessThanOrEqual(2);
 expect(await page.evaluate(()=>({app:window.refreshNodes.app===document.querySelector('#app'),pane:window.refreshNodes.pane===document.querySelector('[data-pane=local]'),list:window.refreshNodes.list===document.querySelector('[data-list=local]'),path:window.refreshNodes.path===document.querySelector('#local-path')}))).toEqual({app:true,pane:true,list:true,path:true});
 await expect(row(page,'file30.txt')).toHaveAttribute('aria-selected','true');await expect(row(page,'file30.txt')).toBeFocused();
 expect(await page.locator('[data-list=local]').evaluate(e=>e.scrollTop)).toBe(captured.top);
 await expect(treeToggle(page,'C:\\root\\folder').locator('xpath=ancestor::*[@role="treeitem"][1]')).toHaveAttribute('aria-expanded',captured.expanded);
});

test('delayed automatic listing cannot overwrite a newer navigation and watcher ownership moves with tabs',async({page})=>{
 await boot(page);await expect.poll(()=>page.evaluate(()=>!!window.refreshFixture.watch)).toBe(true);
 await bump(page,()=>{window.refreshFixture.holdLocal=true;window.refreshFixture.local['C:\\root'].push({name:'stale-result.txt',dir:false,size:1});});
 await expect.poll(()=>page.evaluate(()=>typeof window.refreshFixture.releaseLocal)).toBe('function');
 await page.locator('#local-path').fill('C:\\root\\folder');await page.locator('#local-path').press('Enter');
 await expect(row(page,'new-path.txt')).toBeAttached();await page.evaluate(()=>window.refreshFixture.releaseLocal());
 await page.waitForTimeout(600);await expect(page.locator('#local-path')).toHaveValue('C:\\root\\folder');await expect(row(page,'stale-result.txt')).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>window.refreshFixture.watch?.path)).toBe('C:\\root\\folder');
 const oldToken=await page.evaluate(()=>window.refreshFixture.watch.token);
 await page.locator('#add-tab').click();
 await expect.poll(()=>page.evaluate(token=>window.refreshFixture.calls.some(c=>c.cmd==='unwatch_local_directory'&&c.args.token===token),oldToken)).toBe(true);
 await expect(page.locator('#connect-form')).toBeVisible();await page.locator('#connect-form .primary').click();
 await expect.poll(()=>page.evaluate(()=>window.refreshFixture.watch?.token??0)).toBeGreaterThan(oldToken);
 const nextToken=await page.evaluate(()=>window.refreshFixture.watch.token);
 await page.locator('[data-close]').last().click();
 await expect.poll(()=>page.evaluate(token=>window.refreshFixture.calls.some(c=>c.cmd==='unwatch_local_directory'&&c.args.token===token),nextToken)).toBe(true);
 expect(await page.evaluate(()=>window.refreshFixture.calls.filter(c=>c.cmd==='disconnect_session').length)).toBeGreaterThan(0);
});

async function startFixtureSync(page){
 await page.locator('#prepare').click();await page.locator('#start-form .primary').click();
 await expect(page.locator('#prepare')).toHaveText('Stop sync');
 await expect.poll(()=>page.evaluate(()=>window.refreshFixture.calls.filter(c=>c.cmd==='sync_status').length)).toBeGreaterThan(0);
}
test('only new committed remote parent records refresh including deletion and created ancestor, even after partial failure',async({page})=>{
 await boot(page);await startFixtureSync(page);
 const base=await countReads(page,'remote','/');
 await page.evaluate(()=>{window.refreshFixture.sent=2;window.refreshFixture.remote['/'].push({name:'not-committed.txt',dir:false,size:1});});
 await page.waitForTimeout(1600);expect(await countReads(page,'remote','/')).toBe(base);
 await page.evaluate(()=>{window.refreshFixture.remote['/']=window.refreshFixture.remote['/'].filter(e=>e.name!=='not-committed.txt');window.refreshFixture.remote['/'].push({name:'committed.txt',dir:false,size:3});window.refreshFixture.journal={revision:1,records:[{revision:1,path:'/'}],truncated:false};});
 await expect(row(page,'committed.txt','remote')).toBeAttached();
 const first=await countReads(page,'remote','/');await page.waitForTimeout(1700);expect(await countReads(page,'remote','/')).toBe(first);
 await page.evaluate(()=>{window.refreshFixture.remote['/']=window.refreshFixture.remote['/'].filter(e=>e.name!=='committed.txt');window.refreshFixture.journal={revision:2,records:[{revision:1,path:'/'},{revision:2,path:'/'}],truncated:false};});
 await expect(row(page,'committed.txt','remote')).toHaveCount(0);
 await page.evaluate(()=>{window.refreshFixture.partialFailure=true;window.refreshFixture.remote['/'].push({name:'created-parent',dir:true,size:0});window.refreshFixture.journal={revision:4,records:[{revision:3,path:'/'},{revision:4,path:'/created-parent'}],truncated:false};});
 await expect(row(page,'created-parent','remote')).toBeAttached();
 const prior=await countReads(page,'remote','/');
 await page.evaluate(()=>window.refreshFixture.journal={revision:5,records:[{revision:5,path:'/folder'}],truncated:false});
 await page.waitForTimeout(1600);expect(await countReads(page,'remote','/')).toBe(prior);
});

test('committed parent updates an inactive same-connection workspace without rereading another parent',async({page})=>{
 await boot(page);await startFixtureSync(page);
 await page.locator('#add-tab').click();await page.locator('#connect-form .primary').click();
 await page.locator('#remote-path').fill('/folder');await page.locator('#remote-path').press('Enter');
 await expect(page.locator('#remote-path')).toHaveValue('/folder');await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
 await page.locator('[role=tab]').first().click();await expect(page.locator('#remote-path')).toHaveValue('/');
 const folderBefore=await countReads(page,'remote','/folder'),rootBefore=await countReads(page,'remote','/');
 await page.evaluate(()=>{window.refreshFixture.remote['/folder']=[{name:'background-commit.txt',dir:false,size:5}];window.refreshFixture.journal={revision:1,records:[{revision:1,path:'/folder'}],truncated:false};});
 await expect.poll(()=>countReads(page,'remote','/folder')).toBeGreaterThan(folderBefore);
 expect(await countReads(page,'remote','/')).toBe(rootBefore);
 await page.locator('[role=tab]').last().click();await expect(row(page,'background-commit.txt','remote')).toBeAttached();
});

test('watcher failure reports once without scans and pagehide releases its exact token',async({page})=>{
 await boot(page);await expect.poll(()=>page.evaluate(()=>!!window.refreshFixture.watch)).toBe(true);await page.waitForTimeout(1200);
 const before=await countReads(page),token=await page.evaluate(()=>window.refreshFixture.watch.token);
 await page.evaluate(()=>window.refreshFixture.watch.error='Generated watcher lost');
 await expect(page.locator('main')).toContainText('Generated watcher lost');
 await page.waitForTimeout(1500);expect(await countReads(page)).toBe(before);
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
 await expect.poll(()=>page.evaluate(token=>window.refreshFixture.calls.filter(c=>c.cmd==='unwatch_local_directory'&&c.args.token===token).length,token)).toBe(1);
});

test('a committed directory parent refreshes an expanded remote tree without navigating the list',async({page})=>{
 await boot(page);await startFixtureSync(page);
 await expandTreePath(page,'remote','/');
  await page.locator('[data-tree-toggle=remote][data-tree-path="/folder"]').click();
 await expect(page.locator('[data-tree-select=remote][data-tree-path="/folder"]')).toBeAttached();
 await page.waitForTimeout(250);
 await page.evaluate(()=>{window.refreshTreeRoot=document.querySelector('[data-pane=remote]');window.refreshTreeList=document.querySelector('[data-list=remote]');window.refreshFixture.remote['/folder']=[{name:'new-child',dir:true,size:0}];window.refreshFixture.journal={revision:1,records:[{revision:1,path:'/folder'}],truncated:false};});
 await expect(page.locator('[data-tree-select=remote][data-tree-path="/folder/new-child"]')).toBeAttached();
 await expect(page.locator('#remote-path')).toHaveValue('/');
 expect(await page.evaluate(()=>window.refreshTreeRoot===document.querySelector('[data-pane=remote]')&&window.refreshTreeList===document.querySelector('[data-list=remote]'))).toBe(true);
});

test('automatic patch restores the exact focused parent row or tree control kind',async({page})=>{
 await boot(page);await expect.poll(()=>page.evaluate(()=>!!window.refreshFixture.watch)).toBe(true);await page.waitForTimeout(1000);
 await expandTreePath(page,'local','C:\\root');
  const controls=[page.locator('[data-parent-row=local]'),treeToggle(page,'C:\\root\\folder'),page.locator(`[data-tree-select=local][data-tree-path=${JSON.stringify('C:\\root\\folder')}]`)];
 for(let index=0;index<controls.length;index++){
  await controls[index].focus();
  await page.evaluate(index=>{window.refreshFixture.local['C:\\root'].push({name:`focus-refresh-${index}.txt`,dir:false,size:1});window.refreshFixture.watch.revision++;},index);
  await expect(row(page,`focus-refresh-${index}.txt`)).toBeAttached();await expect(controls[index]).toBeFocused();
 }
});

test('successful ancestor RMDIR rereads a browsed descendant and reports missing rather than confirmed empty',async({page})=>{
 await boot(page);await startFixtureSync(page);
 await page.evaluate(()=>window.refreshFixture.remote['/folder/inside']=[]);
 await page.locator('#remote-path').fill('/folder/inside');await page.locator('#remote-path').press('Enter');
 await expect(page.locator('#remote-path')).toHaveValue('/folder/inside');await expect(page.locator('[data-pane=remote] .empty-row')).toBeVisible();
 const before=await countReads(page,'remote','/folder/inside');
 await page.evaluate(()=>{window.refreshFixture.missingRemotePaths=['/folder/inside'];window.refreshFixture.journal={revision:1,records:[{revision:1,path:'/',removedDirectory:'/folder'}],truncated:false};});
 await expect.poll(()=>countReads(page,'remote','/folder/inside')).toBeGreaterThan(before);
 await expect(page.locator('main')).toContainText('Generated directory not found');
 await expect(page.locator('#remote-path')).toHaveValue('/folder/inside');await expect(page.locator('[data-pane=remote] .empty-row')).toHaveCount(0);
 await page.locator('[data-back=remote]').click();await expect(page.locator('#remote-path')).toHaveValue('/');
});
