import {test,expect} from '@playwright/test';
import {boot,expand,go,treeControl} from './transfer-v2-fixture';
for(const side of ['local','remote'])test(`pending branch read never reopens collapsed branch or steals unrelated focus ${side}`,async({page})=>{
 await boot(page);if(side==='local'){await expand(page,side,'@pc');await expand(page,side,'C:\\');}
 const root=side==='local'?'C:\\root':'/',parent=side==='local'?'C:\\root\\directory-089':'/directory-089',current=parent+(side==='local'?'\\':'/')+'directory-001';
 await go(page,side,current);await expand(page,side,root);
 // Navigation records ancestors without opening them.
 const toggle=treeControl(page,side,parent,'toggle'),row=toggle.locator('xpath=../..');await expect(toggle).toBeAttached();await expect(row).toHaveAttribute('aria-expanded','false');
 await page.evaluate(({side,parent})=>{const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:any,args:any)=>{if(cmd==='list_'+side&&args.path===parent)await new Promise(r=>(window as any).releaseTree=r);return original(cmd,args);};},{side,parent});
 await toggle.click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).releaseTree)).toBe('function');
 await toggle.click();await expect(row).toHaveAttribute('aria-expanded','false');await expect(treeControl(page,side,parent)).toBeFocused();
 const input=page.locator('#'+side+'-path');await input.focus();await page.evaluate(()=>(window as any).releaseTree());
 await expect(row).toHaveAttribute('aria-expanded','false');await expect(input).toBeFocused();await expect(treeControl(page,side,current)).toHaveCount(0);await expect(input).toHaveValue(current);
 await toggle.click();await expect(treeControl(page,side,current)).toBeFocused();await expect(treeControl(page,side,current)).toBeInViewport();
});
for(const language of ['ja','en'])for(const side of ['local','remote']) {
 test(`branch collapse and reopen reveal current without pointer border ${language} ${side}`,async({page})=>{
  await boot(page,language);if(side==='local'){await expand(page,side,'@pc');await expand(page,side,'C:\\');}
  const parent=side==='local'?'C:\\root':'/',current=side==='local'?'C:\\root\\directory-089':'/directory-089';
  await expand(page,side,parent);await go(page,side,current);
  await treeControl(page,side,parent,'toggle').click();
  await expect(treeControl(page,side,parent)).toBeFocused();await expect(treeControl(page,side,parent)).toBeInViewport();
  await treeControl(page,side,parent,'toggle').click();await expect(treeControl(page,side,current)).toBeFocused();await expect(treeControl(page,side,current)).toBeInViewport();
  expect(await treeControl(page,side,current).evaluate(e=>getComputedStyle(e).outlineStyle)).toBe('none');
  await page.keyboard.press('ArrowUp');expect(await page.locator('[data-tree='+side+'] :focus').evaluate(e=>e.matches(':focus-visible'))).toBe(true);
  await expect(page.locator('#'+side+'-path')).toHaveValue(current);
 });
 test(`side bookmarks match paired appearance and context ${language} ${side}`,async({page})=>{
  await boot(page,language);const pair=page.locator('.bookmark-bar [data-bookmark-open]').first(),item=page.locator('[data-side-open]').filter({visible:true});
  const target=page.locator('[data-side-bookmarks='+side+'] [data-side-open]').first();
  const style=(e:Element)=>{const s=getComputedStyle(e);return {bg:s.backgroundColor,border:s.borderStyle,radius:s.borderRadius,shadow:s.boxShadow};};
  expect(await target.evaluate(style)).toEqual(await pair.evaluate(style));
  await pair.click({button:'right'});const expected=await page.locator('#bookmark-tree-context').evaluate(style);await page.keyboard.press('Escape');
  await target.click({button:'right'});expect(await page.locator('#side-bookmark-context').evaluate(style)).toEqual(expected);
  const sideDelete=await page.locator('[data-side-action=delete]').evaluate(e=>getComputedStyle(e).color);await page.keyboard.press('Escape');await pair.click({button:'right'});
  expect(sideDelete).toBe(await page.locator('[data-bookmark-action=delete]').evaluate(e=>getComputedStyle(e).color));
 });
}
test('successful feedback expires; errors and fresh repeat remain; close cleans timer',async({page})=>{
 await boot(page);await page.clock.install({time:new Date('2030-01-01T00:00:00Z')});await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
 await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');const results=document.createElement('div'),cancel=document.createElement('button');operationFeedback('success',results,cancel).finish(true);});
 await expect(page.locator('.operation-feedback')).toHaveCount(1);await page.clock.fastForward(4999);await expect(page.locator('.operation-feedback')).toHaveCount(1);await page.clock.fastForward(1);await expect(page.locator('.operation-feedback')).toHaveCount(0);
 await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');operationFeedback('error',document.createElement('div'),document.createElement('button')).finish(false);});
 await page.clock.fastForward(10000);await expect(page.locator('.operation-feedback')).toHaveCount(1);
 await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');operationFeedback('repeat',document.createElement('div'),document.createElement('button')).finish(true);});
 await page.clock.fastForward(5000);await expect(page.locator('.operation-feedback')).toHaveText(/error/);
 await page.locator('[data-feedback-close]').click();await page.clock.fastForward(10000);await expect(page.locator('.operation-feedback')).toHaveCount(0);
});
for(const side of ['local','remote'])test(`unrelated branch interaction keeps its own toggle focus ${side}`,async({page})=>{
 await boot(page);if(side==='local'){await expand(page,side,'@pc');await expand(page,side,'C:\\');}const parent=side==='local'?'C:\\root':'/';await expand(page,side,parent);
 const prefix=side==='local'?'C:\\root\\':'/';await go(page,side,prefix+'directory-000');const unrelated=treeControl(page,side,prefix+'directory-089','toggle');await unrelated.click();
 await expect(unrelated).not.toHaveAttribute('aria-busy','true');await expect(unrelated).toBeFocused();await expect(page.locator('#'+side+'-path')).toHaveValue(prefix+'directory-000');
});
test('new notices never silently discard earlier action-required failures',async({page})=>{
 await boot(page);await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');for(let i=0;i<4;i++)operationFeedback('failure '+i,document.createElement('div'),document.createElement('button')).finish(false);});
 await expect(page.locator('.operation-feedback')).toHaveCount(4);await expect(page.locator('.operation-feedback').first()).toContainText('failure 0');
});
