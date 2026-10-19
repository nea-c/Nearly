import {test,expect,type Page} from '@playwright/test';

async function boot(page:Page,options:{language?:string;label?:string;failSettings?:boolean;holdStatus?:boolean;phase?:string;installerQa?:boolean}={}){
 await page.addInitScript(options=>{
  window.recovery={calls:[],listeners:{}};
  window.__TAURI__={event:{listen:async(name,callback)=>{window.recovery.listeners[name]=callback;return()=>{};}},core:{invoke:async(cmd,args)=>{
   window.recovery.calls.push({cmd,args,rendered:!!document.querySelector('#add-tab')});
   if(cmd==='register_window')return{label:options.label||'main',freshProcess:true,ownedWorkspaceIds:[],jobs:[]};
   if(cmd==='load_settings'){if(options.failSettings)throw Error('Generated settings failure');return{version:1,profiles:[],history:{},theme:'dark',language:options.language||'en'};}
   if(cmd==='default_folder')return 'C:\\fixture';
   if(cmd==='list_local'||cmd==='list_remote'||cmd==='list_drives')return[];
   if(cmd==='update_restart_status'){
    if(options.holdStatus)return new Promise(resolve=>window.recovery.resolveStatus=resolve);
    return{phase:options.phase||'idle',revision:0,...(options.installerQa?{installerQa:true}:{})};
   }
  }}};
 },options);
 await page.goto('/');await expect(page.locator('#add-tab')).toBeVisible();
}

test('healthy readiness acknowledges only after a successful main UI render, without renderer evidence',async({page})=>{
 await boot(page);await expect.poll(()=>page.evaluate(()=>window.recovery.calls.filter(c=>c.cmd==='ack_update_restart_ready').length)).toBe(1);
 const calls=await page.evaluate(()=>window.recovery.calls.filter(c=>c.cmd==='ack_update_restart_ready'));
 expect(calls[0].args).toBeUndefined();expect(calls[0].rendered).toBe(true);
 await expect(page.locator('#update-recovery-notice')).toHaveCount(0);
});
for(const language of ['ja','en'])test(`recovery notice is owned localized text and never executes repairs ${language}`,async({page})=>{
 await boot(page,{language,phase:'recoveryRequired'});
 await expect(page.locator('#update-recovery-notice')).toContainText(language==='ja'?'更新':'update');
 await expect(page.locator('#update-recovery-notice')).toContainText(language==='ja'?'保持':'retained');
 expect(await page.evaluate(()=>window.recovery.calls.filter(c=>/install_startup|restore|delete/.test(c.cmd)))).toEqual([]);
 await expect(page.locator('#add-tab')).toBeEnabled();
});
test('late status snapshot cannot erase a newer recovery event or show an untrusted reason',async({page})=>{
 await boot(page,{holdStatus:true});
 await expect.poll(()=>page.evaluate(()=>!!window.recovery.resolveStatus)).toBe(true);
 await page.evaluate(()=>window.recovery.listeners['update-restart-status']({payload:{phase:'recoveryRequired',reason:'<img src=x onerror=alert(1)>',revision:3}}));
 await expect(page.locator('#update-recovery-notice')).toBeVisible();
 await page.evaluate(()=>window.recovery.resolveStatus({phase:'idle',revision:0}));
 await expect(page.locator('#update-recovery-notice')).toBeVisible();await expect(page.locator('#update-recovery-notice img')).toHaveCount(0);
 await expect(page.locator('#update-recovery-notice')).not.toContainText('onerror');
});
test('settings failure never acknowledges restart health',async({page})=>{
 await boot(page,{failSettings:true});await expect(page.locator('#add-tab')).toBeDisabled();
 await page.waitForTimeout(100);expect(await page.evaluate(()=>window.recovery.calls.filter(c=>c.cmd==='ack_update_restart_ready'))).toEqual([]);
});
test('secondary windows do not report main restart health',async({page})=>{
 await boot(page,{label:'window-fixture'});await page.waitForTimeout(100);
 expect(await page.evaluate(()=>window.recovery.calls.filter(c=>['ack_update_restart_ready','update_restart_status'].includes(c.cmd)))).toEqual([]);
});
test('QA bootstrap acknowledgement follows workspace registration and is separate from health',async({page})=>{
 await boot(page,{installerQa:true});
 await expect.poll(()=>page.evaluate(()=>window.recovery.calls.filter(c=>c.cmd==='ack_update_restart_ready').length)).toBe(2);
 const calls=await page.evaluate(()=>window.recovery.calls);
 const health=calls.findIndex(c=>c.cmd==='ack_update_restart_ready'&&!c.args);
 const registered=calls.findIndex(c=>c.cmd==='register_workspace');
 const bootstrap=calls.findIndex(c=>c.cmd==='ack_update_restart_ready'&&c.args?.bootstrap===true);
 expect(health).toBeGreaterThan(-1);expect(registered).toBeGreaterThan(health);expect(bootstrap).toBeGreaterThan(registered);
});
