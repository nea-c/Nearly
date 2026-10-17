import { test, expect } from '@playwright/test';
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{
    const profile={id:'layout',name:'Nearly fixture',host:'fixture.invalid',port:22,user:'test',mode:'sftp',auth:'key',hostKey:'pin'};
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      if(cmd==='load_settings')return {version:1,profiles:[profile],history:{}};
      if(cmd==='default_folder')return 'C:\\root';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'},{name:'D:',path:'D:\\'}];
      const entries=[{name:'alpha',dir:true,size:0},{name:'hidden-folder',dir:true,size:0,hidden:true},{name:'A long document name.txt',dir:false,size:2048,modifiedAt:1720000000}];
      if(cmd==='connect_session')return {path:'/',entries};
      if(cmd==='list_local'||cmd==='list_remote') {if(args.path.includes('missing'))throw Error('Folder cannot be read');return args.path.endsWith('alpha')?[]:entries;}
    }}};
  });
  await page.goto('/');await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy','false');
});
test('folder labels and full rows browse and open context menus while only chevrons expand',async({page})=>{
  for(const side of ['local','remote']){
    const path=side==='local'?'C:\\root\\alpha':'/alpha';
    const row=page.locator(`[data-tree-row=${side}]`).filter({has:page.locator(`[data-tree-select=${side}]`)}).filter({hasText:'alpha'});
    const item=row.locator('..');
    expect((await row.boundingBox()).x).toBe((await page.locator(`[data-tree=${side}]`).boundingBox()).x);
    await expect(item).toHaveAttribute('aria-expanded','false');
    await row.click({position:{x:(await row.boundingBox()).width-3,y:12}});
    await expect(page.locator(`#${side}-path`)).toHaveValue(path);
    await expect(item).toHaveAttribute('aria-expanded','false');
    await row.locator('[data-tree-select]').press('ArrowRight');
    await row.locator('[data-tree-select]').dblclick();
    await expect(item).toHaveAttribute('aria-expanded','false');
    await row.click({button:'right',position:{x:(await row.boundingBox()).width-3,y:12}});
    await expect(page.locator('.file-menu')).toBeVisible();await page.keyboard.press('Escape');
    await row.locator('.tree-toggle').click();await expect(item).toHaveAttribute('aria-expanded','true');
    await row.locator('.tree-toggle').click();await expect(item).toHaveAttribute('aria-expanded','false');
  }
});
test('workspace fills window edges and bottom notices remain above the status bar in both themes',async({page})=>{
  for(const theme of ['light','dark']) for(const width of [800,1180]){
    await page.setViewportSize({width,height:width===800?650:850});
    await page.locator('#settings-toggle').click();await page.locator('#theme-select').selectOption(theme);await page.locator('#settings-close').click();
    const geometry=await page.locator('.panes').evaluate(e=>{const r=e.getBoundingClientRect(),status=document.querySelector('.statusbar').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,status:status.top,width:innerWidth}});
    expect(geometry.left).toBe(0);expect(geometry.right).toBe(geometry.width);expect(geometry.bottom).toBe(geometry.status);
    await page.screenshot({path:`test-results/nearly-workspace-${theme}-${width}.png`});
  }
  await page.locator('#remote-path').fill('/missing');await page.locator('#remote-path').press('Enter');
  await expect(page.locator('main>.notice')).toContainText('Folder cannot be read');
  const positions=await page.evaluate(()=>({notice:document.querySelector('main>.notice').getBoundingClientRect().bottom,status:document.querySelector('.statusbar').getBoundingClientRect().top}));
  expect(positions.notice).toBe(positions.status);
  await page.screenshot({path:'test-results/nearly-bottom-notice-dark.png'});
});
