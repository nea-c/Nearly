import {test,expect,type Page} from '@playwright/test';

// Browser coverage of the native IPC contract; no sockets, keys or real files.
async function boot(page:Page,language:'ja'|'en'='ja'){
  await page.addInitScript(({language})=>{
    const profile={id:'generated',name:'Generated fixture',host:'fixture.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',keyFile:'',hostKey:'generated-pin'};
    const running=()=>({status:'running',pending:0,sent:0,speed:0,latency:0,errorCount:0,logs:[],failure:null,stopComplete:false});
    const fixture=(window as any).syncFailureFixture={calls:[] as any[],status:running(),pollError:false,failStop:false};
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any={})=>{
      fixture.calls.push({cmd,args});
      if(cmd==='load_settings')return{version:1,settingsRevision:0,language,profiles:[profile],history:{}};
      if(cmd==='save_settings')return{...args.data,settingsRevision:(args.data.settingsRevision??0)+1};
      if(cmd==='default_folder')return'C:\\generated';
      if(cmd==='list_drives')return[{path:'C:\\',name:'C:'}];
      if(cmd==='connect_session')return{path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return[];
      if(cmd==='start_sync'){fixture.status=running();return;}
      if(cmd==='sync_status'){if(fixture.pollError)throw Error('Status lock failed');return structuredClone(fixture.status);}
      if(cmd==='stop_sync'){if(fixture.failStop)throw Error('Generated stop outcome uncertain');return{knownUnreflected:true};}
      if(cmd==='retry_sync')throw Error('Automatic retry must never be invoked');
      return undefined;
    }}};
  },{language});
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  await page.locator('#prepare').click();
  await page.locator('#start-form .primary').click();
  await expect(page.locator('#start-form')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>(window as any).syncFailureFixture.calls.filter((call:any)=>call.cmd==='sync_status').length)).toBeGreaterThan(0);
}
async function fail(page:Page,stopComplete=false){
  await page.evaluate(({stopComplete})=>{
    (window as any).syncFailureFixture.status={status:'failed',pending:3,sent:0,speed:0,latency:0,errorCount:1,stopComplete,
      logs:Array(100).fill('Skipped unchanged generated.txt'),
      failure:{relativePath:'folder/<img src=x onerror=alert(1)> $&.txt',operation:'compare',reason:'Local source changed',commitState:'unknown',pending:3,requiresRescan:true}};
  },{stopComplete});
  await expect(page.locator('#error-count')).toContainText('1');
  await page.locator('#error-count').click();
}
for(const theme of ['light','dark'])for(const language of ['ja','en'] as const){
 test(`completed paths and actual activity are clear in ${theme} ${language}`,async({page},testInfo)=>{
  await boot(page,language);
  const path='generated/deep/'.repeat(12)+'日本語 <img src=x> $&.txt';
  await page.evaluate(({theme,path})=>{document.documentElement.dataset.theme=theme;Object.assign((window as any).syncFailureFixture.status,{syncPhase:'scanning',pending:0,logs:['Uploaded '+path,'Skipped unchanged keep.txt','Created remote directory generated']});},{theme,path});
  await expect(page.locator('.status-summary .dot')).toHaveClass(/sync-active/);
  await expect(page.locator('.tab .dot')).toHaveClass(/sync-active/);
  await expect(page.locator('#sync-state')).toHaveText(language==='ja'?'走査中':'Scanning');
  await page.locator('#toggle-logs').click();
  const success=page.locator('.logs .log-upload');await expect(success).toHaveCount(1);
  await expect(success.locator('strong')).toHaveText(language==='ja'?'アップロード完了':'Upload complete');
  await expect(success.locator('code')).toHaveText(path);await expect(success.locator('code')).toHaveAttribute('title',path);await expect(success.locator('img')).toHaveCount(0);
  expect(await success.locator('code').evaluate(e=>getComputedStyle(e).overflowWrap)).toBe('anywhere');
  const labelStyle=await success.locator('strong').evaluate(e=>{
   const fg=getComputedStyle(e).color;let parent=e.parentElement,bg='';
   while(parent){const c=getComputedStyle(parent).backgroundColor;if(c!=='transparent'&&c!=='rgba(0, 0, 0, 0)'){bg=c;break;}parent=parent.parentElement;}
   const lum=(s:string)=>{const channels=s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{const n=v/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4;});return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;};
   const a=lum(fg),b=lum(bg);return {color:fg,background:bg,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
  });
  // Dark uses the existing semantic success token; light uses its readable fallback.
  expect(labelStyle.color).toBe(theme==='dark'?'rgb(142, 213, 181)':'rgb(19, 115, 51)');
  expect(labelStyle.contrast).toBeGreaterThanOrEqual(4.5);
  expect(await success.locator('code').evaluate(e=>getComputedStyle(e).color)).not.toBe(labelStyle.color);
  expect(await success.locator('code').evaluate(e=>getComputedStyle(e).userSelect)).toBe('text');
  await testInfo.attach('success-label-contrast',{body:JSON.stringify({theme,language,...labelStyle}),contentType:'application/json'});
  const color=await page.locator('.status-summary .dot').evaluate(e=>getComputedStyle(e).color);
  expect(color).toBe(theme==='dark'?'rgb(85, 214, 250)':'rgb(0, 124, 170)');
  await page.screenshot({path:testInfo.outputPath(`sync-${theme}-${language}.png`)});
  await page.evaluate(()=>{Object.assign((window as any).syncFailureFixture.status,{syncPhase:'working',pending:2});});
  await expect(page.locator('#sync-state')).toHaveText(language==='ja'?'同期中':'Syncing');
  await page.evaluate(()=>{Object.assign((window as any).syncFailureFixture.status,{syncPhase:'caught_up',pending:0});});
  await expect(page.locator('.status-summary .dot')).toHaveClass(/sync-complete/);
  await expect(page.locator('.tab .dot')).toHaveClass(/sync-complete/);
  await expect(page.locator('#sync-state')).toHaveText(language==='ja'?'同期済み・監視中':'Up to date · watching');
  await page.evaluate(()=>{Object.assign((window as any).syncFailureFixture.status,{syncPhase:'stopping',status:'stopping'});});
  await expect(page.locator('.status-summary .dot')).toHaveClass(/sync-paused/);
  await page.evaluate(()=>{Object.assign((window as any).syncFailureFixture.status,{syncPhase:'stopped',status:'stopped'});});
  await expect(page.locator('.status-summary .dot')).toHaveClass(/off/);
 });
}

test('suspended deletion basis is a rescan notice, keeps running and requires manual restart',async({page})=>{
  await boot(page,'en');
  await page.evaluate(()=>(window as any).syncFailureFixture.status.deletionRescanRequired=true);
  await expect(page.locator('#sync-state')).toContainText('Deletion tracking needs a new scan');
  await expect(page.locator('#error-count')).toContainText('0');
  await page.locator('#toggle-logs').click();
  await expect(page.locator('#sync-failure-details')).toContainText('Uploads can continue');
  await expect(page.locator('#sync-failure-details')).toContainText('stop sync and start it again');
  await expect(page.locator('#retry')).toBeDisabled();
  const calls=await page.evaluate(()=>(window as any).syncFailureFixture.calls);
  expect(calls.filter((c:any)=>c.cmd==='stop_sync'||c.cmd==='retry_sync')).toHaveLength(0);
  expect(calls.filter((c:any)=>c.cmd==='start_sync')).toHaveLength(1);
  await page.evaluate(()=>(window as any).syncFailureFixture.status.deletionRescanRequired=false);
  await expect(page.locator('#sync-state')).not.toContainText('Deletion tracking needs a new scan');
  await expect(page.locator('#sync-failure-details')).toBeEmpty();
});

test('Japanese deletion rescan notice explains manual full restart without an error',async({page})=>{
  await boot(page,'ja');
  await page.evaluate(()=>(window as any).syncFailureFixture.status.deletionRescanRequired=true);
  await expect(page.locator('#sync-state')).toContainText('削除同期の再走査が必要');
  await expect(page.locator('#error-count')).toContainText('0');
  await page.locator('#toggle-logs').click();
  await expect(page.locator('#sync-failure-details')).toContainText('アップロードは継続できます');
  await expect(page.locator('#sync-failure-details')).toContainText('同期を停止してから再度開始');
  await expect(page.locator('#sync-failure-details')).toContainText('自動で基準を更新することはありません');
  await expect(page.locator('#retry')).toBeDisabled();
});

test('Japanese failure detail survives mixed logs, escapes paths and waits for confirmed stop',async({page})=>{
  await boot(page);await fail(page);
  const details=page.locator('#sync-failure-details');
  await expect(details).toContainText('完了未確認');
  await expect(details).toContainText('folder/<img src=x onerror=alert(1)> $&.txt');
  await expect(details).toContainText('差分比較');
  await expect(details).toContainText('対象への反映結果は不明');
  await expect(details.locator('img')).toHaveCount(0);
  await expect(page.locator('.logs li')).toHaveCount(100);
  await expect(details).not.toContainText('Local source changed');
  await page.evaluate(()=>(window as any).syncFailureFixture.status.stopComplete=true);
  await expect(details).toContainText('同期を停止しました');
  await expect(details).not.toContainText('完了未確認');
});

test('review and resume stops the old job then requires confirmation for a fresh job',async({page})=>{
  await boot(page,'en');await fail(page,true);
  const oldId=await page.evaluate(()=>(window as any).syncFailureFixture.calls.find((call:any)=>call.cmd==='start_sync').args.id);
  await page.locator('#retry').click();
  await expect(page.locator('#start-form')).toBeVisible();
  const before=await page.evaluate(()=>(window as any).syncFailureFixture.calls);
  expect(before.filter((call:any)=>call.cmd==='start_sync')).toHaveLength(1);
  expect(before.filter((call:any)=>call.cmd==='stop_sync')).toHaveLength(1);
  expect(before.filter((call:any)=>call.cmd==='retry_sync')).toHaveLength(0);
  await page.locator('#start-form .primary').click();
  await expect(page.locator('#start-form')).toHaveCount(0);
  const starts=await page.evaluate(()=>(window as any).syncFailureFixture.calls.filter((call:any)=>call.cmd==='start_sync'));
  expect(starts).toHaveLength(2);expect(starts[1].args.id).not.toBe(oldId);
  expect(starts[1].args.local).toBe(starts[0].args.local);expect(starts[1].args.remote).toBe(starts[0].args.remote);
});

test('failed stop after status error stays latched even if the backend later reports running',async({page})=>{
  await boot(page,'en');
  await page.evaluate(()=>{const fixture=(window as any).syncFailureFixture;fixture.failStop=true;fixture.pollError=true;});
  await expect(page.locator('#error-count')).toContainText('1');
  await page.locator('#error-count').click();
  const details=page.locator('#sync-failure-details');
  await expect(details).toContainText('completion unconfirmed');
  await expect(details).toContainText('Status lock failed');
  await expect(details).toContainText('Generated stop outcome uncertain');
  const count=await page.evaluate(()=>(window as any).syncFailureFixture.calls.filter((call:any)=>call.cmd==='sync_status').length);
  await page.evaluate(()=>(window as any).syncFailureFixture.pollError=false);
  await page.waitForTimeout(1700);
  expect(await page.evaluate(()=>(window as any).syncFailureFixture.calls.filter((call:any)=>call.cmd==='sync_status').length)).toBe(count);
  expect(await page.evaluate(()=>(window as any).syncFailureFixture.calls.filter((call:any)=>call.cmd==='stop_sync').length)).toBe(1);
  await expect(details).toContainText('completion unconfirmed');
});
