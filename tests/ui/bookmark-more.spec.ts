import {test,expect} from '@playwright/test';
for(const theme of ['light','dark'])test(`paired overflow chevron is centered only when needed; context access retains root actions in ${theme}`,async({page})=>{
 await page.addInitScript(({theme})=>{
  const p={id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
  const key=JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);
  window.__TAURI__={core:{invoke:async(cmd,args)=>{
   if(cmd==='load_settings')return JSON.parse(localStorage.getItem('more-fixture')||'null')||{version:1,theme,profiles:[p],history:{},folderBookmarks:[]};
   if(cmd==='save_settings'){localStorage.setItem('more-fixture',JSON.stringify(args.data));return;}
   if(cmd==='default_folder')return 'C:\\root';if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
   if(cmd==='connect_session')return {path:'/',entries:[]};if(cmd==='list_local'||cmd==='list_remote')return [];
  }}};
  window.overflowProfileKey=key;
 },{theme});
 await page.goto('/');await page.locator('#connect-form .primary').click();
 const more=page.locator('#bookmark-more'),tools=page.locator('.bookmark-bar');
 await expect(more).toBeHidden();await expect(tools).toBeVisible();await expect(page.locator('#bookmark-tools')).toHaveCount(0);
 await tools.click({button:'right',position:{x:2,y:2}});await expect(page.locator('#bookmark-tree-context')).toBeVisible();
 expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.map(e=>e.getAttribute('data-bookmark-action')))).toEqual(['register','create','history']);
 await page.keyboard.press('Escape');await expect(page.locator('#bookmark-tree-context')).toHaveCount(0);
 const toolsBox=await tools.boundingBox();expect(toolsBox.width).toBeGreaterThanOrEqual(24);expect(toolsBox.height).toBeGreaterThanOrEqual(24);
 await tools.click({button:'right',position:{x:2,y:toolsBox.height/2}});await expect(page.locator('#bookmark-tree-context')).toBeVisible();
 await page.keyboard.press('Escape');await expect(tools).toBeFocused();
 await page.evaluate(()=>{
  const data=JSON.parse(localStorage.getItem('more-fixture'));
  data.folderBookmarks=Array.from({length:40},(_,i)=>({id:'pair'+i,name:'Long paired bookmark '+i,local:'C:\\pair'+i,remote:'/pair'+i,connectionKey:window.overflowProfileKey}));
  localStorage.setItem('more-fixture',JSON.stringify(data));
 });
 await page.reload();await page.locator('#connect-form .primary').click();await expect(more).toBeVisible();
 await expect(more.locator('svg')).toHaveAttribute('aria-hidden','true');await expect(more.locator('svg circle')).toHaveCount(0);
 await expect(more.locator('svg path')).toHaveAttribute('d','m3 4 4 4-4 4m6-8 4 4-4 4');
 const geometry=await more.evaluate(el=>{const b=el.getBoundingClientRect(),s=el.querySelector('svg').getBoundingClientRect();return {width:b.width,height:b.height,dx:s.x+s.width/2-b.x-b.width/2,dy:s.y+s.height/2-b.y-b.height/2};});
 expect(geometry.width).toBeGreaterThanOrEqual(24);expect(geometry.height).toBeGreaterThanOrEqual(24);
 expect(Math.abs(geometry.dx)).toBeLessThanOrEqual(.5);expect(Math.abs(geometry.dy)).toBeLessThanOrEqual(.5);
 await expect(more).toHaveAttribute('aria-label',/\S/);await expect(more).toHaveAttribute('title',/\S/);
 await more.click({position:{x:2,y:geometry.height/2}});await expect(page.locator('#bookmark-overflow-menu')).toBeVisible();
 expect(await page.locator('#bookmark-overflow-menu [data-bookmark-open]').count()).toBeGreaterThan(0);
 await page.keyboard.press('Escape');await expect(page.locator('#bookmark-overflow-menu')).toHaveCount(0);await expect(more).toBeFocused();
 await tools.click({button:'right',position:{x:2,y:2}});expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.map(e=>e.getAttribute('data-bookmark-action')))).toEqual(['register','create','history']);
 await page.keyboard.press('Escape');await page.screenshot({path:`test-results/bookmark-more-${theme}.png`});
});
