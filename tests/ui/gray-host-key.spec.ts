import { test, expect } from '@playwright/test';
const pin='SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function setup(page, hostKey=pin, theme='light', mismatch=false) {
 await page.addInitScript(({hostKey,theme,mismatch})=>{
  window.calls=[];
  window.__TAURI__={core:{invoke:async(cmd,args)=>{
   window.calls.push({cmd,args});
   if(cmd==='load_settings'){
    if(!localStorage.getItem('gray-settings'))localStorage.setItem('gray-settings',JSON.stringify({version:1,profiles:[{id:'fixture',name:'Fixture',host:'fixture.invalid',port:2222,user:'fixture',mode:'sftp',auth:'key',keyFile:'fixture.ppk',hostKey}],history:{},theme}));
    return JSON.parse(localStorage.getItem('gray-settings'));
   }
   if(cmd==='save_settings'){localStorage.setItem('gray-settings',JSON.stringify(args.data));return;}
   if(cmd==='default_folder')return 'C:\\fixture';
   if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
   if(cmd==='list_local'||cmd==='list_remote')return [];
   if(cmd==='probe_host_key')return {requestId:args.requestId,token:'fixture-token',host:args.profile.host,port:args.profile.port,algorithm:'ssh-ed25519',fingerprint:'SHA256:fixture-candidate',expiresInSeconds:120};
   if(cmd==='connect_session'){if(mismatch)throw Error('host key mismatch');return {path:'/',entries:[]};}
  }}};
 },{hostKey,theme,mismatch});
 await page.goto('/');
 await expect(page.locator('#connect-form')).toBeVisible();
}
const calls=(page,cmd)=>page.evaluate(cmd=>window.calls.filter(c=>c.cmd===cmd).length,cmd);
const savedPin=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('gray-settings')).profiles[0].hostKey);
async function editor(page){await page.locator('#edit-profile').click();await expect(page.locator('#profile-form')).toBeVisible();return page.locator('#profile-form [name=hostKey]');}
async function save(page){await page.locator('#profile-form .primary').click();await expect(page.locator('#profile-form')).toHaveCount(0);}

test('existing host pin is readonly and selectable',async({page})=>{
 await setup(page); const input=await editor(page);
 await expect(input).toHaveAttribute('readonly',''); await expect(input).toHaveValue(pin);
 await input.focus();await input.press('Control+A');
 expect(await input.evaluate(e=>e.selectionEnd-e.selectionStart)).toBe(pin.length);
 await input.press('X');await expect(input).toHaveValue(pin);
 await page.screenshot({path:'test-results/gray-host-key-readonly.png'});
});
test('tampered readonly DOM value cannot replace the saved host pin',async({page})=>{
 await setup(page);const input=await editor(page);
 await input.evaluate(e=>e.value='SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
 await save(page);expect(await savedPin(page)).toBe(pin);
 expect(await calls(page,'connect_session')).toBe(0);expect(await calls(page,'probe_host_key')).toBe(0);
 await page.reload();await editor(page);await expect(page.locator('[name=hostKey]')).toHaveValue(pin);
});
test('blank readonly pin saves blank and first connect probes without authentication',async({page})=>{
 await setup(page,'');const input=await editor(page);
 await expect(input).toHaveAttribute('readonly','');await expect(input).toHaveAttribute('placeholder','初回接続時に確認');
 await save(page);expect(await savedPin(page)).toBe('');expect(await calls(page,'probe_host_key')).toBe(0);
 await page.locator('#connect-form .primary').click();await expect(page.locator('#host-key-fingerprint')).toHaveText('SHA256:fixture-candidate');
 expect(await calls(page,'probe_host_key')).toBe(1);expect(await calls(page,'connect_session')).toBe(0);expect(await calls(page,'list_remote')).toBe(0);expect(await calls(page,'start_sync')).toBe(0);
});
test('an existing mismatched pin never opens first-use approval',async({page})=>{
 await setup(page,pin,'light',true);await page.locator('#connect-form .primary').click();
 await expect.poll(()=>calls(page,'connect_session')).toBe(1);
 await expect(page.locator('#connect-form .form-error')).toContainText('host key mismatch');
 await expect(page.locator('#host-key-overlay')).toHaveCount(0);expect(await calls(page,'probe_host_key')).toBe(0);expect(await calls(page,'approve_host_key')).toBe(0);expect(await savedPin(page)).toBe(pin);
});
async function palette(page,selectors){return await page.evaluate((selectors)=>{
  const rgb=s=>(s.match(/[\d.]+/g)||[]).map(Number).slice(0,3);
  const lum=s=>rgb(s).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  return selectors.map(selector=>{
   const el=document.querySelector(selector),s=getComputedStyle(el);let p=el,bg=s.backgroundColor;
   while(bg==='rgba(0, 0, 0, 0)'&&p.parentElement){p=p.parentElement;bg=getComputedStyle(p).backgroundColor;}
   return {selector,bg,fg:s.color,spread:Math.max(...rgb(bg))-Math.min(...rgb(bg)),contrast:(Math.max(lum(bg),lum(s.color))+.05)/(Math.min(lum(bg),lum(s.color))+.05)};
  });
 },selectors);}


test('dark neutral surfaces keep readable text contrast',async({page})=>{
 await setup(page,pin,'dark');await editor(page);
 const samples=await palette(page,['body','#profile-form','#profile-form [name=hostKey]','#profile-form [name=name]','#cancel']);
 console.log('DARK_DIALOG_PALETTE',JSON.stringify(samples));
 await test.info().attach('palette',{body:JSON.stringify(samples,null,2),contentType:'application/json'});
 for(const sample of samples){expect(sample.spread,JSON.stringify(sample)).toBeLessThanOrEqual(8);expect(sample.contrast,JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);}
 await page.screenshot({path:'test-results/gray-host-key-dark.png'});
 await page.locator('#cancel').click();await page.locator('#connect-form .primary').click();await expect(page.locator('#prepare')).toBeVisible();
 await page.locator('#settings-toggle').click();
 const chrome=await palette(page,['.titlebar','.pane > header','.folder-tree','.tree-caption','[data-list=local]','[data-list=remote]','th','#settings-popup','#theme-select']);
 console.log('DARK_WORKSPACE_PALETTE',JSON.stringify(chrome));
 await test.info().attach('workspace-palette',{body:JSON.stringify(chrome,null,2),contentType:'application/json'});
 for(const sample of chrome){expect(sample.spread,JSON.stringify(sample)).toBeLessThanOrEqual(8);expect(sample.contrast,JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);}
 await page.setViewportSize({width:800,height:650});await page.screenshot({path:'test-results/gray-host-key-workspace-dark.png'});
});
test('light surfaces retain the existing palette',async({page})=>{
 await setup(page);await editor(page);
 const samples=await page.evaluate(()=>['body','#profile-form [name=hostKey]','#cancel'].map(selector=>{const s=getComputedStyle(document.querySelector(selector));return {selector,bg:s.backgroundColor,fg:s.color};}));
 await test.info().attach('light-baseline',{body:JSON.stringify(samples,null,2),contentType:'application/json'});
 console.log('LIGHT_BASELINE',JSON.stringify(samples));
 expect(samples).toEqual([{selector:'body',bg:'rgb(242, 245, 249)',fg:'rgb(36, 51, 72)'},{selector:'#profile-form [name=hostKey]',bg:'rgb(255, 255, 255)',fg:'rgb(35, 58, 89)'},{selector:'#cancel',bg:'rgb(255, 255, 255)',fg:'rgb(53, 71, 93)'}]);
 await page.screenshot({path:'test-results/gray-host-key-light.png'});
});
