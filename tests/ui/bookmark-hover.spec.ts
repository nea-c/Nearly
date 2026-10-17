import {test,expect} from '@playwright/test';

async function fixture(page, theme='light'){
  await page.addInitScript(({theme})=>{
    const profile={id:'fixture',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',keyFile:'generated',hostKey:'pin'};
    const connectionKey=JSON.stringify(['fixture','sftp',profile.host,22,'test','pin']);
    const groups=[['top','Top',null],['left','Left','top'],['right','Right','top'],['deep','Deep','left'],['edge','Edge','deep'],['empty','Empty','right'],['other','Other',null]];
    const nodes=groups.map(([id,name,parentId])=>({id,name,parentId,kind:'group',connectionKey}));
    nodes.push({id:'leaf',kind:'bookmark',bookmarkId:'leaf',parentId:'edge',connectionKey});
    const initial={version:1,profiles:[profile],history:{},theme,folderBookmarks:[{id:'leaf',name:'Leaf',local:'C:\\saved',remote:'/saved',connectionKey}],bookmarkTree:{version:1,nodes}};
    window.hoverCalls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.hoverCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('hover-settings')||'null')||initial;
      if(cmd==='save_settings'){localStorage.setItem('hover-settings',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
      if(cmd==='connect_session')return{path:'/root',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return[];
    }}};
  },{theme});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-bookmark-group=top]')).toBeEnabled();
}
const menu=(page,id)=>page.locator(`[data-bookmark-folder-menu=${id}]`);

test('same top folder second actual click closes its menu and can reopen repeatedly',async({page})=>{
  await fixture(page);
  const folder=page.locator('[data-bookmark-group=top]');
  for(let i=0;i<3;i++){
    await folder.click();await expect(menu(page,'top')).toBeVisible();
    await folder.click();await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);
    await expect(folder).toHaveAttribute('aria-expanded','false');
  }
  expect(await page.evaluate(()=>window.hoverCalls.filter(c=>c.cmd==='start_sync').length)).toBe(0);
});

test('nested hover opens a deep cascade and sibling hover trims only descendants',async({page})=>{
  await fixture(page);await page.locator('[data-bookmark-group=top]').click();
  await page.locator('[data-bookmark-group=left]').hover();await expect(menu(page,'left')).toBeVisible();
  await page.locator('[data-bookmark-group=deep]').hover();await expect(menu(page,'deep')).toBeVisible();
  await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(3);
  await page.locator('[data-bookmark-group=right]').hover();await expect(menu(page,'right')).toBeVisible();
  await expect(menu(page,'left')).toHaveCount(0);await expect(menu(page,'deep')).toHaveCount(0);
  await expect(menu(page,'top')).toBeVisible();
  await page.locator('[data-bookmark-group=empty]').hover();await expect(menu(page,'empty')).toBeVisible();
  await expect(menu(page,'empty').locator('.bookmark-menu-empty')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);
});

test('hover grace allows crossing the gap into a child; outside click and Escape cancel pending hover',async({page})=>{
  await fixture(page);await page.locator('[data-bookmark-group=top]').click();
  const child=page.locator('[data-bookmark-group=left]');await child.hover();await expect(menu(page,'left')).toBeVisible();
  const source=await child.boundingBox(), destination=await menu(page,'left').boundingBox();
  const gapX=destination.x>source.x?(source.x+source.width+destination.x)/2:(destination.x+destination.width+source.x)/2;
  await page.mouse.move(gapX,source.y+source.height/2);await page.waitForTimeout(70);
  await page.mouse.move(destination.x+destination.width/2,destination.y+12);
  await expect(menu(page,'left')).toBeVisible();
  await page.locator('[data-bookmark-group=deep]').hover();await page.keyboard.press('Escape');
  await page.waitForTimeout(450);await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);
  await page.locator('[data-bookmark-group=top]').click();await page.locator('[data-bookmark-group=left]').hover();
  await page.mouse.click(10,500);await page.waitForTimeout(450);
  await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);
});

for(const theme of ['light','dark'])test(`deep menus stay inside narrow ${theme} viewport and switch top folder`,async({page})=>{
  await page.setViewportSize({width:800,height:650});await fixture(page,theme);
  await page.locator('[data-bookmark-group=top]').click();
  await page.locator('[data-bookmark-group=left]').hover();await expect(menu(page,'left')).toBeVisible();
  await page.locator('[data-bookmark-group=deep]').hover();await expect(menu(page,'deep')).toBeVisible();
  await page.locator('[data-bookmark-group=edge]').hover();await expect(menu(page,'edge')).toBeVisible();
  for(const id of ['top','left','deep','edge'])await expect(menu(page,id)).toBeInViewport({ratio:1});
  await page.screenshot({path:`test-results/bookmark-hover-${theme}-800.png`});
  await page.locator('[data-bookmark-group=other]').click();await expect(menu(page,'other')).toBeVisible();
  await expect(menu(page,'top')).toHaveCount(0);await expect(menu(page,'left')).toHaveCount(0);
});

test('ellipsis uses the same root actions as blank-bar context with registration and history reachable',async({page})=>{
  await fixture(page);
  await expect(page.locator('#bookmark-add,#pair-history')).toHaveCount(0);
  await expect(page.locator('#bookmark-more')).toBeVisible();
  await expect(page.locator('#bookmark-more')).toHaveAttribute('aria-haspopup','menu');
  await page.locator('#bookmark-more').click();await expect(page.locator('#bookmark-tree-context')).toBeVisible();
  await page.locator('#bookmark-more').click();await expect(page.locator('#bookmark-tree-context')).toHaveCount(0);
  await page.locator('#bookmark-more').click();
  const actions=await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.map(e=>[e.getAttribute('data-bookmark-action'),e.textContent.trim()]));
  expect(actions.map(a=>a[0])).toEqual(['register','create','history']);
  await page.keyboard.press('Escape');
  const strip=page.locator('.bookmark-items'),b=await strip.boundingBox();
  await strip.click({button:'right',position:{x:b.width-3,y:b.height/2}});
  expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.map(e=>[e.getAttribute('data-bookmark-action'),e.textContent.trim()]))).toEqual(actions);
  await page.locator('[data-bookmark-action=register]').click();await expect(page.locator('#bookmark-form')).toBeVisible();await page.locator('#bookmark-close').click();
  await page.locator('#bookmark-more').click();await page.locator('[data-bookmark-action=history]').click();await expect(page.locator('.pair-history-list')).toBeVisible();
});

test('leaving a folder row for padding before hover delay cannot open that stale child',async({page})=>{
  await fixture(page);await page.locator('[data-bookmark-group=top]').click();
  const row=await page.locator('[data-bookmark-group=left]').boundingBox();
  const parent=await menu(page,'top').boundingBox();
  await page.mouse.move(row.x+row.width/2,row.y+row.height/2);
  await page.mouse.move(parent.x+2,parent.y+2);
  expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('[data-bookmark-tree-node]'),{x:parent.x+2,y:parent.y+2})).toBe(false);
  await page.waitForTimeout(300);
  await expect(menu(page,'left')).toHaveCount(0);await expect(menu(page,'top')).toBeVisible();
});

test('keyboard navigation cancels a pending mouse hover without overriding the chosen row',async({page})=>{
  await fixture(page);await page.locator('[data-bookmark-group=top]').click();
  const left=page.locator('[data-bookmark-group=left]');await left.focus();
  const row=await left.boundingBox();await page.mouse.move(row.x+row.width/2,row.y+row.height/2);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-bookmark-group=right]')).toBeFocused();
  await page.waitForTimeout(300);
  await expect(menu(page,'left')).toHaveCount(0);
  await expect(page.locator('[data-bookmark-group=right]')).toBeFocused();
  await page.keyboard.press('ArrowRight');await expect(menu(page,'right')).toBeVisible();
});
