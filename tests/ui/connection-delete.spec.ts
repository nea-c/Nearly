import {test,expect} from '@playwright/test';

async function setup(page, theme='light') {
  await page.addInitScript(({theme})=>{
    window.calls=[];
    const profile=(id,name)=>({id,name,host:`${id}.invalid`,port:22,user:'fixture',mode:'sftp',auth:'key',keyFile:'fixture.ppk',hostKey:`fixture-${id}`});
    const initial={version:1,profiles:[profile('a','Alpha'),profile('b','Beta')],theme,history:{},connectionTree:{version:1,nodes:[{id:'g',kind:'group',name:'Sites',parentId:null,expanded:true},{id:'a',kind:'profile',profileId:'a',parentId:'g'},{id:'b',kind:'profile',profileId:'b',parentId:null}]}};
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.calls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('delete-settings')||'null')||initial;
      if(cmd==='save_settings'){
        if(window.failSave)throw Error('fixture save denied');
        if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);
        localStorage.setItem('delete-settings',JSON.stringify(args.data));return;
      }
      if(cmd==='default_folder')return 'C:\\fixture';
      if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
      if(cmd==='connect_session'){
        if(window.holdConnect)await new Promise(resolve=>window.releaseConnect=resolve);
        return {path:'/',entries:[]};
      }
      if(cmd==='list_local'||cmd==='list_remote')return [];
      if(cmd==='sync_status')return window.jobStatus||{status:'running',pending:0,sent:0,speed:0,latency:0,errorCount:0,logs:[]};
    }}};
  },{theme});
  await page.goto('/');
  await expect(page.locator('#connection-tree')).toBeVisible();
}
async function menu(page,id) {
  if(id)await page.locator(`[data-connection-node="${id}"]`).click({button:'right'});
  else {const tree=page.locator('#connection-tree');const box=await tree.boundingBox();await tree.click({button:'right',position:{x:8,y:box.height-8}});}
}
const saved=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('delete-settings')||'null'));
async function deletion(page,id){await menu(page,id);await page.locator('[data-menu-action=delete]').click();await expect(page.locator('#connection-node-form')).toBeVisible();}

test('right-click profile targets that row; edit and move leave context while settings remains',async({page})=>{
 await setup(page);
 await page.locator('[data-connection-select=b]').click();
 await menu(page,'a');
 await expect(page.locator('[data-connection-node=a]')).toHaveAttribute('aria-selected','true');
 await expect(page.locator('[data-menu-action=edit],[data-menu-action=move]')).toHaveCount(0);
 await expect(page.locator('[data-menu-action=delete]')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.locator('#edit-profile')).toBeVisible();
 await page.locator('#edit-profile').click();
 await expect(page.locator('#profile-form [name=name]')).toHaveValue('Alpha');
 await page.locator('#cancel').click();
 await menu(page,null);
 await expect(page.locator('[data-menu-action=delete]')).toHaveCount(0);
 await expect(page.locator('[data-menu-action=add-profile]')).toBeVisible();
});

test('profile deletion cancellation and failed save preserve data, successful deletion persists',async({page})=>{
 await setup(page);await deletion(page,'a');
 await expect(page.locator('#connection-tree-dialog')).toContainText('Alpha');
 await page.locator('#connection-node-cancel').click();
 await expect(page.locator('[data-connection-node=a]')).toBeVisible();
 expect(await saved(page)).toBeNull();
 await page.evaluate(()=>window.failSave=true);await deletion(page,'a');
 await page.locator('#connection-node-submit').click();
 await expect(page.locator('#connection-node-form .form-error')).toContainText('fixture save denied');
 await expect(page.locator('[data-connection-node=a]')).toBeVisible();
 expect(await saved(page)).toBeNull();
 await page.evaluate(()=>window.failSave=false);
 await page.locator('#connection-node-submit').click();
 await expect(page.locator('#connection-node-form')).toHaveCount(0);
 await expect(page.locator('[data-connection-node=a]')).toHaveCount(0);
 expect((await saved(page)).profiles.map(p=>p.id)).toEqual(['b']);
 await page.reload();await expect(page.locator('[data-connection-node=a]')).toHaveCount(0);
 await expect(page.locator('[data-connection-node=b]')).toBeVisible();
});

test('group deletion promotes children and last-profile deletion stays empty after reload',async({page})=>{
 await setup(page);await deletion(page,'g');
 await expect(page.locator('#connection-tree-dialog')).toContainText('Sites');
 await page.locator('#connection-node-submit').click();
 await expect(page.locator('[data-connection-node=g]')).toHaveCount(0);
 let state=await saved(page);expect(state.profiles.map(p=>p.id)).toEqual(['a','b']);
 expect(state.connectionTree.nodes.find(n=>n.id==='a').parentId).toBeNull();
 await deletion(page,'a');await page.locator('#connection-node-submit').click();
 await expect(page.locator('[data-connection-node=a]')).toHaveCount(0);
 await deletion(page,'b');await page.locator('#connection-node-submit').click();
 await expect(page.locator('[data-connection-node]')).toHaveCount(0);
 await page.reload();await expect(page.locator('#connection-tree')).toBeVisible();
 await expect(page.locator('[data-connection-node]')).toHaveCount(0);
 expect((await saved(page)).profiles).toEqual([]);
});

test('connected and synchronizing profiles cannot be deleted from another tab',async({page})=>{
 await setup(page);await page.locator('[data-connection-select=a]').click();
 await page.locator('#connect-form .primary').click();await expect(page.locator('#prepare')).toBeEnabled();
 const first=await page.locator('[data-tab][aria-selected=true]').getAttribute('data-tab');
 await page.locator('#add-tab').click();await deletion(page,'a');
 await expect(page.locator('#connection-node-submit')).toBeDisabled();
 await expect(page.locator('#connection-tree-dialog .form-error')).not.toBeEmpty();
 await page.locator('#connection-node-cancel').click();
 await page.locator(`[data-tab="${first}"]`).click();await page.locator('#prepare').click();
 await page.locator('#start-form .primary').click();
 await expect(page.locator('#prepare')).toHaveClass(/destructive/);
 await page.locator('#add-tab').click();await deletion(page,'a');
 await expect(page.locator('#connection-node-submit')).toBeDisabled();
 await page.locator('#connection-node-cancel').click();
 expect((await saved(page)).profiles.map(p=>p.id)).toEqual(['a','b']);
});

test('connecting profile blocks management until its connection settles',async({page})=>{
 await setup(page);await page.evaluate(()=>window.holdConnect=true);
 await page.locator('[data-connection-select=a]').click();await page.locator('#connect-form .primary').click();
 await expect.poll(()=>page.evaluate(()=>!!window.releaseConnect)).toBe(true);
 await page.locator('[data-connection-node=a]').dispatchEvent('contextmenu',{clientX:150,clientY:150});
 await expect(page.locator('#connection-context-menu')).toHaveCount(0);
 await expect(page.locator('#edit-profile')).toBeDisabled();
 expect(await saved(page)).toBeNull();
 await page.evaluate(()=>{window.holdConnect=false;window.releaseConnect();});
 await expect(page.locator('#prepare')).toBeEnabled();
});

test('stale confirmation cannot delete a profile that connected after it opened',async({page})=>{
 await setup(page);await deletion(page,'a');
 await page.evaluate(()=>{
   window.staleDelete=document.querySelector('#connection-node-form');
   document.querySelector('#connect-form').requestSubmit();
 });
 await expect(page.locator('#prepare')).toBeEnabled();
 await page.evaluate(()=>window.staleDelete.requestSubmit());
 await page.locator('#add-tab').click();
 await expect(page.locator('[data-connection-node=a]')).toBeVisible();
 const writes=await page.evaluate(()=>window.calls.filter(c=>c.cmd==='save_settings').map(c=>c.args.data));
 expect(writes.every(data=>data.profiles.some(p=>p.id==='a'))).toBe(true);
});

for(const theme of ['light','dark'])test(`${theme} delete is red with readable hover and focus, screenshots retain settings`,async({page})=>{
 await setup(page,theme);await page.setViewportSize({width:800,height:650});
 await menu(page,'a');const item=page.locator('[data-menu-action=delete]');
 await expect(item).toHaveText('削除');
 await item.hover();
 const palette=await item.evaluate(el=>{
   const c=getComputedStyle(el);return {color:c.color,background:c.backgroundColor};
 });
 const contrast=(fg,bg)=>{
  const lum=s=>{const rgb=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 };
 expect(contrast(palette.color,palette.background)).toBeGreaterThanOrEqual(4.5);
 expect(palette.color).toBe(theme==='light'?'rgb(179, 38, 30)':'rgb(255, 218, 214)');
 await item.focus();await expect(item).toBeFocused();
 await page.screenshot({path:`test-results/connection-delete-${theme}-menu.png`});
 await item.click();await expect(page.locator('#connection-node-submit')).toBeInViewport({ratio:1});
 await page.screenshot({path:`test-results/connection-delete-${theme}-confirm.png`});
});
