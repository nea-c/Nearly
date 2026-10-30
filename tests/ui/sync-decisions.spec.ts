import {test,expect} from '@playwright/test';
import fs from 'node:fs';
test('anonymous sync reason report is readable, selectable and bounded in five themes',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any;
  const profile={id:'sample',name:'Generated fixture',host:'fixture.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',keyFile:'',hostKey:'generated-pin'};
  w.decisionFixture={version:1,counts:{mtime_mismatch:4000,upload_dispatched:4},examples:[{id:'f-0123456789abcdef',reason:'mtime_mismatch',localSize:512,remoteSize:512,localUtcSeconds:1700000000,remoteUtcSeconds:1700000001,remoteMinusLocalSeconds:1,path:'must-not-be-shared',password:'must-not-be-shared'}]};
  w.__TAURI__={core:{invoke:async(cmd:string,args:any={})=>{
   if(cmd==='load_settings')return{version:1,theme:'forest',language:'ja',profiles:[profile],history:{}};
   if(cmd==='save_settings')return args.data;
   if(cmd==='default_folder')return'C:\\generated';
   if(cmd==='list_drives'||cmd==='list_local'||cmd==='list_remote')return[];
   if(cmd==='connect_session')return{path:'/',entries:[]};
   if(cmd==='sync_status')return{status:'running',pending:3996,sent:4,speed:0,latency:0,logs:['Uploaded private-ordinary-log.txt'],syncDecisions:structuredClone(w.decisionFixture)};
  }}};
 });
 await page.goto('/');await page.locator('#connect-form .primary').click();
 await page.locator('#prepare').click();await page.locator('#start-form .primary').click();
 await page.locator('#toggle-logs').click();await page.locator('.sync-decision-diagnostics summary').click();
 const report=page.locator('#sync-decision-report');await expect(report).toHaveValue(/mtime_mismatch/);
 expect(await report.inputValue()).not.toContain('must-not-be-shared');expect(await report.inputValue()).not.toContain('private-ordinary-log');
 await expect(report).toHaveAttribute('readonly','');
 fs.mkdirSync('test-results/sync-decisions',{recursive:true});
 for(const theme of ['light','dark','forest','midnight','mint']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const layout=await report.evaluate(el=>({width:el.getBoundingClientRect().width,parent:el.parentElement!.getBoundingClientRect().width,bottom:el.getBoundingClientRect().bottom,drawerBottom:el.closest('.log-drawer')!.getBoundingClientRect().bottom,color:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));
  expect(layout.width).toBeGreaterThan(100);expect(layout.width).toBeLessThanOrEqual(layout.parent);expect(layout.color).not.toBe(layout.bg);
  expect(layout.bottom).toBeLessThan(layout.drawerBottom);
  if(theme==='light'||theme==='dark')await page.screenshot({path:`test-results/sync-decisions/anonymous-report-${theme}.png`});
 }
 await report.focus();await page.keyboard.press('Control+a');const before=await report.inputValue();
 expect(await report.evaluate(el=>({start:el.selectionStart,end:el.selectionEnd}))).toEqual({start:0,end:before.length});
 await page.evaluate(()=>(window as any).decisionFixture.counts.mtime_mismatch=4001);await page.waitForTimeout(650);expect(await report.inputValue()).toBe(before);
 await page.locator('.sync-decision-diagnostics summary').focus();await expect(report).toHaveValue(/4001/);
 await page.setViewportSize({width:640,height:720});expect(await report.evaluate(el=>el.getBoundingClientRect().right<=innerWidth)).toBe(true);
});
