import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const output=path.resolve('test-results/main-tab-states');fs.mkdirSync(output,{recursive:true});
const themes=['forest','light','dark','midnight','mint'];
async function wholeTabHover(page:any,tab:any,evidence?:string){
 const read=()=>tab.evaluate((el:HTMLElement)=>{
  const close=el.querySelector<HTMLElement>('button:not([role=tab])')!,label=el.querySelector<HTMLElement>('[role=tab]')!;
  const color=(node:HTMLElement)=>{let s=getComputedStyle(node).backgroundColor;while(s==='rgba(0, 0, 0, 0)'&&node.parentElement){node=node.parentElement;s=getComputedStyle(node).backgroundColor;}const c=document.createElement('canvas').getContext('2d')!;c.fillStyle=s;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);};
  return {tab:color(el),close:color(close),label:color(label),selected:label.getAttribute('aria-selected'),theme:document.documentElement.dataset.theme};
 });
 const light=(rgb:number[])=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
 await page.mouse.move(1100,700);const normal=await read();if(evidence)await page.screenshot({path:path.join(output,evidence+'-normal.png')});
 await tab.locator('[role=tab]').hover();const hover=await read();if(evidence)await page.screenshot({path:path.join(output,evidence+'-tab-hover.png')});
 expect(hover.tab).not.toEqual(normal.tab);if(['dark','midnight','forest'].includes(normal.theme!))expect(light(hover.tab)).toBeGreaterThan(light(normal.tab));expect(hover.close).toEqual(hover.tab);expect(hover.label).toEqual(hover.tab);
 await tab.locator('button:not([role=tab])').hover();const close=await read();if(evidence)await page.screenshot({path:path.join(output,evidence+'-close-hover.png')});
 expect(close.tab).toEqual(hover.tab);expect(close.close).not.toEqual(hover.tab);if(['dark','midnight','forest'].includes(normal.theme!))expect(light(close.close)).toBeGreaterThan(light(hover.tab));expect(close.selected).toBe(normal.selected);
 await tab.locator('[role=tab]').hover();expect(await read()).toEqual(hover);
 await page.mouse.move(1100,700);expect(await read()).toEqual(normal);
 await page.keyboard.press('Tab');await tab.locator('button:not([role=tab])').focus();
 const focused=await read();expect(focused.close).not.toEqual(normal.close);expect(focused.selected).toBe(normal.selected);
 expect(await tab.locator('button:not([role=tab])').evaluate((el:HTMLElement)=>el.matches(':focus-visible'))).toBe(true);
 if(await tab.locator('.editor-tab-cross').count())await expect(tab.locator('.editor-tab-cross')).toBeVisible();
 await tab.locator('button:not([role=tab])').evaluate((el:HTMLElement)=>el.blur());
}

test('main tabs join the actual surface without vertical dividers in new, failed and connected states',async({page})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{
  const w=window as any;
  const profile={id:'sample',name:'Sample connection',mode:'sftp',host:'fixture.invalid',port:2222,user:'sample',auth:'key',keyFile:'generated-only',hostKey:'generated-pin'};
  w.__TAURI__={core:{invoke:async(cmd:string)=>{
   if(cmd==='load_settings')return {version:1,theme:'forest',language:'en',profiles:[profile],history:{},exclusions:{},syncOptions:{}};
   if(cmd==='default_folder')return 'C:\\generated';
   if(cmd==='list_drives')return [];
   if(cmd==='connect_session'){if(w.failGeneratedConnection)throw Error('Generated disconnected fixture');return {path:'/generated',entries:[]};}
   if(cmd==='list_local'||cmd==='list_remote')return [];
  }}};
 });
 await page.goto('/');await expect(page.locator('#connect-form')).toBeVisible();
 for(let i=0;i<2;i++)await page.locator('#add-tab').click();
 const results:any[]=[];
 for(const state of ['new','failed','connected']){
  for(const theme of themes){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   for(const index of [0,1,2]){
    const label=page.locator('.titlebar .tab [role=tab]').nth(index);await label.click();await expect(label).toHaveAttribute('aria-selected','true');
    if(state==='failed'){
     await page.evaluate(()=>{(window as any).failGeneratedConnection=true;});
     await page.locator('#connect-form .primary').click();await expect(page.locator('#connect-form .primary')).toBeEnabled();
    }else if(state==='connected'&&await page.locator('#connect-form').count()){
     await page.evaluate(()=>{(window as any).failGeneratedConnection=false;});
     await page.locator('#connect-form .primary').click();await expect(page.locator('.bookmark-bar')).toBeVisible();
    }
    await page.mouse.move(1100,700);
    const read=()=>page.evaluate(()=>{
     const title=document.querySelector<HTMLElement>('.titlebar')!,strip=title.querySelector<HTMLElement>('.tabs')!,active=title.querySelector<HTMLElement>('.tab.active')!;
     const surface=document.querySelector<HTMLElement>('.bookmark-bar')??document.querySelector<HTMLElement>('main')!;
     function effective(el:HTMLElement|null):string{if(!el)return 'none';const c=getComputedStyle(el).backgroundColor;return c==='rgba(0, 0, 0, 0)'?effective(el.parentElement):c;}
     const t=title.getBoundingClientRect(),a=active.getBoundingClientRect(),s=strip.getBoundingClientRect(),below=surface.getBoundingClientRect();
     return {titleHeight:t.height,top:a.top-t.top,clientTop:a.top,tabHeight:a.height,leading:strip.firstElementChild!.getBoundingClientRect().left-s.left,join:below.top-a.bottom,
      activeBackground:getComputedStyle(active).backgroundColor,surfaceBackground:effective(surface),
      tabs:[...strip.querySelectorAll<HTMLElement>('.tab')].map(el=>({left:getComputedStyle(el).borderLeftWidth,right:getComputedStyle(el).borderRightWidth,after:getComputedStyle(el,'::after').content,background:getComputedStyle(el).backgroundColor})),
      stripBackground:getComputedStyle(title).backgroundColor};
    });
    const geometry=await read();results.push({state,theme,index,...geometry});
    if(theme==='forest'&&(index===0||index===1))await page.screenshot({path:path.join(output,`${state}-forest-${index}.png`)});
    // Write observations before assertions so the released failure is reviewable.
    fs.writeFileSync(path.join(output,'geometry.json'),JSON.stringify(results,null,2));
    expect(geometry.leading).toBe(0);expect(geometry.titleHeight).toBe(42);expect(geometry.top).toBe(5);
    expect(geometry.join,`${state}/${theme}/${index} seamless edge`).toBe(0);
    expect(geometry.activeBackground,`${state}/${theme}/${index} actual adjacent surface`).toBe(geometry.surfaceBackground);
    for(const tab of geometry.tabs){expect(tab.left).toBe('0px');expect(tab.right).toBe('0px');expect(tab.after).toBe('none');}
    await wholeTabHover(page,page.locator('.titlebar .tab').nth(index),state==='new'&&index===1&&['light','dark','forest'].includes(theme)?'main-new-'+theme:undefined);
    if(index===0)await wholeTabHover(page,page.locator('.titlebar .tab').nth(1));
    await label.hover();const hovered=await read();expect(hovered.tabs.map(t=>[t.left,t.right,t.after])).toEqual(geometry.tabs.map(t=>[t.left,t.right,t.after]));
    await label.focus();await page.keyboard.press('ArrowRight');await label.focus();
    expect(await label.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid');
   }
  }
 }
});

test('editor whole-tab and close hover are distinct for saved and dirty active/inactive tabs in every theme',async({page})=>{
 test.setTimeout(120000);
 await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async(cmd:string)=>{
  if(cmd==='register_window')return {label:'text-editor',ownedWorkspaceIds:[]};if(cmd==='load_settings')return {theme:'forest',language:'en'};
  if(cmd==='list_text_documents')return ['first','second'].map(token=>({token,text:'generated sample',encoding:'UTF-8',newline:'LF',path:'/generated/'+token+'.txt',side:'local',connectionLabel:'Local'}));
 }},event:{listen:async()=>()=>{}}};});
 await page.goto('/editor.html');await expect(page.locator('.editor-tab')).toHaveCount(2);
 for(const theme of themes){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const index of [0,1]){await page.locator('.editor-tab [role=tab]').nth(index).click();await page.locator('.text-editor:not([hidden]) textarea').fill('generated sample');}
  for(const index of [0,1]){await page.locator('.editor-tab [role=tab]').nth(index).click();for(const dirty of [false,true]){
   await page.locator('.text-editor:not([hidden]) textarea').fill(dirty?'changed generated sample':'generated sample');
   for(const tabIndex of [0,1])await wholeTabHover(page,page.locator('.editor-tab').nth(tabIndex),tabIndex===index&&index===0&&['light','dark'].includes(theme)?'editor-'+(dirty?'dirty':'saved')+'-'+theme:undefined);
   if(dirty){const tab=page.locator('.editor-tab').nth(index);await page.mouse.move(1100,700);await expect(tab.locator('.editor-tab-dirty')).toBeVisible();await tab.locator('[data-editor-tab-close]').hover();await expect(tab.locator('.editor-tab-cross')).toBeVisible();}
  }}
 }
});

test('rendered historical header CSS establishes the total client-to-tab gap at normal and scaled viewports',async({browser})=>{
 test.setTimeout(120000);
 const rows:any[]=[];
 const css=(ref:string)=>['workspace.css','style.css','green-themes.css'].map(name=>ref==='current'?fs.readFileSync('src/'+name,'utf8'):execFileSync('git',['show',ref+':src/'+name],{encoding:'utf8'})).join('\n');
 for(const dpr of [1,1.5]){
  const context=await browser.newContext({deviceScaleFactor:dpr,viewport:{width:1280,height:920}}),page=await context.newPage();
  try{for(const width of [1280,1920]){await page.setViewportSize({width,height:920});
   for(const ref of ['r3.6','5ca1b672efd81a6599d777a47b144f61250b729d','current'])for(const connected of [false,true])for(const index of [0,1,2]){
    const tabs=[0,1,2].map(i=>`<div class="tab ${i===index?'active':''}"><button role="tab"><span>New tab ${i+1}</span></button><button data-close="${i}">×</button></div>`).join('');
    await page.setContent(`<html data-theme="forest"><head><style>${css(ref)} .titlebar{--tab-count:3}</style></head><body><div id="app"><header class="titlebar"><div class="tabs">${tabs}</div><button class="add-tab">+</button><div class="title-drag"></div><div class="window-controls"><button>−</button><button>□</button><button>×</button></div></header><main>${connected?'<div class="bookmark-bar">Generated pair bookmarks</div>':'<div class="connection-view">Generated disconnected fixture</div>'}</main><footer class="statusbar">Generated QA</footer></div></body></html>`);
    await page.mouse.move(1100,700);
    const value=await page.evaluate(()=>{const title=document.querySelector<HTMLElement>('.titlebar')!,tabs=[...document.querySelectorAll<HTMLElement>('.tab')];return {clientTitleTop:title.getBoundingClientRect().top,titleHeight:title.getBoundingClientRect().height,tabs:tabs.map(t=>{const c=getComputedStyle(t),label=t.querySelector<HTMLElement>('[role=tab]')!,span=label.querySelector<HTMLElement>('span')!;return {selected:t.classList.contains('active'),clientTop:t.getBoundingClientRect().top,height:t.getBoundingClientRect().height,labelTop:label.getBoundingClientRect().top,textLineTop:span.getBoundingClientRect().top,paddingTop:c.paddingTop,marginTop:c.marginTop,borderTop:c.borderTopWidth,lineHeight:getComputedStyle(label).lineHeight};})};});
    rows.push({method:'historical CSS with identical generated header markup, not native EXE',ref,connected,index,dpr,viewportWidth:width,...value});
    expect(value.clientTitleTop).toBe(0);expect(value.titleHeight).toBe(42);
    expect(value.tabs.find(t=>t.selected)!.clientTop).toBe(5);
    if(ref==='current')for(const tab of value.tabs){expect(tab.clientTop).toBe(5);expect(tab.textLineTop,'restore the pre-join text position, not only outer padding').toBe(13.25);}
   }
  }}finally{await context.close();}
 }
 fs.writeFileSync(path.join(output,'historical-client-geometry.json'),JSON.stringify(rows,null,2));
});
