import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
test('remote listing cache reuses tree and navigation reads and explicit refresh invalidates',async({page})=>{
  await page.addInitScript(()=>{
    window.perfReads=[];
    const profile={id:'perf',name:'Latency fixture',host:'fixture.invalid',port:22,user:'test',auth:'key',mode:'sftp',hostKey:'SHA256:fixture'};
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      if(cmd==='load_settings')return {version:1,profiles:[profile],history:{}};
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
      if(cmd==='list_local')return [];
      if(cmd==='connect_session')return {path:'/',entries:[{name:'a',dir:true,size:0}]};
      if(cmd==='list_remote') {const start=performance.now();await new Promise(r=>setTimeout(r,150));window.perfReads.push({path:args.path,ms:performance.now()-start});return args.path==='/'?[{name:'a',dir:true,size:0}]:[{name:'child',dir:true,size:0}];}
    }}};
  });
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  const start=Date.now();
  await page.locator('[data-tree-toggle=remote][data-tree-path="/a"]').click();
  await expect(page.locator('[data-tree-select=remote][data-tree-path="/a/child"]')).toBeVisible();
  await page.locator('[data-tree-select=remote][data-tree-path="/a"]').click();
  await expect(page.locator('#remote-path')).toHaveValue('/a');await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
  await page.locator('[data-back=remote]').click();await expect(page.locator('#remote-path')).toHaveValue('/');
  await page.locator('[data-forward=remote]').click();await expect(page.locator('#remote-path')).toHaveValue('/a');
  const result={fixtureLatencyMs:150,totalMs:Date.now()-start,reads:await page.evaluate(()=>window.perfReads)};
  writeFileSync('test-results/navigation-latency-cached.json',JSON.stringify(result,null,2));
  expect(result.reads.length).toBe(1);
  await page.locator('[data-refresh=remote]').click();
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
  expect(await page.evaluate(()=>window.perfReads.length)).toBe(2);
});
