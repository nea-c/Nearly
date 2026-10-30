import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const output=path.resolve('../ui-entry-refinement-result');
test.beforeAll(async()=>{await fs.mkdir(output,{recursive:true});});
const themes=['light','dark','midnight','forest','mint'];
const originalPalettes=JSON.parse(readFileSync(new URL('../fixtures/prejoin-tab-colors.json',import.meta.url),'utf8')).themes;
async function originalInactivePalette(page,kind:'main'|'editor',theme:string) {
  const tab=page.locator(kind==='main'?'.titlebar .tab:not(.active)':'.editor-tab:not(.active)').first();
  const read=()=>tab.evaluate((tab,kind)=>{
    const strip=tab.closest(kind==='main'?'.tabs':'.editor-tabs')!,label=tab.querySelector('[role=tab]')!,close=tab.querySelector('button:not([role=tab])')!;
    const bg=(el:Element)=>getComputedStyle(el).backgroundColor;
    const effective=(el:Element)=>{while(bg(el)==='rgba(0, 0, 0, 0)'&&el.parentElement)el=el.parentElement;return bg(el);};
    return {stripBackground:bg(strip),stripEffective:effective(strip),tabBackground:bg(tab),tabEffective:effective(tab),borderColor:getComputedStyle(tab).borderColor,
      labelColor:getComputedStyle(label).color,labelBackground:bg(label),labelEffective:effective(label),closeColor:getComputedStyle(close).color,closeBackground:bg(close),closeEffective:effective(close)};
  },kind);
  await page.mouse.move(100,500);expect(await read(),theme+' '+kind+' original inactive/strip normal palette').toEqual(originalPalettes[theme][kind].normal);
  // Hover backgrounds intentionally brighten the entire tab now; retain the
  // original normal palette above and original foreground colors on hover.
  await tab.locator('[role=tab]').hover();expect((await read()).labelColor,theme+' '+kind+' label hover foreground').toBe(originalPalettes[theme][kind].labelHover.labelColor);
  await tab.locator('button:not([role=tab])').hover();expect((await read()).closeColor,theme+' '+kind+' close hover foreground').toBe(originalPalettes[theme][kind].closeHover.closeColor);
}

test('main first middle and last tabs share one flush joined shape in every theme',async({page})=>{
  await page.addInitScript(()=>{
    const profile={id:'generated',name:'Generated QA connection',mode:'sftp',host:'fixture.invalid',port:2222,user:'fixture',auth:'key',keyFile:'generated',hostKey:'pin'};
    (window as any).__TAURI__={core:{invoke:async(cmd:string)=>{
      if(cmd==='load_settings')return {version:1,theme:'light',language:'en',profiles:[profile],history:{},exclusions:{},syncOptions:{}};
      if(cmd==='default_folder')return 'C:\\generated';
      if(cmd==='list_drives')return [];
      const entries=[{name:'generated-config.json',dir:false,size:37},{name:'generated-notes.txt',dir:false,size:50}];
      if(cmd==='connect_session')return {path:'/generated/samples',entries};
      if(cmd==='list_local'||cmd==='list_remote')return entries;
    }}};
  });
  await page.goto('/');
  await expect(page.locator('#connect-form')).toBeVisible();
  const initial=await page.locator('.titlebar .tabs').evaluate(strip=>({
    leading:strip.firstElementChild!.getBoundingClientRect().left-strip.getBoundingClientRect().left,
    stripLeading:strip.getBoundingClientRect().left-document.querySelector('.titlebar')!.getBoundingClientRect().left,
    headerHeight:document.querySelector('.titlebar')!.getBoundingClientRect().height,
  }));
  expect(initial).toEqual({leading:0,stripLeading:0,headerHeight:42});
  await page.locator('#connect-form .primary').click();
  for(let i=0;i<2;i++){await page.locator('#add-tab').click();await page.locator('#connect-form .primary').click();}
  for(const theme of themes){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await originalInactivePalette(page,'main',theme);
    let expected;
    for(const index of [0,1,2]){
      const label=page.locator('.titlebar .tab [role=tab]').nth(index);await label.click();await expect(label).toHaveAttribute('aria-selected','true');await page.mouse.move(1100,750);
      const geometry=await page.locator('.titlebar .tab.active').evaluate(el=>{
        const css=getComputedStyle(el),bounds=el.getBoundingClientRect(),strip=document.querySelector('.titlebar .tabs')!,title=document.querySelector('.titlebar')!,bar=document.querySelector('.bookmark-bar')!;
        const t=title.getBoundingClientRect(),s=strip.getBoundingClientRect();
        return {shape:{radius:css.borderRadius,before:getComputedStyle(el,'::before').content,after:getComputedStyle(el,'::after').content,background:css.backgroundColor},bar:getComputedStyle(bar).backgroundColor,
          leading:strip.firstElementChild!.getBoundingClientRect().left-s.left,stripLeading:s.left-t.left,top:bounds.top-t.top,height:bounds.height,headerHeight:t.height,join:bar.getBoundingClientRect().top-bounds.bottom};
      });
      expect(geometry.leading,theme+' flush first tab').toBe(0);expect(geometry.stripLeading).toBe(0);
      expect(geometry.top,theme+' original 5px top gap').toBe(5);expect(geometry.height).toBe(37);expect(geometry.headerHeight).toBe(42);
      expect(geometry.join,theme+' connected surface').toBe(0);expect(geometry.shape.background).toBe(geometry.bar);
      expect(geometry.shape.before).toBe('none');expect(geometry.shape.after).toBe('none');
      if(expected)expect(geometry.shape,theme+' same selected shape at '+index).toEqual(expected);else expected=geometry.shape;
    }
    if(theme==='light'||theme==='dark'){
      await page.locator('.titlebar .tab [role=tab]').nth(1).click();
      await page.locator('.titlebar .tab [role=tab]').nth(1).hover();
      expect(await page.locator('.titlebar .tab.active').evaluate(el=>document.querySelector('.bookmark-bar')!.getBoundingClientRect().top-el.getBoundingClientRect().bottom)).toBe(0);
      await page.mouse.move(1100,750);
      await page.screenshot({path:path.join(output,'main-'+theme+'.png')});
    }
  }
  await page.setViewportSize({width:800,height:650});for(let i=0;i<8;i++)await page.locator('#add-tab').click();
  await page.locator('#connect-form .primary').click();
  const strip=page.locator('.titlebar .tabs');expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await page.keyboard.press('Tab');await page.locator('.titlebar .tab [role=tab]').last().focus();
  expect(await strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
  await page.locator('.titlebar .tab [role=tab]').first().focus();
  expect(await strip.evaluate(el=>el.scrollLeft)).toBe(0);
  const focus=await page.locator('.titlebar .tab [role=tab]').first().evaluate(el=>({visible:el.matches(':focus-visible'),style:getComputedStyle(el).outlineStyle,offset:getComputedStyle(el).outlineOffset}));
  expect(focus).toEqual({visible:true,style:'solid',offset:'-2px'});
  expect(await page.locator('.title-drag').evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(96);
  await expect(page.locator('#settings-toggle')).toBeInViewport();await expect(page.locator('#window-close')).toBeInViewport();
});

test('editor first middle and last tabs share one flush joined shape and scrolling edges',async({page})=>{
  await page.addInitScript(()=>{
    const w=window as any;w.handlers={};
    w.__TAURI__={core:{invoke:async(cmd:string)=>{
      if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};
      if(cmd==='load_settings')return {theme:'light',language:'en'};
      if(cmd==='list_text_documents')return ['first','middle','last'].map((position,index)=>({token:position,text:JSON.stringify({generated:true,position},null,2),encoding:'UTF-8',newline:'LF',path:'/generated/'+position+'/generated-configuration-document-'+position+'.json',side:'remote',connectionLabel:'fixture@localhost:2222'}));
    }},event:{listen:async(name:string,handler:any)=>{w.handlers[name]=handler;return()=>{};}}};
  });
  await page.goto('/editor.html');await expect(page.locator('.editor-tabs [role=tab]')).toHaveCount(3);
  for(const theme of themes){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await originalInactivePalette(page,'editor',theme);
    let expected;
    for(const index of [0,1,2]){
      const label=page.locator('.editor-tabs [role=tab]').nth(index);await label.click();await expect(label).toHaveAttribute('aria-selected','true');await page.mouse.move(1100,750);
      const geometry=await page.locator('.editor-tab.active').evaluate(el=>{
        const css=getComputedStyle(el),bounds=el.getBoundingClientRect(),strip=document.querySelector('.editor-tabs')!,shell=document.querySelector('.editor-shell')!,content=document.querySelector('.editor-content')!,path=document.querySelector('.editor-active-path')!;
        return {shape:{radius:css.borderRadius,before:getComputedStyle(el,'::before').content,after:getComputedStyle(el,'::after').content,background:css.backgroundColor},pathBackground:getComputedStyle(path).backgroundColor,
          leading:strip.firstElementChild!.getBoundingClientRect().left-content.getBoundingClientRect().left,top:bounds.top-shell.getBoundingClientRect().top,height:bounds.height,join:path.getBoundingClientRect().top-bounds.bottom,contentJoin:content.getBoundingClientRect().top-path.getBoundingClientRect().bottom};
      });
      expect(geometry.leading,theme+' flush editor tab/content').toBe(0);expect(geometry.top,theme+' unchanged editor top gap').toBe(8);expect(geometry.height).toBe(40);
      expect(geometry.join).toBe(0);expect(geometry.contentJoin).toBe(0);expect(geometry.shape.background).toBe(geometry.pathBackground);
      expect(geometry.shape.before).toBe('none');expect(geometry.shape.after).toBe('none');
      if(expected)expect(geometry.shape,theme+' same editor selected shape at '+index).toEqual(expected);else expected=geometry.shape;
    }
    if(theme==='light'||theme==='dark'){
      await page.locator('.editor-tabs [role=tab]').nth(1).click();
      await page.mouse.move(1100,750);
      await page.screenshot({path:path.join(output,'editor-'+theme+'.png')});
    }
  }
  await page.setViewportSize({width:800,height:650});
  const strip=page.locator('.editor-tabs');expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  await strip.evaluate(el=>el.scrollLeft=el.scrollWidth);
  await page.keyboard.press('Tab');await page.locator('.editor-tab').last().locator('[data-editor-tab-close]').focus();
  await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator('.editor-tab').last().locator('[data-editor-tab-close]')).toBeInViewport();
  await strip.evaluate(el=>el.scrollLeft=0);
  await page.locator('.editor-tabs [role=tab]').first().focus();await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBe(0);
  expect(await page.locator('.editor-tabs [role=tab]').first().evaluate(el=>({visible:el.matches(':focus-visible'),style:getComputedStyle(el).outlineStyle,offset:getComputedStyle(el).outlineOffset}))).toEqual({visible:true,style:'solid',offset:'-2px'});
  await expect(page.locator('.editor-tab').first().locator('[data-editor-tab-close]')).toBeInViewport();
});
