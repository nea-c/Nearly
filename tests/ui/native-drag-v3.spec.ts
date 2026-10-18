import {test,expect} from '@playwright/test';
import {setup,nativeDrop} from './transfer-v2-drop-fixture';

test('remote threshold starts native ownership while metadata and button release are pending',async({page})=>{
 await setup(page);
 await page.evaluate(()=>{const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:string,args:any)=>{
  if(cmd==='run_remote_drag'){(window as any).calls.push({cmd,args});return new Promise(resolve=>{(window as any).finishNative=resolve;});}
  return original(cmd,args);
 };});
 const row=(await page.locator('[data-list=remote] [data-name="one.txt"]').boundingBox())!;
 await page.mouse.move(row.x+30,row.y+row.height/2);await page.mouse.down();await page.mouse.move(row.x+50,row.y+row.height/2);
 await expect.poll(()=>page.evaluate(()=>(window as any).calls.some((c:any)=>c.cmd==='run_remote_drag'))).toBe(true);
 // OLE was dispatched inside the window, before an exit or button release.
 await page.mouse.up();
 await page.evaluate(()=>(window as any).finishNative({status:'completed',completed:1,bytes:1,message:'delayed metadata copied'}));
 await expect(page.locator('.operation-feedback')).toContainText('delayed metadata copied');
});

test('delayed native self drop stays rejected after completion and next external drag works',async({page})=>{
 await setup(page);
 await page.evaluate(()=>{const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:string,args:any)=>{
  if(cmd==='run_remote_drag'){(window as any).calls.push({cmd,args});return {status:'cancelled',completed:0,bytes:0,message:'cancelled'};}
  return original(cmd,args);
 };});
 const row=(await page.locator('[data-list=remote] [data-name="one.txt"]').boundingBox())!;
 await page.mouse.move(row.x+30,row.y+row.height/2);await page.mouse.down();await page.mouse.move(row.x+50,row.y+row.height/2);await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>(window as any).calls.some((c:any)=>c.cmd==='run_remote_drag'))).toBe(true);
 await expect(page.locator('.operation-feedback[data-complete]')).toHaveAttribute('data-dismissible','true');
 await page.locator('[data-feedback-close]').click();
 const remote=(await page.locator('[data-list=remote] [data-name=folder]').boundingBox())!;
 await page.evaluate(box=>(window as any).nativeDrop({payload:{type:'drop',ownOutbound:true,paths:['C:\\outbound.txt'],position:{x:(box.x+10)*devicePixelRatio,y:(box.y+10)*devicePixelRatio}}}),remote);
 await expect(page.locator('#upload-confirm')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.cmd==='run_upload'))).toBe(false);
 await nativeDrop(page);
 await expect(page.locator('#upload-confirm')).toBeVisible();
});
