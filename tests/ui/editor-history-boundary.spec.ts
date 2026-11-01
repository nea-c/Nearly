import {test,expect} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';
import {capturedHistoryBorder,outerHostHistoryDiagnostic} from './paint-diagnostic.js';
const themes=['light','dark','midnight','forest','mint'];
for(const mode of ['post-on-failure','pre-post','no-mask'] as const)test('exact original interaction history with '+mode+' capture boundaries',async({page,context})=>{
 const out=path.resolve('../release-r4-pre7-history-boundary/qa/'+mode);fs.mkdirSync(out,{recursive:true});
 test.setTimeout(240000);
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();for(let i=0;i<4;i++)await page.locator('#add-tab').click();
 const editor=await context.newPage();await editor.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};if(cmd==='load_settings')return {theme:'forest',language:'en'};if(cmd==='list_text_documents')return ['first','second','middle','fourth','last'].map(token=>({token,path:'/generated/'+token+'.js',side:'remote',connectionLabel:'Generated server',text:Array.from({length:32},(_,i)=>'const generatedLine'+i+' = '+i+';').join('\n'),encoding:'UTF-8',newline:'LF'}));}},event:{listen:async()=>()=>{}}};});
 await editor.goto('/editor.html');await expect(editor.locator('.editor-tab')).toHaveCount(5);
 const records:any[]=[],paint:any[]=[];let outerObserved=false;
 async function paintedDifference(main:any,edit:any){
  const elements=[main,edit],owners=[page,editor],boxes=await Promise.all(elements.map(el=>el.boundingBox()));
  // Keep real button backgrounds, borders and focus paint. Only semantic
  // connection icons / document text and glyph ink are excluded here; their
  // metrics and close ink are tested independently in the unmasked UI.
  const before=mode==='pre-post'?await Promise.all(owners.map(owner=>owner.screenshot({scale:'css'}))):null;
  if(mode!=='no-mask')for(const el of elements)await el.evaluate((node:Element)=>{for(const span of node.querySelectorAll<HTMLElement>('button > span')){span.dataset.qaVisibility=span.style.visibility;span.style.visibility='hidden';}});
  const pngs=await Promise.all(owners.map(owner=>owner.screenshot({scale:'css'})));
  if(mode!=='no-mask')for(const el of elements)await el.evaluate((node:Element)=>{for(const span of node.querySelectorAll<HTMLElement>('button > span')){span.style.visibility=span.dataset.qaVisibility??'';delete span.dataset.qaVisibility;}});
  const after=mode==='pre-post'?await Promise.all(owners.map(owner=>owner.screenshot({scale:'css'}))):null;
  const result=await editor.evaluate(async({pngs,boxes})=>{
   const samples=await Promise.all(pngs.map(async(png:string,i:number)=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);const r=boxes[i];return c.getImageData(r.x,r.y,r.width,r.height+1).data;}));
   // Rounded-edge coverage can differ by a few RGB levels between the two
   // client surfaces. Keep that bounded allowance at the 8px corners only;
   // interior fills, straight borders and focus paint retain a 2-level bound.
   let different=0,max=0;const examples:any[]=[];for(let i=0;i<samples[0].length;i+=4){const x=i/4%boxes[0].width,y=Math.floor(i/4/boxes[0].width),d=Math.max(...[0,1,2,3].map(k=>Math.abs(samples[0][i+k]-samples[1][i+k])));max=Math.max(max,d);const corner=y<8&&(x<8||x>=boxes[0].width-8);if(d>(corner?8:2)){different++;if(examples.length<6)examples.push({x,y,main:[...samples[0].slice(i,i+4)],editor:[...samples[1].slice(i,i+4)]});}}
   return {different,max,examples,mainBox:boxes[0],editorBox:boxes[1],devicePixelRatio:window.devicePixelRatio,userAgent:navigator.userAgent};
  },{pngs:pngs.map(png=>png.toString('base64')),boxes});
  const observedAfter=mode==='post-on-failure'&&result.different>0?await Promise.all(owners.map(owner=>owner.screenshot({scale:'css'}))):after;
  const inspect=(shots:any[])=>capturedHistoryBorder(editor,shots.map(p=>p.toString('base64')),boxes as any);
  return {...result,boundary:{before:before?await inspect(before):null,original:await inspect(pngs),after:observedAfter?await inspect(observedAfter):null}};
 }
 const measure=(el:Element)=>{const css=getComputedStyle(el),r=el.getBoundingClientRect(),label=el.querySelector<HTMLElement>('[role=tab]')!,l=label.getBoundingClientRect(),close=el.querySelector<HTMLElement>('button:not([role=tab])')!,c=close.getBoundingClientRect(),s=getComputedStyle(label),ink=label.lastElementChild!.getBoundingClientRect();return {x:r.x,top:r.y,width:r.width,height:r.height,radius:css.borderRadius,border:[css.borderTopWidth,css.borderRightWidth,css.borderBottomWidth,css.borderLeftWidth,css.borderLeftColor],background:css.backgroundColor,label:{font:s.font,color:s.color,padding:s.padding,top:l.top-r.top,height:l.height,textTop:ink.top-r.top},close:{x:c.x-r.x,y:c.y-r.y,width:c.width,height:c.height,color:getComputedStyle(close).color,radius:getComputedStyle(close).borderRadius}};};
 for(const theme of themes){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await editor.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const selected of [0,2,4]){
   await page.locator('.titlebar .tab [role=tab]').nth(selected).click();await editor.locator('.editor-tab [role=tab]').nth(selected).click();
   for(const state of ['normal','hover','close','focus']){
    await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await editor.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await page.mouse.move(1100,800);await editor.mouse.move(1100,800);
    const index=state==='normal'?selected:(selected+1)%5;
    const main=page.locator('.titlebar .tab').nth(index),edit=editor.locator('.editor-tab').nth(index);
    if(state==='hover'){await main.locator('[role=tab]').hover();await edit.locator('[role=tab]').hover();}
    if(state==='close'){await main.locator('[data-close]').hover();await edit.locator('[data-editor-tab-close]').hover();}
    if(state==='focus'){await page.keyboard.press('Tab');await editor.keyboard.press('Tab');await main.locator('[role=tab]').focus();await edit.locator('[role=tab]').focus();}
    const m=await main.evaluate(measure),e=await edit.evaluate(measure);records.push({theme,selected,state,index,main:m,editor:e});fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(records,null,2));
    expect.soft(e).toEqual(m);
    if(selected===0||state==='normal'){const result=await paintedDifference(main,edit);paint.push({theme,selected,state,index,...result});fs.writeFileSync(path.join(out,'paint-differences.json'),JSON.stringify(paint,null,2));
     const diagnostic={version:1,mode,theme,selected,state,index,region:'All upper-right9x9 pixels x171..179/y0..8 including179,5',originalDifference:mode==='no-mask'?null:{different:result.different,max:result.max,examples:result.examples},...result.boundary};const json=JSON.stringify(diagnostic);if(json.length>65536)throw Error('History boundary diagnostic exceeds bounded log');console.log('PAINT_HISTORY_BOUNDARY '+json);if(!outerObserved&&result.boundary.original.comparison.max>8){outerObserved=true;const probe={version:1,mode,theme,selected,state,...await outerHostHistoryDiagnostic(page,editor,main,edit)};const raw=JSON.stringify(probe);if(raw.length>65536)throw Error('History outer-host diagnostic exceeds bounded log');console.log('PAINT_HISTORY_OUTER '+raw);}}
   }
  }
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await editor.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await page.mouse.move(1100,800);await editor.mouse.move(1100,800);await page.screenshot({path:path.join(out,`main-${theme}.png`)});await editor.screenshot({path:path.join(out,`editor-${theme}.png`)});
  await page.locator('.titlebar .tab.active [data-close]').hover();await editor.locator('.editor-tab.active [data-editor-tab-close]').hover();
  await page.screenshot({path:path.join(out,`main-hover-${theme}.png`)});await editor.screenshot({path:path.join(out,`editor-full-hover-${theme}.png`)});
 }
 const long=editor.locator('.editor-tab').nth(3),name=long.locator('.editor-tab-name');await name.evaluate(el=>el.textContent='設定ファイル-非常に長い名前-configuration-settings-for-generated-sample.json');
 await expect(long.locator('[role=tab]')).toHaveAttribute('title',/Generated server.*\/generated\/fourth.js/);
 expect(await name.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
 for(const width of [500,320]){
  await editor.setViewportSize({width,height:620});const strip=editor.locator('.editor-tabs');expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await editor.locator('.editor-tab').first().locator('[role=tab]').focus();await editor.locator('.editor-tab').last().locator('[data-editor-tab-close]').focus();await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);await expect(editor.locator('.editor-tab').last().locator('[data-editor-tab-close]')).toBeInViewport();
  await editor.locator('.editor-tab').first().locator('[role=tab]').focus();await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBe(0);
 }
 await editor.close();
});
