import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const output=path.resolve(process.env.NEARLY_EDITOR_LAYOUT_OUTPUT||'../editor-width-result');
test('editor uses full width with thin tab contours in all themes and at overflow edges',async({page})=>{
  await fs.mkdir(output,{recursive:true});
  await page.addInitScript(()=>{
    (window as any).__TAURI__={core:{invoke:async(cmd:string)=>{
      if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};
      if(cmd==='load_settings')return {theme:'light',language:'en'};
      if(cmd==='list_text_documents')return ['first','middle','last'].map(name=>({token:name,text:'{\n  "sample": "Generated editor width QA",\n  "enabled": true\n}\n',encoding:'UTF-8',newline:'LF',path:'/generated/'+name+'/configuration-'+name+'.json',side:'local'}));
    }},event:{listen:async()=>()=>{}}};
  });
  await page.goto('/editor.html');await expect(page.locator('.editor-tab')).toHaveCount(3);
  const measurements=[];
  for(const theme of ['light','dark','midnight','forest','mint']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const index of [0,1,2]){
      await page.locator('.editor-tabs [role=tab]').nth(index).click();
      // Measure the normal joined surface; hover deliberately brightens a tab.
      await page.mouse.move(1100,850);
      const m=await page.evaluate(()=>{
        const content=document.querySelector('.editor-content')!,area=document.querySelector('textarea')!,layer=document.querySelector('.syntax-layer')!,tab=document.querySelector('.editor-tab:not(.active)')!,active=document.querySelector('.editor-tab.active')!,row=document.querySelector('.editor-active-path')!;
        const c=content.getBoundingClientRect(),s=getComputedStyle(area),t=getComputedStyle(tab);
        const footer=document.querySelector('.editor-footer')!,f=getComputedStyle(footer),format=document.querySelector('.editor-format-slot')!,messages=document.querySelector('.editor-messages')!;
        return {left:c.left,right:innerWidth-c.right,caretLeft:s.paddingLeft,caretRight:s.paddingRight,highlightPadding:getComputedStyle(layer).paddingLeft,divider:getComputedStyle(tab,'::after').content,leftBorder:t.borderLeftWidth,rightBorder:t.borderRightWidth,pathHeight:row.getBoundingClientRect().height,join:row.getBoundingClientRect().top-active.getBoundingClientRect().bottom,background:getComputedStyle(active).backgroundColor,pathBackground:getComputedStyle(row).backgroundColor,footerHeight:footer.getBoundingClientRect().height,footerTopGap:footer.getBoundingClientRect().top-c.bottom,footerBottomGap:innerHeight-footer.getBoundingClientRect().bottom,totalBottomArea:innerHeight-c.bottom,footerPaddingLeft:f.paddingLeft,footerPaddingRight:f.paddingRight,footerPaddingTop:f.paddingTop,footerPaddingBottom:f.paddingBottom,formatRight:innerWidth-format.getBoundingClientRect().right,messagesLeft:messages.getBoundingClientRect().left};
      });
      measurements.push({theme,index,...m});
      if(!process.env.NEARLY_WIDTH_BASELINE){
        expect(m.left).toBe(0);expect(m.right).toBe(0);
        expect(m.caretLeft).toBe('12px');expect(m.caretRight).toBe('12px');expect(m.highlightPadding).toBe('12px');
        expect(m.leftBorder).toBe('1px');expect(m.rightBorder).toBe('1px');
        expect(m.pathHeight).toBe(18);expect(m.join).toBe(0);expect(m.background).toBe(m.pathBackground);
        expect(m.footerHeight).toBe(16);expect(m.footerTopGap).toBe(2);expect(m.footerBottomGap).toBe(2);expect(m.totalBottomArea).toBe(20);expect(m.footerPaddingLeft).toBe('12px');expect(m.footerPaddingRight).toBe('12px');
        expect(m.footerPaddingTop).toBe('0px');expect(m.footerPaddingBottom).toBe('0px');expect(m.formatRight).toBe(12);expect(m.messagesLeft).toBe(12);
      }
    }
    if(theme==='light'||theme==='dark'){
      await page.locator('.editor-tabs [role=tab]').nth(1).click();
      await page.locator('textarea:visible').fill('{\n  "sample": "Unsaved generated fixture",\n  "enabled": true\n}\n');
      await page.mouse.move(1100,850);await page.waitForTimeout(180);
      await page.screenshot({path:path.join(output,(process.env.NEARLY_WIDTH_BASELINE?'before-':'after-')+theme+'.png')});
    }
  }
  await fs.writeFile(path.join(output,process.env.NEARLY_WIDTH_BASELINE?'before.json':'after.json'),JSON.stringify(measurements,null,2));
  await page.setViewportSize({width:420,height:650});
  const strip=page.locator('.editor-tabs');expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await page.locator('.editor-tab').last().locator('[data-editor-tab-close]').focus();
  await expect(page.locator('.editor-tab').last().locator('[data-editor-tab-close]')).toBeInViewport();
  await strip.evaluate(el=>el.scrollLeft=0);
  await page.locator('.editor-tabs [role=tab]').first().focus();
  await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBe(0);
  await expect(page.locator('.editor-tab').first().locator('[data-editor-tab-close]')).toBeInViewport();
  for(const theme of ['light','dark','midnight','forest','mint']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    expect(await page.locator('.editor-footer').evaluate(el=>el.scrollWidth<=el.clientWidth),theme+' narrow footer fits').toBe(true);
    await expect(page.locator('.editor-format-slot')).toBeInViewport();
    const metrics=await page.locator('.editor-document-status .text-editor-status').evaluate(el=>{
      el.textContent='保存済み gypqj ÅÉ';
      const style=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el);
      const glyphs=range.getBoundingClientRect(),bounds=el.getBoundingClientRect();
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d')!;ctx.font=style.font;
      const ink=ctx.measureText(el.textContent);
      return {font:style.fontSize,line:style.lineHeight,height:bounds.height,glyphHeight:glyphs.height,glyphTop:glyphs.top-bounds.top,glyphBottom:bounds.bottom-glyphs.bottom,ink:ink.actualBoundingBoxAscent+ink.actualBoundingBoxDescent};
    });
    expect(metrics.font).toBe('12px');expect(metrics.line).toBe('16px');expect(metrics.height).toBe(16);
    expect(metrics.ink).toBeLessThanOrEqual(16);expect(metrics.glyphTop).toBeGreaterThanOrEqual(0);expect(metrics.glyphBottom).toBeGreaterThanOrEqual(0);
    await page.locator('.editor-document-status .text-editor-status').evaluate(el=>el.textContent='長い保存失敗ステータス gypqj '.repeat(15));
    expect(await page.locator('.editor-footer').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    expect(await page.locator('.editor-document-status .text-editor-status').evaluate(el=>getComputedStyle(el).overflowY)).toBe('auto');
  }
});
