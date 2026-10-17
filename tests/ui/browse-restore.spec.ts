import { test, expect } from '@playwright/test';

async function fixture(page) {
  await page.addInitScript(() => {
    window.calls=[];
    const profile={id:'browse',name:'Browse fixture',host:'fixture.invalid',port:22,user:'test',auth:'key',mode:'sftp',hostKey:'pin'};
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.calls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('saved')||'null')??{version:1,profiles:[profile],history:{}};
      if(cmd==='save_settings'){localStorage.setItem('saved',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\default';
      if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
      if(cmd==='connect_session')return {path:'/home',entries:[{name:'home.txt',dir:false,size:1}]};
      if(cmd==='list_local'||cmd==='list_remote'){
        if(cmd==='list_local' && localStorage.getItem('all-local-missing')) throw Error('local unavailable');
        if(localStorage.getItem('missing') && (args.path==='C:\\remembered'||args.path==='/remembered')) throw Error('fixture path missing');
        return [{name:'file.txt',dir:false,size:2}];
      }
    }}};
  });
}
async function connect(page){await page.locator('#connect-form .primary').click();await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');}
async function go(page,side,path){await page.locator(`#${side}-path`).fill(path);await page.locator(`#${side}-path`).press('Enter');await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');}
test('successful browse locations restore only after authentication and remain separate from sync defaults',async({page})=>{
  await fixture(page);await page.goto('/');await connect(page);
  await go(page,'local','C:\\remembered');await go(page,'remote','/remembered');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('saved')).browseLocations)).toEqual({'["browse","sftp","fixture.invalid",22,"test","pin"]':{local:'C:\\remembered',remote:'/remembered'}});
  await page.reload();await expect(page.locator('#connect-form')).toBeVisible();
  expect(await page.evaluate(()=>window.calls.filter(c=>['list_local','list_remote','start_sync'].includes(c.cmd)))).toEqual([]);
  await connect(page);await expect(page.locator('#local-path')).toHaveValue('C:\\remembered');await expect(page.locator('#remote-path')).toHaveValue('/remembered');
  await expect(page.locator('[data-back=local]')).toBeDisabled();await expect(page.locator('[data-back=remote]')).toBeDisabled();
  expect(await page.evaluate(()=>window.calls.some(c=>c.cmd==='start_sync'))).toBe(false);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('saved')).history)).toEqual({});
});
test('a successful remote home persists independently when local browsing fails',async({page})=>{
  await fixture(page);await page.goto('/');await page.evaluate(()=>localStorage.setItem('all-local-missing','yes'));
  await connect(page);
  await expect(page.locator('main > .notice')).toContainText('local unavailable');
  await expect.poll(()=>page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('saved')).browseLocations)[0])).toEqual({remote:'/home'});
});
test('missing restored folders show a bottom notice and retain only successful fallbacks',async({page})=>{
  await fixture(page);await page.goto('/');await connect(page);await go(page,'local','C:\\remembered');await go(page,'remote','/remembered');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('saved')).browseLocations)).not.toEqual({});
  await page.evaluate(()=>localStorage.setItem('missing','yes'));await page.reload();await connect(page);
  await expect(page.locator('#local-path')).toHaveValue('C:\\default');await expect(page.locator('#remote-path')).toHaveValue('/home');
  await expect(page.locator('main > .notice')).toContainText('前回フォルダ');
  expect(await page.locator('main').evaluate(e=>e.lastElementChild.classList.contains('notice'))).toBe(true);
  await expect.poll(()=>page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('saved')).browseLocations)[0])).toEqual({local:'C:\\default',remote:'/home'});
});
