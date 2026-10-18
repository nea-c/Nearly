import {test,expect} from '@playwright/test';
async function boot(page,count=1){
  await page.addInitScript(({count})=>{
    const profile={id:'side-fixture',name:'Side fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const key=JSON.stringify([profile.id,profile.mode,profile.host,22,profile.user,profile.hostKey]);
    window.sideCalls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.sideCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('side-folder-settings')||'null')||{version:1,language:'en',profiles:[profile],history:{},localBookmarks:Array.from({length:count},(_,i)=>({id:i?'local-extra'+i:'local-saved',name:'Local saved '+i,path:'C:\\saved'+i})),remoteBookmarks:Array.from({length:count},(_,i)=>({id:i?'remote-extra'+i:'remote-saved',name:'Remote saved '+i,path:'/saved'+i,connectionKey:key})),folderBookmarks:[{id:'pair-saved',name:'Pair saved',local:'C:\\pair',remote:'/pair',connectionKey:key}]};
      if(cmd==='save_settings'){localStorage.setItem('side-folder-settings',JSON.stringify(args.data));return 1;}
      if(cmd==='default_folder')return 'C:\\root';if(cmd==='list_drives')return[{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return{path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return[];
    }}};
  },{count});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
}
for(const side of ['local','remote'])test(`${side} folders persist and history opens only its own pane`,async({page})=>{
  await boot(page);
  const bar=page.locator(`#${side}-bookmarks`);
  await bar.click({button:'right',position:{x:2,y:2}});
  await expect(page.locator('#side-bookmark-context')).toBeVisible();
  await page.locator('[data-side-action=create]').click();
  await expect(page.locator('#bookmark-tree-title')).toHaveText('Add folder');
  await page.locator('#bookmark-folder-name').fill('Organized');
  await page.locator('#bookmark-tree-form .primary').click();
  const folder=bar.locator('[data-bookmark-group]');await expect(folder.locator('.bookmark-label')).toHaveText('Organized');
  await folder.click({button:'right'});await page.locator('[data-side-action=add]').click();
  await page.locator('#side-bookmark-name').fill('Inside');
  await page.locator('#side-bookmark-path').fill(side==='local'?'C:\\inside':'/inside');
  await page.locator('#side-bookmark-save').click();
  await folder.click();const leaf=page.locator('[data-bookmark-folder-menu] [data-side-open]');await expect(leaf).toHaveText('Inside');
  const before=await page.evaluate(()=>({local:document.querySelector('#local-path').value,remote:document.querySelector('#remote-path').value}));
  await leaf.click();
  await expect(page.locator(side==='local'?'#local-path':'#remote-path')).toHaveValue(side==='local'?'C:\\inside':'/inside');
  await expect(page.locator(side==='local'?'#remote-path':'#local-path')).toHaveValue(side==='local'?before.remote:before.local);
  await bar.click({button:'right',position:{x:2,y:2}});await page.locator('[data-side-action=history]').click();
  await expect(page.locator('.side-history-list code').first()).toHaveText(side==='local'?'C:\\inside':'/inside');
  await page.locator('[data-side-history-open]').first().click();
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('side-folder-settings')));
  expect(saved[side+'BookmarkTree'].nodes.some(n=>n.kind==='group'&&n.name==='Organized')).toBe(true);
  expect(saved.folderBookmarks[0].id).toBe('pair-saved');
  expect(saved.folderPairHistory.some(p=>p.local==='C:\\inside'||p.remote==='/inside')).toBe(false);
});
for(const side of ['local','remote'])test(`${side} overflow edit and delete cancellation restore the actual opener`,async({page})=>{
  await boot(page,40);
  const bar=page.locator(`#${side}-bookmarks`),more=bar.locator('[data-bookmark-overflow]');
  for(const action of ['edit','delete']){
    await more.click();
    const hidden=page.locator(`.side-bookmark-menu [data-side-open=${side}-extra39]`);
    await hidden.click({button:'right'});
    await page.locator(`[data-side-action=${action}]`).click();
    await expect(more).toHaveAttribute('aria-expanded','false');
    await page.locator(action==='edit'?'#side-bookmark-cancel':'#side-delete-cancel').click();
    await expect(more).toBeFocused();
    await expect(page.locator('.side-bookmark-menu')).toHaveCount(0);
  }
  await more.click();await page.locator(`.side-bookmark-menu [data-side-open=${side}-extra39]`).click({button:'right'});
  await page.locator('[data-side-action=edit]').click();await page.locator('#side-bookmark-name').fill('Renamed hidden');await page.locator('#side-bookmark-save').click();
  await expect(more).toBeFocused();
});
test('side keyboard context Escape clears expanded state and restores each bar',async({page})=>{
  await boot(page);
  for(const side of ['local','remote']){
    const bar=page.locator(`#${side}-bookmarks`);await bar.focus();await page.keyboard.press('Shift+F10');
    await expect(bar).toHaveAttribute('aria-expanded','true');
    await page.keyboard.press('Escape');await expect(bar).toBeFocused();await expect(bar).toHaveAttribute('aria-expanded','false');
  }
});
test('side item hover matches the paired item in every theme',async({page})=>{
  await boot(page);
  const pair=page.locator('[data-bookmark-open=pair-saved]'),local=page.locator('#local-bookmark-local-saved'),remote=page.locator('#remote-bookmark-remote-saved');
  for(const theme of ['light','dark','midnight','forest','mint']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const values=[];
    for(const row of [pair,local,remote]){await row.hover();values.push(await row.evaluate(e=>{const s=getComputedStyle(e);return{background:s.backgroundColor,color:s.color,border:s.borderColor};}));}
    expect(values[1]).toEqual(values[0]);expect(values[2]).toEqual(values[0]);
  }
});
