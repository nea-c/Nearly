import {test,expect,type Page,type Locator} from '@playwright/test';

async function boot(page:Page,language='en',count=2) {
  await page.addInitScript(({language,count})=>{
    const profile={id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const other={...profile,id:'b',name:'Other',host:'other.invalid'};
    const key=(p:any)=>JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);
    const dirs=Array.from({length:90},(_,i)=>({name:'directory-'+String(i).padStart(3,'0'),dir:true,size:0}));
    (window as any).refinementCalls=[];
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).refinementCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('ui-refinement')||'null')||{version:1,profiles:[profile,other],history:{},language,
        localBookmarks:Array.from({length:count},(_,i)=>({id:'l'+i,name:'Local '+i,path:'C:\\folder'+i})),
        remoteBookmarks:[...Array.from({length:count},(_,i)=>({id:'r'+i,name:'Remote '+i,path:'/folder'+i,connectionKey:key(profile)})),{id:'foreign',name:'Other connection',path:'/private',connectionKey:key(other)}],
        folderBookmarks:Array.from({length:count},(_,i)=>({id:'p'+i,name:'Pair '+i,local:'C:\\pair'+i,remote:'/pair'+i,connectionKey:key(profile)}))};
      if(cmd==='save_settings'){localStorage.setItem('ui-refinement',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:dirs};
      if(cmd==='list_local')return args.path==='C:\\'?[{name:'root',dir:true,size:0}]:dirs;
      if(cmd==='list_remote')return dirs;
    }}};
  },{language,count});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  for(const side of ['local','remote'])await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');
}
const saved=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('ui-refinement')||'{}'));
async function blankContext(bar:Locator) {
  const strip=bar.locator('.bookmark-items');
  await strip.click({button:'right',position:{x:Math.max(3,(await strip.boundingBox())!.width-8),y:8}});
}
const treeControl=(page:Page,side:string,path:string,kind='select')=>page.locator('[data-tree-'+kind+'='+side+'][data-tree-path='+JSON.stringify(path)+']');
async function expand(page:Page,side:string,path:string) {
  const control=treeControl(page,side,path,'toggle');
  if(await control.count()&&await control.locator('xpath=../..').getAttribute('aria-expanded')!=='true'){
    await control.click();await expect(control.locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
  }
}
async function go(page:Page,side:string,path:string) {
  await page.locator('#'+side+'-path').fill(path);await page.locator('#'+side+'-path').press('Enter');
  await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');
}
for(const language of ['ja','en']) {
  test('context-only bookmark controls in '+language,async({page})=>{
    await boot(page,language);
    await expect(page.locator('#bookmark-tools,[data-side-add],[data-side-manage]')).toHaveCount(0);
  });
  test('trees omit top heading without leaving a blank header gap in '+language,async({page})=>{
    await boot(page,language);
    await expect(page.locator('.tree-caption')).toHaveCount(0);
    for(const side of ['local','remote']){
      const tree=page.locator('[data-tree='+side+']'),row=tree.locator('[data-tree-row]').first();
      expect((await row.boundingBox())!.y-(await tree.boundingBox())!.y).toBeLessThan(5);
    }
  });
  test('path-right tree toggle in '+language,async({page})=>{
    await boot(page,language);
    for(const side of ['local','remote']) {
      const path=(await page.locator('#'+side+'-path').boundingBox())!,toggle=(await page.locator('[data-tree-visibility='+side+']').boundingBox())!;
      expect(toggle.x).toBeGreaterThanOrEqual(path.x+path.width-1);
      expect(Math.abs(toggle.y-path.y)).toBeLessThan(3);
    }
  });
  test('empty bars retain contextual add and paired essential actions in '+language,async({page})=>{
    await boot(page,language,0);
    for(const side of ['local','remote']) {
      const bar=page.locator('[data-side-bookmarks='+side+']');
      await blankContext(bar);
      await page.locator('#side-bookmark-context [data-side-action=add]').click();
      await page.locator('#side-bookmark-name').fill('Added '+side);
      await page.locator('#side-bookmark-save').click();
      await expect(bar.locator('[data-side-open]')).toHaveText('Added '+side);
    }
    const bar=page.locator('.bookmark-bar');
    for(const action of ['register','history','create']) {
      await blankContext(bar);await page.locator('[data-bookmark-action='+action+']').click();
      await expect(page.locator('[role=dialog]')).toBeVisible();await page.keyboard.press('Escape');
    }
    const data=await saved(page);expect(data.localBookmarks).toHaveLength(1);expect(data.remoteBookmarks.map((b:any)=>b.id)).toContain('foreign');
    await page.reload();await page.locator('#connect-form .primary').click();
    for(const side of ['local','remote'])await expect(page.locator('[data-side-bookmarks='+side+'] [data-side-open]')).toHaveText('Added '+side);
  });
  for(const side of ['local','remote'])test('record context edit/delete preserves order and scope '+language+' '+side,async({page})=>{
    await boot(page,language);
    const bar=page.locator('[data-side-bookmarks='+side+']'),record=bar.locator('[data-side-open='+side[0]+'0]');
    await record.click({button:'right'});
    const context=page.locator('#side-bookmark-context');
    await expect(context.locator('[data-side-action=add]')).toHaveText(language==='ja'?'ブックマークを追加':'Add bookmark');
    await context.locator('[data-side-action=edit]').click();
    await page.locator('#side-bookmark-name').fill('Edited '+side);
    await page.locator('#side-bookmark-path').fill(side==='local'?'C:\\edited':'/edited');
    await page.locator('#side-bookmark-save').click();
    await expect(record).toHaveText('Edited '+side);
    let data=await saved(page);
    expect(data[side+'Bookmarks'].filter((b:any)=>b.id!=='foreign').map((b:any)=>b.id)).toEqual([side[0]+'0',side[0]+'1']);
    const foreignBefore=JSON.stringify(data.remoteBookmarks.find((b:any)=>b.id==='foreign'));
    await record.click({button:'right'});await context.locator('[data-side-action=delete]').click();
    await expect(page.locator('#side-delete-confirm')).toBeVisible();await page.locator('#side-delete-confirm').click();
    await expect(record).toHaveCount(0);data=await saved(page);
    expect(data[side+'Bookmarks'].filter((b:any)=>b.id!=='foreign').map((b:any)=>b.id)).toEqual([side[0]+'1']);
    expect(JSON.stringify(data.remoteBookmarks.find((b:any)=>b.id==='foreign'))).toBe(foreignBefore);
    expect(data.folderBookmarks.map((b:any)=>b.id)).toEqual(['p0','p1']);
  });
  for(const selector of ['.bookmark-bar','[data-side-bookmarks=local]','[data-side-bookmarks=remote]'])
  test('overflow pointer opening has no first-item focus and keyboard remains accessible '+language+' '+selector,async({page})=>{
    await boot(page,language,40);
    const bar=page.locator(selector),more=bar.locator('[data-bookmark-overflow]');
    await more.click();
    const menu=page.locator(selector==='.bookmark-bar'?'#bookmark-overflow-menu':'.side-bookmark-menu'),first=menu.locator('button').first();
    await expect(menu).toBeVisible();await expect(first).not.toBeFocused();
    expect(await first.evaluate(e=>e.matches(':hover'))).toBe(false);
    const normal=await first.evaluate(e=>getComputedStyle(e).backgroundColor);
    await first.hover();expect(await first.evaluate(e=>e.matches(':hover'))).toBe(true);
    expect(await first.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe(normal);
    await page.keyboard.press('Escape');await expect(more).toBeFocused();
    await more.press('Enter');await expect(first).toBeFocused();expect(await first.evaluate(e=>e.matches(':focus-visible'))).toBe(true);
    await page.keyboard.press('ArrowDown');await expect(menu.locator('button').nth(1)).toBeFocused();
    await page.keyboard.press('Escape');await expect(more).toBeFocused();
  });
  for(const side of ['local','remote'])test('hidden bookmark context keeps overflow focus and order '+language+' '+side,async({page})=>{
    await boot(page,language,40);
    const bar=page.locator('[data-side-bookmarks='+side+']'),more=bar.locator('[data-bookmark-overflow]');
    await more.click();await page.locator('.side-bookmark-menu [data-side-open='+side[0]+'39]').click({button:'right'});
    await page.locator('[data-side-action=edit]').click();
    await expect(more).toHaveAttribute('aria-expanded','false');
    await page.locator('#side-bookmark-cancel').click();await expect(more).toBeFocused();
    await more.click();await page.locator('.side-bookmark-menu [data-side-open='+side[0]+'39]').click({button:'right'});
    await page.locator('[data-side-action=edit]').click();await page.locator('#side-bookmark-name').fill('Renamed hidden');
    await page.locator('#side-bookmark-save').click();await expect(more).toBeFocused();
    const data=await saved(page);
    expect(data[side+'Bookmarks'].filter((b:any)=>b.id!=='foreign').map((b:any)=>b.id)).toEqual(Array.from({length:40},(_,i)=>side[0]+i));
  });
  test('resizing keeps overflow keyboard focus in '+language,async({page})=>{
    await boot(page,language,40);
    for(const selector of ['.bookmark-bar','[data-side-bookmarks=local]','[data-side-bookmarks=remote]']){
      const more=page.locator(selector+' [data-bookmark-overflow]');await more.focus();
      await page.setViewportSize({width:1000,height:920});await expect(more).toBeFocused();
      await page.setViewportSize({width:1280,height:920});await expect(more).toBeFocused();
    }
  });
  test('empty bars have keyboard context access in '+language,async({page})=>{
    await boot(page,language,0);
    for(const selector of ['.bookmark-bar','[data-side-bookmarks=local]','[data-side-bookmarks=remote]']){
      const bar=page.locator(selector);await bar.focus();await page.keyboard.press('Shift+F10');
      const menu=page.locator(selector==='.bookmark-bar'?'#bookmark-tree-context':'#side-bookmark-context');
      await expect(menu).toBeVisible();await expect(menu.locator('button').first()).toBeFocused();
      await expect(bar).toHaveAttribute('aria-expanded','true');
      await page.keyboard.press('Escape');await expect(bar).toBeFocused();await expect(bar).toHaveAttribute('aria-expanded','false');
    }
  });
  for(const side of ['local','remote'])test('repeated pointer reveal scrolls current or rendered ancestor without navigation '+language+' '+side,async({page})=>{
    await boot(page,language);
    if(side==='local'){await expand(page,side,'@pc');await expand(page,side,'C:\\');await expand(page,side,'C:\\root');}
    else await expand(page,side,'/');
    const current=side==='local'?'C:\\root\\directory-089':'/directory-089';
    await go(page,side,current);
    const target=treeControl(page,side,current),toggle=page.locator('[data-tree-visibility='+side+']');
    await expect(target).toBeAttached();
    const snapshot=()=>page.evaluate(()=>({paths:['local','remote'].map(s=>(document.querySelector('#'+s+'-path') as HTMLInputElement).value),expanded:[...document.querySelectorAll('[role=treeitem]')].map(e=>[e.querySelector('[data-tree-path]')?.getAttribute('data-tree-path'),e.getAttribute('aria-expanded')]),reads:(window as any).refinementCalls.filter((c:any)=>['list_local','list_remote','list_drives'].includes(c.cmd)).length}));
    const before=await snapshot();
    for(let i=0;i<3;i++){
      await page.locator('[data-tree='+side+']').evaluate(e=>e.scrollTop=0);
      await toggle.click();await toggle.click();
      await expect(target).toBeFocused();await expect(target).toBeInViewport();
      await page.waitForTimeout(1100);await expect(target).toBeFocused();await expect(target).toBeInViewport();
      expect(await snapshot()).toEqual(before);
    }
    const parent=side==='local'?'C:\\root':'/';
    await treeControl(page,side,parent,'toggle').click();
    const collapsed=await snapshot();await toggle.click();await toggle.click();
    await expect(treeControl(page,side,parent)).toBeFocused();await expect(treeControl(page,side,parent)).toBeInViewport();
    expect(await treeControl(page,side,parent).evaluate(e=>getComputedStyle(e).outlineStyle)).toBe('none');
    expect(await snapshot()).toEqual(collapsed);
  });
}
