import {test,expect,type Page,type Locator} from '@playwright/test';

export async function boot(page:Page,language='en',count=2) {
  await page.addInitScript(({language,count})=>{
    const profile={id:'a',name:'Fixture',mode:'sftp',host:'fixture.invalid',port:22,user:'test',auth:'key',hostKey:'pin'};
    const other={...profile,id:'b',name:'Other',host:'other.invalid'};
    const key=(p:any)=>JSON.stringify([p.id,p.mode,p.host,p.port,p.user,p.hostKey]);
    const dirs=Array.from({length:90},(_,i)=>({name:'directory-'+String(i).padStart(3,'0'),dir:true,size:0}));
    (window as any).refinementCalls=[];
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).refinementCalls.push({cmd,args});
      if(cmd==='load_settings')return JSON.parse(localStorage.getItem('ui-refinement')||'null')||{version:1,profiles:[profile,other],history:{},language,
        localBookmarks:Array.from({length:count},(_,i)=>({id:'l'+i,name:'Local '+i,path:'C:\\folder'+i})),
        remoteBookmarks:[...Array.from({length:count},(_,i)=>({id:'r'+i,name:'Remote '+i,path:'/folder'+i,connectionKey:key(profile)})),{id:'foreign',name:'Other connection',path:'/private',connectionKey:key(other)}],
        folderBookmarks:Array.from({length:count},(_,i)=>({id:'p'+i,name:'Pair '+i,local:'C:\\pair'+i,remote:'/pair'+i,connectionKey:key(profile)}))};
      if(cmd==='save_settings'){localStorage.setItem('ui-refinement',JSON.stringify(args.data));return;}
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:dirs};
      if(cmd==='list_local')return args.path==='C:\\'?[{name:'root',dir:true,size:0}]:dirs;
      if(cmd==='list_remote')return dirs;
    }}};
  },{language,count});
  await page.goto('/');await page.locator('#connect-form .primary').click();
  for(const side of ['local','remote'])await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');
}
const saved=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('ui-refinement')||'{}'));
async function blankContext(bar:Locator) {
  const strip=bar.locator('.bookmark-items');
  await strip.click({button:'right',position:{x:Math.max(3,(await strip.boundingBox())!.width-8),y:8}});
}
export const treeControl=(page:Page,side:string,path:string,kind='select')=>page.locator('[data-tree-'+kind+'='+side+'][data-tree-path='+JSON.stringify(path)+']');
export async function expand(page:Page,side:string,path:string) {
  const control=treeControl(page,side,path,'toggle');
  if(await control.count()&&await control.locator('xpath=../..').getAttribute('aria-expanded')!=='true'){
    await control.click();await expect(control.locator('xpath=../..')).toHaveAttribute('aria-expanded','true');
  }
}
export async function go(page:Page,side:string,path:string) {
  await page.locator('#'+side+'-path').fill(path);await page.locator('#'+side+'-path').press('Enter');
  await expect(page.locator('[data-pane='+side+']')).toHaveAttribute('aria-busy','false');
}
