import { test, expect } from '@playwright/test';
async function setup(page) {
 await page.addInitScript(()=>{
 window.calls=[];window.hold=true;window.fail=false;window.holdPrepare=false;
 const profile={id:'file',name:'Fixture',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',hostKey:'pin'};
 const entries=[{name:'folder',dir:true,size:0},{name:'one.txt',dir:false,size:1},{name:'two.ZIP',dir:false,size:1}];
 window.__TAURI__={core:{invoke:async(cmd,args)=>{window.calls.push({cmd,args});
 if(cmd==='load_settings')return {version:1,settingsRevision:1,profiles:[profile],history:{},theme:'light',language:'en'};
 if(cmd==='save_settings')return 2;if(cmd==='default_folder')return 'C:\\fixture';if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
 if(cmd==='connect_session')return {path:'/',entries};if(cmd==='list_local'||cmd==='list_remote')return entries;
 if(cmd==='prepare_file_operation' && window.holdPrepare)await new Promise(r=>window.releasePrepare=r);
 if(cmd==='run_file_operation' && args.request.items && window.rejectBatch)throw 'Unknown native batch result';
 if(cmd==='run_file_operation' && args.request.items)return {completed:1,message:'batch done',items:args.request.items.map((item,index)=>({source:item.source,completed:index===0,attempted:index<2,message:index===0?'done':index===1?'Injected move failure':'Not attempted'}))};
 if(cmd==='run_file_operation'||cmd==='run_local_archive'){if(window.hold)await new Promise(r=>window.release=r);if(window.fail)throw 'Injected later failure';return {completed:1,message:'done',entries:2,bytes:2,finalPath:args.request.destination};}
 }}};
 });await page.goto('/');await page.locator('#connect-form .primary').click();await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
}

test('remote cut paste batches all roots and retains failed and unattempted clipboard items',async({page})=>{
 await setup(page);
 const rows=page.locator('[data-list=remote] [data-entry]');
 await page.locator('[data-list=remote] [data-name=folder]').click();
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({modifiers:['Control']});
 await page.locator('[data-list=remote] [data-name="two.ZIP"]').click({modifiers:['Control']});
 await page.locator('[data-list=remote] [data-name="two.ZIP"]').click({button:'right'});
 await page.locator('[data-file-action=cut]').click();
 await page.locator('#remote-path').fill('/destination');await page.locator('#remote-path').press('Enter');
 await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({button:'right'});
 await page.locator('[data-file-action=paste]').click();await page.locator('#file-operation-confirm').click();
 await expect.poll(()=>page.evaluate(()=>window.calls.filter(c=>c.cmd==='run_file_operation').length)).toBe(1);
 const request=await page.evaluate(()=>window.calls.find(c=>c.cmd==='run_file_operation').args.request);
 expect(request.action).toBe('move');expect(request.items).toEqual([
 {source:'/folder',destination:'/destination/folder'},
 {source:'/one.txt',destination:'/destination/one.txt'},
 {source:'/two.ZIP',destination:'/destination/two.ZIP'}]);
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-complete','true');
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');
 await expect(page.locator('.operation-feedback')).toContainText('Injected move failure');
 await expect(page.locator('.operation-feedback')).toContainText('Not attempted');
 await page.locator('[data-feedback-close]').click();
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({button:'right'});
 await page.locator('[data-file-action=paste]').click();
 await expect(page.locator('.operation-targets li')).toHaveCount(2);
 await expect(page.locator('.operation-targets')).not.toContainText('/folder');
});

async function prepareMove(page) {
 await page.locator('[data-list=remote] [data-name=folder]').click();
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({modifiers:['Control']});
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({button:'right'});
 await page.locator('[data-file-action=cut]').click();
 await page.locator('#remote-path').fill('/destination');await page.locator('#remote-path').press('Enter');
 await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({button:'right'});
 await page.locator('[data-file-action=paste]').click();
}
async function expectClipboardRetained(page) {
 await page.locator('[data-feedback-close]').click();
 await page.locator('[data-list=remote] [data-name="one.txt"]').click({button:'right'});
 await page.locator('[data-file-action=paste]').click();
 await expect(page.locator('.operation-targets li')).toHaveCount(2);
 await expect(page.locator('.operation-targets')).toContainText('/folder');
 await expect(page.locator('.operation-targets')).toContainText('/one.txt');
}
test('unknown batch result retains the entire cut clipboard without dispatching remaining roots',async({page})=>{
 await setup(page);await page.evaluate(()=>window.rejectBatch=true);await prepareMove(page);
 await page.locator('#file-operation-confirm').click();
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-complete','true');
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');
 expect(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='run_file_operation').length)).toBe(1);
 await expectClipboardRetained(page);
});
test('cancelling batch move preparation sends no mutation and retains the cut clipboard',async({page})=>{
 await setup(page);await page.evaluate(()=>window.holdPrepare=true);await prepareMove(page);
 await page.locator('#file-operation-confirm').click();
 await expect.poll(()=>page.evaluate(()=>typeof window.releasePrepare)).toBe('function');
 await page.locator('#file-operation-cancel').click();
 await page.evaluate(()=>window.releasePrepare());
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-complete','true');
 expect(await page.evaluate(()=>window.calls.filter(c=>c.cmd==='run_file_operation').length)).toBe(0);
 expect(await page.evaluate(()=>window.calls.some(c=>c.cmd==='cancel_file_operation'&&c.args.abandon))).toBe(true);
 await expectClipboardRetained(page);
});