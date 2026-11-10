import {test,expect} from '@playwright/test';
async function setup(page, action='copy', language='en') {
 await page.goto('/');
 await page.evaluate(async({action,language})=>{
  const w=window as any;const {setLanguage}=await import('/src/i18n.ts');setLanguage(language);
  w.sample={phase:'copying',unit:'bytes',done:9,total:10,entries:0,item:2,itemCount:3,selectionCompleted:1,selectionTotal:3};
  w.__TAURI__={core:{invoke:async()=>w.sample}};
  const {operationFeedback}=await import('/src/operation-feedback.ts');
  w.feedback=operationFeedback('Generated selection',document.createElement('div'),document.createElement('button'),{action});
  w.feedback.selectionProgress(0,3);w.feedback.track('fixture');
 },{action,language});
}
for(const language of ['ja','en'])test('copy uses current-root bytes with separate overall counts '+language,async({page})=>{
 await setup(page,'copy',language);
 const gauge=page.locator('.operation-feedback progress'),label=page.locator('.operation-progress-label'),selection=page.locator('.operation-selection-label');
 await expect(gauge).toHaveAttribute('max','10');await expect(gauge).toHaveAttribute('value','9');
 await expect(selection).toContainText(language==='ja'?'全3項目中1項目完了':'1 of 3 items completed');
 await expect(label).toContainText(language==='ja'?'現在項目':'Current item');
 await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing'});
 await expect(label).toContainText(language==='ja'?'確定中':'Finalizing');await expect(gauge).toHaveAttribute('value','9');
 await page.evaluate(()=>window.sample={...window.sample,phase:'copying',done:10});
 await expect(gauge).toHaveAttribute('value','10');await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
 await page.evaluate(()=>window.sample={...window.sample,phase:'scanning',done:0,total:null,item:3,selectionCompleted:2});
 await expect(selection).toContainText(language==='ja'?'全3項目中2項目完了':'2 of 3 items completed');await expect(gauge).not.toHaveAttribute('value');
 await page.evaluate(()=>window.feedback.finish(true));
 await expect(gauge).toHaveAttribute('max','1');await expect(gauge).toHaveAttribute('value','1');
 await expect(selection).toContainText(language==='ja'?'全3項目中3項目完了':'3 of 3 items completed');
 await expect(label).toHaveText(language==='ja'?'完了':'Completed');
});
test('move shows stages and counts but no byte or percentage gauge even with stale byte samples',async({page})=>{
 await setup(page,'move');
 await expect(page.locator('.operation-selection-label')).toContainText('1 of 3 items completed');
 await expect(page.locator('progress')).toBeHidden();await expect(page.locator('.operation-progress-label')).not.toContainText(' B');
 await page.evaluate(()=>window.sample={...window.sample,phase:'moving',unit:'entries',done:0,total:1});
 await expect(page.locator('.operation-progress-label')).toContainText('Moving');
 await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing'});
 await expect(page.locator('.operation-progress-label')).toContainText('Finalizing');await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
 await page.evaluate(()=>window.feedback.finish(true));await expect(page.locator('progress')).toBeHidden();
 await expect(page.locator('.operation-selection-label')).toContainText('3 of 3 items completed');
});
for(const ending of ['cancelled',false] as const)test('copy terminal '+ending+' retains only confirmed counts and no completed byte bar',async({page})=>{
 await setup(page);await expect(page.locator('progress')).toHaveAttribute('value','9');
 await page.evaluate(ending=>{window.feedback.selectionProgress(0,3);window.feedback.selectionProgress(2,9);window.feedback.finish(ending);window.sample={...window.sample,selectionCompleted:3};},ending);
 await expect(page.locator('.operation-selection-label')).toContainText('1 of 3 items completed');
 await expect(page.locator('progress')).toBeHidden();await expect(page.locator('progress')).not.toHaveAttribute('value');
 await expect(page.locator('.operation-progress-label')).toContainText('incomplete');
 await expect(page.locator('.operation-feedback')).toHaveAttribute('data-success','false');
});
test('zero-byte roots remain indeterminate until authoritative success',async({page})=>{
 await setup(page);await page.evaluate(()=>window.sample={...window.sample,phase:'finalizing',done:0,total:0});
 await expect(page.locator('progress')).not.toHaveAttribute('value');await expect(page.locator('.operation-progress-label')).toContainText('0 / 0 B');
 await expect(page.locator('.operation-feedback')).not.toHaveAttribute('data-complete');
 await page.evaluate(()=>window.feedback.finish(true));await expect(page.locator('progress')).toHaveAttribute('value','1');
});
test('invalid bytes never become determinate and retry starts at zero completed items',async({page})=>{
 await setup(page);await page.evaluate(()=>window.sample={...window.sample,done:9007199254740992,total:9007199254740992});
 await expect(page.locator('progress')).not.toHaveAttribute('value');await expect(page.locator('.operation-progress-label')).not.toContainText('9,007');
 await expect(page.locator('.operation-selection-label')).toContainText('1 of 3 items completed');
 await page.evaluate(()=>window.feedback.finish(false));await page.locator('[data-feedback-close]').click();
 await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');window.feedback=operationFeedback('Retry',document.createElement('div'),document.createElement('button'),{action:'copy'});window.feedback.selectionProgress(0,3);});
 await expect(page.locator('.operation-selection-label')).toContainText('0 of 3 items completed');await expect(page.locator('progress')).not.toHaveAttribute('value');
});
test('deletion keeps a selection count gauge separate from recursive entry counts',async({page})=>{
 await setup(page,'delete');await page.evaluate(()=>window.sample={...window.sample,phase:'deleting',unit:'entries',done:19,total:20});
 await expect(page.locator('progress')).toHaveAttribute('max','3');await expect(page.locator('progress')).toHaveAttribute('value','1');
 await expect(page.locator('.operation-progress-label')).toContainText('19 / 20 entries');
 await page.evaluate(()=>window.feedback.finish(false));await expect(page.locator('progress')).toHaveAttribute('value','1');
 await expect(page.locator('.operation-selection-label')).toContainText('1 of 3 items completed');
});

for(const language of ['ja','en'])test('parallel copy groups label aggregate bytes and keep partial counts '+language,async({page})=>{
 await setup(page,'copy',language);
 await page.evaluate(()=>window.sample={...window.sample,groupCount:4,item:1,itemCount:5,selectionTotal:3,selectionCompleted:2,done:256,total:512});
 await expect(page.locator('.operation-progress-label')).toContainText(language==='ja'?'現在グループ（4項目）':'Current group (4 items)');
 await expect(page.locator('progress')).toHaveAttribute('value','256');await expect(page.locator('progress')).toHaveAttribute('max','512');
 await expect(page.locator('progress')).toHaveAttribute('aria-label',language==='ja'?'現在グループの転送バイト数':'Current group transferred bytes');
 await page.evaluate(()=>window.feedback.finish(false));await expect(page.locator('progress')).toBeHidden();
 await expect(page.locator('.operation-selection-label')).toContainText(language==='ja'?'全3項目中2項目完了':'2 of 3 items completed');
});
