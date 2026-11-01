import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const out=path.resolve('../editor-tab-parity-followup/qa');fs.mkdirSync(out,{recursive:true});
const themes=['light','dark','midnight','forest','mint'];
async function editor(page:Page,documents:any[]){
 await page.addInitScript(docs=>{const w=window as any;w.generatedDocuments=docs;w.editorEvents={};w.__TAURI__={core:{invoke:async(cmd:string)=>{
  if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};
  if(cmd==='load_settings')return {theme:'forest',language:'en'};
  if(cmd==='list_text_documents'){if(w.holdList)await new Promise(resolve=>w.releaseList=resolve);return w.generatedDocuments;}
 }},event:{listen:async(name:string,fn:any)=>{w.editorEvents[name]=fn;return ()=>{};}}};},documents);
 await page.goto('/editor.html');await expect(page.locator('.editor-tab')).toHaveCount(documents.length);
}
const doc=(token:string,text:string,side='local')=>({token,text,encoding:'UTF-8',newline:'LF',path:side==='local'?`C:\\generated\\${token}.js`:`/generated/${token}.js`,side,connectionLabel:side==='local'?'Local':'Sample server'});
const longText=Array.from({length:900},(_,i)=>`const line${i} = "Generated line ${i} ${'x'.repeat(60)}";`).join('\n');
test('close hover discs use the reference main palette and compact diameter in both windows and selection states',async({page,context})=>{
 test.setTimeout(120000);
 const evidence=path.resolve('../editor-main-tab-layout/close-qa');fs.mkdirSync(evidence,{recursive:true});
 // Measured pre-change main inactive-disc colours; reuse, do not invent a palette.
 const reference:Record<string,number[]>={light:[168,194,230],dark:[104,104,104],midnight:[97,105,115],forest:[105,117,112],mint:[172,197,182]};
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();await page.locator('#add-tab').click();
 const edit=await context.newPage();await editor(edit,[doc('first','// generated'),doc('second','// generated')]);
 const records:any[]=[];
 for(const theme of themes){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await edit.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const active of [false,true])for(const [name,owner,index,selector,w,h] of [['main',page,active?1:0,'.titlebar .tab [data-close]',28,29.5],['editor',edit,active?0:1,'.editor-tab-close',28,29.5]] as const){
   await owner.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
   const button=owner.locator(selector).nth(index),before=(await button.boundingBox())!;await button.hover();
   const disc=await button.evaluate(el=>{const p=getComputedStyle(el,'::before'),c=document.createElement('canvas').getContext('2d')!;c.fillStyle=p.backgroundColor;c.fillRect(0,0,1,1);return {width:p.width,height:p.height,opacity:p.opacity,rgb:[...c.getImageData(0,0,1,1).data].slice(0,3)};});
   const png=await owner.screenshot();const pixel=await owner.evaluate(async({png,r})=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);return [...c.getImageData(Math.floor(r.x+r.width/2),Math.floor(r.y+r.height/2-8),1,1).data].slice(0,3);},{png:png.toString('base64'),r:before});
   records.push({theme,name,active,rect:before,disc,pixel});fs.writeFileSync(path.join(evidence,'disc-measurements.json'),JSON.stringify(records,null,2));fs.writeFileSync(path.join(evidence,`${theme}-${name}-${active?'active':'inactive'}.png`),png);
   expect(before.width).toBe(w);expect(before.height).toBe(h);expect(await button.boundingBox()).toEqual(before);
   expect.soft(disc.width).toBe('18px');expect.soft(disc.height).toBe('18px');expect(disc.opacity).toBe('1');expect.soft(disc.rgb).toEqual(reference[theme]);expect.soft(pixel).toEqual(reference[theme]);
   await owner.mouse.move(900,800);await owner.keyboard.press('Tab');await button.focus();
   const focused=await button.evaluate(el=>{const p=getComputedStyle(el,'::before'),c=document.createElement('canvas').getContext('2d')!;if(p.opacity!=='1')throw Error('No focused disc');c.fillStyle=p.backgroundColor;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);});expect.soft(focused).toEqual(reference[theme]);
  }
 }
 await edit.close();
});
test('tab close glyphs share editor ink size and optical centering without moving the circle or dirty control',async({page,context})=>{
 test.setTimeout(120000);
 const evidence=path.resolve('../editor-main-tab-layout/glyph-qa');fs.mkdirSync(evidence,{recursive:true});
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();await page.locator('#add-tab').click();
 const edit=await context.newPage();await editor(edit,[doc('first','// generated'),doc('second','// generated')]);
 const records:any[]=[];
 async function ink(owner:Page,selector:string,label:string,theme:string){
  const button=owner.locator(selector).first(),r=(await button.boundingBox())!;
  const png=await owner.screenshot();
  const pixels=await owner.evaluate(async({png,r})=>{
   const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);
   // Sample flat paint beside the 10px-wide glyph, inside the 18px disc.
   const cx=r.x+r.width/2,cy=r.y+r.height/2,bg=c.getImageData(Math.floor(cx-7),Math.floor(cy),1,1).data;
   let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,weight=0,wx=0,wy=0;
   // A 12x10 window contains the complete 10x8px glyph plus 1px margin,
   // without collecting the smaller disc's antialiased outer corners.
   for(let y=Math.floor(cy-5);y<Math.floor(cy+5);y++)for(let x=Math.floor(cx-6);x<Math.floor(cx+6);x++){
    const p=c.getImageData(x,y,1,1).data,w=Math.max(...[0,1,2].map(k=>Math.abs(p[k]-bg[k])));if(w<=8)continue;
    x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);weight+=w;wx+=(x+.5)*w;wy+=(y+.5)*w;
   }
   return {width:x1-x0+1,height:y1-y0+1,dx:wx/weight-cx,dy:wy/weight-cy,boundsDx:(x0+x1+1)/2-cx,boundsDy:(y0+y1+1)/2-cy};
  },{png:png.toString('base64'),r});
  records.push({theme,label,rect:r,ink:pixels,font:await button.evaluate(el=>getComputedStyle(el).font)});
  fs.writeFileSync(path.join(evidence,'glyph-measurements.json'),JSON.stringify(records,null,2));
  fs.writeFileSync(path.join(evidence,`${theme}-${label}.png`),png);
  return {r,pixels};
 }
 for(const theme of themes){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await edit.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  const mainClose=page.locator('.titlebar .tab [data-close]').first(),editorClose=edit.locator('.editor-tab-close').first();
  await mainClose.hover();const m=await ink(page,'.titlebar .tab [data-close]','main-hover',theme);
  await editorClose.hover();const e=await ink(edit,'.editor-tab-close','editor-hover',theme);
  expect(m.r.width).toBe(28);expect(m.r.height).toBe(29.5);expect(e.r.width).toBe(28);expect(e.r.height).toBe(29.5);
  expect(m.pixels.width).toBe(e.pixels.width);expect(m.pixels.height).toBe(e.pixels.height);
  for(const p of [m.pixels,e.pixels]){expect(Math.abs(p.dx)).toBeLessThan(.6);expect(Math.abs(p.dy)).toBeLessThan(.6);}
  await edit.locator('.editor-tab-label').first().click();await edit.locator('.text-editor:not([hidden]) textarea').fill('changed');await edit.mouse.move(900,800);
  await expect(edit.locator('.editor-tab-dirty').first()).toBeVisible();await expect(edit.locator('.editor-tab-cross').first()).toBeHidden();
  const dot=await ink(edit,'.editor-tab-close','dirty-dot',theme);
  expect(Math.abs(dot.pixels.dx)).toBeLessThan(.6);expect(Math.abs(dot.pixels.dy-e.pixels.dy)).toBeLessThan(.6);
  const dirtyRect=await editorClose.boundingBox();await editorClose.hover();const dirty=await ink(edit,'.editor-tab-close','dirty-hover',theme);
  expect(dirtyRect).toEqual(dirty.r);expect(dirty.pixels).toEqual(e.pixels);
  await edit.mouse.move(900,800);await edit.keyboard.press('Tab');await editorClose.focus();
  await expect(edit.locator('.editor-tab-cross').first()).toBeVisible();await expect(edit.locator('.editor-tab-dirty').first()).toBeHidden();
  const focus=await ink(edit,'.editor-tab-close','dirty-focus',theme);
  // Hover and keyboard focus intentionally use the corresponding main
  // foreground colours. Compare physical ink bounds, not colour-weighted AA.
  for(const k of ['width','height','boundsDx','boundsDy'] as const)expect(focus.pixels[k]).toBe(e.pixels[k]);
 }
 await edit.close();
});
const read=(el:Element)=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {background:s.backgroundColor,border:s.borderLeftColor,radius:s.borderTopLeftRadius,height:r.height,top:r.top};};
async function compareCorners(main:Page,editor:Page,index:number){
 const boxes=await Promise.all([main.locator('.titlebar .tab').nth(index),editor.locator('.editor-tab').nth(index)].map(tab=>tab.boundingBox()));
 if(boxes.some(box=>!box))throw Error('Missing rendered tab');
 const [mp,ep]=await Promise.all([main.screenshot({scale:'css'}),editor.screenshot({scale:'css'})]);
 return editor.evaluate(async({mp,ep,boxes})=>{
  const load=async(png:string)=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);return c;};
  const contexts=await Promise.all([load(mp),load(ep)]);
  const sample=(i:number,right:boolean)=>{const r=boxes[i]!;return contexts[i].getImageData(right?r.x+r.width-12:r.x,r.y,12,12).data;};
  // Two channel levels allow antialias rounding, not a painted-over contour.
  const different=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>{let n=0;for(let i=0;i<a.length;i+=4)if([0,1,2,3].some(k=>Math.abs(a[i+k]-b[i+k])>2))n++;return n;};
  return {left:different(sample(0,false),sample(1,false)),right:different(sample(0,true),sample(1,true))};
 },{mp:mp.toString('base64'),ep:ep.toString('base64'),boxes});
}

test('editor inactive tab strip and contours match main reference in five themes without changing spacing',async({page,context})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();for(let i=0;i<4;i++)await page.locator('#add-tab').click();
 const edit=await context.newPage();await editor(edit,['first','second','middle','fourth','last'].map(x=>doc(x,'// Generated sample\nconst ready = true;')));
 const measured:any[]=[];
 for(const theme of themes){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await edit.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  await page.mouse.move(1100,850);await edit.mouse.move(1100,850);
  const main={strip:await page.locator('.titlebar').evaluate(read),tab:await page.locator('.titlebar .tab:not(.active)').first().evaluate(read),active:await page.locator('.titlebar .tab.active').evaluate(read)};
  const before={strip:await edit.locator('.editor-tabs').evaluate(read),tab:await edit.locator('.editor-tab:not(.active)').first().evaluate(read),active:await edit.locator('.editor-tab.active').evaluate(read)};
  measured.push({theme,main,editor:before});fs.writeFileSync(path.join(out,'parity-measurements.json'),JSON.stringify(measured,null,2));
  await page.screenshot({path:path.join(out,`main-${theme}.png`)});await edit.screenshot({path:path.join(out,`editor-${theme}.png`)});
  expect(before.strip.background,theme+' strip').toBe(main.strip.background);
  expect(before.tab.background,theme+' inactive fill').toBe(main.tab.background);
  expect(before.tab.border,theme+' contour').toBe(main.tab.border);
  expect(before.tab.radius,theme+' inactive corners').toBe(main.tab.radius);
  expect(before.active.radius,theme+' active corners').toBe(main.active.radius);
  expect(main.tab.radius).toBe('8px');expect(main.active.radius).toBe('8px');
  expect(before.tab.radius).toBe('8px');expect(before.active.radius).toBe('8px');
  for(const index of [0,2,4]){
   await page.locator('.titlebar .tab [role=tab]').nth(index).click();
   const tabs=edit.locator('.editor-tab');await tabs.nth(index).locator('[role=tab]').click();
   await edit.locator('.text-editor:not([hidden]) textarea').fill('Generated unsaved edit');
   await edit.mouse.move(1100,850);
   const geometry=await tabs.evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:s.borderBottomWidth,radius:s.borderTopLeftRadius};}));
   expect(geometry[0].x).toBe(3);for(const [i,r] of geometry.entries()){expect(r.y).toBe(5);expect(r.h).toBe(37);expect(r.bottom).toBe(i===index?'0px':'1px');if(i)expect(r.x-geometry[i-1].x-geometry[i-1].w).toBe(3);}
   await expect(tabs.nth(index).locator('.editor-tab-dirty')).toBeVisible();
   const inactive=index===0?2:0;
   // Parent radii can agree while an opaque child button covers the arc.
   expect(await compareCorners(page,edit,inactive),theme+' actual normal corner pixels').toEqual({left:0,right:0});
   const target=tabs.nth(inactive),close=target.locator('[data-editor-tab-close]');
   await expect(target.locator('[role=tab]')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
   await expect(close).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
   await target.locator('[role=tab]').hover();const hover=await target.evaluate(read);expect(hover.background).not.toBe(main.tab.background);await expect(close).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
   await close.hover();await expect(close).toHaveCSS('background-color','rgba(0, 0, 0, 0)');expect(await close.evaluate(el=>getComputedStyle(el,'::before').opacity)).toBe('1');await close.focus();await expect(close).toBeFocused();
  }
 }
 await edit.setViewportSize({width:500,height:600});await edit.locator('.editor-tab').first().locator('[role=tab]').focus();await edit.locator('.editor-tab').last().locator('[data-editor-tab-close]').focus();await expect.poll(()=>edit.locator('.editor-tabs').evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
 await edit.locator('.editor-tab').first().locator('[role=tab]').focus();await expect.poll(()=>edit.locator('.editor-tabs').evaluate(el=>el.scrollLeft)).toBe(0);await edit.close();
});

test('tab close add and Settings hover highlights are real circles without shrinking rectangular click targets',async({page,context})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];if(cmd==='request_text_editor_origin_close')return true;}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();await page.locator('#add-tab').click();
 const edit=await context.newPage();await editor(edit,[doc('first','Generated sample'),doc('second','Generated sample')]);
 const qa=path.resolve('../editor-main-tab-layout/circle-qa');fs.mkdirSync(qa,{recursive:true});const measured:any[]=[];
 for(const theme of themes){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await edit.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const [name,owner,target,width,height] of [['main-close',page,page.locator('.titlebar .tab').first().locator('[data-close]'),28,29.5],['add',page,page.locator('#add-tab'),34,34],['settings',page,page.locator('#settings-toggle'),38,42],['editor-close',edit,edit.locator('.editor-tab').first().locator('[data-editor-tab-close]'),28,29.5]] as const){
   // Hover paint and the intentionally retained focus outline are independent.
   await owner.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
   await target.hover();const r=await target.boundingBox();expect(r).not.toBeNull();expect(r!.width).toBe(width);expect(r!.height).toBe(height);
   const diameter=await target.evaluate(el=>parseFloat(getComputedStyle(el,'::before').width));
   const png=(await owner.screenshot({scale:'css'})).toString('base64');
   const pixels=await owner.evaluate(async({png,r,d})=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const g=c.getContext('2d')!;g.drawImage(image,0,0);const at=(x:number,y:number)=>[...g.getImageData(Math.floor(x),Math.floor(y),1,1).data];const x=r.x+(r.width-d)/2,y=r.y+(r.height-d)/2;return {outside:at(x+1,y+1),surrounding:at(r.x-2,y+1),inside:at(x+d/2,y+3)};},{png,r:r!,d:diameter});
   expect(pixels.outside,theme+' '+name+' transparent circular corner').toEqual(pixels.surrounding);expect(pixels.inside,theme+' '+name+' visible highlight disc').not.toEqual(pixels.surrounding);
   measured.push({theme,name,rect:r,pixels});fs.writeFileSync(path.join(qa,'circle-measurements.json'),JSON.stringify(measured,null,2));
   if(['forest','light'].includes(theme))fs.writeFileSync(path.join(qa,`action-${theme}-${name}.png`),Buffer.from(png,'base64'));
   await owner.keyboard.press('Tab');await target.focus();await expect(target).toBeFocused();expect(await target.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid');
   await owner.mouse.move(1100,850);
   if(name.endsWith('close'))expect(await target.evaluate(el=>getComputedStyle(el,'::before').opacity),theme+' '+name+' keyboard-only disc').toBe('1');
  }
 }
 // A clipped button would fail these clicks outside the circular paint area.
 const count=await page.locator('.titlebar .tab').count();await page.locator('#add-tab').click({position:{x:1,y:1}});await expect(page.locator('.titlebar .tab')).toHaveCount(count+1);
 await page.locator('.titlebar .tab').last().locator('[data-close]').click({position:{x:1,y:1}});await expect(page.locator('.titlebar .tab')).toHaveCount(count);
 await page.locator('#settings-toggle').click({position:{x:1,y:1}});await expect(page.locator('#settings-popup')).toBeVisible();await page.locator('#settings-close').click();
 for(const selector of ['#window-minimize','#window-maximize','#window-close'])await expect(page.locator(selector)).toHaveCSS('border-radius','0px');
 await edit.locator('.editor-tab').first().locator('[role=tab]').click();await edit.locator('textarea:visible').fill('Unsaved generated sample');
 const close=edit.locator('.editor-tab').first().locator('[data-editor-tab-close]');await edit.mouse.move(1100,850);await expect(close.locator('.editor-tab-dirty')).toBeVisible();
 await close.hover();await expect(close.locator('.editor-tab-cross')).toBeVisible();await close.click({position:{x:1,y:1}});await expect(edit.locator('[role=alertdialog]')).toBeVisible();await edit.locator('[data-editor-keep]').click();await expect(edit.locator('textarea:visible')).toHaveValue('Unsaved generated sample');await expect(edit.locator('.editor-tab')).toHaveCount(2);await expect(edit.locator('#add-tab')).toHaveCount(0);
 await edit.close();
});

for(const side of ['local','remote'])for(const [kind,text] of [['long',longText],['large-plain',longText.repeat(2)],['short','const short = true;'],['empty','']])test(`new ${side} ${kind} document starts at first line and caret`,async({page})=>{
 await editor(page,[doc('new-file',text,side)]);const input=page.locator('.text-editor:not([hidden]) textarea');await expect(input).toBeFocused();
 await expect.poll(()=>input.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft,start:el.selectionStart,end:el.selectionEnd}))).toEqual({top:0,left:0,start:0,end:0});
 if(kind==='long'){await expect.poll(()=>page.locator('.syntax-code span').count()).toBeGreaterThan(0);await page.setViewportSize({width:640,height:520});await expect.poll(()=>input.evaluate(el=>el.scrollTop)).toBe(0);}
});

test('existing dirty document restores its viewport and selection through delayed reads, dedup and highlighting',async({page})=>{
 await editor(page,[doc('local-long',longText),doc('remote-long',longText,'remote')]);
 const tabs=page.locator('.editor-tab'),first=page.locator('#editor-panel-local-long textarea');await expect(first).toBeFocused();
 await first.evaluate(el=>{el.setSelectionRange(180,190);el.scrollTop=700;el.scrollLeft=210;el.value+='\n// unsaved';el.dispatchEvent(new Event('input',{bubbles:true}));el.setSelectionRange(180,190);el.scrollTop=700;el.scrollLeft=210;el.dispatchEvent(new Event('scroll'));});
 const saved=await first.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft,start:el.selectionStart,end:el.selectionEnd,value:el.value}));
 await tabs.nth(1).locator('[role=tab]').click();const second=page.locator('#editor-panel-remote-long textarea');await second.evaluate(el=>{el.setSelectionRange(20,25);el.scrollTop=350;});
 await page.evaluate(()=>{const w=window as any;w.holdList=true;w.editorEvents['text-editor-opened']({payload:'remote-long'});});
 await expect.poll(()=>page.evaluate(()=>!!(window as any).releaseList)).toBe(true);
 await tabs.nth(0).locator('[role=tab]').click();await expect.poll(()=>first.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft,start:el.selectionStart,end:el.selectionEnd,value:el.value}))).toEqual(saved);
 await page.evaluate(()=>{const w=window as any;w.holdList=false;w.releaseList();});await expect(tabs).toHaveCount(2);await expect(first).toBeFocused();
 await expect.poll(()=>first.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft,start:el.selectionStart,end:el.selectionEnd,value:el.value}))).toEqual(saved);
 await expect(tabs.first().locator('.editor-tab-dirty')).toBeVisible();
 await expect.poll(()=>page.locator('#editor-panel-local-long .syntax-code span').count()).toBeGreaterThan(0);
 await expect.poll(()=>first.evaluate(el=>el.scrollTop)).toBe(saved.top);
 await tabs.nth(1).locator('[role=tab]').click();await expect(second).toBeFocused();await expect.poll(()=>second.evaluate(el=>({top:el.scrollTop,start:el.selectionStart,end:el.selectionEnd}))).toEqual({top:350,start:20,end:25});
});

test('a delayed newly read document starts at the beginning in the reused editor window',async({page})=>{
 await editor(page,[doc('original','short')]);
 await page.evaluate(text=>{const w=window as any;w.holdList=true;w.generatedDocuments.push({token:'new-delayed',path:'/generated/new-delayed.ts',side:'remote',connectionLabel:'Sample server',text,encoding:'UTF-8 BOM',newline:'CRLF'});w.editorEvents['text-editor-opened']({payload:'new-delayed'});},longText);
 await expect.poll(()=>page.evaluate(()=>!!(window as any).releaseList)).toBe(true);await expect(page.locator('.editor-tab')).toHaveCount(1);
 await page.evaluate(()=>{const w=window as any;w.holdList=false;w.releaseList();});const input=page.locator('#editor-panel-new-delayed textarea');await expect(input).toBeFocused();
 await expect.poll(()=>input.evaluate(el=>({top:el.scrollTop,start:el.selectionStart,end:el.selectionEnd}))).toEqual({top:0,start:0,end:0});
 await expect(page.locator('.editor-format-slot')).toContainText('UTF-8 BOM');
});
