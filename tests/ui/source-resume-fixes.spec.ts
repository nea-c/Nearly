import {test,expect,type Page} from '@playwright/test';
const shown="C:\\同期 & 共有\\"+Array.from({length:28},(_,i)=>'長いフォルダー'+i).join('\\')+"\\O'Neil";
const destination="/srv/資料 & O'Neil/"+Array.from({length:22},(_,i)=>'remote-folder-'+i).join('/');
async function boot(page:Page,language='en',theme='dark',root=shown,remote=destination){
 await page.addInitScript(({language,theme,root,remote})=>{
  const profile={id:'fix',name:'Fixture',host:'never-contacted.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',keyFile:'generated-only',hostKey:'fixture'};
  window.uiFix={calls:[],listeners:{},holdStop:false,holdStart:false,failStart:false,status:'running'};
  window.__TAURI__={event:{listen:async(name,callback)=>{window.uiFix.listeners[name]=callback;return()=>{};}},core:{invoke:async(cmd,args)=>{
   window.uiFix.calls.push({cmd,args});
   if(cmd==='load_settings')return JSON.parse(localStorage.getItem('ui-fix')||'null')||{version:1,language,theme,profiles:[profile],history:{}};
   if(cmd==='save_settings'){localStorage.setItem('ui-fix',JSON.stringify(args.data));return;}
   if(cmd==='default_folder')return root;
   if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
   if(cmd==='list_local'||cmd==='list_remote')return[];
   if(cmd==='connect_session')return{path:remote,entries:[]};
   if(cmd==='start_sync'){if(window.uiFix.holdStart)await new Promise(resolve=>window.uiFix.releaseStart=resolve);if(window.uiFix.failStart)throw Error('Generated resume failure');return;}
   if(cmd==='stop_sync'){if(window.uiFix.holdStop)await new Promise(resolve=>window.uiFix.releaseStop=resolve);return{knownUnreflected:false};}
   if(cmd==='sync_status')return{status:window.uiFix.status,pending:0,sent:0,speed:0,latency:0,logs:[]};
  }}};
 },{language,theme,root,remote});
 await page.goto('/');await page.locator('#connect-form .primary').click();
 for(const side of ['local','remote'])await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy','false');
 const remotePath=page.locator('[data-path=remote] input');await remotePath.fill(remote);await remotePath.press('Enter');await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy','false');
}
function contrast(a:string,b:string){const lum=(v:string)=>{const rgb=v.match(/[\d.]+/g)!.slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
for(const language of ['ja','en'])for(const theme of ['light','dark','midnight','forest','mint'])test(`source contrast and escaped long-path layout ${language} ${theme}`,async({page},info)=>{
 await page.setViewportSize({width:800,height:650});await boot(page,language,theme);await page.locator('#prepare').click();
 const source=page.locator('[data-sync-source]');await expect(source).toHaveText(shown);await expect(source.locator('*')).toHaveCount(0);
 const target=page.locator('#start-form > .target code');await expect(target).toHaveText(destination);await expect(target.locator('*')).toHaveCount(0);
 const cards=await page.locator('#start-form > .target,#start-form > .sync-source').evaluateAll(elements=>elements.map(el=>{
  const card=getComputedStyle(el),code=getComputedStyle(el.querySelector('code')!),label=getComputedStyle(el.querySelector('small')!);
  return{padding:card.padding,background:card.backgroundColor,color:card.color,border:card.border,borderRadius:card.borderRadius,display:card.display,gap:card.gap,minHeight:card.minHeight,width:el.getBoundingClientRect().width,path:{font:code.font,lineHeight:code.lineHeight,whiteSpace:code.whiteSpace,overflowWrap:code.overflowWrap,margin:code.margin},label:{font:label.font,color:label.color,lineHeight:label.lineHeight}};
 }));
 expect(cards).toHaveLength(2);expect(cards[1]).toEqual(cards[0]);
 const sample=await source.evaluate(el=>{const s=getComputedStyle(el),box=el.getBoundingClientRect(),host=el.closest('.sync-source')!,h=getComputedStyle(host),d=el.closest('.dialog')!.getBoundingClientRect();return{fg:s.color,bg:h.backgroundColor,box:{left:box.left,right:box.right,width:box.width},dialog:{left:d.left,right:d.right},overflow:document.documentElement.scrollWidth>innerWidth};});
 await info.attach('source-colors',{body:JSON.stringify(sample),contentType:'application/json'});
 await page.screenshot({path:`test-results/source-${language}-${theme}.png`});
 expect(contrast(sample.fg,sample.bg),JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
 expect(sample.box.left).toBeGreaterThanOrEqual(sample.dialog.left);expect(sample.box.right).toBeLessThanOrEqual(sample.dialog.right);expect(sample.overflow).toBe(false);
 await page.locator('#start-form .primary').click();await expect.poll(()=>page.evaluate(()=>window.uiFix.calls.filter(c=>c.cmd==='start_sync').length)).toBe(1);
 expect(await page.evaluate(()=>window.uiFix.calls.find(c=>c.cmd==='start_sync').args.local)).toBe(shown);
 expect(await page.evaluate(()=>window.uiFix.calls.find(c=>c.cmd==='start_sync').args.remote)).toBe(destination);
});

test('Resume is absent throughout active, failed, stopping and pending resume, then returns with original pair',async({page})=>{
 await boot(page);await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await expect(page.locator('#start-form')).toHaveCount(0);await expect(page.locator('#retained-resume')).toHaveCount(0);
 await page.evaluate(()=>window.uiFix.status='failed');await expect(page.locator('#retained-resume')).toHaveCount(0);
 await page.evaluate(()=>window.uiFix.holdStop=true);await page.locator('#prepare').click();await expect(page.locator('#prepare')).toBeDisabled();await expect(page.locator('#retained-resume')).toHaveCount(0);
 await page.evaluate(()=>{window.uiFix.status='running';window.uiFix.releaseStop?.();});await expect(page.locator('#retained-resume')).toBeVisible();
 await page.locator('[data-path=local] input').fill('C:\\different');await page.locator('[data-path=local] input').press('Enter');await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
 await page.locator('#retained-resume').click();await expect(page.locator('[data-sync-source]')).toHaveText(shown);
 await page.evaluate(()=>{window.uiFix.holdStart=true;window.uiFix.failStart=true;});await page.locator('#start-form .primary').click();await expect(page.locator('#retained-resume')).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>window.uiFix.calls.filter(c=>c.cmd==='start_sync').length)).toBe(2);
 await page.evaluate(()=>window.uiFix.releaseStart());await expect(page.locator('.form-error').last()).toContainText('Generated resume failure');await page.locator('#cancel').click();await expect(page.locator('#retained-resume')).toBeVisible();
 await page.locator('#retained-resume').focus();await expect(page.locator('#sync-resume-help')).toContainText(shown);
});
