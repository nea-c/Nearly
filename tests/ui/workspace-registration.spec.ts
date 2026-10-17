import {test,expect,type BrowserContext,type Page} from '@playwright/test';

// Strict native ownership model: an unclaimed ID is refused just like a foreign
// ID. Browser protocol tests do not exercise a real second native window.
async function fixture(context:BrowserContext){
  const pages=new Map<Page,string>(),owners=new Map<string,string>();
  const calls:{label:string;cmd:string;id?:string}[]=[];
  let hold=false,fail=false,release:(()=>void)|undefined;
  await context.exposeBinding('ownershipInvoke',async({page},cmd:string,args:any={})=>{
    const label=pages.get(page)!;calls.push({label,cmd,id:args.id});
    if(cmd==='register_window')return {label,freshProcess:true,ownedWorkspaceIds:[],jobs:[],workspaces:[]};
    if(cmd==='load_settings')return {version:1,settingsRevision:1,language:'en',theme:'light',profiles:[],history:{}};
    if(cmd==='register_workspace'){
      if(hold){hold=false;await new Promise<void>(resolve=>release=resolve);}
      if(fail){fail=false;throw Error('Generated registration failure');}
      if(owners.has(args.id)&&owners.get(args.id)!==label)throw Error('Workspace belongs to another window');
      owners.set(args.id,label);return;
    }
    if(cmd==='disconnect_session'||cmd==='unregister_workspace'){
      if(owners.get(args.id)!==label)throw Error('Workspace belongs to another window');
      if(cmd==='unregister_workspace')owners.delete(args.id);return;
    }
    if(cmd==='close_empty_window'){if([...owners.values()].includes(label))throw Error('Window still owns tabs');return;}
    if(cmd==='list_local'||cmd==='list_remote'||cmd==='local_drives')return [];
    if(cmd==='local_watch_status')return {dirty:false,epoch:0};
    if(cmd==='get_window_state')return {maximized:false};
    return undefined;
  });
  await context.addInitScript(()=>{const w=window as any;w.__TAURI__={core:{invoke:(cmd:string,args:any)=>w.ownershipInvoke(cmd,args)},event:{listen:async()=>()=>{}}};});
  return {owners,calls,holdNext(){hold=true;},failNext(){fail=true;},release(){release?.();},async open(label='main'){const p=await context.newPage();pages.set(p,label);await p.goto('/');await expect(p.locator('#add-tab')).toBeEnabled();return p;}};
}
const ids=(p:Page)=>p.locator('[data-tab]').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).dataset.tab!));
async function create(p:Page){const old=await ids(p);await p.locator('#add-tab').click();await expect(p.locator('[data-tab]')).toHaveCount(old.length+1);return (await ids(p)).find(id=>!old.includes(id))!;}

test('new tab closes immediately and rapid repetition never disconnects an unowned ID',async({context})=>{
  const f=await fixture(context),p=await f.open();
  for(let n=0;n<5;n++){const id=await create(p);await p.locator(`[data-close="${id}"]`).click();await expect(p.locator(`[data-tab="${id}"]`)).toHaveCount(0);expect(f.owners.has(id)).toBe(false);}
  expect(f.calls.filter(c=>c.cmd==='unregister_workspace')).toHaveLength(5);
  await expect(p.locator('body')).not.toContainText('Workspace belongs to another window');
});
test('close waits for pending registration before disconnect and unregister',async({context})=>{
  const f=await fixture(context),p=await f.open();f.holdNext();const id=await create(p);
  await p.locator(`[data-close="${id}"]`).click();
  expect(f.calls.some(c=>c.id===id&&c.cmd==='disconnect_session')).toBe(false);
  f.release();await expect(p.locator(`[data-tab="${id}"]`)).toHaveCount(0);
  expect(f.calls.filter(c=>c.id===id).map(c=>c.cmd)).toEqual(['register_workspace','disconnect_session','unregister_workspace']);
});
test('registration failure preserves the tab and a later close retries safely',async({context})=>{
  const f=await fixture(context),p=await f.open();f.holdNext();f.failNext();const id=await create(p);
  await p.locator(`[data-close="${id}"]`).click();f.release();
  await expect(p.locator('body')).toContainText('Generated registration failure');
  await expect(p.locator(`[data-tab="${id}"]`)).toHaveCount(1);
  expect(f.calls.some(c=>c.id===id&&c.cmd==='disconnect_session')).toBe(false);
  await p.locator(`[data-close="${id}"]`).click();await expect(p.locator(`[data-tab="${id}"]`)).toHaveCount(0);
});
test('foreign ownership remains protected and closing one window never touches another',async({context})=>{
  const f=await fixture(context),p=await f.open(),other=await f.open('other');const otherId=(await ids(other))[0];
  const id=await create(p);await expect.poll(()=>f.owners.get(id)).toBe('main');
  f.owners.set(id,'other');await p.locator(`[data-close="${id}"]`).click();
  await expect(p.locator('body')).toContainText('Workspace belongs to another window');await expect(p.locator(`[data-tab="${id}"]`)).toHaveCount(1);
  expect(f.owners.get(otherId)).toBe('other');expect(f.owners.get(id)).toBe('other');
});
test('last tab unregisters before empty-window close',async({context})=>{
  const f=await fixture(context),p=await f.open();const id=(await ids(p))[0];await p.locator(`[data-close="${id}"]`).click();
  await expect.poll(()=>f.calls.some(c=>c.cmd==='close_empty_window')).toBe(true);
  const ops=f.calls.filter(c=>c.cmd==='unregister_workspace'||c.cmd==='close_empty_window').map(c=>c.cmd);expect(ops).toEqual(['unregister_workspace','close_empty_window']);
});
