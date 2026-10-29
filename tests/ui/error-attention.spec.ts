import{test,expect,type Page}from'@playwright/test';
async function setup(page:Page,start=true){await page.addInitScript(()=>{
 const profile={id:'generated',name:'Generated fixture',host:'fixture.invalid',port:22,user:'dummy',auth:'key',mode:'sftp',keyFile:'',hostKey:'dummy'};
 const f=(window as any).attentionFixture={focused:false,flashing:false,signals:[] as boolean[],requests:[] as any[],failConnect:false,failStart:false,pollError:false,holdStop:false,releaseStop:null as any,status:{status:'running',syncPhase:'caught_up',pending:0,sent:0,speed:0,latency:0,errorCount:0,logs:[],stopComplete:false}};
 (window as any).__TAURI__={core:{invoke:async(c:string,a:any={})=>{
 if(c==='load_settings')return{version:1,language:'en',settingsRevision:0,profiles:[profile],history:{}};
 if(c==='save_settings')return{...a.data,settingsRevision:1};if(c==='default_folder')return'C:\\dummy';if(c==='list_drives'||c==='list_local'||c==='list_remote')return[];
 if(c==='connect_session'){if(f.failConnect)throw Error('Generated connect failure');return{path:'/',entries:[]};}
 if(c==='start_sync'){if(f.failStart)throw Error('Generated start failure');return;}
 if(c==='sync_status'){if(f.pollError)throw Error('Generated status failure');return structuredClone(f.status);}
 if(c==='stop_sync'){if(f.holdStop)return await new Promise(resolve=>f.releaseStop=()=>resolve({knownUnreflected:true}));return{knownUnreflected:true};}
 if(c==='request_error_attention'){f.requests.push(a);if(a.active&&!f.focused){f.flashing=true;f.signals.push(true);}else if(!a.active){f.flashing=false;f.signals.push(false);}return;}
 return undefined;
 }}};
 });await page.goto('/');if(start){await page.locator('#connect-form .primary').click();await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await expect(page.locator('#start-form')).toHaveCount(0);}}
const count=(p:Page)=>p.evaluate(()=>(window as any).attentionFixture.signals.filter((v:boolean)=>v).length);
const fail=(p:Page,n:number)=>p.evaluate(n=>Object.assign((window as any).attentionFixture.status,{status:'failed',syncPhase:'error',errorCount:n}),n);
const focus=(p:Page)=>p.evaluate(()=>{(window as any).attentionFixture.focused=true;window.dispatchEvent(new Event('focus'));});
test('focus and repeated caught-up snapshots preserve completion presentation',async({page})=>{
 await setup(page);await expect(page.locator('#sync-state')).toContainText('Up to date');
 await expect(page.locator('.status-summary .status-icon')).toHaveClass(/sync-complete/);
 const label=await page.locator('#sync-state').textContent();
 await focus(page);await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
 await page.waitForTimeout(1600);
 await expect(page.locator('#sync-state')).toHaveText(label!);
 await expect(page.locator('.status-summary .status-icon')).toHaveClass(/sync-complete/);
 expect(await count(page)).toBe(0);
});

test('new sync errors request once; focus clears attention but keeps failure; later errors rearm',async({page})=>{
 await setup(page);await fail(page,1);await expect.poll(()=>count(page)).toBe(1);await page.waitForTimeout(1600);expect(await count(page)).toBe(1);
 const failureLabel=await page.locator('#sync-state').textContent();
 await focus(page);await expect.poll(()=>page.evaluate(()=>(window as any).attentionFixture.flashing)).toBe(false);await expect(page.locator('#sync-state')).toHaveText(failureLabel!);
 await page.waitForTimeout(900);expect(await count(page)).toBe(1);await page.evaluate(()=>(window as any).attentionFixture.focused=false);await fail(page,2);await expect.poll(()=>count(page)).toBe(2);
 await focus(page);await fail(page,3);await page.waitForTimeout(900);expect(await count(page)).toBe(2);await expect(page.locator('.status-summary .status-icon')).toHaveAttribute('data-state','error');
 const args=await page.evaluate(()=>(window as any).attentionFixture.requests);expect(args.every((a:any)=>Object.keys(a).join(',')==='active')).toBe(true);
});
test('different windows receive and clear only their own attention',async({context})=>{
 const a=await context.newPage(),b=await context.newPage();await setup(a);await setup(b);await fail(a,1);await expect.poll(()=>count(a)).toBe(1);expect(await count(b)).toBe(0);
 await focus(b);expect(await a.evaluate(()=>(window as any).attentionFixture.flashing)).toBe(true);await focus(a);expect(await a.evaluate(()=>(window as any).attentionFixture.status.status)).toBe('failed');expect(await count(b)).toBe(0);
});
test('explicit connection and native start failures notify, repeated painting does not',async({page})=>{
 await setup(page,false);await page.evaluate(()=>(window as any).attentionFixture.failConnect=true);await page.locator('#connect-form .primary').click();await expect.poll(()=>count(page)).toBe(1);await page.waitForTimeout(900);expect(await count(page)).toBe(1);
 await page.locator('#connect-form .primary').click();await expect.poll(()=>count(page)).toBe(2);
 await page.evaluate(()=>{const f=(window as any).attentionFixture;f.failConnect=false;f.failStart=true;});await page.locator('#connect-form .primary').click();await page.locator('#prepare').click();await page.locator('#start-form .primary').click();await expect.poll(()=>count(page)).toBe(3);
});

test('status polling error notifies while native stop is pending',async({page})=>{
 await setup(page);await page.evaluate(()=>{const f=(window as any).attentionFixture;f.pollError=true;f.holdStop=true;});
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).attentionFixture.releaseStop)).toBe('function');
 await expect.poll(()=>count(page)).toBe(1);
 await focus(page);await expect.poll(()=>page.evaluate(()=>(window as any).attentionFixture.flashing)).toBe(false);
 await page.evaluate(()=>(window as any).attentionFixture.releaseStop());
 await expect(page.locator('.status-summary .status-icon')).toHaveAttribute('data-state','error');
 await page.waitForTimeout(900);expect(await count(page)).toBe(1);
});
