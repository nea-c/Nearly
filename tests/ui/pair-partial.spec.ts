import {test,expect,type Page} from '@playwright/test';
async function boot(page:Page){
 await page.addInitScript(()=>{const w=window as any;const p={id:'pair',name:'Generated pair server',mode:'sftp',host:'fixture.invalid',port:22,user:'fixture',auth:'key',hostKey:'pin'};const key=JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);w.pairFixture={calls:[],failLocal:false,failRemote:false,holdRemote:false,saved:null};w.__TAURI__={core:{invoke:async(cmd:string,args:any)=>{const f=w.pairFixture;f.calls.push({cmd,args});
 if(cmd==='load_settings')return {version:1,profiles:[p],history:{},language:'en',folderBookmarks:[{id:'pair-one',name:'Sample pair',local:'C:\\pair-target',remote:'/pair-target',connectionKey:key}]};
 if(cmd==='save_settings'){f.saved=args.data;return 1;}if(cmd==='default_folder')return 'C:\\root';if(cmd==='list_drives')return [];
 if(cmd==='connect_session')return {path:'/',entries:[]};
 if(cmd==='list_local'){if(args.path==='C:\\pair-target'&&f.failLocal)throw 'Generated local denied';return [{name:'local-sample.txt',dir:false,size:1}];}
 if(cmd==='list_remote'){if(args.path==='/pair-target'){if(f.holdRemote)await new Promise(resolve=>f.releaseRemote=resolve);if(f.failRemote)throw 'Generated remote connection failed';}return [{name:'remote-sample.txt',dir:false,size:1}];}
 }}};});await page.goto('/');await page.locator('#connect-form .primary').click();for(const side of ['local','remote'])await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
}
for(const failed of ['local','remote'])test(`pair opens available side when ${failed} fails and retains its own history`,async({page})=>{
 await boot(page);await page.evaluate(failed=>{(window as any).pairFixture[failed==='local'?'failLocal':'failRemote']=true;},failed);
 await page.locator('[data-bookmark-open="pair-one"]').click();
 const successful=failed==='local'?'remote':'local';await expect(page.locator(`#${successful}-path`)).toHaveValue(successful==='local'?'C:\\pair-target':'/pair-target');
 await expect(page.locator(`#${failed}-path`)).toHaveValue(failed==='local'?'C:\\root':'/');
 await expect(page.locator('main > .notice')).toContainText(failed==='local'?'Local':'Remote');
 await expect.poll(()=>page.evaluate(()=>!!(window as any).pairFixture.saved?.browseLocations)).toBe(true);
 const saved=await page.evaluate(()=>(window as any).pairFixture.saved);expect(saved.folderBookmarks[0]).toMatchObject({local:'C:\\pair-target',remote:'/pair-target'});
 expect((saved.folderPairHistory??[]).some((p:any)=>p.local==='C:\\pair-target'||p.remote==='/pair-target')).toBe(false);
});
test('both failed sides report both errors without changing paths',async({page})=>{
 await boot(page);await page.evaluate(()=>Object.assign((window as any).pairFixture,{failLocal:true,failRemote:true}));await page.locator('[data-bookmark-open="pair-one"]').click();await expect(page.locator('main > .notice')).toContainText('Generated local denied');await expect(page.locator('main > .notice')).toContainText('Generated remote connection failed');await expect(page.locator('#local-path')).toHaveValue('C:\\root');await expect(page.locator('#remote-path')).toHaveValue('/');
});
test('fast side commits before delayed peer; repeated click and tab switch do not retarget results',async({page})=>{
 await boot(page);await page.evaluate(()=>(window as any).pairFixture.holdRemote=true);
 await page.locator('[data-bookmark-open="pair-one"]').evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).pairFixture.releaseRemote)).toBe('function');await expect(page.locator('#local-path')).toHaveValue('C:\\pair-target');await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
 expect(await page.evaluate(()=>(window as any).pairFixture.calls.filter((c:any)=>c.cmd==='list_remote'&&c.args.path==='/pair-target').length)).toBe(1);
 await page.locator('#add-tab').click();await page.locator('#connect-form .primary').click();for(const side of ['local','remote'])await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
 const otherPaths=await page.evaluate(()=>['local','remote'].map(side=>(document.querySelector(`#${side}-path`) as HTMLInputElement).value));
 await page.evaluate(()=>(window as any).pairFixture.releaseRemote());await expect(page.locator('#local-path')).toHaveValue(otherPaths[0]);await expect(page.locator('#remote-path')).toHaveValue(otherPaths[1]);await page.locator('[data-tab]').first().click();await expect(page.locator('#local-path')).toHaveValue('C:\\pair-target');await expect(page.locator('#remote-path')).toHaveValue('/pair-target');
});
test('a later local navigation survives the delayed remote half and does not save a mixed pair',async({page})=>{
 await boot(page);await page.evaluate(()=>(window as any).pairFixture.holdRemote=true);await page.locator('[data-bookmark-open="pair-one"]').click();await expect(page.locator('#local-path')).toHaveValue('C:\\pair-target');
 await page.locator('#local-path').fill('C:\\later-view');await page.locator('#local-path').press('Enter');await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');await page.evaluate(()=>(window as any).pairFixture.releaseRemote());await expect(page.locator('#remote-path')).toHaveValue('/pair-target');await expect(page.locator('#local-path')).toHaveValue('C:\\later-view');
 await expect.poll(()=>page.evaluate(()=>(window as any).pairFixture.saved?.browseLocations)).toBeTruthy();
 await page.waitForTimeout(100);
 const history=await page.evaluate(()=>(window as any).pairFixture.saved?.folderPairHistory??[]);
 expect(history.some((p:any)=>p.local==='C:\\later-view'&&p.remote==='/pair-target')).toBe(false);
});
