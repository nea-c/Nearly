import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';import path from 'node:path';
test('compact display-only breadcrumbs track the exact active document and keep filenames visible',async({page})=>{
  await page.addInitScript(()=>{
    const paths=[['C:\\generated\\日本語\\same.json','local',''],['\\\\generated-server\\share\\folder\\same.json','local',''],['/data/main/function/time_leap/same.json','remote','fixture-A@localhost:2222'],['/data/main/function/time_leap/same.json','remote','fixture-B@localhost:2223'],['/'+('very-long-folder/'.repeat(20))+'長い名前.json','remote','fixture-C@localhost:2224']];
    (window as any).__TAURI__={core:{invoke:async(cmd:string)=>{
      if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};
      if(cmd==='load_settings')return {theme:'dark',language:'en'};
      if(cmd==='list_text_documents')return paths.map(([path,side,connectionLabel],i)=>({token:'crumb-'+i,path,side,connectionLabel,text:'generated sample',encoding:'UTF-8',newline:'LF'}));
    }},event:{listen:async()=>()=>{}}};
  });
  await page.goto('/editor.html');await expect(page.locator('.editor-tab')).toHaveCount(5);
  for(const theme of ['light','dark','midnight','forest','mint']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const i of [0,1,2,3,4]){
      await page.locator('.editor-tabs [role=tab]').nth(i).click();
      const row=page.locator('.editor-active-path');
      await expect(row.locator('button,a,input')).toHaveCount(0);
      await expect(row.locator('.editor-breadcrumb-file')).toHaveText(i===4?'長い名前.json':'same.json');
      const title=await row.getAttribute('title');expect(title).toContain(i<2?(i===0?'C:\\generated':'\\\\generated-server\\share'):'/');
      await expect(row).toHaveAttribute('aria-label',i===2?/fixture-A/:i===3?/fixture-B/:i===4?/fixture-C/:/Local/);
      const m=await row.evaluate(el=>{const b=el.getBoundingClientRect(),file=el.querySelector('.editor-breadcrumb-file')!.getBoundingClientRect();return {height:b.height,clipped:el.scrollHeight>el.clientHeight,left:file.left-b.left,right:b.right-file.right,cursor:getComputedStyle(el.querySelector('.editor-breadcrumb-file')!).cursor};});
      expect(m.height).toBe(18);expect(m.clipped).toBe(false);expect(m.left).toBeGreaterThanOrEqual(0);expect(m.right).toBeGreaterThanOrEqual(0);expect(m.cursor).not.toBe('pointer');
      if(theme==='dark'&&i===3){
        const dir=path.resolve('../editor-footer-compact-result');await fs.mkdir(dir,{recursive:true});
        await page.mouse.move(1100,750);await page.screenshot({path:path.join(dir,'breadcrumb-dark.png')});
      }
    }
    await page.setViewportSize({width:420,height:650});
    const row=page.locator('.editor-active-path'),file=row.locator('.editor-breadcrumb-file');
    await expect(file).toBeInViewport();expect(await file.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    expect((await row.getAttribute('title'))!.length).toBeGreaterThan(250);
    expect(await row.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.setViewportSize({width:1280,height:920});
  }
});
