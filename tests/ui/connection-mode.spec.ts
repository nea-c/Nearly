import {test,expect} from '@playwright/test';
const savedMock={id:'saved',name:'Saved mock',mode:'mock',host:'saved.invalid',port:22,user:'fixture',auth:'key',keyFile:'generated-fixture.ppk',hostKey:'fixture-pin'};
async function stub(page,profiles){
 await page.addInitScript(({profiles})=>{
  if(!localStorage.getItem('mode-settings'))localStorage.setItem('mode-settings',JSON.stringify({version:1,profiles,history:{},theme:'light'}));
  window.__modeCalls=[];
  window.__TAURI__={core:{invoke:async(cmd,args)=>{
   window.__modeCalls.push({cmd,args});
   if(cmd==='load_settings')return JSON.parse(localStorage.getItem('mode-settings'));
   if(cmd==='save_settings'){localStorage.setItem('mode-settings',JSON.stringify(args.data));return;}
   if(cmd==='default_folder')return 'C:\\fixture';
   if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
   if(cmd==='list_local'||cmd==='list_remote')return [];
   if(cmd==='connect_session')return {path:'/',entries:[]};
  }}};
 },{profiles});
 await page.goto('/');await expect(page.locator('#connection-tree')).toBeVisible();
}
async function add(page){
 const tree=page.locator('#connection-tree'),b=await tree.boundingBox();
 await tree.click({button:'right',position:{x:8,y:b.height-8}});
 await page.locator('[data-menu-action=add-profile]').click();await expect(page.locator('#profile-form')).toBeVisible();
}
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('mode-settings')));
const network=page=>page.evaluate(()=>window.__modeCalls.filter(c=>['probe_host_key','prepare_session','connect_session','list_remote','start_sync','prepare_file_operation','run_file_operation'].includes(c.cmd)));
async function plainSftp(page){
 const mode=page.locator('#profile-form [name=mode]');
 await expect(mode).toHaveAccessibleName('接続方式');
 await expect(mode.locator('option[value=sftp]')).toHaveText('SFTP');
 await expect(mode.locator('option[value=mock]')).toHaveCount(0);
 await expect(page.locator('#profile-form')).not.toContainText('実接続');
 return mode;
}

test('production fresh browser never seeds a mock connection or offers Mock in a new draft',async({page})=>{
 await page.goto('/');await expect(page.locator('#connection-tree')).toBeVisible();
 await expect(page.locator('[data-connection-node]')).toHaveCount(0);
 await expect(page.locator('#connect-form .primary')).toBeDisabled();
 await add(page);const mode=await plainSftp(page);await expect(mode).toHaveValue('sftp');
});

test('production new saved connection uses only plain SFTP and saving never connects',async({page})=>{
 await stub(page,[]);await add(page);const mode=await plainSftp(page);
 await expect(mode).toHaveValue('sftp');
 await page.screenshot({path:'test-results/connection-mode-new-sftp.png'});
 await page.locator('#profile-form [name=name]').fill('New site');
 await page.locator('#profile-form [name=host]').fill('new.invalid');
 await page.locator('#profile-form [name=user]').fill('fixture');
 await page.locator('#profile-form [name=keyFile]').fill('generated-fixture.ppk');
 await page.locator('#profile-form .primary').click();await expect(page.locator('#profile-form')).toHaveCount(0);
 expect((await stored(page)).profiles[0].mode).toBe('sftp');expect(await network(page)).toEqual([]);
 await page.reload();await expect(page.locator('[data-connection-select]')).toContainText('New site');
 expect(await network(page)).toEqual([]);
});

test('production saved Mock stays Mock and disabled connect rejects a forced submit',async({page})=>{
 await stub(page,[savedMock]);await expect(page.locator('#connect-form .primary')).toBeDisabled();
 expect((await stored(page)).profiles[0].mode).toBe('mock');
 await page.locator('#connect-form').dispatchEvent('submit');
 await expect(page.locator('#connect-form')).toBeVisible();await expect(page.locator('#prepare')).toHaveCount(0);
 expect(await network(page)).toEqual([]);
 await page.reload();await expect(page.locator('#connect-form .primary')).toBeDisabled();
 expect((await stored(page)).profiles[0].mode).toBe('mock');expect(await network(page)).toEqual([]);
});

test('production saved Mock edit requires explicit SFTP selection and never silently converts or connects',async({page})=>{
 await stub(page,[savedMock]);await page.locator('#edit-profile').click();const mode=await plainSftp(page);
 await expect(mode).toHaveValue('');await expect(mode).toHaveAttribute('required','');
 await expect(mode.locator('option:checked')).toHaveAttribute('disabled','');
 expect(await mode.evaluate(el=>el.checkValidity())).toBe(false);
 expect(await mode.locator('option:checked').evaluate(el=>el.disabled)).toBe(true);
 await page.screenshot({path:'test-results/connection-mode-saved-mock-placeholder.png'});
 await page.locator('#profile-form [name=name]').fill('Renamed only');
 await page.locator('#profile-form .primary').click();await expect(page.locator('#profile-form')).toBeVisible();
 expect((await stored(page)).profiles[0]).toEqual(savedMock);expect(await network(page)).toEqual([]);
 // Bypassing browser validity must not silently coerce the placeholder to SFTP.
 await page.locator('#profile-form').dispatchEvent('submit');
 expect((await stored(page)).profiles[0].mode).toBe('mock');
 await expect(page.locator('#profile-form')).toBeVisible();expect(await network(page)).toEqual([]);
 await mode.selectOption('sftp');await page.locator('#profile-form .primary').click();
 await expect(page.locator('#profile-form')).toHaveCount(0);
 expect((await stored(page)).profiles[0]).toMatchObject({id:'saved',mode:'sftp',name:'Renamed only',host:'saved.invalid'});
 expect(await network(page)).toEqual([]);
 await page.reload();await expect(page.locator('#connect-form .primary')).toBeEnabled();
 expect((await stored(page)).profiles[0].mode).toBe('sftp');expect(await network(page)).toEqual([]);
});

test('production existing SFTP retains plain connection method and save/reload does not authenticate or transfer',async({page})=>{
 await stub(page,[{...savedMock,mode:'sftp',name:'Saved SFTP'}]);await page.locator('#edit-profile').click();
 const mode=await plainSftp(page);await expect(mode).toHaveValue('sftp');
 await page.locator('#profile-form .primary').click();await expect(page.locator('#profile-form')).toHaveCount(0);
 expect(await network(page)).toEqual([]);await page.reload();await expect(page.locator('#connection-tree')).toBeVisible();
 expect((await stored(page)).profiles[0].mode).toBe('sftp');expect(await network(page)).toEqual([]);
});
