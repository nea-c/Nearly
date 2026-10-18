import { sideBookmarkAction } from './bookmark-context';
import {test,expect,type Page,type Locator} from '@playwright/test';
async function boot(page:Page,language='en',count=0,group=false,long=false){
  await page.addInitScript(({language,count,group,long})=>{
    const p={id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const key=JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);
    window.bookmarkCalls=[];window.bookmarkFail=false;
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.bookmarkCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('task6-fixture')||'null')||{version:1,profiles:[p],history:{},language,
        localBookmarks:Array.from({length:count},(_,i)=>({id:'l'+i,name:'Local bookmark '+i,path:'C:\\folder'+i})),
        remoteBookmarks:Array.from({length:count},(_,i)=>({id:'r'+i,name:'Remote bookmark '+i,path:'/folder'+i,connectionKey:key})),
        folderBookmarks:Array.from({length:Math.max(count,1)},(_,i)=>({id:'p'+i,name:long?'<img src=x onerror=alert(1)>':'Pair '+i,local:long?'C:\\'+('long-segment\\'.repeat(90))+'end':'C:\\pair'+i,remote:long?'/'+('long-segment/'.repeat(90))+'end':'/pair'+i,connectionKey:key})),
        ...(group?{bookmarkTree:{version:1,nodes:[...Array.from({length:Math.max(count,1)},(_,i)=>({kind:'bookmark',id:'p'+i,bookmarkId:'p'+i,parentId:i===0?'hidden-group':null,connectionKey:key})),{kind:'group',id:'hidden-group',name:'Hidden group',parentId:null,connectionKey:key}]}}:{})};
      if(cmd==='save_settings'){if(window.bookmarkFail)throw Error('Fixture save refused');localStorage.setItem('task6-fixture',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:[]};if(cmd==='list_local'||cmd==='list_remote')return [];
    }}};
  },{language,count,group,long});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  for(const side of ['local','remote'])await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
}
test('registration Cancel closes only registration for mouse, keyboard and repeated Escape; history remains deliberate',async({page})=>{
  await boot(page);
  for(const how of ['mouse','keyboard','escape','mouse']){
    await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});await page.locator('[data-bookmark-action=register]').click();
    await expect(page.locator('#bookmark-form')).toBeVisible();
    if(how==='escape')await page.keyboard.press('Escape');
    else if(how==='keyboard'){await page.locator('#bookmark-cancel').focus();await page.keyboard.press('Enter');}
    else await page.locator('#bookmark-cancel').click();
    await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
    await expect(page.locator('.bookmark-bar')).toHaveAttribute('aria-expanded','false');
    await expect(page.locator('.bookmark-bar')).toBeFocused();
  }
  await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});await page.locator('[data-bookmark-action=history]').click();
  await expect(page.locator('.pair-history-list')).toBeVisible();
});
test('paired held registration save does not close another tab side dialog',async({page})=>{
  await boot(page);
  await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});await page.locator('[data-bookmark-action=register]').click();await page.locator('#bookmark-name').fill('Held pair');
  await page.evaluate(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==='save_settings')await new Promise(resolve=>window.releasePairSave=resolve);return invoke(cmd,args);};});
  await page.locator('#bookmark-save').click();await expect.poll(()=>page.evaluate(()=>typeof window.releasePairSave)).toBe('function');
  await page.keyboard.press('Control+t');await page.locator('#connect-form .primary').click();await sideBookmarkAction(page,'local','add');await page.locator('#side-bookmark-name').fill('Keep this dialog');
  await page.evaluate(()=>window.releasePairSave());await expect(page.locator('#side-bookmark-name')).toHaveValue('Keep this dialog');
});
test('hidden paired group uses original nodes, survives overflow to visible resize, and pointer drag preserves IDs',async({page})=>{
  await boot(page,'en',40,true);
  await page.locator('#bookmark-more').click();await page.locator('[data-bookmark-group=hidden-group]').click();
  await expect(page.locator('[data-bookmark-folder-menu=hidden-group] [data-bookmark-open=p0]')).toBeVisible();
  expect(await page.locator('[data-bookmark-group=hidden-group]').count()).toBe(1);
  await page.keyboard.press('Escape');await page.setViewportSize({width:4000,height:920});await expect(page.locator('#bookmark-more')).toBeHidden();
  await page.locator('[data-bookmark-group=hidden-group]').click();await expect(page.locator('[data-bookmark-folder-menu=hidden-group] [data-bookmark-open=p0]')).toBeVisible();
  await page.keyboard.press('Escape');await page.setViewportSize({width:900,height:920});await expect(page.locator('#bookmark-more')).toBeVisible();
  await page.locator('#bookmark-more').click();await page.locator('[data-bookmark-group=hidden-group]').click();
  await page.locator('[data-bookmark-open=p0]').dragTo(page.locator('.bookmark-bar [data-bookmark-open=p1]'));
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')).bookmarkTree.nodes.find(n=>n.id==='p0').parentId)).toBe(null);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')));
  expect(saved.folderBookmarks.map(b=>b.id)).toEqual(Array.from({length:40},(_,i)=>'p'+i));
  await expect(page.locator('#local-path')).toHaveValue('C:\\root');await expect(page.locator('#remote-path')).toHaveValue('/');
});
for(const language of ['ja','en'])test(`side rows and paired overflow resize and keyboard in ${language}`,async({page})=>{
  await boot(page,language,40);
  for(const selector of ['[data-side-bookmarks=local]','[data-side-bookmarks=remote]','.bookmark-bar']){
    const bar=page.locator(selector), more=bar.locator('[data-bookmark-overflow]');
    await expect(more).toBeVisible();expect(await more.locator('svg').count()).toBe(1);
    const height=(await bar.boundingBox())!.height;
    await more.focus();await page.keyboard.press('Enter');await expect(more).toHaveAttribute('aria-expanded','true');
    const first=await page.evaluate(()=>document.activeElement?.textContent);await page.keyboard.press('ArrowDown');expect(await page.evaluate(()=>document.activeElement?.textContent)).not.toBe(first);
    await page.keyboard.press('Escape');await expect(more).toBeFocused();
    await page.setViewportSize({width:900,height:920});expect((await bar.boundingBox())!.height).toBe(height);
    await page.setViewportSize({width:1600,height:920});expect((await bar.boundingBox())!.height).toBe(height);
  }
});
test('side navigation changes only its path and preserves pair history and sync roots; saves reload and reject failure',async({page})=>{
  await boot(page,'en',2);
  const snapshot=()=>page.evaluate(()=>({paths:['local','remote'].map(s=>(document.querySelector('#'+s+'-path') as HTMLInputElement).value),saved:JSON.parse(localStorage.getItem('task6-fixture')||'{}')}));
  const before=await snapshot();await page.locator('[data-side-bookmarks=local] [data-side-open=l0]').click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\folder0');await expect(page.locator('#remote-path')).toHaveValue(before.paths[1]);
  expect((await snapshot()).saved.folderPairHistory).toEqual(before.saved.folderPairHistory);
  expect(Object.values((await snapshot()).saved.browseLocations).some((value:any)=>value.local==='C:\\folder0')).toBe(true);
  expect((await snapshot()).saved.history).toEqual(before.saved.history);
  for(const side of ['local','remote']){await page.locator(`[data-refresh=${side}]`).click();await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');}
  await page.waitForTimeout(1300);expect((await snapshot()).saved.folderPairHistory).toEqual(before.saved.folderPairHistory);
  await page.locator('[data-side-bookmarks=remote] [data-side-open=r0]').click();await expect(page.locator('#remote-path')).toHaveValue('/folder0');
  await sideBookmarkAction(page,'local','add');await page.locator('#side-bookmark-name').fill('New local');await page.locator('#side-bookmark-path').fill('C:\\new');
  await page.evaluate(()=>window.bookmarkFail=true);await page.locator('#side-bookmark-save').click();await expect(page.locator('#side-bookmark-dialog .form-error')).not.toBeEmpty();
  expect((await snapshot()).saved.localBookmarks).toHaveLength(2);
  await page.evaluate(()=>window.bookmarkFail=false);await page.locator('#side-bookmark-save').click();await expect(page.locator('#side-bookmark-dialog')).toHaveCount(0);
  await page.reload();await page.locator('#connect-form .primary').click();await expect(page.locator('[data-side-open]').filter({hasText:'New local'})).toBeVisible();
  await page.locator('#prepare').click();await page.locator('#start-form .primary').click();
  await expect.poll(()=>page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='start_sync').length)).toBe(1);
  const started=await snapshot();expect(Object.entries(started.saved.history).some(([key,value])=>JSON.parse(key)[1]==='/folder0'&&value==='C:\\folder0')).toBe(true);
  expect(started.saved.folderPairHistory.some(pair=>pair.local==='C:\\folder0'&&pair.remote==='/folder0')).toBe(true);
});
test('side dialog edit, duplicate rejection and confirmed removal are acknowledged; Cancel and Escape close',async({page})=>{
  await boot(page,'en',2);
  const bar=page.locator('[data-side-bookmarks=local]');
  for(const how of ['mouse','keyboard','escape']){
    await sideBookmarkAction(page,'local','add');
    await expect(page.locator('#side-bookmark-dialog')).toBeVisible();
    if(how==='escape')await page.keyboard.press('Escape');
    else if(how==='keyboard'){await page.locator('#side-bookmark-cancel').focus();await page.keyboard.press('Enter');}
    else await page.locator('#side-bookmark-cancel').click();
    await expect(page.locator('#side-bookmark-dialog')).toHaveCount(0);
    await expect(bar).toBeFocused();
    await expect(bar).toHaveAttribute('aria-expanded','false');
  }
  await sideBookmarkAction(page,'local','edit','l0');
  await page.locator('#side-bookmark-name').fill('Renamed');await page.locator('#side-bookmark-path').fill('C:\\folder1');await page.locator('#side-bookmark-save').click();
  await expect(page.locator('#side-bookmark-dialog .form-error')).toContainText('Duplicate');
  await page.locator('#side-bookmark-path').fill('C:\\edited');await page.locator('#side-bookmark-save').click();await expect(bar.locator('[data-side-open=l0]')).toHaveText('Renamed');
  await sideBookmarkAction(page,'local','delete','l0');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')).localBookmarks.length)).toBe(2);
  await page.locator('#side-delete-confirm').click();await expect(bar.locator('[data-side-open=l0]')).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')).localBookmarks.length)).toBe(1);
});
test('side bars scope remote records by actual identity and share local records in another tab; stale saves cannot close replacement dialogs',async({page})=>{
  await boot(page,'en',2);
  await sideBookmarkAction(page,'local','add');await page.locator('#side-bookmark-name').fill('Held');await page.locator('#side-bookmark-path').fill('C:\\held');
  await page.evaluate(()=>{const invoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==='save_settings')await new Promise(resolve=>window.releaseBookmarkSave=resolve);return invoke(cmd,args);};});
  await page.locator('#side-bookmark-save').click();await expect.poll(()=>page.evaluate(()=>typeof window.releaseBookmarkSave)).toBe('function');
  await page.keyboard.press('Control+t');await page.locator('#connect-form .primary').click();
  await expect(page.locator('#side-bookmark-dialog')).toHaveCount(0);
  await sideBookmarkAction(page,'remote','add');await page.locator('#side-bookmark-name').fill('Replacement');
  await page.evaluate(()=>window.releaseBookmarkSave());await expect(page.locator('#side-bookmark-name')).toHaveValue('Replacement');
  await page.keyboard.press('Escape');await page.locator('[data-refresh=local]').click();await expect(page.locator('[data-side-open]').filter({hasText:'Held'})).toBeVisible();
  // Rebind the existing rendered bars with a disconnected Workspace. This exercises the local contract without introducing a new screen.
  const result=await page.evaluate(async()=>{
    const {Store}=await import('/src/core.ts');const {bindSideBookmarks,sideBookmarkBar}=await import('/src/side-bookmarks-ui.ts');
    const data=JSON.parse(localStorage.getItem('task6-fixture'));const store=new Store(data);const w=store.createWorkspace('a','C:\\root');w.localBrowse='C:\\root';
    const remote=sideBookmarkBar(store,{...w,connection:{...store.profiles[0],host:'other.invalid'}},'remote');
    const holder=document.querySelector('[data-side-bookmarks=local]');holder.outerHTML=sideBookmarkBar(store,w,'local');window.disconnectedSideCalls=[];
    bindSideBookmarks(store,w,'local',()=>true,async path=>{window.disconnectedSideCalls.push(['navigate',path]);return true;},async change=>{window.disconnectedSideCalls.push(['save']);return change(store);},()=>{},()=>{});
    return {remote,localCount:store.localBookmarks.length};
  });
  expect(result.remote).not.toContain('data-side-open=');expect(result.localCount).toBe(3);
  await page.locator('[data-side-open=l0]').click();expect(await page.evaluate(()=>window.disconnectedSideCalls)).toEqual([['navigate','C:\\folder0']]);
  await sideBookmarkAction(page,'local','add');await page.locator('#side-bookmark-cancel').click();
  expect(await page.evaluate(()=>window.disconnectedSideCalls)).toEqual([['navigate','C:\\folder0']]);
});
test('paired tooltip uses vertical escaped paths on hover and focus, and sync cards put source first',async({page})=>{
  await boot(page);
  const item=page.locator('[data-bookmark-open=p0]');
  await item.hover();await expect(page.locator('[role=tooltip] code')).toHaveText(['C:\\pair0','/pair0']);
  await page.keyboard.press('Escape');await expect(page.locator('#bookmark-description')).toHaveCount(0);
  await page.locator('#local-path').focus();await item.focus();await expect(item).toHaveAttribute('aria-describedby','bookmark-description');await expect(item).not.toHaveAttribute('title');
  await page.locator('#prepare').click();
  const cards=page.locator('#start-form .sync-path-summary');
  await expect(cards.first().locator('[data-sync-source]')).toBeVisible();
  await expect(cards.nth(1).locator('[data-sync-destination]')).toBeVisible();
  await page.locator('#start-form .primary').click();await expect.poll(()=>page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='start_sync').length)).toBe(1);
  expect(await page.evaluate(()=>window.bookmarkCalls.find(c=>c.cmd==='start_sync').args)).toMatchObject({profile:{id:'a',host:'fixture.invalid'},local:'C:\\root',remote:'/',passphrase:'',deleteRemoved:false,recursive:true});
});
test('long paired tooltip wraps escaped user data with no layout shift in each theme',async({page})=>{
  await page.setViewportSize({width:800,height:650});await boot(page,'en',0,false,true);
  for(const theme of ['light','dark','midnight','forest','mint']){
    await page.locator('#settings-toggle').click();await page.locator('#theme-select').selectOption(theme);await page.locator('#settings-close').click();
    const bar=page.locator('.bookmark-bar'),item=page.locator('[data-bookmark-open=p0]'),before=await bar.boundingBox();
    const colors=await page.evaluate(()=>({paired:getComputedStyle(document.querySelector('.bookmark-bar')).backgroundColor,side:getComputedStyle(document.querySelector('.side-bookmark-bar')).backgroundColor}));expect(colors.side).toBe(colors.paired);
    await item.hover();const tooltip=page.locator('#bookmark-description');await expect(tooltip).toBeVisible();await expect(tooltip.locator('img')).toHaveCount(0);await expect(tooltip.locator('strong')).toHaveText('<img src=x onerror=alert(1)>');
    await expect(tooltip).toBeInViewport({ratio:1});expect(await bar.boundingBox()).toEqual(before);
    expect(await tooltip.locator('code').evaluateAll(es=>es.every(e=>e.scrollWidth<=e.clientWidth+1))).toBe(true);
    await page.screenshot({path:`test-results/task6-tooltip-${theme}.png`});await tooltip.hover();await page.mouse.wheel(0,450);await expect.poll(()=>tooltip.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
    await page.mouse.move(700,600);await expect(tooltip).toHaveCount(0);
    await item.focus();await expect(tooltip).toBeVisible();await page.keyboard.press('PageDown');await expect.poll(()=>tooltip.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);await page.locator('#local-path').focus();await expect(tooltip).toHaveCount(0);
  }
});

// Exercise the real shared ActionHost completion refresh together with side-only
// navigation. Only native filesystem calls are modeled, like the surrounding UI.
async function historyOperationFixture(page:Page){
  await boot(page,'en',2);
  await page.evaluate(()=>{
    const invoke=window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke=async(cmd,args)=>{
      const result=await invoke(cmd,args);
      if(cmd==='list_local')return [{name:'one.txt',dir:false,size:4}];
      if(cmd==='run_file_operation')return {completed:1,message:'done'};
      if(cmd==='run_local_archive')return {action:args.request.action,finalPath:args.request.destination,entries:1,bytes:4};
      return result;
    };
  });
}
async function historySnapshot(page:Page){
  return page.evaluate(()=>{const data=JSON.parse(localStorage.getItem('task6-fixture')||'{}');return {folderPairHistory:data.folderPairHistory??[],history:data.history??{}};});
}
async function completeHistoryOperation(page:Page,action:'createfile'|'duplicate'|'delete'|'compress'){
  const row=page.locator('[data-list=local] [data-name="one.txt"]');await expect(row).toBeVisible();await row.click({button:'right'});
  await page.locator(`[data-file-action=${action}]`).click();
  if(action==='createfile'){await page.locator('[name=create-name]').fill('created.txt');await page.locator('#create-entry-confirm').click();}
  else if(action==='compress')await page.locator('#archive-confirm').click();
  else {if(action==='duplicate')await page.locator('[name=operation-destination]').fill('copy.txt');await page.locator('#file-operation-confirm').click();}
  await expect(page.locator('[data-feedback-close]')).toBeEnabled();
  await page.locator('[data-feedback-close]').click();
}
async function refreshHistoryPane(page:Page,side:'local'|'remote'){
  const before=await page.evaluate(side=>window.bookmarkCalls.filter(c=>c.cmd==='list_'+side).length,side);
  await page.locator(`[data-refresh=${side}]`).click();
  await expect.poll(()=>page.evaluate(side=>window.bookmarkCalls.filter(c=>c.cmd==='list_'+side).length,side)).toBeGreaterThan(before);
  await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
}
for(const action of ['createfile','duplicate','delete','compress'] as const)test(`review completion ${action} preserves side-bookmark history suppression through both Refresh controls`,async({page})=>{
  await historyOperationFixture(page);
  const before=await historySnapshot(page);
  await page.locator('[data-side-bookmarks=local] [data-side-open=l0]').click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\folder0');await expect(page.locator('#remote-path')).toHaveValue('/');
  await completeHistoryOperation(page,action);
  await refreshHistoryPane(page,'local');await refreshHistoryPane(page,'remote');
  expect(await historySnapshot(page)).toEqual(before);
  await expect(page.locator('#local-path')).toHaveValue('C:\\folder0');await expect(page.locator('#remote-path')).toHaveValue('/');
  const dispatched=await page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='run_file_operation'||c.cmd==='run_local_archive').at(-1));
  expect(dispatched.cmd).toBe(action==='compress'?'run_local_archive':'run_file_operation');
  expect(JSON.stringify(dispatched.args.request)).toContain('C:\\\\folder0');
});
test('review completion keeps ordinary view pair history enabled',async({page})=>{
  await historyOperationFixture(page);await refreshHistoryPane(page,'local');
  await completeHistoryOperation(page,'createfile');
  const before=(await historySnapshot(page)).folderPairHistory.find(p=>p.local==='C:\\root'&&p.remote==='/');expect(before).toBeTruthy();
  await refreshHistoryPane(page,'remote');
  await expect.poll(async()=>(await historySnapshot(page)).folderPairHistory.find(p=>p.local==='C:\\root'&&p.remote==='/')?.openedAt).toBeGreaterThan(before.openedAt);
});
test('review completion preserves deliberate navigation, Back and paired-open history',async({page})=>{
  await historyOperationFixture(page);await page.locator('[data-side-bookmarks=local] [data-side-open=l0]').click();await completeHistoryOperation(page,'duplicate');
  await page.locator('#local-path').fill('C:\\deliberate');await page.locator('#local-path').press('Enter');await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  const pair=(await historySnapshot(page)).folderPairHistory.find(p=>p.local==='C:\\deliberate'&&p.remote==='/');expect(pair).toBeTruthy();
  await page.locator('[data-side-bookmarks=local] [data-side-open=l1]').click();await expect(page.locator('#local-path')).toHaveValue('C:\\folder1');
  await page.locator('[data-back=local]').click();await expect(page.locator('#local-path')).toHaveValue('C:\\deliberate');
  await expect.poll(async()=>(await historySnapshot(page)).folderPairHistory.find(p=>p.local==='C:\\deliberate'&&p.remote==='/')?.openedAt).toBeGreaterThan(pair.openedAt);
  await page.locator('[data-bookmark-open=p0]').click();await expect(page.locator('#local-path')).toHaveValue('C:\\pair0');await expect(page.locator('#remote-path')).toHaveValue('/pair0');
  expect((await historySnapshot(page)).folderPairHistory.some(p=>p.local==='C:\\pair0'&&p.remote==='/pair0')).toBe(true);
});
test('review completion preserves explicit Start mapping after side bookmark',async({page})=>{
  await historyOperationFixture(page);await page.locator('[data-side-bookmarks=local] [data-side-open=l0]').click();await completeHistoryOperation(page,'delete');
  await page.locator('#prepare').click();await page.locator('#start-form .primary').click();
  await expect.poll(()=>page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='start_sync').length)).toBe(1);
  const saved=await historySnapshot(page);expect(saved.folderPairHistory.some(p=>p.local==='C:\\folder0'&&p.remote==='/')).toBe(true);
  expect(Object.entries(saved.history).some(([key,value])=>JSON.parse(key)[1]==='/'&&value==='C:\\folder0')).toBe(true);
});

async function pointerStart(page:Page,source:Locator){
  const box=await source.boundingBox();expect(box).not.toBeNull();
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();
  await page.mouse.move(box!.x+box!.width/2+9,box!.y+box!.height/2,{steps:3});
}
for(const targetKind of ['group','bookmark'])for(const edge of ['before','after'])test(`review overflow ${targetKind} ${edge} uses vertical pointer ordering with original IDs`,async({page})=>{
  await page.setViewportSize({width:800,height:650});await boot(page,'en',40,true);
  await page.locator('#bookmark-more').click();const menu=page.locator('#bookmark-overflow-menu');
  await menu.evaluate(e=>e.scrollTop=e.scrollHeight);
  const target=menu.locator(targetKind==='group'?'[data-bookmark-group=hidden-group]':'[data-bookmark-open=p39]');
  await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();expect(box).not.toBeNull();
  await pointerStart(page,page.locator('.bookmark-bar [data-bookmark-open=p1]'));
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height*(edge==='before'?.12:.88),{steps:12});
  await expect(target).toHaveAttribute('data-bookmark-drop',edge);await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')).bookmarkTree.nodes.find(n=>n.id==='p1').parentId)).toBe(null);
  const snapshot=await page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture'))),roots=snapshot.bookmarkTree.nodes.filter(n=>n.parentId===null).map(n=>n.id),targetId=targetKind==='group'?'hidden-group':'p39';
  expect(roots.indexOf('p1')).toBe(roots.indexOf(targetId)+(edge==='before'?-1:1));
  expect(snapshot.folderBookmarks.map(b=>b.id)).toEqual(Array.from({length:40},(_,i)=>'p'+i));
  await expect(page.locator('#local-path')).toHaveValue('C:\\root');await expect(page.locator('#remote-path')).toHaveValue('/');
});
test('review overflow blank padding drops a nested child at root and never invents a group ID',async({page})=>{
  await page.setViewportSize({width:800,height:650});await boot(page,'en',40,true);await page.locator('#bookmark-more').click();
  const menu=page.locator('#bookmark-overflow-menu');await menu.evaluate(e=>e.scrollTop=e.scrollHeight);
  await menu.locator('[data-bookmark-group=hidden-group]').click();const child=page.locator('[data-bookmark-folder-menu=hidden-group] [data-bookmark-open=p0]');await expect(child).toBeVisible();
  const box=await menu.boundingBox();await pointerStart(page,child);
  await page.mouse.move(box!.x+2,box!.y+box!.height/2,{steps:12});await expect(menu).toHaveAttribute('data-bookmark-drop','inside');await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')).bookmarkTree.nodes.find(n=>n.id==='p0').parentId)).toBe(null);
  const nodes=await page.evaluate(()=>JSON.parse(localStorage.getItem('task6-fixture')).bookmarkTree.nodes);
  expect(nodes.every(n=>n.parentId===null||n.parentId==='hidden-group')).toBe(true);expect(nodes.filter(n=>n.id==='p0')).toHaveLength(1);
});
test('review long overflow autoscrolls during a real held pointer and reaches lower rows',async({page})=>{
  await page.setViewportSize({width:800,height:650});await boot(page,'en',80,true);await page.locator('#bookmark-more').click();
  const menu=page.locator('#bookmark-overflow-menu'),before=await menu.evaluate(e=>({top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight}));expect(before.height).toBeGreaterThan(before.client);
  const source=menu.locator('[data-bookmark-tree-node]').first(),sourceId=await source.getAttribute('data-bookmark-tree-node');await pointerStart(page,source);
  const box=await menu.boundingBox();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height-8,{steps:12});
  await expect.poll(()=>menu.evaluate(e=>e.scrollTop)).toBeGreaterThan(before.top+150);
  const lower=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('[data-bookmark-tree-node]')?.getAttribute('data-bookmark-tree-node'),{x:box!.x+box!.width/2,y:box!.y+box!.height-8});expect(lower).toBeTruthy();expect(lower).not.toBe(sourceId);
  await page.keyboard.press('Escape');await page.mouse.up();
  expect(await page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='start_sync').length)).toBe(0);await expect(page.locator('#local-path')).toHaveValue('C:\\root');
});
for(const previous of ['fresh','root-context'])test(`review visible group Escape restores its opener after ${previous} menu state`,async({page})=>{
  await boot(page,'en',2,true);if(previous==='root-context'){await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});await page.keyboard.press('Escape');}
  const group=page.locator('[data-bookmark-group=hidden-group]');await group.focus();await page.keyboard.press('ArrowDown');await expect(page.locator('[data-bookmark-folder-menu=hidden-group] [data-bookmark-open=p0]')).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);await expect(group).toBeFocused();
});
test('review visible entry context Escape restores the entry instead of a previous root-context opener',async({page})=>{
  await boot(page,'en',2,true);await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});await page.keyboard.press('Escape');
  const entry=page.locator('.bookmark-bar [data-bookmark-open=p1]');await entry.focus();await entry.press('Shift+F10');await expect(page.locator('#bookmark-tree-context')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('#bookmark-tree-context')).toHaveCount(0);await expect(entry).toBeFocused();
});
test('review nested visible-group Escape restores top opener and does not refocus a replaced tab',async({page})=>{
  await boot(page,'en',2,true);await page.evaluate(()=>{const data=JSON.parse(localStorage.getItem('task6-fixture')),group=data.bookmarkTree.nodes.find(n=>n.id==='hidden-group');data.bookmarkTree.nodes.push({...group,id:'nested',name:'Nested',parentId:group.id});data.bookmarkTree.nodes.find(n=>n.id==='p0').parentId='nested';localStorage.setItem('task6-fixture',JSON.stringify(data));});
  await page.reload();await page.locator('#connect-form .primary').click();const group=page.locator('[data-bookmark-group=hidden-group]');await group.focus();await page.keyboard.press('ArrowDown');await expect(page.locator('[data-bookmark-group=nested]')).toBeFocused();await page.keyboard.press('ArrowRight');await expect(page.locator('[data-bookmark-open=p0]')).toBeFocused();
  await page.keyboard.press('Escape');await expect(group).toBeFocused();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Control+t');await expect(page.locator('#connect-form')).toBeVisible();const input=page.locator('#connect-form input').first();await input.focus();await page.keyboard.press('Escape');await expect(input).toBeFocused();await expect(page.locator('.bookmark-menu-stack')).toHaveCount(0);
});
test('review nested overflow Escape and nested-entry context restore the real overflow opener',async({page})=>{
  await boot(page,'en',40,true);const more=page.locator('#bookmark-more');await more.click();const menu=page.locator('#bookmark-overflow-menu');await menu.evaluate(e=>e.scrollTop=e.scrollHeight);
  const group=menu.locator('[data-bookmark-group=hidden-group]');await group.focus();await page.keyboard.press('ArrowRight');await expect(page.locator('[data-bookmark-open=p0]')).toBeFocused();await page.keyboard.press('Escape');await expect(more).toBeFocused();
  await more.click();await menu.evaluate(e=>e.scrollTop=e.scrollHeight);await group.focus();await page.keyboard.press('ArrowRight');await page.locator('[data-bookmark-open=p0]').press('Shift+F10');await expect(page.locator('#bookmark-tree-context')).toBeVisible();await page.keyboard.press('Escape');await expect(more).toBeFocused();
});

