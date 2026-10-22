import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, language = 'en', empty = false) {
  await page.addInitScript(({language, empty}) => {
    const profile = {id:'repairs', name:'Fixture', mode:'sftp', host:'fixture.invalid', port:22, user:'test', auth:'key', hostKey:'pin'};
    const key = JSON.stringify([profile.id, profile.mode, profile.host, 22, profile.user, profile.hostKey]);
    const groups = ['top','second','third'].map((id,i) => ({id, kind:'group', name:id, parentId:i ? ['top','second'][i-1] : null}));
    const initial = {version:1, language, profiles:[profile], history:{}, localBookmarks:[], remoteBookmarks:[],
      localBookmarkTree:{version:1,nodes:empty?[]:groups}, remoteBookmarkTree:{version:1,nodes:empty?[]:groups.map(n=>({...n,connectionKey:key}))}};
    (window as any).repairCalls=[];
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).repairCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('repair-settings')||'null')||initial;
      if(cmd==='save_settings'){localStorage.setItem('repair-settings',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return [];
    }}};
  },{language,empty});
  await page.goto('/'); await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
}
for (const language of ['en','ja']) test(`empty side bars show translated help in ${language}`,async({page})=>{
  await boot(page,language,true);
  for(const side of ['local','remote'])await expect(page.locator(`#${side}-bookmarks .bookmark-empty`)).toContainText(language==='en'?'Right-click':'右クリック');
});
for(const side of ['local','remote']) {
  test(`${side} first pointer registration has no bar focus ring and keyboard keeps focus visible`,async({page})=>{
    await boot(page,'en',true);
    const bar=page.locator(`#${side}-bookmarks`);
    await bar.click({button:'right',position:{x:2,y:2}});
    await page.locator('[data-side-action=add]').click();
    await page.locator('#side-bookmark-name').fill('First');
    await page.locator('#side-bookmark-name').press('Enter');
    await expect(bar.locator('[data-side-open]')).toHaveText('First');
    expect(await bar.evaluate(e=>getComputedStyle(e).outlineStyle)).toBe('none');
    await expect(bar.locator('[data-side-open]')).toBeFocused();
    await bar.focus(); await page.keyboard.press('Shift+F10'); await page.keyboard.press('Escape');
    await expect(bar).toBeFocused();
    expect(await bar.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
  });
  test(`${side} folder deletion promotes its children and persists`,async({page})=>{
    await boot(page);
    await page.locator(`#${side}-bookmarks [data-bookmark-group=top]`).click({button:'right'});
    await page.locator('[data-side-action=delete]').click();
    await page.locator('#bookmark-tree-form .primary').click();
    await expect(page.locator(`#${side}-bookmarks [data-bookmark-group=top]`)).toHaveCount(0);
    await expect(page.locator(`#${side}-bookmarks [data-bookmark-group=second]`)).toBeVisible();
    const nodes=await page.evaluate(side=>JSON.parse(localStorage.getItem('repair-settings')!)[side+'BookmarkTree'].nodes,side);
    expect(nodes.find((n:any)=>n.id==='second').parentId).toBe(null);
  });
  test(`${side} depth-three context dismiss preserves hierarchy inside and closes outside`,async({page})=>{
    await boot(page);
    await page.locator(`#${side}-bookmarks [data-bookmark-group=top]`).click();
    await page.locator('[data-bookmark-group=second]').hover();
    await expect(page.locator('[data-bookmark-folder-menu=second]')).toBeVisible();
    await page.locator('[data-bookmark-group=third]').hover();
    await expect(page.locator('[data-bookmark-folder-menu=third]')).toBeVisible();
    await page.locator('[data-bookmark-group=third]').click({button:'right'});
    await expect(page.locator('#side-bookmark-context')).toBeVisible();
    await expect(page.locator('[data-bookmark-group=third]')).toHaveAttribute('data-bookmark-context-target','true');
    // Wait beyond the cascade's 240 ms leave timer: a context must freeze it.
    await page.waitForTimeout(350);
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
    await expect(page.locator('#side-bookmark-context')).toBeVisible();
    const box=(await page.locator('[data-bookmark-folder-menu=top]').boundingBox())!;
    await page.mouse.click(box.x+3,box.y+3);
    await expect(page.locator('#side-bookmark-context')).toHaveCount(0);
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
    await expect(page.locator('[data-bookmark-context-target]')).toHaveCount(0);
    await page.locator('[data-bookmark-group=third]').click({button:'right'});
    await expect(page.locator('#side-bookmark-context')).toBeVisible();
    await page.mouse.click(box.x+3,box.y+3,{button:'right'});
    await expect(page.locator('#side-bookmark-context')).toHaveCount(0);
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
    await page.locator('[data-bookmark-group=second]').press('Shift+F10');
    await expect(page.locator('[data-bookmark-group=second]')).toHaveAttribute('data-bookmark-context-target','true');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-bookmark-group=second]')).toBeFocused();
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
    await page.locator('[data-bookmark-group=third]').press('Shift+F10');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
    await expect(page.locator('[data-bookmark-group=third]')).toBeFocused();
    await expect(page.locator(`#${side}-bookmarks [data-bookmark-group=top]`)).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('[data-bookmark-group=second]')).toHaveAttribute('aria-expanded','true');
    await page.mouse.click(10,800);
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);
  });
  test(`${side} second and third depth contexts mutate their exact group`,async({page})=>{
    await boot(page);
    for(const id of ['second','third']) {
      await page.locator(`#${side}-bookmarks [data-bookmark-group=top]`).click();
      if(id==='third') {await page.locator('[data-bookmark-group=second]').hover();await expect(page.locator('[data-bookmark-folder-menu=second]')).toBeVisible();}
      await page.locator(`[data-bookmark-group=${id}]`).click({button:'right'});
      await expect(page.locator(`[data-bookmark-group=${id}]`)).toHaveAttribute('data-bookmark-context-target','true');
      await page.locator('[data-side-action=rename]').click();
      await page.locator('#bookmark-folder-name').fill(id+' renamed');
      await page.locator('#bookmark-tree-form .primary').click();
      await expect.poll(()=>page.evaluate(({side,id})=>JSON.parse(localStorage.getItem('repair-settings')!)[side+'BookmarkTree'].nodes.find((n:any)=>n.id===id).name,{side,id})).toBe(id+' renamed');
    }
  });
  test(`${side} blank folder context Escape restores a focusable cascade anchor`,async({page})=>{
    await boot(page);
    await page.locator(`#${side}-bookmarks [data-bookmark-group=top]`).click();
    await page.locator('[data-bookmark-group=second]').hover();
    await expect(page.locator('[data-bookmark-folder-menu=second]')).toBeVisible();
    await page.locator('[data-bookmark-group=third]').hover();
    const empty=page.locator('[data-bookmark-folder-menu=third] .bookmark-menu-empty');
    await expect(empty).toBeVisible();
    await empty.click({button:'right'});
    await expect(page.locator('#side-bookmark-context')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
    await expect(page.locator('[data-bookmark-group=third]')).toBeFocused();
  });
  test(`${side} context blocks background action and pointer dismissal clears target feedback`,async({page})=>{
    await boot(page);
    const folder=page.locator(`#${side}-bookmarks [data-bookmark-group=top]`);
    await folder.click({button:'right'});
    await expect(folder).toHaveAttribute('data-bookmark-context-target','true');
    const before=await page.evaluate(()=>(window as any).repairCalls.filter((c:any)=>c.cmd==='list_local'||c.cmd==='list_remote').length);
    const refresh=(await page.locator('[data-refresh=local]').boundingBox())!;
    await page.mouse.click(refresh.x+refresh.width/2,refresh.y+refresh.height/2);
    await expect(page.locator('#side-bookmark-context')).toHaveCount(0);
    await expect(folder).not.toHaveAttribute('data-bookmark-context-target');
    expect(await folder.evaluate(e=>e===document.activeElement)).toBe(false);
    expect(await page.evaluate(()=>(window as any).repairCalls.filter((c:any)=>c.cmd==='list_local'||c.cmd==='list_remote').length)).toBe(before);
    await page.locator('[data-refresh=local]').click();
    await expect.poll(()=>page.evaluate(()=>(window as any).repairCalls.filter((c:any)=>c.cmd==='list_local'||c.cmd==='list_remote').length)).toBeGreaterThan(before);
  });
}
