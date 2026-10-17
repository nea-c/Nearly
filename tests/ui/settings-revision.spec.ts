import {test,expect} from '@playwright/test';
async function setup(page,uncertain=false){
 await page.addInitScript(({uncertain})=>{
  window.calls=[];
  window.__TAURI__={core:{invoke:async(cmd,args)=>{
   window.calls.push({cmd,args});
   if(cmd==='load_settings'){
    if(!localStorage.getItem('revision-settings'))localStorage.setItem('revision-settings',JSON.stringify({version:1,settingsRevision:5,profiles:[{id:'fixture',name:'Fixture',host:'fixture.invalid',port:2222,user:'fixture',mode:'sftp',auth:'key',keyFile:'fixture.ppk',hostKey:''}],history:{},theme:'light'}));
    return JSON.parse(localStorage.getItem('revision-settings'));
   }
   if(cmd==='save_settings'){
    const saved=JSON.parse(localStorage.getItem('revision-settings'));
    if(args.data.settingsRevision!==saved.settingsRevision)throw Error('settings revision conflict');
    const revision=saved.settingsRevision+1;localStorage.setItem('revision-settings',JSON.stringify({...args.data,settingsRevision:revision}));return revision;
   }
   if(cmd==='default_folder')return 'C:\\fixture';
   if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
   if(cmd==='list_local'||cmd==='list_remote')return [];
   if(cmd==='probe_host_key')return {requestId:args.requestId,token:'fixture-token',host:args.profile.host,port:args.profile.port,algorithm:'ssh-ed25519',fingerprint:'SHA256:fixture-candidate',expiresInSeconds:120};
   if(cmd==='approve_host_key'){
    const saved=JSON.parse(localStorage.getItem('revision-settings'));
    if(!uncertain&&args.expectedRevision!==saved.settingsRevision)throw Error('approval revision conflict');
    const profile={...args.profile,hostKey:'SHA256:fixture-candidate'};
    saved.profiles=saved.profiles.map(p=>p.id===profile.id?profile:p);saved.settingsRevision++;
    if(uncertain){saved.theme='dark';saved.localPaneRatio=.62;}
    localStorage.setItem('revision-settings',JSON.stringify(saved));
    if(uncertain)throw Error('approval outcome needs reload');
    return {...profile,settingsRevision:saved.settingsRevision};
   }
   if(cmd==='connect_session')throw Error('unexpected network connection');
  }}};
 },{uncertain});
 await page.goto('/');await expect(page.locator('#connect-form')).toBeVisible();
}
async function theme(page,value){await page.locator('#settings-toggle').click();await page.locator('#theme-select').selectOption(value);await page.locator('#settings-close').click();}
async function approve(page){await page.locator('#connect-form .primary').click();await expect(page.locator('#host-key-approve')).toBeVisible();await page.locator('#host-key-approve').click();}
const calls=(page,cmd)=>page.evaluate(cmd=>window.calls.filter(c=>c.cmd===cmd),cmd);
test('saved revisions flow into subsequent settings and host approval without entering profiles',async({page})=>{
 await setup(page);await theme(page,'dark');
 await expect.poll(async()=> (await calls(page,'save_settings')).length).toBe(1);
 expect((await calls(page,'save_settings'))[0].args.data.settingsRevision).toBe(5);
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('revision-settings')).settingsRevision)).toBe(6);
 await theme(page,'light');
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('revision-settings')).settingsRevision)).toBe(7);
 expect((await calls(page,'save_settings'))[1].args.data.settingsRevision).toBe(6);
 await approve(page);await expect(page.locator('#host-key-overlay')).toHaveCount(0);
 expect((await calls(page,'approve_host_key'))[0].args.expectedRevision).toBe(7);
 await theme(page,'dark');
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('revision-settings')).settingsRevision)).toBe(9);
 const last=(await calls(page,'save_settings')).at(-1).args.data;
 expect(last.settingsRevision).toBe(8);expect(last.profiles[0].hostKey).toBe('SHA256:fixture-candidate');expect(last.profiles[0]).not.toHaveProperty('settingsRevision');
 expect(await calls(page,'connect_session')).toEqual([]);expect(await calls(page,'start_sync')).toEqual([]);
});
test('uncertain approval reload refuses unrelated disk edits instead of adopting a stale revision',async({page})=>{
 await setup(page,true);await approve(page);
 await expect(page.locator('#host-key-overlay .form-error')).toContainText('approval outcome');
 await page.locator('#host-key-reload').click();
 await expect(page.locator('#host-key-overlay .form-error')).toContainText('再起動');
 await expect(page.locator('#host-key-overlay')).toBeVisible();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('revision-settings')));
 expect(saved.settingsRevision).toBe(6);expect(saved.theme).toBe('dark');expect(saved.localPaneRatio).toBe(.62);
 expect(await calls(page,'save_settings')).toEqual([]);expect(await calls(page,'connect_session')).toEqual([]);
});
