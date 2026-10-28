import { test, expect } from '@playwright/test';

async function fixture(page, theme='light') {
  await page.addInitScript(({theme})=>{
    const profile={id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',keyFile:'generated',hostKey:'pin'};
    const key=JSON.stringify(['a','sftp',profile.host,22,'test','pin']);
    const initial={version:1,theme,profiles:[profile],history:{},folderBookmarks:[{id:'one',name:'One',connectionKey:key,local:'C:\\saved',remote:'/saved'}],bookmarkTree:{version:1,nodes:[{id:'one',kind:'bookmark',bookmarkId:'one',parentId:null,connectionKey:key},{id:'g',kind:'group',name:'Group',parentId:null,connectionKey:key}]},syncPresets:[{id:'preset',name:'Rules',exclusionRules:'*.tmp',deleteRemoved:false,recursive:true}],exclusions:{},syncOptions:{}};
    window.chromeCalls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.chromeCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('chrome-settings')||'null')||initial;
      if(cmd==='save_settings'){if(window.holdChromeSave)await new Promise((resolve,reject)=>{window.resolveChromeSave=resolve;window.rejectChromeSave=reject});localStorage.setItem('chrome-settings',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/root',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return [];
    }}};
  },{theme});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('[data-bookmark-open=one]')).toBeEnabled();
}
async function context(page,id?) {
  if(id)await page.locator(`[data-bookmark-tree-node=${id}]`).click({button:'right'});
  else {const strip=page.locator('.bookmark-bar .bookmark-items'),b=await strip.boundingBox();await strip.click({button:'right',position:{x:b.width-3,y:b.height/2}});}
  await expect(page.locator('#bookmark-tree-context')).toBeVisible();
}
async function contrast(locator) {
  return locator.evaluate(element=>{
    const parse=(text)=>text.match(/[\d.]+/g).map(Number);
    let node=element, background;
    while(node){const value=parse(getComputedStyle(node).backgroundColor);if(value.length===3||value[3]===1){background=value;break;}node=node.parentElement;}
    background??=[255,255,255];
    const luminance=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const values=[luminance(parse(getComputedStyle(element).color)),luminance(background)].sort((a,b)=>b-a);
    return (values[0]+.05)/(values[1]+.05);
  });
}
const snapshot=page=>page.evaluate(()=>{const data=JSON.parse(localStorage.getItem('chrome-settings'));return Object.fromEntries(['profiles','history','folderBookmarks','bookmarkTree','exclusions','syncOptions','syncPresets'].map(key=>[key,data[key]]))});

for(const mode of ['light','dark'])test(`bookmark context has ordered concise actions and red deletion in ${mode}`,async({page})=>{
  await fixture(page,mode);await context(page);
  expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.map(e=>e.getAttribute('data-bookmark-action')))).toEqual(['register','create','history']);
  await expect(page.locator('[data-bookmark-action=create]')).toHaveText('フォルダを追加');
  await page.keyboard.press('Escape');
  for(const id of ['one','g']){
    await context(page,id);
    expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.slice(0,3).map(e=>e.getAttribute('data-bookmark-action')))).toEqual(['register','create','history']);
    await expect(page.locator('[data-bookmark-action=create]')).toHaveText('フォルダを追加');
    await expect(page.locator('[data-bookmark-action=move]')).toHaveCount(0);
    await expect(page.locator('[data-bookmark-action=edit]')).toHaveCount(id==='one'?1:0);
    expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.slice(3).map(e=>e.getAttribute('data-bookmark-action')))).toEqual(id==='one'?['edit','rename','delete']:['rename','delete']);
    await expect(page.locator('[data-bookmark-action=rename]')).toBeVisible();
    const deletion=page.locator('[data-bookmark-action=delete]');
    const color=await deletion.evaluate(e=>getComputedStyle(e).color);
    expect(color).toBe(mode==='light'?'rgb(179, 38, 30)':'rgb(255, 180, 171)');
    expect(await contrast(deletion)).toBeGreaterThanOrEqual(4.5);
    await deletion.hover();
    const hover=await deletion.evaluate(e=>getComputedStyle(e).color.match(/[\d.]+/g).map(Number));
    expect(hover[0]).toBeGreaterThan(hover[1]);expect(hover[0]).toBeGreaterThan(hover[2]);
    expect(await contrast(deletion)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({path:`test-results/bookmark-chrome-${mode}-menu.png`});
    await page.keyboard.press('Escape');
  }
});

test('context rename changes only item or folder name and persists; busy failure keeps the original metadata',async({page})=>{
  await fixture(page);
  await expect.poll(()=>page.evaluate(()=>!!localStorage.getItem('chrome-settings'))).toBe(true);
  for(const [id,newName] of [['one','Renamed item'],['g','Renamed group']]){
    const before=await snapshot(page);
    await context(page,id);await page.locator('[data-bookmark-action=rename]').click();
    await expect(page.locator('#bookmark-tree-dialog input')).toHaveCount(1);
    await expect(page.locator('#bookmark-tree-dialog select,#bookmark-tree-dialog textarea,#bookmark-form')).toHaveCount(0);
    await page.locator('#bookmark-folder-name').fill(newName);
    await page.locator('#bookmark-tree-form .primary').click();
    await expect(page.locator('#bookmark-tree-dialog')).toHaveCount(0);
    const after=await snapshot(page);
    if(id==='one')before.folderBookmarks[0].name=newName;else before.bookmarkTree.nodes.find(n=>n.id===id).name=newName;
    expect(after).toEqual(before);
  }
  await page.reload();await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-bookmark-open=one]')).toHaveText('Renamed item');
  await expect(page.locator('[data-bookmark-group=g]')).toContainText('Renamed group');
  const before=await snapshot(page);
  await context(page,'one');await page.locator('[data-bookmark-action=rename]').click();
  await page.locator('#bookmark-folder-name').fill('Rejected');
  await page.evaluate(()=>window.holdChromeSave=true);
  await page.locator('#bookmark-tree-form .primary').click();
  await expect.poll(()=>page.evaluate(()=>!!window.rejectChromeSave)).toBe(true);
  await expect(page.locator('#bookmark-tree-cancel')).toBeDisabled();
  await page.keyboard.press('Escape');await expect(page.locator('#bookmark-tree-dialog')).toBeVisible();
  await page.evaluate(()=>{window.holdChromeSave=false;window.rejectChromeSave(Error('fixture rename failure'))});
  await expect(page.locator('#bookmark-tree-dialog .form-error')).toContainText('fixture rename failure');
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(()=>window.chromeCalls.filter(c=>['start_sync','run_file_operation'].includes(c.cmd)).length)).toBe(0);
});

for(const mode of ['light','dark'])test(`flat bookmark and navigation chrome retains focus and footer hit areas in ${mode}`,async({page})=>{
  await page.setViewportSize({width:800,height:650});await fixture(page,mode);
  for(const selector of ['[data-bookmark-open=one]','[data-bookmark-group=g]','[data-up=local]']){
    const button=page.locator(selector);await expect(button).toBeEnabled();
    const style=await button.evaluate(e=>({background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopColor,shadow:getComputedStyle(e).boxShadow,height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width}));
    expect(style.background).toBe('rgba(0, 0, 0, 0)');expect(style.border).toBe('rgba(0, 0, 0, 0)');expect(style.shadow).toBe('none');expect(style.height).toBeGreaterThanOrEqual(24);expect(style.width).toBeGreaterThanOrEqual(24);
    expect(await contrast(button)).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Tab');await button.focus();
    expect(await button.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
  }
  for(const selector of ['#error-count','#toggle-logs']){
    const button=page.locator(selector);const style=await button.evaluate(e=>({border:parseFloat(getComputedStyle(e).borderTopWidth),height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width}));
    expect(style.border).toBeGreaterThan(0);expect(style.height).toBeGreaterThanOrEqual(20);expect(style.width).toBeGreaterThanOrEqual(24);
    expect(await contrast(button)).toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Tab');await button.focus();
    expect(await button.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
    await button.click();await expect(page.locator('#log-drawer')).toBeVisible();await page.locator('#close-logs').click();
  }
  await page.screenshot({path:`test-results/bookmark-chrome-${mode}-800.png`});
});
