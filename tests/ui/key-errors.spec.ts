import {test,expect} from '@playwright/test';
const fixtureMessage='パスフレーズまたは鍵ファイルを確認してください';
async function boot(page,theme='light',language='ja'){
 await page.addInitScript(({theme,language})=>{
  window.calls=[];window.rejections=[];window.nextError={kind:'keyUnlockFailed',message:'Check the passphrase or key file'};
  const profiles=['a','b'].map(id=>({id,name:id,host:id+'.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',keyFile:'generated.ppk',hostKey:'SHA256:fixture'}));
  window.__TAURI__={core:{invoke:async(cmd,args)=>{
   window.calls.push({cmd,args});
   if(cmd==='load_settings')return{version:1,theme,language,profiles,history:{}};
   if(cmd==='default_folder')return'C:\\fixture';
   if(cmd==='connect_session'){
    if(window.holdConnection)return new Promise((_,reject)=>window.rejections.push(reject));
    throw window.nextError;
   }
  }}};
 },{theme,language});await page.goto('/');await expect(page.locator('#connect-form')).toBeVisible();
}
for(const language of ['ja','en'])for(const theme of ['light','dark','midnight'])test('reserved inline key slot preserves geometry and retry input in '+theme+' '+language,async({page})=>{
 await boot(page,theme,language);const expected=language==='ja'?fixtureMessage:'Check the passphrase or key file';const input=page.locator('[name=passphrase]');
 await expect(page.locator('#passphrase-error')).toBeAttached();
 const before=await page.locator('#connect-form').evaluate(form=>{
  window.originalKeyForm=form;window.originalKeyInput=form.querySelector('[name=passphrase]');
  return [...form.querySelectorAll('[name=passphrase],.actions,.primary')].map(n=>n.getBoundingClientRect().toJSON());
 });
 await input.fill('synthetic-secret');await input.press('Enter');
 await expect(page.locator('#passphrase-error')).toHaveText(expected);
 await expect(page.locator('#connect-form > .form-error')).toBeEmpty();
 await expect(input).toBeFocused();await expect(input).toHaveValue('');await expect(input).toHaveAttribute('aria-invalid','true');
 const after=await page.locator('#connect-form').evaluate(form=>({same:form===window.originalKeyForm&&form.querySelector('[name=passphrase]')===window.originalKeyInput,boxes:[...form.querySelectorAll('[name=passphrase],.actions,.primary')].map(n=>n.getBoundingClientRect().toJSON())}));
 expect(after.same).toBe(true);expect(after.boxes).toEqual(before);await page.screenshot({path:'test-results/key-error-'+language+'-'+theme+'.png'});
 expect(await page.evaluate(()=>window.calls.filter(c=>['save_settings','start_sync','run_file_operation'].includes(c.cmd)))).toEqual([]);
 await input.fill('corrected');await expect(page.locator('#passphrase-error')).toBeEmpty();await expect(input).not.toHaveAttribute('aria-invalid','true');
 await page.evaluate(()=>window.holdConnection=true);await input.press('Enter');
 await expect(page.locator('#passphrase-error')).toBeEmpty();await expect(input).toBeDisabled();
 await page.evaluate(()=>window.rejections[0]({kind:'other',message:'Opaque network failure'}));
 await expect(page.locator('#connect-form > .form-error')).toHaveText('Opaque network failure');
 await expect(page.locator('#passphrase-error')).toBeEmpty();
});
test('plain authentication text and structured other remain generic; profile edits clear old inline errors',async({page})=>{
 await boot(page);
 for(const error of ['Incorrect passphrase',{kind:'other',message:'Incorrect passphrase'},{kind:'other',message:'Host key mismatch'}]){
  await page.evaluate(error=>window.nextError=error,error);await page.locator('#connect-form .primary').click();
  await expect(page.locator('#connect-form > .form-error')).toHaveText(typeof error==='string'?error:error.message);
  await expect(page.locator('#passphrase-error')).toBeEmpty();
 }
 await page.evaluate(()=>window.nextError={kind:'keyUnlockFailed',message:'Check the passphrase or key file'});
 await page.locator('#connect-form .primary').click();await expect(page.locator('#passphrase-error')).toHaveText(fixtureMessage);
 await page.locator('[data-connection-select=b]').click();await expect(page.locator('#passphrase-error')).toBeEmpty();
 await page.locator('[data-connection-select=a]').click();await expect(page.locator('#passphrase-error')).toBeEmpty();
});
test('pending connection retains tab guard and cancellation suppresses a late inline failure',async({page})=>{
 await boot(page);await page.locator('#add-tab').click();
 await page.locator('.tab').first().click();await page.evaluate(()=>window.holdConnection=true);
 await page.locator('[name=passphrase]').fill('synthetic');await page.locator('#connect-form .primary').click();
 await expect(page.locator('#connect-cancel')).toBeEnabled();
 await page.locator('.tab').last().click();await expect(page.locator('[role=tab]').first()).toHaveAttribute('aria-selected','true');
 await expect(page.locator('[name=passphrase]')).toBeDisabled();await page.locator('#connect-cancel').click();
 await page.evaluate(()=>window.rejections[0]({kind:'keyUnlockFailed',message:'Check the passphrase or key file'}));
 await expect(page.locator('#connect-form .primary')).toBeEnabled();await expect(page.locator('#passphrase-error')).toBeEmpty();
 await page.locator('.tab').last().click();await expect(page.locator('[role=tab]').last()).toHaveAttribute('aria-selected','true');await expect(page.locator('#passphrase-error')).toBeEmpty();
});
test('adversarial replacement form ignores late failure and retains replacement focus',async({page})=>{
 await boot(page);await page.evaluate(()=>window.holdConnection=true);
 await page.locator('#connect-form .primary').click();await expect(page.locator('#connect-cancel')).toBeEnabled();
 // No production transition currently permits replacement while connecting.
 // Explicit DOM replacement tests the async owner guard without weakening it.
 await page.locator('#connect-form').evaluate(form=>{
  const replacement=document.createElement('form');replacement.id='connect-form';
  const input=document.createElement('input');input.id='replacement-input';replacement.append(input);form.replaceWith(replacement);input.focus();
 });
 await page.evaluate(()=>window.rejections[0]({kind:'keyUnlockFailed',message:'Check the passphrase or key file'}));
 await expect(page.locator('#replacement-input')).toBeFocused();await expect(page.locator('#passphrase-error')).toHaveCount(0);
});
