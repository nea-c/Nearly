import {test,expect,type Page} from '@playwright/test';
async function setup(page:Page,language:'ja'|'en'){
 await page.addInitScript(({language})=>{
  const p={id:'fixture',name:'Fixture',host:'fixture.invalid',port:22,user:'dummy',auth:'key',mode:'sftp',keyFile:'',hostKey:'dummy'};
  const f=(window as any).indicatorFixture={failConnect:false,status:{status:'running',syncPhase:'caught_up',pending:0,sent:0,speed:0,latency:0,errorCount:0,logs:[]}};
  (window as any).__TAURI__={core:{invoke:async(c:string,a:any={})=>{
   if(c==='load_settings')return {version:1,language,settingsRevision:0,profiles:[p,{...p,id:'other',name:'Other fixture'}],history:{}};
   if(c==='save_settings')return {...a.data,settingsRevision:1};
   if(c==='default_folder')return 'C:\\dummy';
   if(c==='list_drives')return [];
   if(c==='connect_session'){if(f.failConnect)throw Error('Generated connection failed');return {path:'/',entries:[]};}
   if(c==='list_local'||c==='list_remote')return [];
   if(c==='sync_status')return structuredClone(f.status);
   if(c==='stop_sync')return {knownUnreflected:true};
   return undefined;
  }}};
 },{language});await page.goto('/');
}
for(const theme of ['light','dark'])for(const language of ['ja','en'] as const)test(`fixed shared indicators ${theme} ${language}`,async({page},info)=>{
 await setup(page,language);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 const footer=page.locator('.status-summary .status-icon'),active=()=>page.locator('[role=tab][aria-selected=true] .status-icon');
 let labelPosition:number|undefined,nameOffset:number|undefined;
 const check=async(state:string)=>{await expect(footer).toHaveAttribute('data-state',state);await expect(active()).toHaveAttribute('data-state',state);for(const e of [footer,active()])await expect.poll(async()=>{const b=await e.boundingBox();return b&&{width:b.width,height:b.height};}).toEqual({width:14,height:14});
 const x=await page.locator('#sync-state').evaluate(e=>e.getBoundingClientRect().x);labelPosition??=x;expect(x).toBe(labelPosition);
 const offset=await page.locator('[role=tab][aria-selected=true]').evaluate(e=>e.querySelector('span:not(.dot)')!.getBoundingClientRect().x-e.getBoundingClientRect().x);nameOffset??=offset;expect(offset).toBe(nameOffset);
 };
 await check('disconnected');await page.evaluate(()=>(window as any).indicatorFixture.failConnect=true);await page.locator('#connect-form .primary').click();await check('error');await page.getByRole('treeitem',{name:'Other fixture',exact:true}).click();await check('disconnected');
 await page.evaluate(()=>(window as any).indicatorFixture.failConnect=false);await page.locator('#connect-form .primary').click();await check('connected');
 await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await check('sync');
 const labelX=await page.locator('#sync-state').evaluate(e=>e.getBoundingClientRect().x),nameX=await page.locator('[role=tab][aria-selected=true] > span:not(.dot)').evaluate(e=>e.getBoundingClientRect().x);
 for(const phase of ['scanning','working','caught_up']){await page.evaluate(phase=>Object.assign((window as any).indicatorFixture.status,{syncPhase:phase}),phase);await check('sync');expect(await page.locator('#sync-state').evaluate(e=>e.getBoundingClientRect().x)).toBe(labelX);expect(await page.locator('[role=tab][aria-selected=true] > span:not(.dot)').evaluate(e=>e.getBoundingClientRect().x)).toBe(nameX);}
 await expect(page.locator('[role=tab][aria-selected=true]')).toHaveAttribute('aria-label',language==='ja'?/変更を監視中/:/Watching for changes/);
 await page.locator('#add-tab').click();await check('disconnected');await expect(page.locator('.tab .status-icon[data-state=sync]')).toHaveCount(1);
 await page.locator('#connect-form .primary').click();await check('connected');await expect(page.locator('.tab .status-icon[data-state=sync]')).toHaveCount(1);
 await page.locator('[role=tab]').first().click();await check('sync');
 await page.screenshot({path:info.outputPath(`status-${theme}-${language}.png`)});
 await page.evaluate(()=>Object.assign((window as any).indicatorFixture.status,{status:'stopping',syncPhase:'stopping'}));await check('stopping');
 await page.evaluate(()=>Object.assign((window as any).indicatorFixture.status,{status:'failed',syncPhase:'error',errorCount:1}));await check('error');
 await page.evaluate(()=>Object.assign((window as any).indicatorFixture.status,{status:'stopped',syncPhase:'stopped'}));await check('connected');
});
