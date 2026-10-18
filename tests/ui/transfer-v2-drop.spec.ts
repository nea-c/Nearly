import {test,expect} from '@playwright/test';
import {setup,nativeDrop} from './transfer-v2-drop-fixture';

test('Japanese upload confirmation accurately explains later conflict choices',async({page})=>{
 await setup(page,'sftp',true,'ja');await nativeDrop(page,'[data-list=remote] [data-name=folder]',['C:\\source\\tree']);
 await expect(page.getByRole('dialog')).toContainText('同名の項目があれば転送中に確認します。');
 await expect(page.getByRole('dialog')).not.toContainText('既存の対象は置換しません');
});
test('remote drag leaving window hands captured remote sources to native COPY only',async({page})=>{
 await setup(page);await page.evaluate(()=>{const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:string,args:any)=>{if(cmd==='run_remote_drag'){(window as any).calls.push({cmd,args});return {status:'completed',completed:1,bytes:1,message:'Windows copy fixture'};}return original(cmd,args);};});
 const source=(await page.locator('[data-list=remote] [data-name="one.txt"]').boundingBox())!,viewport=page.viewportSize()!;
 await page.mouse.move(source.x+30,source.y+source.height/2);await page.mouse.down();await page.mouse.move(viewport.width+20,source.y+source.height/2,{steps:12});await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>(window as any).calls.filter((c:any)=>c.cmd==='run_remote_drag').length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).calls.find((c:any)=>c.cmd==='run_remote_drag').args.request.sources)).toEqual(['/one.txt']);
 expect(await page.evaluate(()=>(window as any).calls.some((c:any)=>['run_upload','run_download','run_file_operation'].includes(c.cmd)))).toBe(false);await expect(page.locator('.operation-feedback')).toContainText('Windows copy fixture');
});
test('remote-to-local pointer drop freezes download copies and never deletes remote sources',async({page})=>{
 await setup(page);await page.evaluate(()=>{const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:string,args:any)=>{if(cmd==='run_remote_drag'){(window as any).calls.push({cmd,args});return new Promise(resolve=>{(window as any).finishNative=resolve;});}if(cmd==='run_download'){(window as any).calls.push({cmd,args});return {status:'completed',completed:1,bytes:1,message:'downloaded'};}return original(cmd,args);};});
 const source=(await page.locator('[data-list=remote] [data-name="one.txt"]').boundingBox())!,target=(await page.locator('[data-list=local] [data-name=folder]').boundingBox())!;
 await page.mouse.move(source.x+30,source.y+source.height/2);await page.mouse.down();await page.mouse.move(target.x+30,target.y+target.height/2,{steps:12});await page.mouse.up();
 await page.evaluate(box=>(window as any).finishNative({status:'cancelled',completed:0,bytes:0,message:'internal return',internalPosition:{x:(box.x+30)*devicePixelRatio,y:(box.y+box.height/2)*devicePixelRatio}}),target);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog')).toContainText('C:\\fixture\\folder');await page.locator('#download-confirm').click();
 await expect.poll(()=>page.evaluate(()=>(window as any).calls.filter((c:any)=>c.cmd==='run_download').length)).toBe(1);
 const request=await page.evaluate(()=>(window as any).calls.find((c:any)=>c.cmd==='run_download').args.request);expect(request.sources).toEqual(['/one.txt']);expect(request.local).toBe('C:\\fixture\\folder');
 expect(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.cmd==='run_file_operation'&&['delete','move'].includes(c.args.request.action)))).toBe(false);await expect(page.locator('.operation-feedback')).toContainText('Completed');
});
test('upload confirmation is centered modal and folders include contents without checkbox',async({page})=>{
 await setup(page);await nativeDrop(page,'[data-list=remote] [data-name=folder]',['C:\\source\\tree']);
 const modal=page.getByRole('dialog');await expect(modal).toBeVisible();await expect(modal.locator('input[type=checkbox]')).toHaveCount(0);
 expect(await modal.evaluate(e=>getComputedStyle(e.parentElement!).position)).toBe('fixed');const box=(await modal.boundingBox())!,viewport=page.viewportSize()!;expect(Math.abs(box.y+box.height/2-viewport.height/2)).toBeLessThan(20);
 await page.locator('#upload-confirm').click();await expect.poll(()=>page.evaluate(()=>(window as any).calls.filter((c:any)=>c.cmd==='run_upload').length)).toBe(1);
 const request=await page.evaluate(()=>(window as any).calls.find((c:any)=>c.cmd==='run_upload').args.request);expect(request.recursive).toBe(true);expect(request.interactive).toBe(true);expect(request.remote).toBe('/folder');
});
test('captured conflicts offer choice and apply-all; type mismatch cannot overwrite',async({page})=>{
 await setup(page);await page.evaluate(()=>{const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:string,args:any)=>{
  if(cmd==='file_transfer_prompt')return (window as any).conflict;
  if(cmd==='choose_file_transfer'){(window as any).choices=args;(window as any).conflict=null;(window as any).releaseRun();return;}
  return original(cmd,args);
 };(window as any).holdRun=true;(window as any).conflict={token:'owned',source:'C:\\source\\one.txt',destination:'/folder/one.txt',sourceDirectory:false,targetDirectory:true,canOverwrite:false};});
 await nativeDrop(page,'[data-list=remote] [data-name=folder]',['C:\\source\\one.txt']);await page.locator('#upload-confirm').click();
 const modal=page.locator('#transfer-conflict');await expect(modal).toBeVisible();await expect(modal).toContainText('/folder/one.txt');await expect(modal.locator('[data-choice=overwrite]')).toHaveCount(0);
 await modal.locator('[name=apply-all]').check();await modal.locator('[data-choice=keepboth]').click();await expect(modal).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).choices.decision)).toEqual({token:'owned',action:'keepboth',applyAll:true});await expect(page.locator('.operation-feedback')).toContainText('Completed');
});
