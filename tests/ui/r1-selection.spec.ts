import {test,expect} from '@playwright/test';
async function boot(page){
  await page.addInitScript(()=>{
    const profile=(id,name)=>({id,name,host:`${id}.invalid`,port:22,user:'fixture',auth:'key',mode:'sftp',keyFile:'',hostKey:''});
    const initial={version:1,settingsRevision:1,theme:'forest',language:'ja',profiles:[profile('alpha','Alpha'),profile('beta','Beta')],history:{sentinel:'keep'},connectionTree:{version:1,nodes:[{id:'saved-group',kind:'group',name:'Saved',parentId:null,expanded:true},{id:'alpha',kind:'profile',profileId:'alpha',parentId:null},{id:'beta',kind:'profile',profileId:'beta',parentId:null}]}};
    window.calls=[];
    window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(command,args)=>{
      window.calls.push({command,args});
      if(command==='load_settings')return JSON.parse(localStorage.getItem('r1-selection-state')||'null')||initial;
      if(command==='save_settings'){const next={...args.data,settingsRevision:(JSON.parse(localStorage.getItem('r1-selection-state')||'null')?.settingsRevision||1)+1};localStorage.setItem('r1-selection-state',JSON.stringify(next));return next.settingsRevision;}
      if(command==='default_folder')return 'C:\\isolated';
      if(command==='list_drives')return [{path:'C:\\',name:'C:'}];
      if(command==='list_local')return [];
      if(['prepare_session','connect_session','start_sync','list_remote'].includes(command))throw Error('Unexpected connection: '+command);
      return undefined;
    }}};
  });await page.goto('/');await expect(page.locator('#connect-form')).toBeVisible();
}
async function noConnection(page){expect(await page.evaluate(()=>window.calls.filter(x=>['prepare_session','connect_session','start_sync','list_remote'].includes(x.command)))).toEqual([]);await expect(page.locator('#prepare')).toHaveCount(0);await expect(page.locator('[data-tab]')).toHaveCount(1);}
test('last clicked saved profile restores before connection and survives rename/deletion',async({page})=>{
  await boot(page);await page.locator('[data-connection-select=beta]').click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('r1-selection-state')||'{}').lastSelectedProfileId)).toBe('beta');
  await page.reload();await expect(page.locator('[data-connection-node=beta]')).toHaveAttribute('aria-selected','true');await noConnection(page);
  await page.locator('#edit-profile').click();await page.locator('#profile-form [name=name]').fill('Beta renamed');await page.locator('#profile-form .primary').click();await expect(page.locator('#profile-form')).toHaveCount(0);
  await page.reload();await expect(page.locator('[data-connection-node=beta]')).toHaveAttribute('aria-selected','true');await expect(page.locator('[data-connection-select=beta]')).toContainText('Beta renamed');await noConnection(page);
  await page.locator('[data-connection-node=beta]').click({button:'right'});await page.locator('[data-menu-action=delete]').click();await page.locator('#connection-node-submit').click();await expect(page.locator('[data-connection-node=beta]')).toHaveCount(0);
  await page.reload();await expect(page.locator('[data-connection-node=alpha]')).toHaveAttribute('aria-selected','true');await noConnection(page);
});
test('selecting a group does not erase the last saved connection choice',async({page})=>{
  await boot(page);await page.locator('[data-connection-select=beta]').click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('r1-selection-state')||'{}').lastSelectedProfileId)).toBe('beta');
  await page.locator('[data-connection-select=saved-group]').click();await page.reload();
  await expect(page.locator('[data-connection-node=beta]')).toHaveAttribute('aria-selected','true');await noConnection(page);
});
