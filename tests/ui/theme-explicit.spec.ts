import { test, expect } from '@playwright/test';

async function boot(page, options: {theme?: string; os?: 'light'|'dark'; holdLoad?: boolean; holdSave?: boolean; failLoad?: boolean} = {}) {
  await page.emulateMedia({colorScheme:options.os ?? 'light'});
  await page.addInitScript(options => {
    window.calls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.calls.push({cmd,args});
      if(cmd==='load_settings') {
        if(options.failLoad) throw Error('fixture load failed');
        if(!localStorage.getItem('theme-explicit-settings')) localStorage.setItem('theme-explicit-settings',JSON.stringify({version:1,settingsRevision:12,theme:options.theme,profiles:[{id:'saved',name:'Saved endpoint',host:'fixture.invalid',port:2222,user:'fixture',mode:'sftp',auth:'key',keyFile:'fixture.ppk',hostKey:''}],history:{saved:'/original'},localPaneRatio:.62,localTreeRatio:.35,remoteTreeRatio:.43,exclusions:{pair:'*.tmp'},syncOptions:{pair:{deleteRemoved:false,recursive:true}},syncPresets:[{id:'preset',name:'Keep preset',exclusionRules:'*.tmp',deleteRemoved:false,recursive:true}],folderBookmarks:[{id:'bookmark',name:'Keep bookmark',connectionKey:JSON.stringify(['saved','sftp','fixture.invalid',2222,'fixture','']),local:'C:\\fixture',remote:'/original'}]}));
        if(options.holdLoad) await new Promise(resolve=>window.releaseThemeLoad=resolve);
        return JSON.parse(localStorage.getItem('theme-explicit-settings'));
      }
      if(cmd==='save_settings') {
        if(options.holdSave) await new Promise(resolve=>window.releaseThemeSave=resolve);
        const disk=JSON.parse(localStorage.getItem('theme-explicit-settings'));
        if(args.data.settingsRevision!==disk.settingsRevision) throw Error('settings revision conflict');
        localStorage.setItem('theme-explicit-settings',JSON.stringify({...args.data,settingsRevision:disk.settingsRevision+1}));
        if(window.rejectThemeSave)throw Error('uncertain theme save');
        return disk.settingsRevision+1;
      }
      if(cmd==='default_folder')return 'C:\\fixture';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='list_local'||cmd==='list_remote')return [];
      if(cmd==='connect_session'||cmd==='start_sync')throw Error('unexpected network operation');
    }}};
  },options);
  await page.goto('/',{waitUntil:'commit'});
}
const saves=page=>page.evaluate(()=>window.calls.filter(c=>c.cmd==='save_settings'));
const disk=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('theme-explicit-settings')));

for(const prior of [undefined,'system'])for(const os of ['light','dark'] as const)
test(`${prior ?? 'absent'} preference resolves OS ${os} once after loading and persists the complete settings`,async({page})=>{
  await boot(page,{theme:prior,os,holdLoad:true});
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseThemeLoad)).toBe('function');
  expect(await saves(page)).toEqual([]);
  await page.evaluate(()=>window.releaseThemeLoad());
  await expect(page.locator('#connect-form')).toBeVisible();
  expect((await saves(page)).length).toBe(1);
  const payload=(await saves(page))[0].args.data;
  expect(payload.theme).toBe(os);expect(payload.settingsRevision).toBe(12);
  expect(payload.profiles[0].id).toBe('saved');expect(payload.history).toEqual({saved:'/original'});
  expect(payload.localPaneRatio).toBe(.62);expect(payload.localTreeRatio).toBe(.35);expect(payload.remoteTreeRatio).toBe(.43);expect(payload.exclusions).toEqual({pair:'*.tmp'});
  expect(payload.folderBookmarks[0].id).toBe('bookmark');expect(payload.syncPresets[0].id).toBe('preset');expect(payload.syncOptions.pair).toEqual({deleteRemoved:false,recursive:true});
  expect((await disk(page)).settingsRevision).toBe(13);
  await page.emulateMedia({colorScheme:os==='light'?'dark':'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme',os);
  expect((await saves(page)).length).toBe(1);
  await page.reload({waitUntil:'commit'});
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseThemeLoad)).toBe('function');
  await page.evaluate(()=>window.releaseThemeLoad());
  await expect(page.locator('#connect-form')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme',os);
  expect(await saves(page)).toEqual([]);
  await page.locator('#settings-toggle').click();await page.locator('#theme-select').selectOption(os==='light'?'dark':'light');
  await expect.poll(async()=> (await disk(page)).settingsRevision).toBe(14);
  expect((await saves(page))[0].args.data.settingsRevision).toBe(13);
});

for(const theme of ['light','dark','midnight','forest','mint'])
test(`saved explicit ${theme} starts without a normalization write and ignores OS changes`,async({page})=>{
  await boot(page,{theme,os:'dark'});await expect(page.locator('#connect-form')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  expect(await saves(page)).toEqual([]);
  await page.emulateMedia({colorScheme:'light'});
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#theme-select option')).toHaveText(['ライト','ダーク','ミッドナイト','ジェイド','ミント']);
  await expect(page.locator('#theme-select')).toHaveValue(theme);
  expect(await page.locator('html').evaluate(el=>el.style.colorScheme)).toBe(['light','mint'].includes(theme)?'light':'dark');
});

for(const outcome of ['conflict','uncertain'])
test(`held initial save ${outcome} blocks UI and cannot trigger a retry or stale overwrite`,async({page})=>{
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error))); 
  await boot(page,{theme:'system',os:'dark',holdSave:true});
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseThemeSave)).toBe('function');
  await expect(page.locator('#connect-form')).toHaveCount(0);
  await page.keyboard.press('Control+t');await page.keyboard.press('Control+Tab');await page.keyboard.press('Control+w');
  expect(pageErrors).toEqual([]);
  if(outcome==='conflict')await page.evaluate(()=>{const data=JSON.parse(localStorage.getItem('theme-explicit-settings'));data.settingsRevision=13;data.localPaneRatio=.7;data.theme='light';localStorage.setItem('theme-explicit-settings',JSON.stringify(data));});
  else await page.evaluate(()=>window.rejectThemeSave=true);
  await page.emulateMedia({colorScheme:'light'});await page.evaluate(()=>window.releaseThemeSave());
  await expect(page.locator('body')).toContainText(outcome==='conflict'?'settings revision conflict':'uncertain theme save');
  await expect(page.locator('#connect-form')).toHaveCount(0);
  await page.locator('#settings-toggle').click();await expect(page.locator('#theme-select')).toBeDisabled();
  expect((await saves(page)).length).toBe(1);expect((await disk(page)).localPaneRatio).toBe(outcome==='conflict'?.7:.62);expect((await disk(page)).theme).toBe(outcome==='conflict'?'light':'dark');
  expect(pageErrors).toEqual([]);
});

for(const failure of ['load','invalid-theme'])
test(`${failure} never triggers a default theme save`,async({page})=>{
  await boot(page,{failLoad:failure==='load',theme:failure==='invalid-theme'?'unknown':'system',os:'dark'});
  await expect(page.locator('body')).toContainText('再起動');
  expect(await saves(page)).toEqual([]);await expect(page.locator('#connect-form')).toHaveCount(0);
  await page.locator('#settings-toggle').click();await expect(page.locator('#theme-select')).toBeDisabled();
});

