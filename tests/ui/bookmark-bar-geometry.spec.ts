import {test,expect} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';
const out=path.resolve(process.env.NEARLY_BOOKMARK_GEOMETRY_OUTPUT||'../editor-tabs-eight-final');fs.mkdirSync(out,{recursive:true});
test('pair local and remote bookmark bars share pair height while registered item shapes and density remain intact',async({page})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{const p={id:'generated',name:'Generated server',mode:'sftp',host:'fixture.invalid',port:2222,user:'sample',auth:'key',hostKey:'pin'},key=JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{const n=Number(localStorage.getItem('geometry-count')||0);if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[p],history:{},folderBookmarks:Array.from({length:n},(_,i)=>({id:'p'+i,name:'Pair '+i,local:'C:\\generated\\'+i,remote:'/generated/'+i,connectionKey:key})),localBookmarks:Array.from({length:n},(_,i)=>({id:'l'+i,name:'Local '+i,path:'C:\\generated\\'+i})),remoteBookmarks:Array.from({length:n},(_,i)=>({id:'r'+i,name:'Remote '+i,path:'/generated/'+i,connectionKey:key}))};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];if(cmd==='connect_session')return {path:'/generated',entries:[]};if(cmd==='list_local'||cmd==='list_remote')return [];}}};});
 await page.goto('/');const measurements:any[]=[];
 for(const count of [0,3,20]){
  await page.evaluate(n=>localStorage.setItem('geometry-count',String(n)),count);await page.reload();await page.locator('#connect-form .primary').click();await expect(page.locator('.bookmark-bar')).toBeVisible();
  for(const width of [1280,640])for(const compact of [false,true])for(const theme of ['light','dark','midnight','forest','mint']){
   await page.setViewportSize({width,height:920});await page.evaluate(({compact,theme})=>{document.documentElement.dataset.compactExplorer=String(compact);document.documentElement.dataset.theme=theme;},{compact,theme});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const bars=[];for(const selector of ['.bookmark-bar','#local-bookmarks','#remote-bookmarks']){
    const bar=page.locator(selector);const normal=await bar.evaluate(el=>{const s=getComputedStyle(el);return {height:el.getBoundingClientRect().height,padding:[s.paddingTop,s.paddingBottom],items:[...el.querySelectorAll('.bookmark-items > .bookmark-tree-item')].map(item=>{const c=getComputedStyle(item);return {radius:c.borderRadius,height:item.getBoundingClientRect().height,font:c.fontSize,icon:item.querySelector('svg')?.getBoundingClientRect().height??null,before:getComputedStyle(item,'::before').content,after:getComputedStyle(item,'::after').content};})};});
    const item=bar.locator('.bookmark-items > .bookmark-tree-item:visible').first();let hovered=null;
    if(await item.count()){await item.hover();hovered=await item.evaluate(el=>({radius:getComputedStyle(el).borderRadius,height:el.getBoundingClientRect().height}));await page.keyboard.press('Tab');await item.focus();await expect(item).toBeFocused();expect(await item.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid');}
    bars.push({selector,...normal,hovered});
   }
   measurements.push({count,width,compact,theme,bars});fs.writeFileSync(path.join(out,'bookmark-measurements.json'),JSON.stringify(measurements,null,2));
   if(count===3&&width===1280&&!compact&&['light','forest'].includes(theme)){fs.mkdirSync(path.join(out,'qa'),{recursive:true});await page.mouse.move(1100,850);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});await page.screenshot({path:path.join(out,'qa',`bookmarks-${theme}.png`)});}
  }
 }
 // Keep the pair baseline explicit; do not change it to make the side bars pass.
 for(const row of measurements){expect(row.bars[0].height).toBe(39);for(const bar of row.bars){expect(bar.height,`${row.theme}/${row.width}/${row.compact}/${row.count} ${bar.selector}`).toBe(39);for(const item of bar.items){expect(item.radius).toBe('4px');expect(item.font).toBe('11px');}if(bar.hovered)expect(bar.hovered.radius).toBe('4px');}}
});
