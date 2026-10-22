import {test,expect} from '@playwright/test';

async function boot(page,theme='mint') {
  await page.addInitScript(theme=>{
    window.navigationCalls=[];
    window.__TAURI__={core:{invoke:async(cmd,args)=>{
      window.navigationCalls.push({cmd,args});
      if(cmd==='load_settings')return {version:1,language:'en',theme,profiles:[{id:'visual',name:'Visual fixture',host:'fixture.invalid',port:22,user:'fixture',mode:'sftp',auth:'key',hostKey:'pin'}],history:{}};
      if(cmd==='save_settings')return 1;
      if(cmd==='default_folder')return 'C:\\fixture';
      if(cmd==='list_drives')return [{name:'C:',path:'C:\\'}];
      if(cmd==='connect_session')return {path:'/fixture',entries:[{name:'folder',dir:true,size:0}]};
      if(cmd==='list_local'||cmd==='list_remote')return [{name:'folder',dir:true,size:0}];
      if(cmd==='run_file_operation'||cmd==='start_sync')throw Error('Unexpected write');
    }}};
  },theme);
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-parent-row=local]')).toBeVisible();
}

function luminance(rgb:string) {
  const v=rgb.match(/[\d.]+/g)!.slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);
  return v[0]*.2126+v[1]*.7152+v[2]*.0722;
}
function contrast(a:string,b:string) {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}

test('parent navigation retains the exact ordinary folder base in both panes with an upward overlay',async({page})=>{
  await boot(page);
  for(const side of ['local','remote']) {
    const parent=page.locator(`[data-parent-row=${side}] [data-entry-icon]`);
    const ordinary=page.locator(`[data-list=${side}] [data-name=folder] .folder-glyph`);
    const shape=el=>{const s=getComputedStyle(el),tab=getComputedStyle(el,'::before');return {width:s.width,height:s.height,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,tab:{width:tab.width,height:tab.height,background:tab.backgroundColor,border:tab.border,top:tab.top,left:tab.left}};};
    expect(await parent.evaluate(shape)).toEqual(await ordinary.evaluate(shape));
    await expect(parent.locator('[data-parent-arrow]')).toHaveCount(1);
    await expect(parent.locator('[data-parent-arrow]')).toBeVisible();
  }
  await page.screenshot({path:'test-results/parent-folder-repaired.png'});
});

for(const theme of ['mint','forest'])test(`${theme} navigation clearly separates disabled controls and retains disabled behavior`,async({page})=>{
  await boot(page,theme);
  const enabled=page.locator('[data-refresh=local]');
  const disabled=page.locator('[data-back=local]');
  await expect(disabled).toBeDisabled();
  const enabledColor=await enabled.evaluate(e=>getComputedStyle(e).color);
  const disabledColor=await disabled.evaluate(e=>getComputedStyle(e).color);
  expect(contrast(enabledColor,disabledColor)).toBeGreaterThanOrEqual(2.8);
  expect(disabledColor).toBe(theme==='mint'?'rgb(123, 145, 131)':'rgb(108, 133, 119)');
  if(theme==='forest')expect(luminance(disabledColor)).toBeLessThan(luminance('rgb(162, 179, 169)'));
  // f93745a: disabled navigation had transparent backgrounds/borders and no box shadow.
  const priorBox={background:'rgba(0, 0, 0, 0)',border:'rgba(0, 0, 0, 0)',shadow:'none'};
  const state=await disabled.evaluate(e=>{const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,border:s.borderColor,shadow:s.boxShadow};});
  expect({background:state.background,border:state.border,shadow:state.shadow}).toEqual(priorBox);
  await disabled.hover({force:true});
  expect(await disabled.evaluate(e=>{const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,border:s.borderColor,shadow:s.boxShadow};})).toEqual(state);
  const before=await page.evaluate(()=>window.navigationCalls.length);
  await disabled.evaluate((e:HTMLButtonElement)=>e.click());
  expect(await page.evaluate(()=>window.navigationCalls.length)).toBe(before);
  for(const action of ['back','forward','up','refresh'])for(const side of ['local','remote']) {
    const control=page.locator(`[data-${action}=${side}]`);
    const initial=await control.evaluate((e:HTMLButtonElement)=>e.disabled);
    const appearance=await control.evaluate((e:HTMLButtonElement)=>{e.disabled=true;const s=getComputedStyle(e);return{color:s.color,background:s.backgroundColor,border:s.borderColor,shadow:s.boxShadow,icon:getComputedStyle(e.querySelector('svg')!).color};});
    expect(appearance.color).toBe(disabledColor);
    expect(appearance.icon).toBe(disabledColor);
    expect({background:appearance.background,border:appearance.border,shadow:appearance.shadow}).toEqual(priorBox);
    await control.evaluate((e:HTMLButtonElement,value)=>e.disabled=value,initial);
  }
  await page.screenshot({path:`test-results/navigation-disabled-${theme}.png`});
});
