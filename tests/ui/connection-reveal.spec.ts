import {test,expect,type Page} from '@playwright/test';
import {treeControl,go} from './transfer-v2-fixture';
type Side='local'|'remote';
const current=(side:Side)=>side==='local'?'C:\\root\\branch-119\\branch-119\\target-119':'/branch-119/branch-119/target-119';
const held=(side:Side)=>side==='local'?'C:\\root\\branch-119':'/branch-119';
const tree=(page:Page,side:Side)=>page.locator(`[data-tree=${side}]`);
const selected=(page:Page,side:Side)=>page.locator(`[data-tree=${side}] [role=treeitem][aria-selected=true] > [data-tree-row]`);

async function fixture(page:Page,side:Side='remote'){
  await page.addInitScript(({side})=>{
    const profile={id:'reveal',name:'Reveal',mode:'sftp',host:'reveal.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const key=JSON.stringify([profile.id,profile.mode,profile.host,profile.port,profile.user,profile.hostKey]);
    const remote='/branch-119/branch-119/target-119',local='C:\\root\\branch-119\\branch-119\\target-119';
    const branch=side==='remote'?'/branch-119':'C:\\root\\branch-119';
    const dirs=(prefix:string)=>Array.from({length:120},(_,index)=>({name:prefix+String(index).padStart(3,'0'),dir:true,size:0}));
    const branches=[...dirs('branch-'),{name:'long-folder-'.repeat(35),dir:true,size:0}];
    Object.assign(window,{revealCalls:[],revealTopWrites:[],revealDeepFinished:false});
    // Record real application scroll writes without changing the browser's layout.
    const scroll=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop')!;
    const ids=new WeakMap<Element,number>();let nextId=0;
    Object.defineProperty(Element.prototype,'scrollTop',{...scroll,set(value:number){
      scroll.set!.call(this,value);
      if(this instanceof HTMLElement&&this.matches('[data-tree]')){
        if(!ids.has(this))ids.set(this,++nextId);
        (window as any).revealTopWrites.push({id:ids.get(this),side:this.dataset.tree,top:scroll.get!.call(this)});
      }
    }});
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).revealCalls.push({cmd,args});
      if(cmd==='load_settings')return{version:1,language:'en',profiles:[profile],history:{},browseLocations:{[key]:{local:side==='local'?local:'C:\\root',remote:side==='remote'?remote:'/'}}};
      if(cmd==='save_settings'){(window as any).revealSaved=args.data;return;}
      if(cmd==='default_folder')return'C:\\root';
      if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
      if(cmd==='connect_session')return{path:'/',entries:branches};
      if(cmd==='list_local'||cmd==='list_remote'){
        if(args.path===branch)await new Promise(resolve=>(window as any).releaseReveal=()=>resolve(null));
        if(args.path===branch+'\\branch-119'||args.path===branch+'/branch-119'){
          await new Promise(resolve=>setTimeout(resolve,90));
          (window as any).revealDeepFinished=true;return dirs('target-');
        }
        if(args.path===remote||args.path===local)return[];
        if(args.path==='C:\\')return[{name:'root',dir:true,size:0}];
        return branches;
      }
    }}};
  },{side});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).releaseReveal)).toBe('function');
}
async function settle(page:Page){await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
async function release(page:Page){await page.evaluate(()=>(window as any).releaseReveal());await expect.poll(()=>page.evaluate(()=>(window as any).revealDeepFinished)).toBe(true);await settle(page);}
const horizontal=(page:Page,side:Side)=>tree(page,side).evaluate(nav=>{
  const values:number[]=[];for(let element:Element|null=nav;element;element=element.parentElement)values.push(element.scrollLeft);return values;
});
async function geometry(page:Page,side:Side){return treeControl(page,side,current(side)).evaluate(element=>{
  const nav=element.closest<HTMLElement>('[data-tree]')!,row=element.closest<HTMLElement>('[data-tree-row]')!;
  const area=nav.getBoundingClientRect(),bounds=row.getBoundingClientRect();
  return{top:bounds.top,bottom:bounds.bottom,viewportTop:area.top+nav.clientTop,viewportBottom:area.top+nav.clientTop+nav.clientHeight,scrollTop:nav.scrollTop};
});}
for(const side of ['remote','local'] as const)test(`delayed offscreen ${side} current folder is vertically revealed after final connection render`,async({page})=>{
  await fixture(page,side);
  await tree(page,side).evaluate(nav=>{nav.scrollLeft=130;nav.dispatchEvent(new Event('scroll'));});
  const before=await horizontal(page,side);expect(before[0]).toBeGreaterThan(0);
  const editor=page.locator(side==='remote'?'#local-path':'#remote-path');await editor.focus();
  await release(page);
  await expect(selected(page,side)).toHaveAttribute('data-tree-path',current(side));
  const bounds=await geometry(page,side);
  console.log('connection reveal geometry',side,JSON.stringify({bounds,writes:await page.evaluate(()=>(window as any).revealTopWrites.slice(-12))}));
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop-1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportBottom+1);
  expect(bounds.scrollTop).toBeGreaterThan(0);
  expect(await horizontal(page,side)).toEqual(before);await expect(editor).toBeFocused();
  // After its one reveal, later renders must honor deliberate user scrolling.
  await tree(page,side).evaluate(nav=>{nav.scrollTop=0;nav.dispatchEvent(new Event('scroll'));});
  await page.locator('#toggle-logs').click();await page.locator('#toggle-logs').click();await settle(page);
  expect(await tree(page,side).evaluate(nav=>nav.scrollTop)).toBe(0);
  await expect(selected(page,side)).toHaveAttribute('data-tree-path',current(side));
});
test('vertical user scrolling during a held remote initializer cancels only its obsolete scroll reveal',async({page})=>{
  await fixture(page);const box=(await tree(page,'remote').boundingBox())!;
  await page.mouse.move(box.x+20,box.y+80);await page.mouse.wheel(0,400);
  await expect.poll(()=>tree(page,'remote').evaluate(nav=>nav.scrollTop)).toBeGreaterThan(0);
  const before=await tree(page,'remote').evaluate(nav=>nav.scrollTop);
  await release(page);await page.waitForTimeout(250);await settle(page);
  await expect(selected(page,'remote')).toHaveAttribute('data-tree-path',current('remote'));
  expect(await tree(page,'remote').evaluate(nav=>nav.scrollTop)).toBe(before);
});
test('a queued remote reveal cannot overwrite deliberate scrolling before its deferred render',async({page})=>{
  await fixture(page);await page.locator('#local-path').fill('C:\\draft');
  await release(page);
  const box=(await tree(page,'remote').boundingBox())!;
  await page.mouse.move(box.x+20,box.y+80);await page.mouse.wheel(0,400);
  await expect.poll(()=>tree(page,'remote').evaluate(nav=>nav.scrollTop)).toBeGreaterThan(0);
  const before=await tree(page,'remote').evaluate(nav=>nav.scrollTop);
  await page.locator('#toggle-logs').click();await page.waitForTimeout(250);await settle(page);
  await expect(selected(page,'remote')).toHaveAttribute('data-tree-path',current('remote'));
  expect(await tree(page,'remote').evaluate(nav=>nav.scrollTop)).toBe(before);
});
test('new remote navigation invalidates a delayed connection reveal without focus or scroll movement',async({page})=>{
  await fixture(page);await go(page,'remote','/replacement');await page.locator('#local-path').focus();
  await page.evaluate(()=>(window as any).releaseReveal());await settle(page);await page.waitForTimeout(130);
  await expect(page.locator('#remote-path')).toHaveValue('/replacement');
  await expect(selected(page,'remote')).toHaveAttribute('data-tree-path','/replacement');
  expect(await tree(page,'remote').evaluate(nav=>nav.scrollTop)).toBe(0);await expect(page.locator('#local-path')).toBeFocused();
});
test('tab switch away and back invalidates an outstanding remote connection reveal',async({page})=>{
  await fixture(page);const first=await page.locator('[data-tab][aria-selected=true]').getAttribute('data-tab');
  await page.keyboard.press('Control+t');await expect(page.locator('#connect-form')).toBeVisible();
  await page.locator(`[data-tab="${first}"]`).click();await page.locator('#local-path').focus();
  await page.evaluate(()=>(window as any).releaseReveal());await settle(page);await page.waitForTimeout(130);
  await expect(page.locator('#remote-path')).toHaveValue(current('remote'));
  expect(await tree(page,'remote').evaluate(nav=>nav.scrollTop)).toBe(0);await expect(page.locator('#local-path')).toBeFocused();
});
