import { sideBookmarkAction } from './bookmark-context';
import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page) {
  await page.addInitScript(() => {
    const profile = {id:'policy', name:'Saved profile', mode:'sftp', host:'fixture.invalid', port:22, user:'fixture', auth:'key', keyFile:'generated.ppk', hostKey:'pin'};
    const key = JSON.stringify([profile.id,profile.mode,profile.host,profile.port,profile.user,profile.hostKey]);
    const settings = {version:1, language:'en', profiles:[profile], history:{'["policy","/old"]':'C:\\old'}, browseLocations:{},
      localBookmarks:[{id:'local',name:'Saved bookmark',path:'C:\\saved'}], remoteBookmarks:[],
      folderBookmarks:[{id:'pair',name:'Saved pair',local:'C:\\saved',remote:'/saved',connectionKey:key}]};
    (window as any).policyCalls=[];
    (window as any).policySettings=JSON.stringify(settings);
    const entries=[{name:'one.txt',dir:false,size:1},{name:'two.ZIP',dir:false,size:2}];
    (window as any).__TAURI__={core:{invoke:async(cmd:string,args:any)=>{
      (window as any).policyCalls.push({cmd,args});
      if(cmd==='load_settings')return settings;
      if(cmd==='default_folder')return 'C:\\fixture';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries};
      if(cmd==='list_local'||cmd==='list_remote')return entries;
      if(cmd==='save_settings')return 2;
    }}};
  });
  await page.goto('/');
  await expect(page.locator('#connect-form')).toBeVisible();
}

async function policy(page: Page, root: string) {
  await expect.poll(() => page.locator(root).evaluate(node => [...node.querySelectorAll('form,input,textarea'), ...(node.matches('form,input,textarea')?[node]:[])]
    .filter(field => field.getAttribute('autocomplete')!=='off'||field.matches('input[list]')).map(field=>field.id||field.getAttribute('name')||field.tagName))).toEqual([]);
}

test('initial connection fields and dynamic connection/profile forms suppress suggestions without changing saved values',async({page})=>{
  await boot(page);
  await policy(page,'#connect-form');
  await expect(page.locator('[name=passphrase]')).toHaveAttribute('type','password');
  await page.locator('[data-connection-node=policy]').click({button:'right'});
  await page.locator('[data-menu-action=rename]').click();
  await policy(page,'#connection-node-form');
  await expect(page.locator('#connection-node-name')).toHaveValue('Saved profile');
  await page.keyboard.press('Escape');
  await page.locator('[data-connection-node=policy]').click({button:'right'});
  await page.locator('[data-menu-action=add-profile]').click();
  await policy(page,'#profile-form');
  const settings=await page.evaluate(()=>JSON.parse((window as any).policySettings));
  expect(settings.profiles[0].name).toBe('Saved profile');
  expect(settings.history).toEqual({'["policy","/old"]':'C:\\old'});
  expect(settings.localBookmarks[0].path).toBe('C:\\saved');
  const saves=await page.evaluate(()=>(window as any).policyCalls.filter((c:any)=>c.cmd==='save_settings').map((c:any)=>c.args.data));
  for(const saved of saves) {
    expect(saved.profiles).toEqual(settings.profiles);
    expect(saved.history).toEqual(settings.history);
    expect(saved.localBookmarks).toEqual(settings.localBookmarks);
    expect(saved.folderBookmarks).toEqual(settings.folderBookmarks);
  }
});

test('bookmark, create, archive and file transfer dialogs receive policy on repeated insertion',async({page})=>{
  await boot(page);await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
  await policy(page,'#app');
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
  for(let repeat=0;repeat<2;repeat++) {
    await sideBookmarkAction(page,'local','add');
    await policy(page,'#side-bookmark-dialog');
    await expect(page.locator('#side-bookmark-path')).toHaveValue('C:\\fixture');
    await page.keyboard.press('Escape');
    await page.locator('.bookmark-bar').click({button:'right',position:{x:2,y:2}});await page.locator('[data-bookmark-action=register]').click();
    await policy(page,'#bookmark-form');await page.keyboard.press('Escape');
  }
  for(const action of ['createfile','compress','duplicate','move']) {
    await page.locator('[data-list=local] [data-name="one.txt"]').click({button:'right'});
    await page.locator(`[data-file-action=${action}]`).click();
    await expect(page.locator('[role=dialog]')).toBeVisible();
    await policy(page,'[role=dialog]');
    await page.locator('#create-entry-cancel,#archive-cancel,#file-operation-cancel').click();
    await expect(page.locator('[role=dialog]')).toHaveCount(0);
  }
});

test('late form attributes and datalist bindings are repaired without clearing nodes, values or focus',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{
    const form=document.createElement('form');form.id='late-policy';
    form.innerHTML='<input id="late-field" value="Preserved 日本語" autocomplete="email" list="kept-history"><textarea>Kept notes</textarea><datalist id="kept-history"><option value="Preserved history"></datalist>';
    document.body.append(form);
    (window as any).lateField=form.querySelector('input');
    (window as any).lateForm=form;
    form.querySelector('input')!.focus();
  });
  await policy(page,'#late-policy');
  await expect(page.locator('#late-field')).toHaveValue('Preserved 日本語');
  await expect(page.locator('#late-field')).toBeFocused();
  await expect(page.locator('#kept-history option')).toHaveAttribute('value','Preserved history');
  await expect(page.locator('#late-policy textarea')).toHaveValue('Kept notes');
  await page.evaluate(()=>{
    document.querySelector('#late-field')!.setAttribute('autocomplete','username');
    document.querySelector('#late-field')!.setAttribute('list','kept-history');
    document.querySelector('#late-policy')!.setAttribute('autocomplete','on');
  });
  await policy(page,'#late-policy');
  expect(await page.evaluate(()=>document.querySelector('#late-field')===(window as any).lateField&&document.querySelector('#late-policy')===(window as any).lateForm)).toBe(true);
  const mutations=await page.evaluate(async()=>{
    let count=0;const observer=new MutationObserver(records=>count+=records.length);
    observer.observe(document.querySelector('#late-policy')!,{subtree:true,attributes:true});
    await new Promise(resolve=>setTimeout(resolve,80));observer.disconnect();return count;
  });
  expect(mutations).toBe(0);
});

test('normal typing and synthetic Japanese composition preserve input, selection and uncancelled events',async({page})=>{
  await boot(page);
  const field=page.locator('[name=passphrase]');
  await field.fill('synthetic');await field.press('End');await page.keyboard.type('-typed');
  await expect(field).toHaveValue('synthetic-typed');
  const composition=await field.evaluate((input:HTMLInputElement)=>{
    const events:Event[]=[];
    const fire=(event:Event)=>{events.push(event);input.dispatchEvent(event);};
    input.setSelectionRange(0,input.value.length);
    fire(new CompositionEvent('compositionstart',{bubbles:true,cancelable:true,data:''}));
    fire(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Process',isComposing:true}));
    fire(new CompositionEvent('compositionupdate',{bubbles:true,cancelable:true,data:'にほん'}));
    fire(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertCompositionText',data:'日本語',isComposing:true}));
    input.setRangeText('日本語',0,input.value.length,'end');
    fire(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'日本語',isComposing:true}));
    fire(new CompositionEvent('compositionend',{bubbles:true,cancelable:true,data:'日本語'}));
    return {cancelled:events.filter(event=>event.defaultPrevented).map(event=>event.type),value:input.value,start:input.selectionStart,end:input.selectionEnd};
  });
  expect(composition).toEqual({cancelled:[],value:'日本語',start:3,end:3});
  await policy(page,'#connect-form');await expect(field).toHaveValue('日本語');await expect(field).toBeFocused();
  const persisted=await page.evaluate(()=>JSON.stringify((window as any).policyCalls.filter((c:any)=>c.cmd==='save_settings')));
  expect(persisted).not.toContain('synthetic');expect(persisted).not.toContain('日本語');
});

test('policy installs on prepopulated DOM, scans only inserted subtrees and can be disposed',async({page})=>{
  await page.goto('/drag-preview.html');
  const result=await page.evaluate(async()=>{
    const {installInputPolicy}=await import('/src/input-policy.ts');
    const form=document.createElement('form');form.autocomplete='on';
    form.innerHTML='<input value="Keep" list="kept"><input type="password" value="synthetic-only"><textarea>Notes</textarea><input type="checkbox" checked><datalist id="kept"><option value="Retain"></datalist>';
    document.body.append(form);
    localStorage.setItem('input-policy-sentinel','untouched');
    const inputs=[...form.querySelectorAll('input,textarea')];
    let fullScans=0;const query=document.querySelectorAll;
    document.querySelectorAll=function(...args:Parameters<typeof query>){fullScans++;return query.apply(this,args);} as typeof query;
    const dispose=installInputPolicy(document);
    const initialScans=fullScans;
    fullScans=0;
    const inserted=document.createElement('section');inserted.innerHTML='<input autocomplete="email" value="Late">';
    document.body.append(inserted);
    const late=inserted.querySelector('input')!;late.focus();
    const synchronousFocusPolicy=late.autocomplete;
    for(let i=0;i<100;i++){inserted.className='unrelated-'+i;inserted.append(document.createElement('span'));}
    await new Promise(resolve=>setTimeout(resolve,20));
    const scanCount=fullScans;
    dispose();document.querySelectorAll=query;
    const disposed=document.createElement('input');disposed.autocomplete='email';disposed.setAttribute('list','kept');document.body.append(disposed);disposed.focus();
    await new Promise(resolve=>setTimeout(resolve,20));
    return {initialScans,scanCount,synchronousFocusPolicy,fields:inputs.map(field=>({same:field.isConnected,value:field.value,autocomplete:field.autocomplete,list:field.getAttribute('list')})),
      checked:(inputs[3] as HTMLInputElement).checked,form:form.autocomplete,option:form.querySelector('option')!.value,
      storage:localStorage.getItem('input-policy-sentinel'),disposed:{autocomplete:disposed.autocomplete,list:disposed.getAttribute('list')}};
  });
  expect(result.initialScans).toBe(1);expect(result.scanCount).toBe(0);expect(result.synchronousFocusPolicy).toBe('off');
  expect(result.fields.map(field=>field.value)).toEqual(['Keep','synthetic-only','Notes','on']);
  expect(result.fields.every(field=>field.same&&field.autocomplete==='off'&&field.list===null)).toBe(true);
  expect(result.checked).toBe(true);expect(result.form).toBe('off');expect(result.option).toBe('Retain');expect(result.storage).toBe('untouched');
  expect(result.disposed).toEqual({autocomplete:'email',list:'kept'});
});
