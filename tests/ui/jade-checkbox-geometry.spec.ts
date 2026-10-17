import {test,expect,type Locator} from '@playwright/test';

async function inspectStates(box:Locator) {
  const samples=[];
  for(const checked of [false,true]) for(const disabled of [false,true]) {
    await box.evaluate((el:HTMLInputElement,state)=>{el.checked=state.checked;el.disabled=state.disabled;},{checked,disabled});
    if(!disabled) {await box.focus();await box.hover();}
    const colors=await box.evaluate(el=>{
      const s=getComputedStyle(el),mark=getComputedStyle(el,'::before');
      const lum=(rgb:string)=>{const c=rgb.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
      const a=lum(s.backgroundColor),b=lum(mark.backgroundColor);
      return {tickContrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),tick:mark.transform};
    });
    if(checked){expect(colors.tick).toBe('matrix(1, 0, 0, 1, 0, 0)');expect(colors.tickContrast).toBeGreaterThanOrEqual(4.5);}
    samples.push(await box.evaluate(el=>{
      const b=el.getBoundingClientRect(),s=getComputedStyle(el);
      return {width:b.width,height:b.height,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],border:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],boxSizing:s.boxSizing};
    }));
  }
  for(const sample of samples) expect(sample).toEqual({width:14,height:14,padding:['0px','0px','0px','0px'],border:['1px','1px','1px','1px'],boxSizing:'border-box'});
  await box.evaluate((el:HTMLInputElement)=>{el.disabled=false;});
}

for(const theme of ['light','dark','midnight','forest','mint']) test(`${theme} checkbox geometry is identical in real settings, sync dialog and column menu`,async({page})=>{
  await page.addInitScript(theme=>localStorage.setItem('syncfiles-v1',JSON.stringify({theme,version:1})),theme);
  await page.goto('/');
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#theme-select')).toHaveValue(theme);
  await expect(page.locator('#theme-select option[value="forest"]')).toHaveText('ジェイド');
  await inspectStates(page.locator('#compact-explorer'));
  await page.screenshot({path:`test-results/jade/${theme}-settings-checkbox.png`});
  await page.locator('#settings-close').click();
  await page.locator('#connect-form .primary').click();
  await page.locator('#prepare').click();
  for(const id of ['delete-removed','recursive-sync'])await inspectStates(page.locator(`#${id}`));
  await page.screenshot({path:`test-results/jade/${theme}-sync-checkboxes.png`});
  await page.locator('#cancel').click();
  await page.locator('[data-pane="local"] [data-column-sort="name"]').click({button:'right'});
  await expect(page.locator('.column-menu')).toBeVisible();
  for(const box of await page.locator('.column-menu input[type="checkbox"]').all())await inspectStates(box);
  await page.screenshot({path:`test-results/jade/${theme}-column-checkboxes.png`});
  await page.emulateMedia({forcedColors:'active'});
  await inspectStates(page.locator('.column-menu input[type="checkbox"]').first());
});
