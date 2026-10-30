import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const output=path.resolve('../release-r4-pre5/file-table-qa');fs.mkdirSync(output,{recursive:true});
for(const theme of ['light','dark','midnight','forest','mint'])test(`file table continuous heading and unruled rows ${theme}`,async({page})=>{
 test.setTimeout(180000);
 await page.setViewportSize({width:2200,height:900});
 await page.addInitScript(theme=>{
  const entries=Array.from({length:80},(_,i)=>({name:i<2?'Sample folder '+i:'sample-'+String(i).padStart(2,'0')+'.json',dir:i<2,size:128+i,modifiedAt:1700000000+i}));
  const columns={order:['name','size','type','modified'],hidden:[],widths:{name:280,size:100,type:100,modified:170}};
  let saved:any={version:1,theme,language:'en',profiles:[{id:'generated',name:'Sample connection',host:'fixture.invalid',port:2222,user:'sample',mode:'sftp',auth:'key',keyFile:'generated-only',hostKey:'generated-pin'}],history:{},paneColumns:{local:structuredClone(columns),remote:structuredClone(columns)}};
  (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
   if(cmd==='load_settings')return saved;if(cmd==='save_settings'){saved=args.data;return;}
   if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];
   const rows=localStorage.getItem('generated-empty-surface')==='1'?[]:entries;
   if(cmd==='connect_session')return {path:'/generated',entries:rows};if(cmd==='list_local'||cmd==='list_remote')return rows;
  }}};
 },theme);
 const open=async()=>{await page.goto('/');await page.locator('#connect-form .primary').click();await expect(page.locator('[data-list=remote] th[data-column=name]')).toBeVisible();};
 await open();
 const evidence:any[]=[];
 async function check(empty=false){
  await page.mouse.move(0,0);await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
  const metrics=await page.locator('.table-scroll[data-list]').evaluateAll((lists:HTMLElement[])=>lists.map(el=>{
   const r=el.getBoundingClientRect(),heads=[...el.querySelectorAll<HTMLElement>('th[data-column]')],first=heads[0].getBoundingClientRect(),cell=el.querySelector<HTMLElement>('tr[data-entry] td');
   const right=r.left+el.clientLeft+el.clientWidth-3;
   return {side:el.dataset.list,width:el.clientWidth,scroll:el.scrollWidth,scrollHeight:el.scrollHeight,height:el.clientHeight,scrollLeft:el.scrollLeft,scrollTop:el.scrollTop,
    widths:heads.map(h=>h.getBoundingClientRect().width),rowHeight:cell?.parentElement!.getBoundingClientRect().height,cellBorders:[...el.querySelectorAll('tbody td')].map(c=>getComputedStyle(c).borderBottomColor),
    points:[{x:Math.round(Math.max(first.left+30,r.left+20)),y:Math.floor(first.top+3)},{x:Math.floor(right),y:Math.floor(first.top+3)},
     {x:Math.round(Math.max(first.left+30,r.left+20)),y:Math.floor(first.bottom-1)},{x:Math.floor(right),y:Math.floor(first.bottom-1)}],
    cellAlignment:heads.map(h=>{const c=el.querySelector<HTMLElement>('tr[data-entry] [data-cell="'+h.dataset.column+'"]');return c?c.getBoundingClientRect().left-h.getBoundingClientRect().left:0;})};
  }));
  const png=(await page.screenshot()).toString('base64');
  const pixels=await page.evaluate(async({png,metrics})=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d')!;c.drawImage(image,0,0);return metrics.map(m=>m.points.map(p=>[...c.getImageData(p.x,p.y,1,1).data]));},{png,metrics});
  evidence.push({empty,metrics,pixels});fs.writeFileSync(path.join(output,theme+'.json'),JSON.stringify(evidence,null,2));
  for(const [i,m]of metrics.entries()){
   const list=page.locator('[data-list="'+m.side+'"]');
   await expect(list.getByRole('columnheader')).toHaveCount(4);
   await expect(list.locator('table')).toHaveAttribute('aria-colcount','4');
   expect(m.widths).toEqual([280,100,100,170]);expect(m.cellAlignment.every(x=>Math.abs(x)<1)).toBe(true);
   expect(pixels[i][1],m.side+' heading fill reaches viewport edge').toEqual(pixels[i][0]);
   expect(pixels[i][3],m.side+' heading lower edge reaches viewport edge').toEqual(pixels[i][2]);
   for(const color of m.cellBorders)expect(color).toBe('rgba(0, 0, 0, 0)');
   if(!empty){expect(m.scrollHeight).toBeGreaterThan(m.height);expect(m.rowHeight).toBe(await page.evaluate(()=>document.documentElement.dataset.compactExplorer==='true'?24:33));}
  }
 }
 for(const width of [2200,900])for(const compact of [false,true]){
  await page.setViewportSize({width,height:900});await page.evaluate(c=>document.documentElement.dataset.compactExplorer=String(c),compact);
  await page.locator('.table-scroll').evaluateAll((els:HTMLElement[])=>els.forEach(e=>{e.scrollLeft=0;e.scrollTop=0;}));await check();
  if(theme==='forest'&&width===2200&&!compact){const r=await page.locator('[data-list=remote]').boundingBox();await page.screenshot({path:path.join(output,'file-list-forest.png'),clip:{...r!,height:Math.min(r!.height,360)}});}
  await page.locator('.table-scroll').evaluateAll((els:HTMLElement[])=>els.forEach(e=>{e.scrollLeft=e.scrollWidth;e.scrollTop=200;}));await check();
 }
 await page.evaluate(()=>localStorage.setItem('generated-empty-surface','1'));await page.setViewportSize({width:2200,height:900});await open();await expect(page.locator('[data-list=remote] .empty-message')).toBeVisible();await check(true);
 await expect(page.locator('[data-list=remote] .empty')).toHaveAttribute('aria-colspan','4');
});
