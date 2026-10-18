import {test,expect} from '@playwright/test';
import {boot} from './transfer-v2-fixture';

test('cancelled download notice expires at five seconds; actionable error persists',async({page})=>{
 await boot(page);await page.clock.install({time:new Date('2030-01-01T00:00:00Z')});await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
 await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');operationFeedback('Cancelled download',document.createElement('div'),document.createElement('button')).finish('cancelled');});
 await page.clock.fastForward(4999);await expect(page.locator('.operation-feedback')).toHaveCount(1);
 await page.clock.fastForward(1);await expect(page.locator('.operation-feedback')).toHaveCount(0);
 await page.evaluate(async()=>{const {operationFeedback}=await import('/src/operation-feedback.ts');operationFeedback('Action required',document.createElement('div'),document.createElement('button')).finish(false);});
 await page.clock.fastForward(10000);await expect(page.locator('.operation-feedback')).toContainText('Action required');
});

test('transfer outcome never divides item counts by bytes and distinguishes skipped/staged data',async({page})=>{
 await boot(page,'en');
 const texts=await page.evaluate(async()=>{const {formatTransferOutcome}=await import('/src/transfer-outcome.ts');return [
  formatTransferOutcome({status:'completed',completed:1,bytes:392,transferredBytes:392,skipped:0,message:''}),
  formatTransferOutcome({status:'partial',completed:0,bytes:0,transferredBytes:128,skipped:2,message:''})];});
 expect(texts[0]).toContain('1 item');expect(texts[0]).toContain('392 bytes');expect(texts[0]).not.toContain('1 / 392');
 expect(texts[1]).toContain('0 bytes');expect(texts[1]).toContain('2 skipped');expect(texts[1]).toContain('128 bytes transferred');
});

for(const language of ['ja','en'])for(const theme of ['light','dark','midnight','forest','mint'])test(`conflict checkbox shares text row ${language} ${theme}`,async({page})=>{
 await boot(page,language);await page.evaluate(async(theme)=>{
  document.documentElement.dataset.theme=theme;
  const original=(window as any).__TAURI__.core.invoke;(window as any).__TAURI__.core.invoke=async(cmd:string,args:any)=>cmd==='file_transfer_prompt'?{token:'fixture',source:'source',destination:'destination',canOverwrite:true,sourceDirectory:false,targetDirectory:false}:original(cmd,args);
  const {watchTransferChoices}=await import('/src/transfer-conflict.ts');(window as any).stopConflict=watchTransferChoices('fixture');
 },theme);
 const label=page.locator('#transfer-conflict label'),check=label.locator('input');await expect(check).toBeVisible();
 const geometry=await label.evaluate(label=>{const c=label.querySelector('input')!.getBoundingClientRect();const range=document.createRange();range.selectNodeContents(label.querySelector('span')??label.lastChild!);const t=range.getBoundingClientRect();return {cx:c.x,cy:c.y,ch:c.height,tx:t.x,ty:t.y,th:t.height};});
 expect(geometry.tx).toBeGreaterThan(geometry.cx+10);expect(Math.abs(geometry.cy+geometry.ch/2-geometry.ty-Math.min(geometry.th,20)/2)).toBeLessThan(6);
 await check.check();await expect(check).toBeChecked();await page.keyboard.press('Escape');await expect(page.locator('#transfer-conflict')).toHaveCount(0);
});
