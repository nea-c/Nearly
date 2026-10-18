// Native QA only: actual owned WebView, generated directories and localhost SFTP.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {expect} from '@playwright/test';

const control=(page,side,folder,kind='select')=>page.locator('[data-tree-'+kind+'='+side+'][data-tree-path='+JSON.stringify(folder)+']');
const idle=async page=>{for(const side of ['local','remote'])await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');};
async function go(page,side,folder){
  await page.locator('#'+side+'-path').fill(folder);await page.locator('#'+side+'-path').press('Enter');await idle(page);
}
async function expand(page,side,folder){
  const button=control(page,side,folder,'toggle');await expect(button).toBeAttached();
  if(await button.locator('xpath=../..').getAttribute('aria-expanded')!=='true'){
    await button.click();await expect(button.locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
    await expect(button).not.toHaveAttribute('aria-busy','true');
  }
}
const state=page=>page.evaluate(()=>({
  paths:['local','remote'].map(side=>document.querySelector('#'+side+'-path').value),
  expanded:[...document.querySelectorAll('[data-tree] [role=treeitem]')].map(item=>[item.querySelector('[data-tree-path]')?.getAttribute('data-tree-path'),item.getAttribute('aria-expanded')]),
}));
async function language(page,value){
  await page.locator('#settings-toggle').click();await page.locator('#language-select').selectOption(value);await page.locator('#settings-close').click();await idle(page);
}
async function reveal(page,side,folder,toggle,before,evidence,label){
  await page.locator('[data-tree='+side+']').evaluate(node=>node.scrollTop=0);
  await toggle.click();await expect(page.locator('[data-tree='+side+']')).toBeHidden();await toggle.click();
  const target=control(page,side,folder);await expect(target).toBeFocused();await expect(target).toBeInViewport();
  await page.waitForTimeout(180);await expect(target).toBeFocused();await expect(target).toBeInViewport();
  const metrics=await target.evaluate(node=>{
    const nav=node.closest('[data-tree]'),row=node.getBoundingClientRect(),bounds=nav.getBoundingClientRect(),style=getComputedStyle(node);
    return {path:node.dataset.treePath,focused:document.activeElement===node,documentFocused:document.hasFocus(),outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),top:row.top,bottom:row.bottom,treeTop:bounds.top,treeBottom:bounds.bottom,scrollTop:nav.scrollTop};
  });
  evidence.push({check:'Native tree reveal observation',label,side,metrics});
  assert.equal(metrics.outlineStyle,'none','Pointer reveal must not add a persistent focus frame');
  assert.ok(metrics.bottom>metrics.treeTop&&metrics.top<metrics.treeBottom);
  assert.deepEqual(await state(page),before,'Reveal must not navigate or expand branches');
}
export async function verifyNativeUiRefinement(page,context){
  const {local,remote,remoteDisk,evidence,screenshot,treeOnly=false}=context;
  const closeNotice=page.locator('#window-close-notice button');
  if(await closeNotice.isVisible())await closeNotice.click();
  const parentLocal=path.join(local,'reveal-check'),parentRemote=remote+'/reveal-check';
  await fs.mkdir(parentLocal);await fs.mkdir(path.join(remoteDisk,'reveal-check'));
  for(let i=0;i<90;i++){
    const name='directory-'+String(i).padStart(3,'0');
    await fs.mkdir(path.join(parentLocal,name));await fs.mkdir(path.join(remoteDisk,'reveal-check',name));
  }
  await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().unminimize());await page.bringToFront();
  for(const lang of ['en','ja']){
    await language(page,lang);
    for(const side of ['local','remote']){
      const parent=side==='local'?parentLocal:parentRemote;
      await go(page,side,parent);
      if(side==='local'){
        await expand(page,side,'@pc');const drive=path.parse(parentLocal).root;await expand(page,side,drive);
        let prefix=drive;for(const part of path.relative(drive,parentLocal).split(path.sep)){prefix=path.join(prefix,part);await expand(page,side,prefix);}
      }else{
        await expand(page,side,'/');let prefix='';for(const part of parentRemote.split('/').filter(Boolean)){prefix+='/'+part;await expand(page,side,prefix);}
      }
      const current=side==='local'?path.join(parentLocal,'directory-089'):parentRemote+'/directory-089';
      await go(page,side,current);const toggle=page.locator('[data-tree-visibility='+side+']'),before=await state(page);
      for(let i=0;i<3;i++)await reveal(page,side,current,toggle,before,evidence,lang+' exact '+i);
      await control(page,side,parent,'toggle').click();const collapsed=await state(page);
      for(let i=0;i<3;i++)await reveal(page,side,parent,toggle,collapsed,evidence,lang+' ancestor '+i);
      for(const phase of ['reopen','collapse']){
        await control(page,side,parent,'toggle').click();
        const expected=phase==='reopen'?current:parent,label=control(page,side,expected);
        await expect(label).toBeFocused();await expect(label).toBeInViewport();
        const metrics=await label.evaluate(node=>({path:node.dataset.treePath,focused:document.activeElement===node,documentFocused:document.hasFocus(),outlineStyle:getComputedStyle(node).outlineStyle}));
        assert.equal(metrics.documentFocused,true);assert.equal(metrics.outlineStyle,'none');
        evidence.push({check:'Native branch reveal observation',side,lang,phase,metrics});
        assert.deepEqual((await state(page)).paths,collapsed.paths,'Branch changes never navigate');
        if(phase==='reopen'){
          const expandedDescendants=await page.locator('[data-tree-row='+side+']').evaluateAll((rows,{parent,side})=>rows.filter(row=>row.dataset.treePath?.startsWith(parent+(side==='local'?'\\':'/'))&&row.closest('[role=treeitem]')?.getAttribute('aria-expanded')==='true').map(row=>row.dataset.treePath),{parent,side});
          assert.deepEqual(expandedDescendants,[],'No descendant expands automatically');
          await page.keyboard.press('ArrowUp');const keyboard=await page.locator('[data-tree='+side+'] :focus').evaluate(node=>({visible:node.matches(':focus-visible'),outline:getComputedStyle(node).outlineStyle}));
          assert.equal(keyboard.visible,true);assert.equal(keyboard.outline,'solid');evidence.push({check:'Native normal tree keyboard focus retained',side,lang,keyboard});
        }
      }
      await screenshot(page,'native-tree-reveal-'+lang+'-'+side);
      assert.equal(await page.locator('.tree-caption').count(),0);
      const input=await page.locator('#'+side+'-path').boundingBox(),button=await toggle.boundingBox();assert.ok(button.x>=input.x+input.width-1);
    }
    if(!treeOnly){
      for(const selector of ['.bookmark-bar','[data-side-bookmarks=local]','[data-side-bookmarks=remote]']){
        const bar=page.locator(selector),more=bar.locator('[data-bookmark-overflow]');
        await expect(more).toBeVisible();await more.click();
        const menu=page.locator(selector==='.bookmark-bar'?'#bookmark-overflow-menu':'.side-bookmark-menu'),first=menu.locator('button').first();
        await expect(first).not.toBeFocused();assert.equal(await first.evaluate(node=>node.matches(':hover')),false);
        await page.keyboard.press('Escape');await expect(more).toBeFocused();
        await more.press('Enter');await expect(first).toBeFocused();await page.keyboard.press('Escape');
        await bar.focus();await page.keyboard.press('Shift+F10');
        const contextMenu=page.locator(selector==='.bookmark-bar'?'#bookmark-tree-context':'#side-bookmark-context');
        await expect(contextMenu).toBeVisible();await expect(contextMenu.locator('button').first()).toBeFocused();
        await page.keyboard.press('Escape');await expect(bar).toBeFocused();
      }
      assert.equal(await page.locator('#bookmark-tools,[data-side-add],[data-side-manage]').count(),0);
    }
  }
  await language(page,'en');
  evidence.push({check:'Native UI refinement repeated tree current/ancestor reveal with visible focus and scroll, no navigation/expansion, JP/EN and both sides',pass:true,revealCycles:24,treeOnly,foreground:await page.evaluate(()=>document.hasFocus())});
}
