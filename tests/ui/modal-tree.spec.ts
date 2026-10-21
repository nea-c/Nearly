import {test,expect,type Page} from '@playwright/test';
import {boot,treeControl,go} from './transfer-v2-fixture';

const menu=(page:Page)=>page.locator('#bookmark-tree-context,#side-bookmark-context');
for(const side of ['paired','local','remote'])test(`${side} context blocks background clicks and hover, highlights only its target, traps focus`,async({page})=>{
  await boot(page);
  const bar=page.locator(side==='paired'?'.bookmark-bar':`[data-side-bookmarks=${side}]`);
  const target=bar.locator('[data-bookmark-tree-node]').first();
  const before=await page.locator('#remote-path').inputValue();
  await target.click({button:'right'});
  await expect(target).toHaveAttribute('data-bookmark-context-target','true');
  const path=page.locator('#remote-path'),box=(await path.boundingBox())!;
  await page.mouse.move(box.x+20,box.y+10);
  expect(await path.evaluate(el=>el.matches(':hover'))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  expect(await menu(page).evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await menu(page).evaluate(el=>el.contains(document.activeElement))).toBe(true);
  const settings=(await page.locator('#settings-toggle').boundingBox())!;
  await page.mouse.click(settings.x+8,settings.y+8);
  await expect(menu(page)).toHaveCount(0);await expect(page.locator('#settings-popup')).toHaveCount(0);
  await expect(target).not.toHaveAttribute('data-bookmark-context-target');
  await expect(target).not.toBeFocused();await expect(path).toHaveValue(before);
  await bar.click({button:'right',position:{x:2,y:2}});
  await expect(page.locator('[data-bookmark-context-target]')).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(bar).toBeFocused();
});
test('overflow context retains its visible target through dismissal and right-click releases do not leak',async({page})=>{
  await boot(page,'en',40);
  await page.locator('#local-bookmark-more').click();
  const target=page.locator('#bookmark-overflow-menu [data-bookmark-tree-node]').first();
  await target.click({button:'right'});
  await expect(page.locator('[data-bookmark-context-target]')).toBeVisible();
  await expect(page.locator('[data-bookmark-context-target]')).toHaveCount(1);
  const settings=(await page.locator('#settings-toggle').boundingBox())!;
  await page.mouse.click(settings.x+8,settings.y+8,{button:'right'});
  await expect(menu(page)).toHaveCount(0);await expect(page.locator('#settings-popup')).toHaveCount(0);
  await page.locator('#local-bookmark-more').click();await page.keyboard.press('Escape');
  await expect(page.locator('[data-bookmark-context-target]')).toHaveCount(0);
});
test('settings consumes outside pointer sequence, traps focus and preserves immediate preference saving',async({page})=>{
  await boot(page);await page.locator('#settings-toggle').click();
  await page.locator('#theme-select').selectOption('dark');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('ui-refinement')||'{}').theme)).toBe('dark');
  await expect(page.locator('#settings-popup')).toBeVisible();
  await page.keyboard.press('Tab');expect(await page.locator('#settings-popup').evaluate(el=>el.contains(document.activeElement))).toBe(true);
  const add=(await page.locator('#add-tab').boundingBox())!;
  const count=await page.locator('[data-tab]').count();
  await page.mouse.move(add.x+5,add.y+5);expect(await page.locator('#add-tab').evaluate(el=>el.matches(':hover'))).toBe(false);
  await page.mouse.down();await expect(page.locator('#settings-popup')).toBeVisible();
  await page.mouse.up();await expect(page.locator('#settings-popup')).toHaveCount(0);
  await expect(page.locator('[data-tab]')).toHaveCount(count);await expect(page.locator('#settings-toggle')).toBeFocused();
});
for(const popup of ['context','settings'])test(`${popup} keeps application shortcuts inside the popup`,async({page})=>{
  await boot(page);
  const paths=await Promise.all(['local','remote'].map(side=>page.locator('#'+side+'-path').inputValue()));
  const count=await page.locator('[data-tab]').count();
  if(popup==='context')await page.locator('.bookmark-bar [data-bookmark-tree-node]').first().click({button:'right'});
  else await page.locator('#settings-toggle').click();
  const surface=popup==='context'?menu(page):page.locator('#settings-popup');
  const reads=await page.evaluate(()=>(window as any).refinementCalls.filter((c:any)=>['list_local','list_remote','connect_session'].includes(c.cmd)).length);
  for(const key of ['Control+t','Control+w','Control+Tab','Alt+ArrowLeft','F5'])await page.keyboard.press(key);
  await expect(surface).toBeVisible();await expect(page.locator('[data-tab]')).toHaveCount(count);
  expect(await Promise.all(['local','remote'].map(side=>page.locator('#'+side+'-path').inputValue()))).toEqual(paths);
  expect(await page.evaluate(()=>(window as any).refinementCalls.filter((c:any)=>['list_local','list_remote','connect_session'].includes(c.cmd)).length)).toBe(reads);
});
test('removing a context target dismisses the popup and restores bar focus',async({page})=>{
  await boot(page);
  await page.locator('#local-bookmarks [data-bookmark-tree-node]').first().click({button:'right'});
  await page.locator('[data-bookmark-context-target]').evaluate(el=>el.remove());
  await expect(menu(page)).toHaveCount(0);await expect(page.locator('#local-bookmarks')).toBeFocused();
  await expect(page.locator('#app')).not.toHaveAttribute('inert');
});
test('outside right-click dismisses once without opening a different bar context or leaking pointer events',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{
    (window as any).backgroundEvents=[];
    for(const type of ['pointerdown','pointerup','click','contextmenu'])document.querySelector('#app')!.addEventListener(type,event=>(window as any).backgroundEvents.push(event.type));
  });
  for(let attempt=0;attempt<3;attempt++){
    await page.locator('.bookmark-bar [data-bookmark-tree-node]').first().click({button:'right'});
    await page.evaluate(()=>(window as any).backgroundEvents=[]);
    const other=(await page.locator('#remote-bookmarks').boundingBox())!;
    await page.mouse.click(other.x+2,other.y+2,{button:'right'});
    await expect(menu(page)).toHaveCount(0);
    expect(await page.evaluate(()=>(window as any).backgroundEvents)).toEqual([]);
  }
});
test('child native confirmation stays interactive without dismissing its settings parent',async({page})=>{
  await boot(page);await page.locator('#settings-toggle').click();
  await page.evaluate(async()=>{
    const {confirmPresetRemoval}=await import('/src/confirmation-dialog.ts');
    (window as any).confirmation=confirmPresetRemoval('Fixture',document.querySelector<HTMLElement>('#settings-close')!);
  });
  await page.locator('#preset-removal-cancel').click();
  await expect(page.locator('#settings-popup')).toBeVisible();
  await expect(page.locator('#settings-close')).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.locator('#settings-popup')).toHaveCount(0);
});
test('connection reveals ancestors only once and respects later collapse, navigation and panel reopening',async({page})=>{
  await boot(page);
  await expect(treeControl(page,'local','C:\\root')).toBeVisible();
  await expect(page.locator('[data-tree=local] [role=treeitem][aria-selected=true] > [data-tree-row]')).toHaveAttribute('data-tree-path','C:\\root');
  await treeControl(page,'local','@pc','toggle').click();
  await go(page,'local','C:\\root\\directory-089');
  await page.locator('[data-tree-visibility=local]').click();await page.locator('[data-tree-visibility=local]').click();
  await expect(treeControl(page,'local','@pc','toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded','false');
  await expect(treeControl(page,'local','C:\\root')).toHaveCount(0);
});

async function deepFixture(page:Page,options:{hold?:string;missing?:boolean;fail?:boolean;omittedRoot?:boolean;replacement?:boolean;wide?:boolean}={}){
  await page.addInitScript(options=>{
    const p={id:'deep',name:'Deep',mode:'sftp',host:'deep.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const other={...p,id:'replacement',name:'Replacement',host:'replacement.invalid'};
    const key=JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);
    const otherKey=JSON.stringify([other.id,other.mode,other.host,other.port,other.user,other.hostKey]);
    const dir=(name:string)=>({name,dir:true,size:0});
    const listings:Record<string,any[]>={'/':[dir('a')],'/a':[dir('b')],'/a/b':[dir('c')],'/a/b/c':[], 'C:\\':[dir('root')],'C:\\root':[dir('deep')],'C:\\root\\deep':[dir('leaf')],'C:\\root\\deep\\leaf':[]};
    if(options.omittedRoot)listings['/']=[];
    if(options.wide)listings['/'].push(dir('long-folder-'.repeat(35)));
    listings['/different']=[dir('leaf')];listings['/different/leaf']=[];
    Object.assign(window,{deepCalls:[],deepOptions:options});
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).deepCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('deep-settings')||'null')||{version:1,language:'en',profiles:options.replacement?[p,other]:[p],history:{},browseLocations:{[key]:{local:'C:\\root\\deep\\leaf',remote:'/a/b/c'},...(options.replacement?{[otherKey]:{local:'C:\\root',remote:'/different/leaf'}}:{})}};
      if(cmd==='save_settings'){localStorage.setItem('deep-settings',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='connect_session')return{path:'/',entries:args.profile.id==='replacement'?[dir('different')]:listings['/']};
      if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
      if(cmd==='list_local'||cmd==='list_remote'){
        if(args.path===(window as any).deepOptions.hold)await new Promise(resolve=>(window as any).deepRelease=()=>{(window as any).deepOptions.hold='';resolve(null);});
        if(options.missing&&args.path==='/a')return[];
        if(options.fail&&args.path==='/a')throw Error('ancestor denied');
        return listings[args.path]||[];
      }
    }}};
  },options);
  await page.goto('/');await page.locator('#connect-form .primary').click();
}
const selectedPath=(page:Page,side:string)=>page.locator(`[data-tree=${side}] [role=treeitem][aria-selected=true] > [data-tree-row]`);
test('deep saved folders are selected and visible after authentication and reconnect without focus stealing',async({page})=>{
  await deepFixture(page);
  for(let attempt=0;attempt<2;attempt++){
    for(const [side,path] of [['local','C:\\root\\deep\\leaf'],['remote','/a/b/c']]){
      await expect(selectedPath(page,side)).toHaveAttribute('data-tree-path',path);
      await expect(treeControl(page,side,path)).toBeVisible();
      await expect(treeControl(page,side,path,'toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded','false');
      await expect(page.locator('#'+side+'-path')).toHaveValue(path);
    }
    if(!attempt){await page.reload();await expect(page.locator('[data-tree]')).toHaveCount(0);await page.locator('#connect-form .primary').click();}
  }
});
for(const fail of [false,true])test(`unavailable ancestor falls back only in tree selection; listing failure=${fail}`,async({page})=>{
  await deepFixture(page,fail?{fail:true}:{missing:true});
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/a');
  await expect(page.locator('#remote-path')).toHaveValue('/a/b/c');
  const data=await page.evaluate(()=>JSON.parse(localStorage.getItem('deep-settings')||'{}'));
  expect(Object.values(data.browseLocations).some((p:any)=>p.remote==='/a/b/c')).toBe(true);
  await expect(page.locator('[data-tree=remote]')).not.toContainText(/Loading|�Ǎ���/);
});
test('user collapse during ancestor loading survives completion and ordinary panel reopening',async({page})=>{
  await deepFixture(page,{hold:'/a'});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).deepRelease)).toBe('function');
  const toggle=treeControl(page,'remote','/','toggle');await toggle.click();
  await page.locator('#local-path').focus();await page.evaluate(()=>(window as any).deepRelease());
  await expect(toggle.locator('xpath=../..')).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('#local-path')).toBeFocused();
  await page.locator('[data-tree-visibility=remote]').click();await page.locator('[data-tree-visibility=remote]').click();
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/');
  await expect(page.locator('#remote-path')).toHaveValue('/a/b/c');
});
test('tab switch away and back cancels held initialization before later ancestors expand',async({page})=>{
  await deepFixture(page,{hold:'/a'});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).deepRelease)).toBe('function');
  const first=await page.locator('[data-tab][aria-selected=true]').getAttribute('data-tab');
  await page.keyboard.press('Control+t');await expect(page.locator('#connect-form')).toBeVisible();
  await page.locator(`[data-tab="${first}"]`).click();
  await page.locator('#local-path').focus();await page.evaluate(()=>(window as any).deepRelease());
  await expect(treeControl(page,'remote','/a','toggle')).not.toHaveAttribute('aria-busy','true');
  await expect(treeControl(page,'remote','/a','toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
  await expect(treeControl(page,'remote','/a/b','toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded','false');
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/a/b');
  await expect(page.locator('#local-path')).toBeFocused();
});
test('pending initialization render preserves an open context target for its full lifetime',async({page})=>{
  await deepFixture(page,{hold:'/a'});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).deepRelease)).toBe('function');
  // An empty bar still owns a modal context while the ancestor read is pending.
  await page.locator('#local-bookmarks').click({button:'right',position:{x:2,y:2}});
  await page.evaluate(()=>(window as any).deepRelease());
  await expect(menu(page)).toBeVisible();
  await page.waitForTimeout(150);await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/a/b/c');
});
test('new navigation cancels held ancestor expansion without changing the newer path',async({page})=>{
  await deepFixture(page,{hold:'/a'});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).deepRelease)).toBe('function');
  await go(page,'remote','/other');
  await page.evaluate(()=>(window as any).deepRelease());
  await expect(page.locator('#remote-path')).toHaveValue('/other');
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/other');
  await expect(treeControl(page,'remote','/a','toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
  await expect(treeControl(page,'remote','/a/b','toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded','false');
  await expect(treeControl(page,'remote','/a/b/c')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).deepCalls.filter((c:any)=>c.cmd==='list_remote'&&c.args.path==='/a/b').length)).toBe(0);
});

test('review fix: loaded connection root omitting a denied restored ancestor selects root without changing browse',async({page})=>{
  await deepFixture(page,{omittedRoot:true,fail:true});
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/');
  await expect(treeControl(page,'remote','/a')).toHaveCount(0);
  await expect(page.locator('#remote-path')).toHaveValue('/a/b/c');
  await expect.poll(()=>page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('deep-settings')||'{}').browseLocations||{}).some((path:any)=>path.remote==='/a/b/c'))).toBe(true);
});
for(const popup of ['context','settings'])for(const dismissal of ['Escape','early right context'])
test(`review fix: ${popup} consumes release after more than 500ms held through ${dismissal}`,async({page})=>{
  await boot(page);
  if(popup==='context')await page.locator('#local-bookmarks [data-bookmark-tree-node]').first().click({button:'right'});
  else await page.locator('#settings-toggle').click();
  const surface=popup==='context'?menu(page):page.locator('#settings-popup');
  await page.evaluate(()=>{
    (window as any).heldBackgroundEvents=[];
    for(const type of ['pointerup','mouseup','click','auxclick','contextmenu'])document.querySelector('#app')!.addEventListener(type,event=>(window as any).heldBackgroundEvents.push(event.type));
  });
  const tabs=await page.locator('[data-tab]').count(),box=(await page.locator('#add-tab').boundingBox())!;
  await page.mouse.move(box.x+5,box.y+5);
  const button=dismissal==='Escape'?'left':'right';
  await page.mouse.down({button});
  if(dismissal==='Escape')await page.keyboard.press('Escape');
  else await page.evaluate(({x,y})=>{
    // Deliberately model Windows' supported contextmenu-before-pointerup ordering.
    if(document.querySelector('.popup-backdrop'))document.elementFromPoint(x,y)!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:x,clientY:y}));
  },{x:box.x+5,y:box.y+5});
  await expect(surface).toHaveCount(0);await page.waitForTimeout(700);
  await page.mouse.up({button});
  expect(await page.evaluate(()=>(window as any).heldBackgroundEvents)).toEqual([]);
  await expect(page.locator('[data-tab]')).toHaveCount(tabs);
  // The very next deliberate gesture must work; no extra click is required.
  await page.locator('#settings-toggle').click();await expect(page.locator('#settings-popup')).toBeVisible();
});
test('review fix: child confirmation outside interaction, Tab and Escape preserve settings parent',async({page})=>{
  await boot(page);await page.locator('#settings-toggle').click();
  await page.evaluate(async()=>{
    const {confirmPresetRemoval}=await import('/src/confirmation-dialog.ts');
    (window as any).childResult=confirmPresetRemoval('Fixture',document.querySelector<HTMLElement>('#settings-close')!);
  });
  const child=page.locator('#preset-removal-dialog');
  await page.keyboard.press('Tab');await expect(page.locator('#preset-removal-confirm')).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.locator('#preset-removal-cancel')).toBeFocused();
  await page.mouse.click(5,80);await expect(child).toBeVisible();await expect(page.locator('#settings-popup')).toBeVisible();
  await page.keyboard.press('Escape');await expect(child).toHaveCount(0);
  await expect(page.locator('#settings-popup')).toBeVisible();await expect(page.locator('#settings-close')).toBeFocused();
  expect(await page.evaluate(()=>(window as any).childResult)).toBe(false);
});
test('review fix: rapid replacement by a different connection cannot consume old held initialization',async({page})=>{
  await deepFixture(page,{hold:'/a',replacement:true});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).deepRelease)).toBe('function');
  const old=await page.locator('[data-tab][aria-selected=true]').getAttribute('data-tab');
  await page.keyboard.press('Control+t');
  await page.locator('[data-connection-select=replacement]').click();await page.locator('#connect-form .primary').click();
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/different/leaf');
  await page.locator(`[data-close="${old}"]`).click();await expect(page.locator(`[data-tab="${old}"]`)).toHaveCount(0);
  await page.locator('#local-path').focus();await page.evaluate(()=>(window as any).deepRelease());
  await expect(page.locator('#remote-path')).toHaveValue('/different/leaf');
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/different/leaf');
  await expect(page.locator('#local-path')).toBeFocused();
  expect(await page.evaluate(()=>(window as any).deepCalls.filter((c:any)=>c.cmd==='connect_session').map((c:any)=>c.args.profile.host))).toEqual(['deep.invalid','replacement.invalid']);
  expect(await page.evaluate(()=>(window as any).deepCalls.filter((c:any)=>c.cmd==='list_remote'&&c.args.profile.id==='deep'&&c.args.path==='/a/b').length)).toBe(0);
});
test('review fix: held connection initialization preserves real horizontal offset and editor focus',async({page})=>{
  await deepFixture(page,{hold:'/a',wide:true});
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).deepRelease)).toBe('function');
  const before=await page.locator('[data-tree=remote]').evaluate(element=>{element.scrollLeft=130;element.dispatchEvent(new Event('scroll'));return element.scrollLeft;});
  expect(before).toBeGreaterThan(0);
  await page.locator('#local-path').focus();await page.evaluate(()=>(window as any).deepRelease());
  await expect(selectedPath(page,'remote')).toHaveAttribute('data-tree-path','/a/b/c');
  await expect.poll(()=>page.locator('[data-tree=remote]').evaluate(element=>element.scrollLeft)).toBe(before);
  await expect(page.locator('#local-path')).toBeFocused();
});
for(const popup of ['context','settings'])test(`review fix: ${popup} consumes auxiliary tail when native context follows pointer release`,async({page})=>{
  await boot(page);
  if(popup==='context')await page.locator('#local-bookmarks [data-bookmark-tree-node]').first().click({button:'right'});
  else await page.locator('#settings-toggle').click();
  const events=await page.evaluate(()=>{
    const app=document.querySelector('#app')!,backdrop=document.querySelector('.popup-backdrop')!;
    const seen:string[]=[];
    for(const type of ['pointerup','mouseup','click','auxclick','contextmenu'])app.addEventListener(type,event=>seen.push(event.type));
    backdrop.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:71,pointerType:'mouse',button:2,buttons:2}));
    backdrop.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:71,pointerType:'mouse',button:2,buttons:0}));
    backdrop.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));
    app.dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:2,detail:1}));
    return seen;
  });
  expect(events).toEqual([]);
  await expect(menu(page)).toHaveCount(0);await expect(page.locator('#settings-popup')).toHaveCount(0);
  await page.locator('#settings-toggle').click();await expect(page.locator('#settings-popup')).toBeVisible();
});
