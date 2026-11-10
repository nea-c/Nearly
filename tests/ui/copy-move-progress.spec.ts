import {test,expect} from '@playwright/test';
async function setup(page) {
 await page.addInitScript(()=>{
  const w=window as any;w.calls=[];w.pending=[];
  w.sample={phase:'copying',unit:'bytes',done:128,total:512,entries:0,item:1,itemCount:1};
  const profile={id:'progress-fixture',name:'Generated progress fixture',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',hostKey:'pin'};
  const entries=[{name:'one.bin',dir:false,size:512},{name:'two.bin',dir:false,size:1024}];
  w.__TAURI__={core:{invoke:async(cmd,args)=>{
   w.calls.push({cmd,args});
   if(cmd==='load_settings')return {version:1,settingsRevision:1,profiles:[profile],history:{},theme:'light',language:'en'};
   if(cmd==='save_settings')return 2;if(cmd==='default_folder')return 'C:\\fixture';if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
   if(cmd==='connect_session')return {path:'/',entries};if(cmd==='list_local'||cmd==='list_remote')return entries;
   if(cmd==='file_operation_progress')return w.sample;
   if(cmd==='prepare_file_operation'&&w.holdPrepare)await new Promise(r=>w.releasePrepare=r);
   if(cmd==='run_file_operation')return new Promise((resolve,reject)=>w.pending.push({request:args.request,resolve,reject}));
  }}};
 });
 await page.goto('/');await page.locator('#connect-form .primary').click();
 await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
}
async function start(page,side,action,multiple=false) {
 const row=page.locator(`[data-list=${side}] [data-name="one.bin"]`);
 await row.click();
 if(multiple) {
  await page.locator(`[data-list=${side}] [data-name="two.bin"]`).click({modifiers:['Control']});
  await row.click({button:'right'});await page.locator(`[data-file-action=${action==='copy'?'copy':'cut'}]`).click();
  await page.locator(`#${side}-path`).fill(side==='local'?'C:\\target':'/target');await page.locator(`#${side}-path`).press('Enter');
  await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
  await row.click({button:'right'});await page.locator('[data-file-action=paste]').click();
 } else {
  await row.click({button:'right'});await page.locator(`[data-file-action=${action==='copy'?'duplicate':'move'}]`).click();
  await page.locator('[name=operation-destination]').fill(action==='copy'?'copied.bin':side==='local'?'C:\\target':'/target');
 }
 await page.locator('#file-operation-confirm').click();
 await expect.poll(()=>page.evaluate(()=>window.pending.length)).toBe(1);
}
async function complete(page,index=0) {
 await page.evaluate(index=>{const p=window.pending[index];p.resolve({completed:1,message:'Generated result',items:p.request.items?.map(item=>({source:item.source,completed:true,attempted:true,message:'Generated success'}))});},index);
}
for(const side of ['local','remote'])for(const multiple of [false,true])test(`${side} ${multiple?'multiple':'single'} copy polls bytes and waits for native outcome`,async({page})=>{
 await setup(page);await start(page,side,'copy',multiple);
 const gauge=page.locator('.operation-feedback progress');await expect(gauge).toHaveAttribute('value','128');await expect(gauge).toHaveAttribute('max','512');
 expect(await page.evaluate(()=>window.calls.some(c=>c.cmd==='file_operation_progress'&&c.args.id===window.pending[0].request.id))).toBe(true);
 if(multiple){await expect(page.locator('.operation-selection-label')).toContainText('0 of 2 items completed');await expect(page.locator('.operation-progress-label')).toContainText('Current item');}
 await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing',done:512});
 await expect(gauge).toHaveAttribute('value','512');await expect(page.locator('.operation-progress-label')).toContainText('Finalizing');await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
 await complete(page);
 if(side==='local'&&multiple){
  await expect.poll(()=>page.evaluate(()=>window.pending.length)).toBe(2);
  await page.evaluate(()=>window.sample={...window.sample,phase:'copying',done:256,total:1024});
  await expect(gauge).toHaveAttribute('max','1024');await expect(gauge).toHaveAttribute('value','256');
  await expect(page.locator('.operation-selection-label')).toContainText('1 of 2 items completed');await complete(page,1);
 }
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','true');await expect(page.locator('.operation-progress-label')).toHaveText('Completed');
 if(multiple)await expect(page.locator('.operation-selection-label')).toContainText('2 of 2 items completed');
});
for(const side of ['local','remote'])test(`${side} multiple move shows only stages and successful root counts`,async({page})=>{
 await setup(page);await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing',unit:'entries',done:0,total:null});await start(page,side,'move',true);
 await expect(page.locator('.operation-progress-label')).toContainText('Finalizing');await expect(page.locator('progress')).toBeHidden();await expect(page.locator('.operation-selection-label')).toContainText('0 of 2 items completed');
 await complete(page);
 if(side==='local'){await expect.poll(()=>page.evaluate(()=>window.pending.length)).toBe(2);await expect(page.locator('.operation-selection-label')).toContainText('1 of 2 items completed');await complete(page,1);}
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','true');await expect(page.locator('progress')).toBeHidden();await expect(page.locator('.operation-selection-label')).toContainText('2 of 2 items completed');
});
for(const side of ['local','remote'])test(`${side} cancelled copy does not complete after all bytes were written`,async({page})=>{
 await setup(page);await start(page,side,'copy');await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing',done:512});await expect(page.locator('progress')).toHaveAttribute('value','512');
 await page.locator('#file-operation-cancel').click();expect(await page.evaluate(()=>window.calls.some(c=>c.cmd==='cancel_file_operation'))).toBe(true);
 await page.evaluate(()=>window.pending[0].reject('Generated cancellation during finalization'));
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');await expect(page.locator('.operation-progress-label')).toContainText('incomplete');await expect(page.locator('progress')).toBeHidden();
});
test('remote batch close failure preserves committed roots without treating written bytes as completion',async({page})=>{
 await setup(page);await start(page,'remote','copy',true);
 await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing',done:512,selectionCompleted:1,selectionTotal:2});await expect(page.locator('.operation-selection-label')).toContainText('1 of 2 items completed');
 await page.evaluate(()=>{const p=window.pending[0];p.resolve({completed:1,message:'Generated partial result',items:p.request.items.map((item,i)=>({source:item.source,completed:i===0,attempted:true,message:i===0?'Confirmed root':'Generated CLOSE failure'}))});});
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');await expect(page.locator('.operation-selection-label')).toContainText('1 of 2 items completed');await expect(page.locator('progress')).toBeHidden();
});

test('next local root resets the byte gauge during held preparation and ignores the previous poll',async({page})=>{
 await setup(page);await start(page,'local','copy',true);await expect(page.locator('progress')).toHaveAttribute('value','128');
 await page.evaluate(()=>{const w=window as any,original=w.__TAURI__.core.invoke;w.__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==='file_operation_progress'&&!w.latePoll)return new Promise(resolve=>w.latePoll=resolve);return original(cmd,args);};w.holdPrepare=true;});
 await expect.poll(()=>page.evaluate(()=>typeof window.latePoll)).toBe('function');await complete(page);
 await expect.poll(()=>page.evaluate(()=>typeof window.releasePrepare)).toBe('function');
 await expect(page.locator('.operation-progress-label')).toContainText('Scanning');await expect(page.locator('progress')).not.toHaveAttribute('value');
 await page.evaluate(()=>{window.sample={...window.sample,phase:'scanning',done:0,total:null};window.latePoll({phase:'copying',unit:'bytes',done:512,total:512,item:1,itemCount:1});});
 await expect(page.locator('progress')).not.toHaveAttribute('value');await expect(page.locator('.operation-selection-label')).toContainText('1 of 2 items completed');
 await page.evaluate(()=>{window.holdPrepare=false;window.releasePrepare();});await expect.poll(()=>page.evaluate(()=>window.pending.length)).toBe(2);
 await complete(page,1);await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','true');
});
