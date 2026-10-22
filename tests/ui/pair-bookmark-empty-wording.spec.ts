import {test,expect} from '@playwright/test';

async function boot(page,language:string,populated=false) {
  await page.addInitScript(({language,populated})=>{
    const profile={id:'pair-wording',name:'Fixture',host:'fixture.invalid',port:22,user:'fixture',auth:'key',mode:'sftp',hostKey:'pin'};
    const key=JSON.stringify([profile.id,profile.mode,profile.host,22,profile.user,profile.hostKey]);
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      if(cmd==='load_settings')return {version:1,theme:'light',language,profiles:[profile],history:{},folderBookmarks:populated?[{id:'pair-item',name:'Saved pair',connectionKey:key,local:'C:\\saved',remote:'/saved'}]:[]};
      if(cmd==='save_settings')return 1;
      if(cmd==='default_folder')return 'C:\\fixture';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/',entries:[]};
      if(cmd==='list_local'||cmd==='list_remote')return [];
      if(cmd==='run_file_operation'||cmd==='start_sync')throw Error('Unexpected write');
    }}};
  },{language,populated});
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('#paired-bookmarks')).toBeVisible();
}

for(const language of ['ja','en'])test(`pair empty instruction reuses the existing side wording without a hover tooltip (${language})`,async({page})=>{
  await boot(page,language);
  const empty=page.locator('#paired-bookmarks .bookmark-empty');
  const expected=language==='ja'?'右クリックでブックマークを追加':'Right-click to add bookmarks';
  await expect(empty).toHaveText(expected);
  for(const side of ['local','remote'])await expect(page.locator(`#${side}-bookmarks .bookmark-empty`)).toHaveText(expected);
  await expect(empty).not.toHaveAttribute('title');
  await empty.hover();
  await page.waitForTimeout(450);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('populated pair bookmarks retain their existing item tooltip',async({page})=>{
  await boot(page,'en',true);
  await expect(page.locator('#paired-bookmarks .bookmark-empty')).toHaveCount(0);
  await page.locator('[data-bookmark-open=pair-item]').hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toContainText('C:\\saved');
  await expect(page.getByRole('tooltip')).toContainText('/saved');
});
