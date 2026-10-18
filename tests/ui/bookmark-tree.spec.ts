import { bookmarkRootAction } from './bookmark-context';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const profile={id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',keyFile:'generated.ppk',hostKey:'SHA256:'+'A'.repeat(43)};
    const key=JSON.stringify(['a','sftp','fixture.invalid',22,'test',profile.hostKey]);
    window.bookmarkCalls=[]; window.failBookmarkSave=false;
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.bookmarkCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('bookmark-fixture')||'null')||{version:1,profiles:[profile],history:{},folderBookmarks:[{id:'one',name:'One',connectionKey:key,local:'C:\\root',remote:'/'},{id:'two',name:'Two',connectionKey:key,local:'C:\\root\\two',remote:'/two'}]};
      if(cmd==='save_settings') {if(window.failBookmarkSave)throw Error('generated save failure');localStorage.setItem('bookmark-fixture',JSON.stringify(args.data));}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{path:'C:\\',name:'C:'}];
      if(cmd==='connect_session')return {path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return [];
    }}};
  });
  await page.goto('/'); await page.locator('#connect-form .primary').click();
  await expect(page.locator('.bookmark-bar')).toBeVisible();await expect(page.locator('#bookmark-tools')).toHaveCount(0);
});

async function context(page,id?) {
  if(id)await page.locator(`[data-bookmark-tree-node="${id}"]`).first().click({button:'right'});
  else { const strip=page.locator('.bookmark-bar .bookmark-items'), box=await strip.boundingBox(); await strip.click({button:'right',position:{x:box!.width-2,y:2}}); }
  await expect(page.locator('#bookmark-tree-context')).toBeVisible();
}
async function create(page,name,parent?) {
  await context(page,parent); await page.locator('[data-bookmark-action=create]').click();
  await page.locator('#bookmark-folder-name').fill(name); await page.locator('#bookmark-tree-form .primary').click();
  await expect(page.locator('#bookmark-tree-dialog')).toHaveCount(0);
  expect(await page.locator('.bookmark-items [data-bookmark-tree-node]').evaluateAll(es=>es.every(e=>!e.disabled))).toBe(true);
  return page.evaluate(name=>JSON.parse(localStorage.getItem('bookmark-fixture')).bookmarkTree.nodes.find(n=>n.name===name).id,name);
}
async function moveIntoNested(page, source, group, nested) {
  await page.locator(`[data-bookmark-group="${group}"]`).click();
  await page.locator(`[data-bookmark-tree-node="${source}"]`).dragTo(page.locator(`[data-bookmark-group="${nested}"]`));
  await expect.poll(async()=> (await saved(page)).bookmarkTree.nodes.find(n=>n.id===source).parentId).toBe(nested);
  await page.keyboard.press('Escape');
}
async function saved(page) { return page.evaluate(()=>JSON.parse(localStorage.getItem('bookmark-fixture'))); }

test('bookmark organizing groups nest, move and persist without changing pair IDs or starting sync',async({page})=>{
  const group=await create(page,'Sites');
  const nested=await create(page,'Staging',group);
  await moveIntoNested(page,'one',group,nested);
  const data=await saved(page);
  expect(data.folderBookmarks.map(b=>b.id)).toEqual(['one','two']);
  expect(data.bookmarkTree.nodes.find(n=>n.id==='one').parentId).toBe(nested);
  await page.reload(); await page.locator('#connect-form .primary').click();
  await page.locator(`[data-bookmark-group="${group}"]`).click();
  await page.locator(`[data-bookmark-group="${nested}"]`).click();
  await expect(page.locator('[data-bookmark-folder-menu] [data-bookmark-open=one]')).toHaveText('One');
  await page.locator('[data-bookmark-folder-menu] [data-bookmark-open=one]').click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\root');
  expect(await page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='start_sync').length)).toBe(0);
  expect(await page.locator('.bookmark-bar').evaluate(e=>e.getBoundingClientRect().height)).toBe(39);
});

test('group rename and dissolution preserve children; drag reorder does not open a pair',async({page})=>{
  const group=await create(page,'Group');
  await context(page,group); await page.locator('[data-bookmark-action=rename]').click();
  await page.locator('#bookmark-folder-name').fill('Renamed');await page.locator('#bookmark-tree-form .primary').click();
  await expect(page.locator('#bookmark-tree-dialog')).toHaveCount(0);
  await page.locator('[data-bookmark-tree-node="two"]').dragTo(page.locator(`[data-bookmark-tree-node="${group}"]`));
  await expect.poll(async()=> (await saved(page)).bookmarkTree.nodes.find(n=>n.id==='two').parentId).toBe(group);
  await expect(page.locator('#local-path')).toHaveValue('C:\\root');
  await context(page,group);await page.locator('[data-bookmark-action=delete]').click();
  await expect(page.locator('#bookmark-tree-dialog')).toContainText('中');
  await page.locator('#bookmark-tree-form .primary').click();
  await expect(page.locator('#bookmark-tree-dialog')).toHaveCount(0);
  const data=await saved(page);expect(data.folderBookmarks.map(b=>b.id)).toEqual(['one','two']);
  expect(data.bookmarkTree.nodes.find(n=>n.id==='two').parentId).toBe(null);
  expect(data.bookmarkTree.nodes.some(n=>n.id===group)).toBe(false);
});

test('failed hierarchy save keeps draft and old collection, while page menu is suppressed and custom menu remains',async({page})=>{
  await page.evaluate(()=>{window.failBookmarkSave=true;});
  await context(page);await page.locator('[data-bookmark-action=create]').click();
  await page.locator('#bookmark-folder-name').fill('Unsaved');await page.locator('#bookmark-tree-form .primary').click();
  await expect(page.locator('#bookmark-tree-dialog .form-error')).toContainText('generated save failure');
  await expect(page.locator('#bookmark-folder-name')).toHaveValue('Unsaved');
  await expect(page.locator('[data-bookmark-group]')).toHaveCount(0);
  await page.locator('#bookmark-tree-cancel').click();
  const suppressed=await page.evaluate(()=>!document.querySelector('.statusbar').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
  expect(suppressed).toBe(true);
  await context(page,'one');await expect(page.locator('[data-bookmark-action=rename]')).toBeVisible();
  await page.locator('[data-bookmark-action=rename]').click();await expect(page.locator('#bookmark-tree-dialog')).toBeVisible();
});
test('bookmark menus fit narrow themes and a dragged bar survives polling until explicit tab change',async({page})=>{
  const group=await create(page,'Sites');
  const nested=await create(page,'Staging',group);
  await moveIntoNested(page,'one',group,nested);
  await page.setViewportSize({width:800,height:650});
  for(const theme of ['light','dark']) {
    await page.locator('#settings-toggle').click();await page.locator('#theme-select').selectOption(theme);await page.locator('#settings-close').click();
    await page.locator(`[data-bookmark-group="${group}"]`).click();
    await page.locator(`[data-bookmark-group="${nested}"]`).click();
    await expect(page.locator('#bookmark-folder-menu')).toBeInViewport({ratio:1});
    await page.screenshot({path:`test-results/bookmark-tree-${theme}-800.png`});
    await page.keyboard.press('Escape');
  }
  const held = page.locator('[data-bookmark-tree-node="two"]');
  await held.evaluate(e => window.draggedBookmark = e);
  const heldBox = await held.boundingBox();
  await page.mouse.move(heldBox!.x + heldBox!.width / 2, heldBox!.y + heldBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(heldBox!.x + heldBox!.width / 2 + 12, heldBox!.y + heldBox!.height / 2, {steps: 4});
  await page.waitForTimeout(1500);
  expect(await page.evaluate(()=>window.draggedBookmark.isConnected)).toBe(true);
  await page.keyboard.press('Control+t');
  await expect(page.locator('#connect-form')).toBeVisible();
  await expect(page.locator('.pane')).toHaveCount(0);
  await page.mouse.up();
});
test('history overlays close when the owning tab or endpoint no longer matches',async({page})=>{
  await bookmarkRootAction(page,'history');await expect(page.locator('#bookmark-overlay')).toBeVisible();
  await page.evaluate(async()=>{
    const {Store}=await import('/src/core.ts');const {bindBookmarks}=await import('/src/folder-bookmarks.ts');
    const data=JSON.parse(localStorage.getItem('bookmark-fixture')||'null');
    const store=new Store(data||{version:1,profiles:[{id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'SHA256:fixture'}],history:{}});
    const id=document.querySelector('[data-tab][aria-selected=true]').getAttribute('data-tab');
    const w=store.createWorkspace('a','C:\\root');w.id=id;
    w.connection={id:'a',name:'Changed',mode:'sftp',host:'other.invalid',port:22,user:'test',auth:'key',hostKey:'SHA256:other'};
    bindBookmarks(store,w,async()=>{},()=>{},async()=>true,()=>{},async change=>change(store));
  });
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
  await bookmarkRootAction(page,'history');
  await page.keyboard.press('Control+t');
  await expect(page.locator('#connect-form')).toBeVisible();await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
});

test('Nearly bookmark registration is available on blank bar and folder context without an organizer button',async({page})=>{
  await expect(page.locator('#bookmark-organize')).toHaveCount(0);
  await context(page);await page.locator('[data-bookmark-action=register]').click();
  await expect(page.locator('#bookmark-form')).toBeVisible();
  await page.locator('#bookmark-close').click();
  const group=await create(page,'Registered');
  await context(page,group);await page.locator('[data-bookmark-action=register]').click();
  await page.locator('#bookmark-name').fill('Current');await page.locator('#bookmark-save').click();
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
  expect((await saved(page)).bookmarkTree.nodes.find(n=>n.id==='one').parentId).toBe(group);
});

test('Nearly nested bookmark folders retain parents and open beside their full-width row',async({page})=>{
  const group=await create(page,'Sites'), nested=await create(page,'Nested',group);
  await page.locator(`[data-bookmark-group="${group}"]`).click();
  await page.locator(`[data-bookmark-group="${nested}"]`).hover();
  await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(2);
  const boxes=await page.locator('[data-bookmark-folder-menu]').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}));
  expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x+boxes[0].w-2);
  await expect(page.locator(`[data-bookmark-folder-menu="${group}"] [data-bookmark-group="${nested}"]`)).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.locator('[data-bookmark-folder-menu]')).toHaveCount(0);
});

test('Nearly actual bookmark drag moves into a folder then blank bar, with no browse or sync',async({page})=>{
  const group=await create(page,'Drop here');
  await page.locator('[data-bookmark-tree-node="two"]').dragTo(page.locator(`[data-bookmark-tree-node="${group}"]`));
  await expect.poll(async()=> (await saved(page)).bookmarkTree.nodes.find(n=>n.id==='two').parentId).toBe(group);
  await page.waitForTimeout(350);await page.locator(`[data-bookmark-group="${group}"]`).click();
  const strip=page.locator('.bookmark-bar .bookmark-items'), box=await strip.boundingBox();
  await page.locator('[data-bookmark-tree-node="two"]').dragTo(strip,{targetPosition:{x:box!.width-8,y:box!.height/2}});
  await expect.poll(async()=> (await saved(page)).bookmarkTree.nodes.find(n=>n.id==='two').parentId).toBe(null);
  await expect(page.locator('#local-path')).toHaveValue('C:\\root');
  expect(await page.evaluate(()=>window.bookmarkCalls.filter(c=>c.cmd==='start_sync').length)).toBe(0);
});

test('Nearly bookmark drag click guard does not block a different bookmark',async({page})=>{
  const box = await page.locator('[data-bookmark-open="one"]').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 12, box!.y + box!.height / 2, {steps: 4});
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.locator('[data-bookmark-open="two"]').click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\root\\two');
  await expect(page.locator('#remote-path')).toHaveValue('/two');
});

test('hierarchy save exposes fresh menu handlers when its dialog closes',async({page})=>{
  const group=await create(page,'Acknowledged parent');
  await context(page,group);await page.locator('[data-bookmark-action=create]').click();
  await page.locator('#bookmark-folder-name').fill('Acknowledged child');
  const observed=await page.evaluate(async group=>{
    const dialog=document.querySelector('#bookmark-tree-dialog')!;
    const closed=new Promise<void>(resolve=>{
      const observer=new MutationObserver(()=>{if(!dialog.isConnected){observer.disconnect();resolve();}});
      observer.observe(document.body,{childList:true,subtree:true});
    });
    (dialog.querySelector('form') as HTMLFormElement).requestSubmit();
    await closed;
    const child=JSON.parse(localStorage.getItem('bookmark-fixture')!).bookmarkTree.nodes.find((node:any)=>node.name==='Acknowledged child');
    (document.querySelector(`[data-bookmark-group="${group}"]`) as HTMLButtonElement).click();
    return {childId:child.id,menuChildren:[...document.querySelectorAll('[data-bookmark-folder-menu] [data-bookmark-tree-node]')].map((button:HTMLElement)=>button.dataset.bookmarkTreeNode)};
  },group);
  expect(observed.menuChildren).toContain(observed.childId);
});

