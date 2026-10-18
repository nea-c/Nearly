import { expandTreePath } from './tree-expansion';
import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, compact = false) {
  await page.addInitScript(({ compact }) => {
    const profile = {id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const dirs = Array.from({length:80}, (_, i) => ({name:'directory-'+String(i).padStart(3,'0'),dir:true,size:0}));
    window.treeCalls = []; window.treeHold = '';
    window.__TAURI__ = {core:{invoke:async(cmd,args)=>{
      window.treeCalls.push({cmd,args});
      if(cmd==='load_settings') return JSON.parse(localStorage.getItem('tree-layout-fixture')||'null') || {version:1,profiles:[profile],history:{},language:'en',compactExplorer:compact};
      if(cmd==='save_settings') {localStorage.setItem('tree-layout-fixture',JSON.stringify(args.data));return;}
      if(cmd==='default_folder') return 'C:\\root';
      if(cmd==='list_drives') return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session') return {path:'/',entries:dirs};
      if(cmd==='list_local'&&args.path==='C:\\') return [{name:'root',dir:true,size:0}];
       if(cmd==='list_local'||cmd==='list_remote') {
        if(args.path===window.treeHold) return await new Promise(resolve=>window.treeRelease=()=>resolve(dirs));
        return dirs;
      }
    }}};
  }, { compact });
  await page.goto('/'); await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
}
async function go(page:Page, side:string, path:string) {
  await page.locator(`#${side}-path`).fill(path); await page.locator(`#${side}-path`).press('Enter');
  await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
}
const state = (page:Page) => page.evaluate(()=>({
  paths:['local','remote'].map(side=>(document.querySelector(`#${side}-path`) as HTMLInputElement).value),
  expanded:[...document.querySelectorAll('[data-tree] [role=treeitem]')].map(e=>[e.querySelector('[data-tree-path]')?.getAttribute('data-tree-path'),e.getAttribute('aria-expanded')]),
  reads:window.treeCalls.filter(c=>['list_local','list_remote','list_drives'].includes(c.cmd)).length,
}));
const widths = (page:Page) => page.evaluate(()=>Object.fromEntries(['local','remote'].map(side=>[side,{
  tree:document.querySelector(`[data-tree=${side}]`)!.getBoundingClientRect().width,
  list:document.querySelector(`[data-list=${side}]`)!.getBoundingClientRect().width,
}])));

test('explicit reveal focuses and scrolls current rendered directory once, with keyboard reopening and no navigation or expansion', async({page})=>{
  await boot(page);
  await go(page,'remote','/directory-079');
  const root = page.locator('[data-tree-toggle=remote][data-tree-path="/"]');
  if (await root.locator('xpath=../..').getAttribute('aria-expanded') !== 'true') await root.click();
  await expect(page.locator('[data-tree-select=remote][data-tree-path="/directory-079"]')).toBeVisible();
  const before=await state(page);
  const toggle=page.locator('[data-tree-visibility=remote]');
  await toggle.click(); await expect(page.locator('[data-tree=remote]')).toBeHidden();
  await toggle.focus(); await page.keyboard.press('Enter');
  const target=page.locator('[data-tree-select=remote][data-tree-path="/directory-079"]');
  await expect(target).toBeFocused(); await expect(target).toBeInViewport();
  expect(await state(page)).toEqual(before);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-tree-select=remote][data-tree-path="/directory-078"]')).toBeFocused();
  await page.locator('#local-path').focus();
  await page.waitForTimeout(1300); await expect(page.locator('#local-path')).toBeFocused();
  await toggle.click(); await toggle.click(); await expect(target).toBeFocused();
  expect(await state(page)).toEqual(before);
});

test('collapsed remote root and virtual PC root are nearest rendered ancestors; sides and tabs stay isolated', async({page})=>{
  await boot(page); await go(page,'remote','/directory-079/child');
  const root = page.locator('[data-tree-toggle=remote][data-tree-path="/"]');
  if (await root.locator('xpath=../..').getAttribute('aria-expanded') === 'true') await root.click();
  const before=await state(page);
  await page.locator('[data-tree-visibility=remote]').click(); await page.locator('[data-tree-visibility=remote]').click();
  await expect(page.locator('[data-tree-select=remote][data-tree-path="/"]')).toBeFocused();
  const pc=page.locator('[data-tree-toggle=local][data-tree-path="@pc"]');
  if(await pc.locator('xpath=../..').getAttribute('aria-expanded')==='true')await pc.click();
  const collapsed=await state(page);
  await page.locator('[data-tree-visibility=local]').click(); await page.locator('[data-tree-visibility=local]').click();
  await expect(page.locator('[data-tree-toggle=local][data-tree-path="@pc"]')).toBeFocused();
  expect(await state(page)).toEqual(collapsed);
  expect(collapsed.paths).toEqual(before.paths);
  await page.locator('[data-tree-visibility=remote]').click();
  const first=await page.locator('[data-tab][aria-selected=true]').getAttribute('data-tab');
  await page.keyboard.press('Control+t'); await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-tree=remote]')).toBeVisible();
  await page.locator(`[data-tab="${first}"]`).click();
  await expect(page.locator('[data-tree=remote]')).toBeHidden();
  await expect(page.locator('[data-tree=local]')).toBeVisible();
});

test('reveal during held listing does not steal focus after async completion or tab switch', async({page})=>{
  await boot(page);
  await page.evaluate(()=>window.treeHold='/held');
  await page.locator('#remote-path').fill('/held'); await page.locator('#remote-path').press('Enter');
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','true');
  await page.locator('[data-tree-visibility=remote]').click(); await page.locator('[data-tree-visibility=remote]').click();
  await expect(page.locator('[data-tree-select=remote][data-tree-path="/"]')).toBeFocused();
  await page.locator('#local-path').focus();
  await page.evaluate(()=>window.treeRelease());
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#local-path')).toBeFocused();
  await page.keyboard.press('Control+t'); await expect(page.locator('#connect-form')).toBeVisible();
  await page.waitForTimeout(1200); await expect(page.locator('[data-tree]')).toHaveCount(0);
});

test('reveal chooses a collapsed intermediate ancestor and local exact folder with localized accessible controls', async({page})=>{
  await boot(page); await go(page,'remote','/directory-079/child');
  await expandTreePath(page,'remote','/');
  await expandTreePath(page,'local','C:\\');
  const branch=page.locator('[data-tree-toggle=remote][data-tree-path="/directory-079"]');
  if(await branch.locator('xpath=../..').getAttribute('aria-expanded')==='true')await branch.click();
  const before=await state(page);
  await page.locator('[data-tree-visibility=remote]').click();await page.locator('[data-tree-visibility=remote]').click();
  await expect(page.locator('[data-tree-select=remote][data-tree-path="/directory-079"]')).toBeFocused();
  expect(await state(page)).toEqual(before);
  await page.locator('[data-tree-visibility=local]').click();await page.locator('[data-tree-visibility=local]').click();
  await expect(page.locator('[data-tree=local]').getByRole('button',{name:'root',exact:true})).toBeFocused();
  await expect(page.locator('[data-tree-visibility=local]')).toHaveAccessibleName('Local: Hide folder tree');
  await page.locator('#settings-toggle').click();await page.locator('#language-select').selectOption('ja');await page.locator('#settings-close').click();
  await expect(page.locator('[data-tree-visibility=remote]')).toHaveAccessibleName('リモート: フォルダツリーを隠す');
  await page.locator('[data-tree-visibility=remote]').click();
  await expect(page.locator('[data-tree-visibility=remote]')).toHaveAccessibleName('リモート: フォルダツリーを表示');
});

for(const compact of [false,true]) test(`center divider preserves desired pixels both sides with clamp/recovery and persisted independent resizing compact=${compact}`,async({page})=>{
  await page.setViewportSize({width:1500,height:900}); await boot(page,compact);
  for(const side of ['local','remote']) {
    await page.locator(`#${side}-tree-splitter`).focus();
    for(let i=0;i<(side==='local'?4:2);i++) await page.keyboard.press('ArrowRight');
  }
  const original=await widths(page);
  await page.locator('#pane-splitter').focus(); await page.keyboard.press('ArrowLeft');
  let next=await widths(page);
  for(const side of ['local','remote']) expect(Math.abs(next[side].tree-original[side].tree)).toBeLessThan(1);
  const center=await page.locator('#pane-splitter').boundingBox();
  await page.mouse.move(center!.x+3,center!.y+80);await page.mouse.down();await page.mouse.move(350,center!.y+80,{steps:12});await page.mouse.up();
  next=await widths(page); expect(next.local.tree).toBeLessThan(original.local.tree);expect(next.local.list).toBeGreaterThanOrEqual(139);
  const wanted=await page.evaluate(()=>JSON.parse(localStorage.getItem('tree-layout-fixture')));
  expect(Math.abs(wanted.localTreeWidth-original.local.tree)).toBeLessThan(1);
  await page.locator('#pane-splitter').focus();await page.keyboard.press('Home');
  next=await widths(page);for(const side of ['local','remote']) expect(Math.abs(next[side].tree-original[side].tree)).toBeLessThan(1);
  for(let i=0;i<10;i++)await page.keyboard.press('ArrowRight');
  next=await widths(page);expect(next.remote.tree).toBeLessThan(original.remote.tree);expect(next.remote.list).toBeGreaterThanOrEqual(139);
  await page.locator('#pane-splitter').focus();await page.keyboard.press('Home');
  next=await widths(page);for(const side of ['local','remote']) expect(Math.abs(next[side].tree-original[side].tree)).toBeLessThan(1);
  const tree=await page.locator('#local-tree-splitter').boundingBox();
  await page.mouse.move(tree!.x+3,tree!.y+80);await page.mouse.down();await page.mouse.move(tree!.x+43,tree!.y+80,{steps:8});await page.mouse.up();
  const resized=await widths(page);expect(resized.local.tree).toBeGreaterThan(original.local.tree+35);expect(resized.remote.tree).toBeCloseTo(original.remote.tree,0);
  await page.reload();await page.locator('#connect-form .primary').click();
  await expect.poll(async()=>Math.abs((await widths(page)).local.tree-resized.local.tree)).toBeLessThan(1);
  await page.setViewportSize({width:800,height:650});await page.setViewportSize({width:1500,height:900});
  await expect.poll(async()=>Math.abs((await widths(page)).local.tree-resized.local.tree)).toBeLessThan(1);
});

for(const compact of [false,true]) for(const side of ['local','remote'])
test(`hidden ${side} tree gives usable full-width rows and recovers desired width after hidden resizing compact=${compact}`,async({page})=>{
  await page.setViewportSize({width:1500,height:900});await boot(page,compact);
  await page.locator(`#${side}-tree-splitter`).focus();await page.keyboard.press('ArrowRight');
  const intended=(await widths(page))[side].tree;
  const before=await state(page);
  await page.locator(`[data-tree-visibility=${side}]`).click();
  await expect(page.locator(`[data-tree=${side}]`)).toBeHidden();
  await expect(page.locator(`#${side}-tree-splitter`)).toBeHidden();
  const assertFullWidth=async()=>{
    const geometry=await page.locator(`[data-pane=${side}] .pane-body`).evaluate(body=>{
      const area=body.getBoundingClientRect(),list=body.querySelector('[data-list]')!.getBoundingClientRect();
      return {available:body.clientWidth,width:list.width,left:list.left-area.left};
    });
    expect(Math.abs(geometry.width-geometry.available)).toBeLessThan(1);
    expect(Math.abs(geometry.left)).toBeLessThan(1);
  };
  await assertFullWidth();
  const row=page.locator(`[data-list=${side}] [data-entry][data-name="directory-000"]`);
  await row.locator('[data-cell=name]').click();await expect(row).toHaveAttribute('aria-selected','true');
  await page.locator('#pane-splitter').focus();
  for(let i=0;i<4;i++)await page.keyboard.press(side==='local'?'ArrowLeft':'ArrowRight');
  await assertFullWidth();
  await page.setViewportSize({width:1000,height:700});await assertFullWidth();
  await page.setViewportSize({width:1500,height:900});
  await page.locator('#pane-splitter').focus();await page.keyboard.press('Home');
  await assertFullWidth();
  await row.locator('[data-cell=name]').click();await expect(row).toHaveAttribute('aria-selected','true');
  expect(await state(page)).toEqual(before);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('tree-layout-fixture')));
  expect(Math.abs(saved[`${side}TreeWidth`]-intended)).toBeLessThan(1);
  await page.locator(`[data-tree-visibility=${side}]`).click();
  await expect(page.locator(`[data-tree=${side}]`)).toBeVisible();
  expect(Math.abs((await widths(page))[side].tree-intended)).toBeLessThan(1);
  expect((await widths(page))[side].list).toBeGreaterThanOrEqual(139);
  expect(await state(page)).toEqual(before);
});
