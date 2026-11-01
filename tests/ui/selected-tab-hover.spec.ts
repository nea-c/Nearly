import {test,expect,type Page} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';
const out=path.resolve('../editor-selected-hover/qa');fs.mkdirSync(out,{recursive:true});
test('selected main and editor tabs retain exact normal pixels on label hover, with close and inactive hover intact',async({page,context})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();await page.locator('#add-tab').click();
 const editor=await context.newPage();await editor.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};if(cmd==='load_settings')return {theme:'forest',language:'en'};if(cmd==='list_text_documents')return ['first','second'].map(token=>({token,path:'/generated/'+token+'.js',side:'remote',connectionLabel:'Generated server',text:'// generated',encoding:'UTF-8',newline:'LF'}));}},event:{listen:async()=>()=>{}}};});
 await editor.goto('/editor.html');await expect(editor.locator('.editor-tab')).toHaveCount(2);
 const rows:any[]=[];
 async function different(owner:Page,a:Buffer,b:Buffer){return owner.evaluate(async images=>{const data=await Promise.all(images.map(async png=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const g=c.getContext('2d')!;g.drawImage(image,0,0);return g.getImageData(0,0,c.width,c.height).data;}));let n=0;for(let i=0;i<data[0].length;i+=4)if([0,1,2,3].some(k=>data[0][i+k]!==data[1][i+k]))n++;return n;},[a.toString('base64'),b.toString('base64')]);}
 for(const theme of ['light','dark','midnight','forest','mint']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await editor.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const [name,owner,selector] of [['main',page,'.titlebar .tab'],['editor',editor,'.editor-tab']] as const){
   const tab=owner.locator(selector).first(),label=tab.locator('[role=tab]'),close=tab.locator('button:not([role=tab])');await label.click();
   for(const dirty of name==='editor'?[false,true]:[false]){
    if(name==='editor')await owner.locator('textarea:visible').fill(dirty?'// generated dirty':'// generated');
    await owner.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await owner.mouse.move(1100,800);
    const normal=await tab.screenshot({scale:'css'});await label.hover();const hovered=await tab.screenshot({scale:'css'});const same=await different(owner,normal,hovered);
    rows.push({theme,name,dirty,labelHoverChangedPixels:same});fs.writeFileSync(path.join(out,'selected-hover-measurements.json'),JSON.stringify(rows,null,2));
    fs.writeFileSync(path.join(out,`${theme}-${name}-${dirty?'dirty':'saved'}-normal.png`),normal);fs.writeFileSync(path.join(out,`${theme}-${name}-${dirty?'dirty':'saved'}-hover.png`),hovered);
    expect.soft(same,`${theme}/${name}/${dirty} selected label hover`).toBe(0);
    await close.hover();const closeShot=await tab.screenshot({scale:'css'});expect(await different(owner,normal,closeShot)).toBeGreaterThan(0);
    expect(await close.evaluate(el=>({width:getComputedStyle(el,'::before').width,opacity:getComputedStyle(el,'::before').opacity}))).toEqual({width:'18px',opacity:'1'});
    if(dirty){await expect(close.locator('.editor-tab-cross')).toBeVisible();await expect(close.locator('.editor-tab-dirty')).toBeHidden();}
    await owner.mouse.move(1100,800);await owner.keyboard.press('Tab');await close.focus();await expect(close).toHaveCSS('outline-style','solid');expect(await close.evaluate(el=>getComputedStyle(el,'::before').opacity)).toBe('1');
    if(dirty)await expect(close.locator('.editor-tab-cross')).toBeVisible();
   }
   await owner.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await owner.mouse.move(1100,800);const inactive=owner.locator(selector).last();
   const before=await inactive.screenshot({scale:'css'});await inactive.locator('[role=tab]').hover();expect(await different(owner,before,await inactive.screenshot({scale:'css'}))).toBeGreaterThan(0);
  }
 }
 await editor.close();
});
