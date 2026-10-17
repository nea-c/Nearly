import {test,expect,type Page} from '@playwright/test';
async function boot(page:Page,language:string){
 await page.addInitScript(language=>{
  const profile={id:'p',name:'Fixture',host:'fixture.invalid',port:22,user:'test',mode:'sftp',auth:'key',keyFile:'fixture',hostKey:'pin'};
  window.locationFixture={calls:[]};
  window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(cmd,args)=>{
   window.locationFixture.calls.push({cmd,args});
   if(cmd==='load_settings')return{version:1,profiles:[profile],history:{},language,theme:'light'};
   if(cmd==='default_folder')return 'C:\\original';
   if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
   if(cmd==='list_local'||cmd==='list_remote')return[];
   if(cmd==='connect_session')return{path:'/',entries:[]};
   if(cmd==='stop_sync')return{knownUnreflected:false};
   if(cmd==='sync_status')return{status:'running',pending:0,sent:0,speed:0,latency:0,logs:[]};
  }}};
 },language);
 await page.goto('/');await page.locator('#connect-form .primary').click();
 await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
}
async function navigate(page:Page,side:string,path:string){const input=page.locator(`[data-path=${side}] input`);await input.fill(path);await input.press('Enter');await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');}
async function geometry(page:Page){return page.evaluate(()=>Object.fromEntries(['#prepare','.sync-resume-slot','.sync-location-slot','[data-pane=remote] header','[data-path=remote]'].map(selector=>{const r=document.querySelector(selector)!.getBoundingClientRect();return[selector,{x:r.x,y:r.y,width:r.width,height:r.height}];})));}
for(const language of ['ja','en'])for(const width of [800,1280])test(`same-row actions collapse absent Resume and navigate only ${language} ${width}`,async({page})=>{
 await page.setViewportSize({width,height:800});await boot(page,language);
 await expect(page.locator('#retained-open')).toHaveCount(0);await expect(page.locator('#retained-resume')).toHaveCount(0);
 const before=await geometry(page);
 await expect(page.locator('.sync-resume-slot')).toBeHidden();
 expect(before['#prepare'].x+before['#prepare'].width).toBe(before['[data-pane=remote] header'].x+before['[data-pane=remote] header'].width-8);
 await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await expect(page.locator('#start-form')).toHaveCount(0);
 await expect(page.locator('#retained-open')).toHaveText(language==='ja'?'同期した場所へ戻る':'Return to synced locations');
 await expect(page.locator('#retained-resume')).toHaveCount(0);
 const running=await geometry(page);expect(running).toEqual(before);
 await expect(page.locator('.sync-resume-slot')).toBeHidden();
 await page.locator('#prepare').click();await expect(page.locator('#retained-resume')).toBeVisible();
 const stopped=await geometry(page);
 expect(stopped['[data-pane=remote] header']).toEqual(before['[data-pane=remote] header']);expect(stopped['[data-path=remote]']).toEqual(before['[data-path=remote]']);
 expect(stopped['#prepare'].x).toBe(before['#prepare'].x-80);
 expect(stopped['.sync-resume-slot'].x+stopped['.sync-resume-slot'].width).toBe(before['#prepare'].x+before['#prepare'].width);
 expect(stopped['.sync-location-slot'].x+stopped['.sync-location-slot'].width).toBeLessThanOrEqual(stopped['#prepare'].x);
 const resume=await page.locator('#retained-resume').boundingBox();expect(resume!.x).toBe(stopped['.sync-resume-slot'].x);
 await navigate(page,'local','C:\\browse');await navigate(page,'remote','/browse');
 const starts=await page.evaluate(()=>window.locationFixture.calls.filter(c=>c.cmd==='start_sync').length);
 await page.locator('#retained-open').focus();await expect(page.locator('#sync-locations-help')).toBeVisible();await expect(page.locator('#sync-locations-help')).toContainText('C:\\original');
 await page.locator('#retained-open').click();await expect(page.locator('[data-path=local] input')).toHaveValue('C:\\original');await expect(page.locator('[data-path=remote] input')).toHaveValue('/');
 expect(await page.evaluate(()=>window.locationFixture.calls.filter(c=>c.cmd==='start_sync').length)).toBe(starts);
 expect(await geometry(page)).toEqual(stopped);
});
