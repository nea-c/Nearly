import {test,expect} from '@playwright/test';
test('explorer edit dispatches independent window without covering main file actions',async({page})=>{
 await page.goto('/');await page.evaluate(async()=>{const w=window as any;w.editorCalls=[];w.__TAURI__={core:{invoke:async(cmd,args)=>{w.editorCalls.push({cmd,args});if(cmd==='open_text_document')return {token:'doc-a',text:'sample',encoding:'UTF-8',newline:'LF',side:'local',path:'C:/sample/a.txt',connectionLabel:''};}}};const {openTextEditor}=await import('/src/text-editor.ts');await openTextEditor({side:'local',path:'C:/sample/a.txt',workspaceId:'generated'},()=>true,async()=>{});});
 await expect(page.locator('.text-editor')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).editorCalls.some(c=>c.cmd==='open_text_document'))).toBe(true);
});
