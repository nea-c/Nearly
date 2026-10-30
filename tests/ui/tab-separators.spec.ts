import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve('../tabs-reference-spacing-followup/qa');fs.mkdirSync(output,{recursive:true});
const themes=['forest','light','dark','midnight','mint'];
async function uniformLowerEdge(page:any,tabs:any,index:number){
 const samples=await tabs.evaluateAll((nodes:HTMLElement[])=>{
  const strip=nodes[0].parentElement!,end=strip.getBoundingClientRect().right;
  return {border:getComputedStyle(strip).getPropertyValue('--border-main').trim()||'#ccd7e5',samples:nodes.flatMap((el,i)=>{
   const r=el.getBoundingClientRect(),next=nodes[i+1]?.getBoundingClientRect();
   const center=Math.floor((r.top+r.bottom)/2);
   return [{kind:'tab',index:i,x:Math.floor((r.left+r.right)/2),y:Math.floor(r.bottom-1)},
    {kind:'left',index:i,x:Math.floor(r.left),y:center},{kind:'right',index:i,x:Math.floor(r.right-1),y:center},
    {kind:'top',index:i,x:Math.floor((r.left+r.right)/2),y:Math.floor(r.top)},
    {kind:'space',index:i,x:Math.floor((r.left+r.right)/2),y:Math.floor(r.top-1)},{kind:'space',index:i,x:Math.floor((r.left+r.right)/2),y:Math.floor(r.top-2)},
    {kind:'inner',index:i,x:Math.floor(r.left+1),y:center},{kind:'inner',index:i,x:Math.floor(r.right-2),y:center},
    ...(next?[{kind:'gap',index:i,x:Math.floor((r.right+next.left)/2),y:Math.floor(r.bottom-1)},{kind:'air',index:i,x:Math.floor((r.right+next.left)/2),y:center}]:end>r.right+10?[{kind:'tail',index:i,x:Math.floor(end-2),y:Math.floor(r.bottom-1)}]:[])];
  })};
 });
 const png=(await page.screenshot({scale:'css'})).toString('base64');
 const pixels=await page.evaluate(async({png,samples})=>{
  const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);
  const rows=samples.samples.map(s=>({...s,color:[...c.getImageData(s.x,s.y,1,1).data]}));c.fillStyle=samples.border;c.fillRect(0,0,1,1);return {rows,border:[...c.getImageData(0,0,1,1).data]};
 },{png,samples});
 for(const row of pixels.rows){if(row.kind==='inner'||row.kind==='space'||row.kind==='air'||row.kind==='tab'&&row.index===index)expect(row.color,`${row.kind}${row.index} open bottom, clear spacing or single stroke`).not.toEqual(pixels.border);else expect(row.color,`${row.kind}${row.index} outline and uniform lower edge`).toEqual(pixels.border);}
 return pixels;
}
async function read(tabs:any){return tabs.evaluateAll((nodes:HTMLElement[])=>nodes.map(el=>{
 const s=getComputedStyle(el),p=getComputedStyle(el,'::after'),b=el.getBoundingClientRect();
 const close=el.querySelector('button:not([role=tab])')!.getBoundingClientRect(),marker=el.querySelector('.status-icon')?.getBoundingClientRect();
 return {visible:p.content!=='none'&&p.content!=='normal'&&p.display!=='none',background:s.backgroundColor,left:s.borderLeftWidth,right:s.borderRightWidth,top:s.borderTopWidth,bottom:s.borderBottomWidth,radius:parseFloat(s.borderTopLeftRadius),x:b.x,y:b.y,w:b.width,h:b.height,close:{width:close.width,height:close.height,top:close.top},marker:marker?{width:marker.width,height:marker.height,top:marker.top}:null};
}));}
async function verify(page:any,tabs:any,index:number){
 await page.mouse.move(1100,850);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
 const baseline=await read(tabs);expect(baseline.map((t:any)=>t.visible)).toEqual([false,false,false,false,false]);
 fs.writeFileSync(path.join(output,baseline[0].marker?'main-observed.json':'editor-observed.json'),JSON.stringify(baseline,null,2));
 for(const [i,row] of baseline.entries()){expect(row.left).toBe('1px');expect(row.right).toBe('1px');expect(row.top).toBe('1px');expect(row.bottom).toBe(i===index?'0px':'1px');expect(row.radius).toBeGreaterThanOrEqual(4);}
 const spacing=await tabs.first().evaluate((el:HTMLElement)=>el.classList.contains('editor-tab')?4:3);
 for(let i=0;i<baseline.length-1;i++)expect(baseline[i+1].x-baseline[i].x-baseline[i].w,'reference intertab spacing').toBe(spacing);
 expect(await tabs.first().evaluate(el=>el.getBoundingClientRect().left-el.parentElement!.getBoundingClientRect().left),'first-tab inset matches intertab spacing').toBe(spacing);
 // The contour remains continuous while either target is hovered or focused.
 const target=index===2?0:2;
 const label=tabs.nth(target).locator('[role=tab]'),close=tabs.nth(target).locator('button:not([role=tab])');
 for(const control of [label,close]){await control.hover();const hovered=await read(tabs);expect(hovered.map((t:any)=>[t.visible,t.left,t.right])).toEqual(baseline.map((t:any)=>[t.visible,t.left,t.right]));}
 await page.mouse.move(1100,850);await close.focus();const focused=await read(tabs);expect(focused.map((t:any)=>[t.visible,t.left,t.right])).toEqual(baseline.map((t:any)=>[t.visible,t.left,t.right]));
 await close.evaluate((el:HTMLElement)=>el.blur());expect(await read(tabs)).toEqual(baseline);
 await uniformLowerEdge(page,tabs,index);
 return baseline;
}
test('main tab contours replace floating separators in all themes and connection states',async({page})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{const w=window as any;const profile={id:'sample',name:'Sample connection',mode:'sftp',host:'fixture.invalid',port:2222,user:'sample',auth:'key',keyFile:'generated-only',hostKey:'generated-pin'};
 w.__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[profile],history:{},exclusions:{},syncOptions:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];if(cmd==='connect_session'){if(w.failGeneratedConnection)throw Error('Generated disconnected fixture');return {path:'/generated',entries:[]};}if(cmd==='list_local'||cmd==='list_remote')return [];}}};});
 await page.goto('/');await expect(page.locator('#connect-form')).toBeVisible();for(let i=0;i<4;i++)await page.locator('#add-tab').click();
 await page.mouse.move(1100,850);await page.screenshot({path:path.join(output,'main-initial-forest.png')});
 const tabs=page.locator('.titlebar .tab'),results:any[]=[];
 for(const state of ['new','failed','connected'])for(const theme of themes){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const index of [0,2,4]){
  await tabs.nth(index).locator('[role=tab]').click();
  if(state==='failed'){await page.evaluate(()=>{(window as any).failGeneratedConnection=true;});await page.locator('#connect-form .primary').click();await expect(page.locator('#connect-form .primary')).toBeEnabled();}
  if(state==='connected'&&await page.locator('#connect-form').count()){await page.evaluate(()=>{(window as any).failGeneratedConnection=false;});await page.locator('#connect-form .primary').click();await expect(page.locator('.bookmark-bar')).toBeVisible();}
  const rows=await verify(page,tabs,index);for(const row of rows){expect(row.y).toBe(5);expect(row.h).toBe(37);expect(row.w).toBe(180);expect(row.marker).toMatchObject({width:14,height:14});}
  expect(await tabs.last().evaluate(el=>el.parentElement!.getBoundingClientRect().right-el.getBoundingClientRect().right),'no leftover old-gap space after the final tab').toBe(0);
  results.push({state,theme,index,rows});fs.writeFileSync(path.join(output,'main-measurements.json'),JSON.stringify(results,null,2));
  if(index===4&&['forest','light','dark'].includes(theme))await page.screenshot({path:path.join(output,`main-${state}-${theme}.png`)});
 }}
 await page.setViewportSize({width:640,height:600});await tabs.last().locator('[role=tab]').focus();expect(await page.locator('.tabs').evaluate(el=>el.scrollWidth>el.clientWidth&&el.scrollLeft>0)).toBe(true);
 await tabs.first().locator('[role=tab]').focus();expect(await page.locator('.tabs').evaluate(el=>el.scrollLeft)).toBe(0);
});
test('editor tab contours preserve joined active tabs, dirty close targets and overflow',async({page})=>{
 test.setTimeout(120000);await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};if(cmd==='load_settings')return {theme:'forest',language:'en'};if(cmd==='list_text_documents')return ['first','second','middle','fourth','last'].map(token=>({token,text:'Generated sample',encoding:'UTF-8',newline:'LF',path:'/generated/'+token+'.txt',side:'local',connectionLabel:'Local'}));}},event:{listen:async()=>()=>{}}};});
 await page.goto('/editor.html');const tabs=page.locator('.editor-tab');await expect(tabs).toHaveCount(5);const results:any[]=[];
 for(const theme of themes){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const index of [0,2,4]){
  await tabs.nth(index).locator('[role=tab]').click();await page.locator('.text-editor:not([hidden]) textarea').fill('Generated edited sample');
  const rows=await verify(page,tabs,index);expect(rows[index].h).toBe(40);for(const row of rows)expect(row.y).toBe(8);results.push({theme,index,rows});fs.writeFileSync(path.join(output,'editor-measurements.json'),JSON.stringify(results,null,2));
  await expect(tabs.nth(index).locator('.editor-tab-dirty')).toBeVisible();await tabs.nth(index).locator('[data-editor-tab-close]').hover();await expect(tabs.nth(index).locator('.editor-tab-cross')).toBeVisible();await page.mouse.move(1100,850);
  if(index===4&&['forest','light','dark'].includes(theme))await page.screenshot({path:path.join(output,`editor-${theme}.png`)});
 }}
 await page.setViewportSize({width:500,height:600});const strip=page.locator('.editor-tabs');
 expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
 await tabs.last().locator('[data-editor-tab-close]').focus();await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
 await expect(tabs.last().locator('[data-editor-tab-close]')).toBeInViewport();
 await tabs.first().locator('[role=tab]').focus();await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBe(0);
});
