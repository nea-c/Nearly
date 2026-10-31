import {test,expect} from '@playwright/test';
test('terminal success omits stale per-item sampled counters',async({page})=>{
 await page.goto('/');await page.evaluate(async()=>{const w=window as any;const {setLanguage}=await import('/src/i18n.ts');setLanguage('en');w.__TAURI__={core:{invoke:async()=>({phase:'copying',unit:'bytes',done:32768,total:65536,entries:0,item:1,itemCount:2})}};const {operationFeedback}=await import('/src/operation-feedback.ts');w.feedback=operationFeedback('Generated copy',document.createElement('div'),document.createElement('button'));w.feedback.track('generated');});
 await expect(page.locator('progress')).toHaveAttribute('value','32768');await page.evaluate(()=>(window as any).feedback.finish(true));await expect(page.locator('.operation-progress-label')).toHaveText('Completed');
});
test('ID switches share one throttled in-flight poll; delayed responses cannot overwrite terminal UI',async({page})=>{
 await page.goto('/');await page.evaluate(async()=>{const w=window as any;const {setLanguage}=await import('/src/i18n.ts');setLanguage('en');w.polls=[];w.__TAURI__={core:{invoke:async(_cmd:string,args:any)=>new Promise(resolve=>w.polls.push({id:args.id,time:performance.now(),resolve}))}};const {operationFeedback}=await import('/src/operation-feedback.ts');w.feedback=operationFeedback('Generated move',document.createElement('div'),document.createElement('button'));w.feedback.track('first');});
 await expect.poll(()=>page.evaluate(()=>(window as any).polls.length)).toBe(1);
 await page.evaluate(()=>{(window as any).feedback.track('second');(window as any).feedback.track('third');});
 await page.waitForTimeout(250);expect(await page.evaluate(()=>(window as any).polls.map((p:any)=>p.id))).toEqual(['first']);
 await page.evaluate(()=>(window as any).polls[0].resolve({phase:'copying',unit:'bytes',done:99,total:100,entries:0,item:1,itemCount:1}));
 await expect.poll(()=>page.evaluate(()=>(window as any).polls.length)).toBe(2);expect(await page.evaluate(()=>(window as any).polls[1].id)).toBe('third');
 await page.evaluate(()=>{const w=window as any;w.feedback.track('fourth');w.polls[1].resolve(null);});
 await page.waitForTimeout(50);expect(await page.evaluate(()=>(window as any).polls.length)).toBe(2);
 await expect.poll(()=>page.evaluate(()=>(window as any).polls.length)).toBe(3);
 expect(await page.evaluate(()=>{const w=window as any;return w.polls[2].time-w.polls[1].time;})).toBeGreaterThanOrEqual(190);
 await page.evaluate(()=>{const w=window as any;w.feedback.finish(false);w.polls[2].resolve({phase:'copying',unit:'bytes',done:99,total:100,entries:0,item:1,itemCount:1});});
 await expect(page.locator('.operation-progress-label')).toHaveText('Operation incomplete — inspect results');await page.waitForTimeout(250);expect(await page.evaluate(()=>(window as any).polls.length)).toBe(3);await expect(page.locator('progress')).not.toHaveAttribute('value');
});
test('operation gauge distinguishes scan, bytes, finalizing and failure; ignores late progress',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const w=window as any;
  const {setLanguage}=await import('/src/i18n.ts');setLanguage('en');
  w.progressSample={phase:'scanning',unit:'bytes',done:0,total:null,entries:0};
  w.__TAURI__={core:{invoke:async(cmd:string)=>cmd==='file_operation_progress'?w.progressSample:undefined}};
  const {operationFeedback}=await import('/src/operation-feedback.ts');
  const results=document.createElement('div'),cancel=document.createElement('button');
  w.feedback=operationFeedback('Sample remote copy',results,cancel);w.feedback.track('generated');
 });
 const gauge=page.locator('.operation-feedback progress');
 await expect(gauge).toBeVisible();await expect(gauge).not.toHaveAttribute('value');
 await page.evaluate(()=>{(window as any).progressSample={phase:'copying',unit:'bytes',done:32768,total:65536,entries:0};});
 await expect(gauge).toHaveAttribute('value','32768');await expect(gauge).toHaveAttribute('max','65536');
 await page.evaluate(()=>{(window as any).progressSample={phase:'finalizing',unit:'bytes',done:65536,total:65536,entries:1};});
 await expect(gauge).not.toHaveAttribute('value');
 await page.evaluate(()=>{(window as any).feedback.finish(false);(window as any).progressSample={phase:'copying',unit:'bytes',done:1,total:2,entries:0};});
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');
 await page.waitForTimeout(400);await expect(gauge).not.toHaveAttribute('value');
 await expect(page.locator('.operation-progress-label')).toContainText('incomplete');
});
test('remote multi-delete dispatches one frozen batch and preserves partial outcomes',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any;w.batchCalls=[];
  const entries=[{name:'sample-a.txt',dir:false,size:12},{name:'sample-b.txt',dir:false,size:12}];
  const profile={id:'generated',name:'Generated server',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',hostKey:'pin'};
  w.__TAURI__={core:{invoke:async(cmd:string,args:any)=>{w.batchCalls.push({cmd,args});
   if(cmd==='load_settings')return {version:1,settingsRevision:1,profiles:[profile],history:{},theme:'light',language:'en'};
   if(cmd==='default_folder')return 'C:\\fixture';if(cmd==='list_drives')return [];
   if(cmd==='connect_session')return {path:'/',entries};if(cmd==='list_local'||cmd==='list_remote')return entries;
   if(cmd==='file_operation_progress')return {phase:'deleting',unit:'entries',done:1,total:2,entries:1,item:1,itemCount:2};
   if(cmd==='run_file_operation'){await new Promise(r=>w.releaseBatch=r);return {completed:1,message:'Partial generated result',items:[{source:'/sample-a.txt',completed:true,attempted:true,message:'Deleted'},{source:'/sample-b.txt',completed:false,attempted:true,message:'Generated permission failure'}]};}
  }}};
 });
 await page.goto('/');await page.locator('#connect-form .primary').click();
 const rows=page.locator('[data-list=remote] [data-name]');await rows.first().click();await rows.nth(1).click({modifiers:['Control']});await rows.first().click({button:'right'});
 await page.locator('[data-file-action=delete]').click();await page.locator('#file-operation-confirm').click();
 await expect.poll(()=>page.evaluate(()=>(window as any).batchCalls.filter((c:any)=>c.cmd==='run_file_operation').length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).batchCalls.find((c:any)=>c.cmd==='run_file_operation').args.request.items)).toEqual([{source:'/sample-a.txt'},{source:'/sample-b.txt'}]);
 await expect(page.locator('.operation-feedback progress')).toHaveAttribute('max','2');
 await page.evaluate(()=>(window as any).releaseBatch());await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');await expect(page.locator('.operation-feedback')).toContainText('Generated permission failure');await expect(page.locator('.operation-feedback progress')).toHaveAttribute('value','1');await expect(page.locator('.operation-feedback progress')).toHaveAttribute('max','2');
});
for(const theme of ['light','dark'])test(`sample progress preview ${theme}`,async({page})=>{
 await page.goto('/');await page.evaluate(async(theme)=>{
  document.documentElement.dataset.theme=theme;const {setLanguage}=await import('/src/i18n.ts');setLanguage('ja');
  const w=window as any;w.__TAURI__={core:{invoke:async()=>({phase:'copying',unit:'bytes',done:33554432,total:104857600,entries:2,item:3,itemCount:5})}};
  const {operationFeedback}=await import('/src/operation-feedback.ts');const results=document.createElement('div');results.className='operation-results';results.textContent='/samples/photos → /samples/backup';const cancel=document.createElement('button');cancel.textContent='中止';w.sampleFeedback=operationFeedback('リモートコピー',results,cancel);w.sampleFeedback.track('generated-preview');
 },theme);
 await expect(page.locator('.operation-feedback progress')).toHaveAttribute('value','33554432');
 await page.locator('.operation-feedback').screenshot({path:`../remote-operation-result/progress-${theme}.png`});
});
