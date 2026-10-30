import {test,expect} from '@playwright/test';

test('main selected tab joins the pair bar with a consistent shape in all themes and remains scrollable',async({page})=>{
 await page.addInitScript(()=>{
  const profile={id:'sample',name:'Sample server',mode:'sftp',host:'fixture.invalid',port:22,user:'fixture',auth:'key',keyFile:'generated',hostKey:'pin'};
  (window as any).__TAURI__={core:{invoke:async(cmd)=>{
   if(cmd==='load_settings')return {version:1,theme:'light',profiles:[profile],history:{},exclusions:{},syncOptions:{}};
   if(cmd==='default_folder')return 'C:\\generated';
   if(cmd==='list_drives')return [];
   if(cmd==='connect_session')return {path:'/samples',entries:[]};
   if(cmd==='list_local'||cmd==='list_remote')return [];
  }}};
 });
 await page.goto('/');await page.locator('#connect-form .primary').click();
 await expect(page.locator('.bookmark-bar')).toBeVisible();
 await page.locator('#add-tab').click();await page.locator('#connect-form .primary').click();
 for(const theme of ['light','dark','midnight','forest','mint']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.mouse.move(1100,750);
  const shape=await page.locator('.titlebar .tab.active').evaluate(el=>{
   const style=getComputedStyle(el),bar=document.querySelector('.bookmark-bar')!,title=document.querySelector('.titlebar')!;
   return {background:style.backgroundColor,bar:getComputedStyle(bar).backgroundColor,
    foot:getComputedStyle(el,'::before').backgroundImage,radius:parseFloat(style.borderTopLeftRadius),
    gap:bar.getBoundingClientRect().top-title.getBoundingClientRect().bottom,
    inactive:getComputedStyle(document.querySelector('.titlebar .tab:not(.active)')!).backgroundColor};
  });
  expect(shape.background,theme).toBe(shape.bar);expect(shape.foot,theme).toBe('none');
  expect(shape.radius).toBeGreaterThanOrEqual(8);expect(shape.gap).toBe(0);expect(shape.inactive).not.toBe(shape.background);
  await page.locator('.titlebar .tab.active [data-close]').hover();
  await expect(page.locator('.titlebar .tab.active [data-close]')).toBeVisible();
 }
 await page.setViewportSize({width:800,height:600});
 for(let i=0;i<8;i++)await page.locator('#add-tab').click();
 await page.locator('#connect-form .primary').click();
 await expect(page.locator('.bookmark-bar')).toBeVisible();
 const strip=page.locator('.titlebar .tabs');
 expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
 await page.locator('.titlebar .tab').last().locator('[role=tab]').focus();
 expect(await strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
});
