import {test,expect} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';
import {observeUnmaskedBorder,visibilityMaskPaintDiagnostic} from './paint-diagnostic.js';
test('observe clean product paint before visibility-mask ABABA and fresh outer-host controls',async({page,context})=>{
 test.setTimeout(240000);
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[],history:{}};if(cmd==='default_folder')return 'C:\\generated';if(cmd==='list_drives')return [];}}};});
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();for(let i=0;i<4;i++)await page.locator('#add-tab').click();
 const editor=await context.newPage();await editor.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};if(cmd==='load_settings')return {theme:'forest',language:'en'};if(cmd==='list_text_documents')return ['first','second','middle','fourth','last'].map(token=>({token,path:'/generated/'+token+'.js',side:'remote',connectionLabel:'Generated server',text:'// generated fixture',encoding:'UTF-8',newline:'LF'}));}},event:{listen:async()=>()=>{}}};});
 await editor.goto('/editor.html');await expect(editor.locator('.editor-tab')).toHaveCount(5);
 await editor.evaluate(()=>{(window as any).__maskFlowNodes=Array.from(document.querySelectorAll('.editor-tab'));(window as any).__maskFlowButtons=Array.from(document.querySelectorAll('.editor-tab button'));});
 const out=path.resolve('../release-r4-pre7-mask-diagnostic/qa');fs.mkdirSync(out,{recursive:true});
 function emit(marker:string,value:unknown){const json=JSON.stringify(value);if(json.length>65536)throw Error('Mask-flow diagnostic exceeds bounded log');console.log(marker+' '+json);}
 async function normal(selected:number){await page.locator('.titlebar .tab [role=tab]').nth(selected).click();await editor.locator('.editor-tab [role=tab]').nth(selected).click();for(const owner of [page,editor]){await owner.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();});await owner.mouse.move(1100,800);}}
 // Actual product interaction history: no DOM masking has occurred in these
 // pages. Do not assert visual equality here; record it without hiding evidence.
 for(const theme of ['light','dark','midnight','forest','mint']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await editor.evaluate(t=>document.documentElement.dataset.theme=t,theme);const observations=[];
  for(const selected of [0,2,4]){
   await normal(selected);observations.push({selected,...await observeUnmaskedBorder(page,editor,page.locator('.titlebar .tab').nth(selected),editor.locator('.editor-tab').nth(selected))});
   const i=(selected+1)%5;for(const [owner,selector,close]of [[page,'.titlebar .tab','[data-close]'],[editor,'.editor-tab','[data-editor-tab-close]']] as const){const tab=owner.locator(selector).nth(i);await tab.locator('[role=tab]').hover();await tab.locator(close).hover();await tab.locator('[role=tab]').focus();}
  }
  const record={version:1,theme,observations};emit('PAINT_UNMASKED_HISTORY',record);fs.writeFileSync(path.join(out,'unmasked-'+theme+'.json'),JSON.stringify(record));
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='forest');await editor.evaluate(()=>document.documentElement.dataset.theme='forest');await normal(0);
 const flow=await visibilityMaskPaintDiagnostic(page,editor,page.locator('.titlebar .tab').first(),editor.locator('.editor-tab').first());emit('PAINT_MASK_FLOW',flow);fs.writeFileSync(path.join(out,'mask-flow.json'),JSON.stringify(flow));
 expect(await editor.evaluate(()=>Array.from(document.querySelectorAll('.editor-tab')).every((n,i)=>n===(window as any).__maskFlowNodes[i])&&Array.from(document.querySelectorAll('.editor-tab button')).every((n,i)=>n===(window as any).__maskFlowButtons[i]))).toBe(true);
 await expect(editor.locator('[data-mask-paint-host]')).toHaveCount(0);await expect(editor.locator('textarea:visible')).toHaveValue('// generated fixture');
 await editor.close();
});
