import { expandTreePath } from './tree-expansion';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.rootCalls = [];
    const entries = [{name:'empty',dir:true,size:0}, ...Array.from({length:50}, (_,i)=>({name:`file${i}.txt`,dir:false,size:i}))];
    window.__TAURI__ = {core:{invoke:async(cmd,args)=>{
      window.rootCalls.push({cmd,args});
      if(cmd==='load_settings') return {version:1,profiles:[{id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',keyFile:'generated.ppk',hostKey:'SHA256:'+'A'.repeat(43)}],history:{},paneColumns:{local:{order:['size','name','type','modified'],hidden:[],widths:{size:100,name:280,type:100,modified:170}},remote:{order:['size','name','type','modified'],hidden:[],widths:{size:100,name:280,type:100,modified:170}}}};
      if(cmd==='default_folder') return 'C:\\root';
      if(cmd==='list_drives') return [{path:'C:\\',name:'C:'},{path:'D:\\',name:'D:'}];
      if(cmd==='connect_session') return {path:'/',entries};
      if(cmd==='list_local'&&args.path==='C:\\')return [{name:'root',dir:true,size:0},...entries.slice(1)];
      if(cmd==='list_local'||cmd==='list_remote') return args.path.endsWith('empty')?[]:entries;
    }}};
  });
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('#prepare')).toBeVisible();
});

test('absolute drive roots open through path Enter and PC tree; drive-relative input cannot change target', async({page})=>{
  for(const drive of ['C','D']) {
    await page.locator('#local-path').fill(drive+':\\');
    await page.locator('#local-path').press('Enter');
    await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('[data-up=local]')).toBeDisabled();
    await expect(page.locator('[data-list=local] [data-entry]')).toHaveCount(51);
    await expandTreePath(page,'local','@pc');
    const button=page.locator('[data-tree-select=local]').filter({hasText:drive+':' }).first();
    await button.click();
    await expect(page.locator('#local-path')).toHaveValue(drive+':\\');
  }
  const count=await page.evaluate(()=>window.rootCalls.filter(c=>c.cmd==='list_local').length);
  await page.locator('#local-path').fill('C:');
  await page.locator('#local-path').press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.rootCalls.filter(c=>c.cmd==='list_local').length)).toBe(count);
  await expect(page.locator('[data-up=local]')).toBeDisabled();
});

for(const side of ['local','remote']) test(`${side} empty folder can repeatedly collapse and expand without re-fetch`,async({page})=>{
  const path=side==='local'?'C:\\root\\empty':'/empty';
  const toggle=page.locator(`[data-tree-toggle=${side}]`).filter({has:page.locator('svg')}).and(page.locator(`[data-tree-path="${path.replaceAll('\\','\\\\')}"]`));
  await expandTreePath(page,side,side==='local'?'C:\\root':'/');
  // Expand the lazy child, then exercise the now-known empty state.
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle.locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
  const count=await page.evaluate(()=>window.rootCalls.length);
  for(let i=0;i<3;i++) {
    await toggle.click();
    await expect(toggle.locator('xpath=../..')).toHaveAttribute('aria-expanded','false');
    await toggle.click();
    await expect(toggle.locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
  }
  expect(await page.evaluate(()=>window.rootCalls.length)).toBe(count);
});

test('name-cell icons remain clipped under headers when name is not first and list scrolls',async({page})=>{
  await page.setViewportSize({width:800,height:650});
  for(const side of ['local','remote']) {
    const list=page.locator(`[data-list=${side}]`);
    await expect(list.locator('th').nth(1)).toHaveAttribute('data-column','name');
    await expect(list.locator('td:not([data-cell=name]) .folder-glyph')).toHaveCount(0);
    const valid=await list.evaluate(el=>{
      const cell=el.querySelector('td[data-cell=name]'),icon=cell.querySelector('.folder-glyph');
      const c=cell.getBoundingClientRect(),i=icon.getBoundingClientRect();
      return getComputedStyle(cell).isolation==='isolate'&&i.left>=c.left&&i.right<=c.right;
    });
    expect(valid).toBe(true);
    await list.evaluate(el=>{el.scrollTop=23;el.scrollLeft=90;});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const headerOnTop=await list.evaluate(el=>{
      const h=el.querySelector('th[data-column=name]'),b=h.getBoundingClientRect();
      return document.elementFromPoint(b.left+40,b.top+15)?.closest('th')===h;
    });
    expect(headerOnTop).toBe(true);
  }
  await page.screenshot({path:'test-results/explorer-icon-clipping-800.png'});
});
