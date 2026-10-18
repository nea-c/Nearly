import {test,expect,type Page} from '@playwright/test';
import {expandTreePath} from './tree-expansion';

async function boot(page:Page,language:string,side:string){
  await page.addInitScript(({language,side})=>{
    const profile={id:'silent',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const dirs=[{name:'branch',dir:true,size:0}];
    Object.assign(window,{silentCalls:[],silentPath:side==='local'?'C:\\root\\branch':'/branch',silentHold:true});
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).silentCalls.push({cmd,args});
      if(cmd==='load_settings')return {version:1,profiles:[profile],history:{},language};
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:dirs};
      if(cmd==='list_local'&&args.path==='C:\\')return [{name:'root',dir:true,size:0}];
      if(cmd==='list_local'||cmd==='list_remote'){
        if(args.path===(window as any).silentPath&&(window as any).silentHold)
          return await new Promise((resolve,reject)=>{(window as any).silentRelease=(fail=false)=>{(window as any).silentHold=false;fail?reject(Error('fixture listing failed')):resolve([{name:'child',dir:true,size:0}]);};});
        return dirs;
      }
    }}};
  },{language,side});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
  await expandTreePath(page,side,side==='local'?'C:\\root':'/');
}
for(const language of ['ja','en'])for(const side of ['local','remote']){
  test(`silent loading with repeated expansion ${side} ${language}`,async({page})=>{
    await boot(page,language,side);
    const path=side==='local'?'C:\\root\\branch':'/branch';
    const toggle=page.locator(`[data-tree-toggle=${side}][data-tree-path=${JSON.stringify(path)}]`);
    const item=toggle.locator('xpath=../..');
    const selected=await page.locator(`[data-tree=${side}] [role=treeitem][aria-selected=true] > [data-tree-row]`).getAttribute('data-tree-path');
    await toggle.click();await expect(toggle).toHaveAttribute('aria-busy','true');
    await expect(item.locator(':scope > [role=group] > *')).toHaveCount(0,{timeout:700});
    await expect(page.locator(`[data-tree=${side}]`)).not.toContainText(/読込中|Loading/);
    for(let i=0;i<3;i++){await toggle.click();await toggle.click();}
    await toggle.click();await expect(item).toHaveAttribute('aria-expanded','false');
    expect(await page.evaluate(()=>{const w=window as any;return w.silentCalls.filter((c:any)=>c.args?.path===w.silentPath).length;})).toBe(1);
    await page.evaluate(()=>(window as any).silentRelease());
    await expect(toggle).not.toHaveAttribute('aria-busy','true');
    await expect(item).toHaveAttribute('aria-expanded','false');
    expect(await page.locator(`[data-tree=${side}] [role=treeitem][aria-selected=true] > [data-tree-row]`).getAttribute('data-tree-path')).toBe(selected);
    await toggle.click();await expect(item.locator('[data-tree-select]').filter({hasText:'child'})).toBeVisible();
    expect(await page.evaluate(()=>{const w=window as any;return w.silentCalls.filter((c:any)=>c.args?.path===w.silentPath).length;})).toBe(1);
  });
  test(`listing failure remains actionable ${side} ${language}`,async({page})=>{
    await boot(page,language,side);
    const path=side==='local'?'C:\\root\\branch':'/branch';
    const toggle=page.locator(`[data-tree-toggle=${side}][data-tree-path=${JSON.stringify(path)}]`),item=toggle.locator('xpath=../..');
    await toggle.click();await expect(toggle).toHaveAttribute('aria-busy','true');
    await page.evaluate(()=>(window as any).silentRelease(true));
    await expect(item.getByRole('alert')).toContainText('fixture listing failed');
    await item.locator('[data-tree-retry]').click();
    await expect(item.getByRole('alert')).toHaveCount(0);
    await expect(item).toHaveAttribute('aria-expanded','true');
    expect(await page.evaluate(()=>{const w=window as any;return w.silentCalls.filter((c:any)=>c.args?.path===w.silentPath).length;})).toBe(2);
  });
}
