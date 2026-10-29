import {test,expect} from '@playwright/test';
async function setup(page){
 await page.goto('/');await page.evaluate(async()=>{
 const w=window as any;w.lifecycleCalls=[];w.docs=[
 {token:'origin-a',workspaceId:'a',side:'remote',path:'/same.txt',text:'original',encoding:'UTF-8',newline:'LF',connectionLabel:'a'},
 {token:'origin-b',workspaceId:'b',side:'remote',path:'/same.txt',text:'other',encoding:'UTF-8',newline:'LF',connectionLabel:'b'},
 {token:'local-a',workspaceId:'a',side:'local',path:'C:/local.txt',text:'local',encoding:'UTF-8',newline:'LF',connectionLabel:''}];
 w.__TAURI__={core:{invoke:async(cmd,args)=>{w.lifecycleCalls.push({cmd,args});if(cmd==='list_text_documents')return w.docs;if(cmd==='close_text_document')w.docs=w.docs.filter(d=>d.token!==args.token);if(cmd==='save_text_document'){if(w.holdSave)return new Promise(resolve=>w.releaseSave=()=>resolve({text:args.text,message:'Saved'}));if(w.failSave)throw Error('fixture save failure');return {text:args.text,message:'Saved'};}}},event:{listen:async(name,handler)=>{(w.handlers??={})[name]=handler;return()=>{};}}};
 const {setLanguage}=await import('/src/i18n.ts');setLanguage('en');document.querySelector('#app')?.remove();const root=document.createElement('div');document.body.append(root);const {mountTextEditorWindow}=await import('/src/editor-window.ts');await mountTextEditorWindow(root);
 });
}
const request=page=>page.evaluate(()=>{(window as any).handlers['text-editor-origin-close']({payload:{requestId:'generated-close',tokens:['origin-a']}});});
test('origin closure closes only clean remote documents belonging to that session',async({page})=>{
 await setup(page);await request(page);await expect(page.locator('#editor-tab-origin-a')).toHaveCount(0);await expect(page.locator('#editor-tab-origin-b')).toHaveCount(1);await expect(page.locator('#editor-tab-local-a')).toHaveCount(1);expect(await page.evaluate(()=>(window as any).lifecycleCalls.find(c=>c.cmd==='resolve_text_editor_origin_close')?.args)).toEqual({requestId:'generated-close',accepted:true});
});
test('dirty origin closure can be canceled and a failed save retains content',async({page})=>{
 await setup(page);await page.locator('#editor-tab-origin-a').click();await page.locator('#editor-panel-origin-a textarea').fill('retained edits');await page.evaluate(()=>(window as any).failSave=true);await page.keyboard.press('Control+s');await expect(page.locator('.editor-document-status')).toContainText('fixture save failure');await request(page);await expect(page.locator('[data-editor-keep]')).toBeVisible();await page.locator('[data-editor-keep]').click();await expect(page.locator('#editor-panel-origin-a textarea')).toHaveValue('retained edits');expect(await page.evaluate(()=>(window as any).lifecycleCalls.find(c=>c.cmd==='resolve_text_editor_origin_close')?.args.accepted)).toBe(false);await request(page);await page.locator('[data-editor-discard]').click();await expect(page.locator('#editor-tab-origin-a')).toHaveCount(0);
});

test('scope confirmation is transactional and cancel restores the selected unrelated tab',async({page})=>{
 await setup(page);await page.locator('#editor-tab-origin-a').click();await page.locator('#editor-panel-origin-a textarea').fill('first dirty');await page.locator('#editor-tab-origin-b').click();await page.locator('#editor-panel-origin-b textarea').fill('second dirty');await page.locator('#editor-tab-local-a').click();
 await page.evaluate(()=>(window as any).handlers['text-editor-origin-close']({payload:{requestId:'multi',tokens:['origin-a','origin-b']}}));await page.locator('[data-editor-discard]').click();await page.locator('[data-editor-keep]').click();await expect(page.locator('.editor-tabs [role=tab]')).toHaveCount(3);await expect(page.locator('#editor-tab-local-a')).toHaveAttribute('aria-selected','true');await expect(page.locator('#editor-panel-origin-a textarea')).toHaveValue('first dirty');await expect(page.locator('#editor-panel-origin-b textarea')).toHaveValue('second dirty');
});
test('expired native close request cancels the prompt and preserves dirty content',async({page})=>{
 await setup(page);await page.locator('#editor-tab-origin-a').click();await page.locator('#editor-panel-origin-a textarea').fill('timed out content');await request(page);await expect(page.locator('[data-editor-keep]')).toBeVisible();await page.evaluate(()=>(window as any).handlers['text-editor-origin-close-expired']({payload:'generated-close'}));await expect(page.locator('[data-editor-keep]')).toHaveCount(0);await expect(page.locator('#editor-panel-origin-a textarea')).toHaveValue('timed out content');await expect(page.locator('.editor-tabs [role=tab]')).toHaveCount(3);
});

test('origin close refuses an active save and permits retry after it settles',async({page})=>{
 await setup(page);await page.locator('#editor-tab-origin-a').click();await page.locator('#editor-panel-origin-a textarea').fill('saving buffer');await page.evaluate(()=>(window as any).holdSave=true);await page.keyboard.press('Control+s');await expect(page.locator('#editor-panel-origin-a')).toHaveAttribute('data-busy','true');await request(page);await expect(page.locator('.editor-global-status')).toContainText('Finish or cancel');await expect(page.locator('.editor-tabs [role=tab]')).toHaveCount(3);expect(await page.evaluate(()=>(window as any).lifecycleCalls.find(c=>c.cmd==='resolve_text_editor_origin_close')?.args.accepted)).toBe(false);await page.evaluate(()=>(window as any).releaseSave());await expect(page.locator('#editor-panel-origin-a')).toHaveAttribute('data-busy','false');await expect(page.locator('.editor-global-status')).toBeEmpty();await request(page);await expect(page.locator('#editor-tab-origin-a')).toHaveCount(0);await expect(page.locator('#editor-tab-origin-b')).toHaveCount(1);
});
