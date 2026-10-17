import {test,expect} from '@playwright/test';
for(const language of ['ja','en'])test(`comparison and expanded deletion consent remain explicit ${language}`,async({page})=>{
 await page.addInitScript(language=>{
  window.copyCalls=[];
  window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(cmd,args)=>{
   window.copyCalls.push({cmd,args});
   if(cmd==='load_settings')return{version:1,profiles:[{id:'p',name:'Fixture',host:'fixture.invalid',port:22,user:'test',mode:'sftp',auth:'key',keyFile:'fixture',hostKey:'pin'}],history:{},theme:'light',language};
   if(cmd==='default_folder')return 'C:\\source';
   if(cmd==='connect_session')return{path:'/destination',entries:[]};
   if(cmd==='list_local'||cmd==='list_remote'||cmd==='list_drives')return[];
   if(cmd==='stop_sync')return{knownUnreflected:false};
   if(cmd==='sync_status')return{status:'running',pending:0,sent:0,speed:0,latency:0,logs:[]};
  }}};
 },language);
 await page.goto('/');await page.locator('#connect-form .primary').click();await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
 await page.locator('#prepare').click();
 await expect(page.locator('#start-form')).toContainText(language==='ja'?'1秒単位':'one-second');
 await expect(page.locator('#start-form')).toContainText(language==='ja'?'内容の一致を保証':'content equality');
 await expect(page.locator('#start-form')).toContainText(language==='ja'?'リモート側が新しくても':'remote file is newer');
 await expect(page.locator('#delete-warning')).toBeHidden();await page.locator('#delete-removed').check();
 await expect(page.locator('#delete-warning')).toBeVisible();await expect(page.locator('#delete-warning')).toContainText(language==='ja'?'開始時の比較':'initial comparison');
 await expect(page.locator('#delete-warning')).toContainText(language==='ja'?'空フォルダー':'empty folders');
 expect(await page.evaluate(()=>window.copyCalls.filter(c=>c.cmd==='start_sync').length)).toBe(0);
 await page.locator('#start-form .primary').click();await expect(page.locator('#start-form')).toHaveCount(0);await page.locator('#prepare').click();await page.locator('#retained-resume').click();
 await expect(page.locator('.resume-settings .warning')).toContainText(language==='ja'?'開始時の比較':'initial comparison');
 expect(await page.evaluate(()=>window.copyCalls.filter(c=>c.cmd==='start_sync').length)).toBe(1);
});
