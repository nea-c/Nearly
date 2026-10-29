import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{const w=window as any;const profile={id:'text-fixture',name:'Generated fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'fixture',auth:'key',hostKey:'pin'};w.openCalls=[];w.openError='';w.openTokens={};w.openHold=false;
 const entries=[{name:'config.json',dir:false,size:32},{name:'ordinary',dir:true,size:0},{name:'folder.lnk',dir:false,size:100},{name:'image.png',dir:false,size:32},{name:'unknown.custom',dir:false,size:32},{name:'binary.txt',dir:false,size:32},{name:'large.txt',dir:false,size:2097152}];
 w.__TAURI__={core:{invoke:async(cmd,args)=>{w.openCalls.push({cmd,args});
 if(cmd==='load_settings')return {version:1,language:'en',profiles:[profile],history:{}};
 if(cmd==='default_folder')return 'C:\\fixture';if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
 if(cmd==='connect_session')return {path:'/',entries};if(cmd==='list_local')return args.path==='C:\\fixture'?entries:[];if(cmd==='list_remote')return args.path==='/'?entries:[];
 if(cmd==='resolve_local_folder_shortcut')return 'D:\\target';
 if(cmd==='prepare_file_operation'&&w.openHold)await new Promise(resolve=>w.openRelease=resolve);
 if(cmd==='open_text_document'){if(w.openError)throw Error(w.openError);if(args.request.path.endsWith('binary.txt'))throw Error('Binary or control characters are not editable');if(args.request.path.endsWith('large.txt'))throw Error('Text editor limit is 1 MiB');const key=JSON.stringify([args.request.side,args.request.sessionId,args.request.path]);return w.openTokens[key]??(w.openTokens[key]={token:'doc-'+Object.keys(w.openTokens).length});}
 }}};
 });await page.goto('/');await page.locator('#connect-form .primary').click();await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
});
const row=(page,side,name)=>page.locator('[data-pane='+side+'] [data-entry][data-name="'+name+'"]');
const calls=(page,cmd)=>page.evaluate(cmd=>(window as any).openCalls.filter(c=>c.cmd===cmd),cmd);
for(const side of ['local','remote'])test(side+' text double-click opens the existing native editor target and deduplicates',async({page})=>{
 await row(page,side,'config.json').dblclick();await expect.poll(async()=>(await calls(page,'open_text_document')).length).toBe(1);
 const first=(await calls(page,'open_text_document'))[0].args.request;expect(first.side).toBe(side);expect(first.path).toBe(side==='local'?'C:\\fixture\\config.json':'/config.json');expect(first.workspaceId).toBeTruthy();expect(first.sessionId).toBeTruthy();
 await row(page,side,'config.json').dblclick();await expect.poll(async()=>(await calls(page,'open_text_document')).length).toBe(2);expect(await page.evaluate(()=>Object.keys((window as any).openTokens).length)).toBe(1);await expect(page.locator('.text-editor')).toHaveCount(0);
});
test('folders and local shortcuts still navigate, nontext and remote shortcuts keep their behavior',async({page})=>{
 await row(page,'local','image.png').dblclick();await row(page,'remote','folder.lnk').dblclick();expect(await calls(page,'open_text_document')).toEqual([]);expect(await calls(page,'resolve_local_folder_shortcut')).toEqual([]);
 await row(page,'remote','ordinary').dblclick();await expect(page.locator('#remote-path')).toHaveValue('/ordinary');await page.locator('[data-back=remote]').click();await expect(page.locator('#remote-path')).toHaveValue('/');
 await row(page,'local','ordinary').dblclick();await expect(page.locator('#local-path')).toHaveValue('C:\\fixture\\ordinary');await page.locator('[data-back=local]').click();await row(page,'local','folder.lnk').dblclick();await expect(page.locator('#local-path')).toHaveValue('D:\\target');expect((await calls(page,'resolve_local_folder_shortcut')).length).toBe(1);
});
test('unrecognized extensions keep explicit Edit text menu access',async({page})=>{
 await row(page,'local','unknown.custom').dblclick();expect(await calls(page,'open_text_document')).toEqual([]);await row(page,'local','unknown.custom').click({button:'right'});await page.locator('[data-file-action=edittext]').click();await expect.poll(async()=>(await calls(page,'open_text_document')).length).toBe(1);
});
test('sync refusal, binary and size validation remain visible and release the prepared operation',async({page})=>{
 await page.evaluate(()=>(window as any).openError='Text editor overlaps an active sync');await row(page,'remote','config.json').dblclick();await expect(page.locator('.notice')).toContainText('active sync');await page.evaluate(()=>(window as any).openError='');
 for(const [name,error] of [['binary.txt','Binary'],['large.txt','1 MiB']]){await row(page,'local',name).dblclick();await expect(page.locator('.notice')).toContainText(error);}
 expect((await calls(page,'cancel_file_operation')).length).toBe(3);expect(await page.evaluate(()=>Object.keys((window as any).openTokens).length)).toBe(0);
});
test('tab switch while prepare waits refuses the stale text target',async({page})=>{
 await page.evaluate(()=>(window as any).openHold=true);await row(page,'remote','config.json').dblclick();await expect.poll(()=>page.evaluate(()=>typeof (window as any).openRelease)).toBe('function');await page.keyboard.press('Control+t');await page.evaluate(()=>(window as any).openRelease());await expect.poll(async()=>(await calls(page,'cancel_file_operation')).length).toBe(1);expect(await calls(page,'open_text_document')).toEqual([]);
});
