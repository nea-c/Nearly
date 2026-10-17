import {test,expect,type Page} from '@playwright/test';
async function boot(page:Page,language='en',theme='light'){
 await page.addInitScript(({language,theme})=>{
  const profile={id:'p',name:'Fixture',host:'fixture.invalid',port:22,user:'test',mode:'sftp',auth:'key',keyFile:'fixture',hostKey:'pin'};
  const initial={version:1,profiles:[profile],history:{'["p","/remote"]':'C:\\old-history'},theme,language};
  window.r2={calls:[],listeners:{},failStart:false};
  window.__TAURI__={event:{listen:async(name,callback)=>{window.r2.listeners[name]=callback;return()=>{};}},core:{invoke:async(cmd,args)=>{
   window.r2.calls.push({cmd,args});
   if(cmd==='load_settings')return JSON.parse(localStorage.getItem('r2-sync')||'null')||initial;
   if(cmd==='save_settings'){localStorage.setItem('r2-sync',JSON.stringify(args.data));return;}
   if(cmd==='default_folder')return 'C:\\shown';
   if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
   if(cmd==='connect_session')return{path:'/',entries:[]};
   if(cmd==='list_local'||cmd==='list_remote')return[];
   if(cmd==='start_sync'&&window.r2.failStart)throw Error('Generated start refused');
   if(cmd==='stop_sync')return{knownUnreflected:false};
   if(cmd==='sync_status')return{status:'running',pending:0,sent:0,speed:0,latency:0,logs:[]};
  }}};
 },{language,theme});
 await page.goto('/');await page.locator('#connect-form .primary').click();
 for(const side of ['local','remote'])await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
}
async function navigate(page:Page,side:string,path:string){await page.locator(`[data-path=${side}] input`).fill(path);await page.locator(`[data-path=${side}] input`).press('Enter');await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');}
const starts=(page:Page)=>page.evaluate(()=>window.r2.calls.filter(c=>c.cmd==='start_sync').map(c=>c.args));
async function start(page:Page,destructive=false){
 await page.locator('#prepare').click();
 if(destructive){await page.locator('#delete-removed').check();await page.locator('#recursive-sync').uncheck();await page.locator('#exclusion-details').evaluate(el=>(el as HTMLDetailsElement).open=true);await page.locator('#exclusion-rules').fill('frozen-cache/');}
 await page.locator('#start-form .primary').click();await expect(page.locator('#start-form')).toHaveCount(0);
}
test('Sync uses the current explorer source and removes the redundant chooser',async({page})=>{
 await boot(page);await navigate(page,'remote','/remote');
 await page.locator('#prepare').focus();await expect(page.locator('#sync-primary-help')).toBeVisible();await expect(page.locator('#sync-primary-help')).toContainText('C:\\shown');
 await page.locator('#prepare').click();await expect(page.locator('[data-sync-source]')).toHaveText('C:\\shown');
 await expect(page.locator('#pick-local')).toHaveCount(0);await expect(page.locator('#start-form [name=local]')).toBeHidden();
 await page.evaluate(()=>{(document.querySelector('#start-form [name=local]')as HTMLInputElement).value='C:\\forged';});
 await page.locator('#start-form .primary').click();await expect.poll(async()=>(await starts(page)).length).toBe(1);
 expect((await starts(page))[0].local).toBe('C:\\shown');expect((await starts(page))[0].remote).toBe('/remote');
 await expect(page.locator('#retained-resume')).toHaveCount(0);await expect(page.locator('.stopped-context')).toHaveCount(0);
 await page.locator('#prepare').click();await expect(page.locator('#retained-resume')).toBeVisible();
 const boxes=await Promise.all(['#prepare','#retained-resume'].map(selector=>page.locator(selector).boundingBox()));expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x+boxes[0]!.width);expect(boxes[1]!.x-boxes[0]!.x-boxes[0]!.width).toBeLessThan(15);
});
test('Resume freezes the successful pair and settings through navigation, settings refresh and fresh scan',async({page})=>{
 await boot(page);await navigate(page,'remote','/remote');await start(page,true);const first=(await starts(page))[0];
 await page.locator('#prepare').click();await expect(page.locator('#retained-resume')).toBeEnabled();
 await navigate(page,'local','C:\\new-explorer');await navigate(page,'remote','/different');
 await page.evaluate(()=>{const data=JSON.parse(localStorage.getItem('r2-sync')!);data.syncPresets=[{id:'nearly:sync-default:v1',name:'Default',exclusionRules:'new-default/',deleteRemoved:false,recursive:true}];localStorage.setItem('r2-sync',JSON.stringify(data));window.r2.listeners['settings-changed']?.({payload:{settingsRevision:1}});});
 await expect(page.locator('#retained-resume')).toHaveCount(1);await page.locator('#retained-resume').focus();await expect(page.locator('#sync-resume-help')).toBeVisible();await expect(page.locator('#sync-resume-help')).toContainText('C:\\shown');await expect(page.locator('#sync-resume-help')).toContainText('/remote');
 await page.locator('#retained-resume').click();await expect(page.locator('[data-sync-source]')).toHaveText('C:\\shown');await expect(page.locator('#delete-removed')).toBeChecked();await expect(page.locator('#delete-removed')).toBeDisabled();await expect(page.locator('#recursive-sync')).not.toBeChecked();await expect(page.locator('.resume-exclusions')).toContainText('frozen-cache/');await expect(page.locator('#start-form .warning').first()).toBeVisible();
 await page.locator('#start-form .primary').click();await expect.poll(async()=>(await starts(page)).length).toBe(2);const resumed=(await starts(page))[1];
 expect(resumed.id).not.toBe(first.id);for(const key of ['local','remote','exclusionRules','deleteRemoved','recursive'])expect(resumed[key]).toEqual(first[key]);
});
test('a failed start and persisted metadata after restart never create Resume',async({page})=>{
 await boot(page);await page.evaluate(()=>window.r2.failStart=true);await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await expect(page.locator('.form-error').last()).toContainText('Generated start refused');await page.locator('#cancel').click();await expect(page.locator('#retained-resume')).toHaveCount(0);
 await page.reload();await expect(page.locator('#connect-form')).toBeVisible();await expect(page.locator('#retained-resume')).toHaveCount(0);expect(await page.evaluate(()=>window.r2.calls.filter(c=>c.cmd==='connect_session'||c.cmd==='start_sync').length)).toBe(0);
});
for(const language of ['ja','en'])for(const theme of ['light','dark','midnight','forest','mint'])test(`matching adjacent actions and focus help ${language} ${theme}`,async({page})=>{
 await boot(page,language,theme);await start(page);await page.locator('#prepare').click();
 await page.mouse.move(4,4);
 await expect(page.locator('#prepare')).toHaveText(language==='ja'?'同期':'Sync');await expect(page.locator('#retained-resume')).toHaveText(language==='ja'?'再開':'Resume');
 const styles=await Promise.all(['#prepare','#retained-resume'].map(selector=>page.locator(selector).evaluate(el=>{const s=getComputedStyle(el);return{background:s.backgroundColor,color:s.color,padding:s.padding,height:el.getBoundingClientRect().height};})));expect(styles[1]).toEqual(styles[0]);
 await page.locator('#retained-resume').focus();await expect(page.locator('#sync-resume-help')).toBeVisible();
 if(theme==='forest'&&language==='ja')await page.screenshot({path:'test-results/r2-sync-actions-forest.png'});
});
