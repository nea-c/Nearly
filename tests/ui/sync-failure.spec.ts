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
