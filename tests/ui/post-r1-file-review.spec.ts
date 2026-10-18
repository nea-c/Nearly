import {test,expect} from '@playwright/test';
async function boot(page){await page.addInitScript(()=>{
 const profile={id:'review',name:'Review fixture',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',hostKey:'pin'};
 const root=[{name:'folder',dir:true,size:0},{name:'a',dir:true,size:0},{name:'one.txt',dir:false,size:1}];
 window.review={calls:[],removed:false,hold:false,running:false};
 window.__TAURI__={core:{invoke:async(cmd,args)=>{window.review.calls.push({cmd,args});
 if(cmd==='load_settings')return {version:1,settingsRevision:1,profiles:[profile],history:{},language:'en',theme:'light'};
 if(cmd==='save_settings')return 2;if(cmd==='default_folder')return 'C:\\fixture';if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];if(cmd==='connect_session')return {path:'/',entries:root};if(cmd==='list_local')return root;
 if(cmd==='list_remote'){if(window.review.removed && (args.path==='/folder'||args.path.startsWith('/folder/')))throw 'Generated removed directory';return args.path==='/'?root:[{name:'sub',dir:true,size:0},{name:'one.txt',dir:false,size:1}];}
 if(cmd==='run_file_operation'){if(window.review.hold)await new Promise(r=>window.review.release=r);if(['delete','move'].includes(args.request.action)&&args.request.source==='/folder')window.review.removed=true;return {completed:1,message:'done'};}
 if(cmd==='start_sync'){window.review.running=true;return;}
 if(cmd==='stop_sync'){window.review.running=false;return {knownUnreflected:false};}
 if(cmd==='sync_status')return {status:window.review.running?'running':'stopped',pending:0,sent:0,speed:0,latency:0,logs:[]};
 }}};
  });await page.goto('/');await page.locator('#connect-form .primary').click();await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');await page.locator('[data-tree-toggle=remote][data-tree-path="/"]').click();}
async function browse(page,path){await page.locator('#remote-path').fill(path);await page.locator('#remote-path').press('Enter');await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');}
for(const action of ['delete','move'])test(`removed cached remote directory and descendant refetch after ${action} without relocating another tab`,async({page})=>{
 await boot(page);await browse(page,'/folder/sub');await browse(page,'/folder');
 await page.locator('#add-tab').click();await page.locator('#connect-form .primary').click();await browse(page,'/folder/sub');await page.locator('[data-list=remote] [data-name="one.txt"]').click();await page.locator('[data-tab]').first().click();await expect(page.locator('#remote-path')).toHaveValue('/folder');
 const before=await page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='list_remote'&&c.args.path==='/folder').length);
 await page.locator('[data-tree-select=remote][data-tree-path="/folder"]').click({button:'right'});await page.locator(`[data-file-action=${action}]`).click();if(action==='move')await page.locator('[name=operation-destination]').fill('/destination');await page.locator('#file-operation-confirm').click();await expect(page.locator('[data-feedback-close]')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='list_remote'&&c.args.path==='/folder').length)).toBe(before+1);await expect(page.locator('main > .notice')).toContainText('Generated removed directory');await expect(page.locator('#remote-path')).toHaveValue('/folder');
 await page.locator('[data-tab]').nth(1).click();await expect(page.locator('#remote-path')).toHaveValue('/folder/sub');await expect(page.locator('[data-list=remote] [data-name="one.txt"]')).toHaveAttribute('aria-selected','true');
 const descendants=await page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='list_remote'&&c.args.path==='/folder/sub').length);await browse(page,'/folder/sub');await expect.poll(()=>page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='list_remote'&&c.args.path==='/folder/sub').length)).toBe(descendants+1);
});
test('Stop Sync dispatches while an independent file RPC is held',async({page})=>{
 await boot(page);await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await expect(page.locator('#start-form')).toHaveCount(0);await expect(page.locator('#prepare')).toHaveText('Stop sync');
 await page.locator('#local-path').fill('C:\\nonoverlap');await page.locator('#local-path').press('Enter');await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');await page.evaluate(()=>window.review.hold=true);await page.locator('[data-list=local] [data-name="one.txt"]').click({button:'right'});await page.locator('[data-file-action=duplicate]').click();await page.locator('[name=operation-destination]').fill('copy.txt');await page.locator('#file-operation-confirm').click();await expect.poll(()=>page.evaluate(()=>typeof window.review.release)).toBe('function');await expect(page.locator('#prepare')).toBeEnabled();await page.locator('#prepare').click();await expect.poll(()=>page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='stop_sync').length)).toBe(1);await page.evaluate(()=>window.review.release());
});
test('remote root-child tree Duplicate dispatches sibling destination',async({page})=>{
 await boot(page);await page.locator('[data-tree-select=remote][data-tree-path="/folder"]').click({button:'right'});await page.locator('[data-file-action=duplicate]').click();await page.locator('[name=operation-destination]').fill('copy');await page.locator('#file-operation-confirm').click();await expect.poll(()=>page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='run_file_operation').length)).toBe(1);expect(await page.evaluate(()=>window.review.calls.find(c=>c.cmd==='run_file_operation').args.request)).toMatchObject({side:'remote',action:'copy',source:'/folder',destination:'/copy'});
});
test('remote one-character parent Duplicate dispatches valid POSIX destination',async({page})=>{
 await boot(page);await browse(page,'/a');await page.locator('[data-list=remote] [data-name="one.txt"]').click({button:'right'});await page.locator('[data-file-action=duplicate]').click();await page.locator('[name=operation-destination]').fill('copy.txt');await page.locator('#file-operation-confirm').click();await expect.poll(()=>page.evaluate(()=>window.review.calls.filter(c=>c.cmd==='run_file_operation').length)).toBe(1);expect(await page.evaluate(()=>window.review.calls.find(c=>c.cmd==='run_file_operation').args.request)).toMatchObject({side:'remote',action:'copy',source:'/a/one.txt',destination:'/a/copy.txt'});
});

