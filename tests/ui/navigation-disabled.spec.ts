import {test,expect} from '@playwright/test';
async function fixture(page,theme){
  await page.addInitScript(({theme})=>{
    window.navCalls=[];window.navHeld=false;window.navRelease={};
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.navCalls.push({cmd,args});
      if(cmd==='load_settings')return {version:1,theme,profiles:[{id:'nav',name:'Navigation',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',keyFile:'generated',hostKey:'pin'}],history:{}};
      if(cmd==='default_folder')return 'C:\\';
      if(cmd==='list_drives')return[{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return{path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote'){
        if(window.navHeld)return new Promise(resolve=>window.navRelease[cmd]=()=>resolve([]));
        return[];
      }
    }}};
  },{theme});
  await page.goto('/');
}
async function connect(page){await page.locator('#connect-form .primary').click();for(const side of ['local','remote'])await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');}
const color=button=>button.evaluate(e=>getComputedStyle(e).color);
const readCount=page=>page.evaluate(()=>window.navCalls.filter(c=>['list_local','list_remote'].includes(c.cmd)).length);
async function clickDisabled(page,button){
  await expect(button).toBeDisabled();const box=await button.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  expect(await button.evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const before=await color(button);await page.mouse.down();
  expect(await color(button)).toBe(before);
  expect(await button.evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await page.mouse.up();
  await button.evaluate(e=>{document.body.tabIndex=-1;document.body.focus();e.focus();});
  await expect(button).not.toBeFocused();await page.keyboard.press('Enter');
}
for(const theme of ['light','dark']){
  test(`disabled navigation icons are explicitly muted at both roots in ${theme}`,async({page})=>{
    await page.setViewportSize({width:800,height:650});await fixture(page,theme);await connect(page);
    const before=await readCount(page);
    for(const side of ['local','remote']){
      const normal=await color(page.locator(`[data-refresh=${side}]`));
      for(const action of ['back','forward','up']){
        const button=page.locator(`[data-${action}=${side}]`);await expect(button).toBeDisabled();
        expect(await color(button)).not.toBe(normal);
        expect(await button.locator('svg').evaluate(e=>getComputedStyle(e).color)).toBe(await color(button));
        await clickDisabled(page,button);
      }
    }
    expect(await readCount(page)).toBe(before);
    await page.mouse.move(5,5);await page.screenshot({path:`test-results/navigation-disabled-${theme}-roots.png`});
  });
  test(`loading disables every navigation action without dispatch and restores normal colors in ${theme}`,async({page})=>{
    await fixture(page,theme);await connect(page);
    const normals={};for(const side of ['local','remote'])normals[side]=await color(page.locator(`[data-refresh=${side}]`));
    await page.evaluate(()=>window.navHeld=true);
    for(const side of ['local','remote']){await page.locator(`[data-refresh=${side}]`).click();await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','true');}
    const before=await readCount(page);
    for(const side of ['local','remote'])for(const action of ['back','forward','up','refresh']){
      const button=page.locator(`[data-${action}=${side}]`);await expect(button).toBeDisabled();expect(await color(button)).not.toBe(normals[side]);await clickDisabled(page,button);
    }
    expect(await readCount(page)).toBe(before);
    await page.screenshot({path:`test-results/navigation-disabled-${theme}-loading.png`});
    await page.evaluate(()=>{window.navHeld=false;Object.values(window.navRelease).forEach(release=>release())});
    for(const side of ['local','remote']){await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');const button=page.locator(`[data-refresh=${side}]`);await expect(button).toBeEnabled();expect(await color(button)).toBe(normals[side]);}
  });
}
test('unconnected workspace has no folder navigation controls',async({page})=>{
  await fixture(page,'dark');await expect(page.locator('#connect-form')).toBeVisible();await expect(page.locator('.pane,.path-navigation')).toHaveCount(0);
});
