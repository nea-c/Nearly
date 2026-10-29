import {test,expect} from '@playwright/test';

const controls=['#settings-toggle','#window-minimize','#window-maximize'];
async function appearance(page,selector:string,focus=false) {
  return page.locator(selector).evaluate((element,focus)=>{
    const css=getComputedStyle(element);
    return {color:css.color,background:css.backgroundColor,...(focus?{
      outlineColor:css.outlineColor,outlineStyle:css.outlineStyle,outlineWidth:css.outlineWidth,
    }:{})};
  },focus);
}

for (const theme of ['light','dark','midnight','forest','mint']) {
  test(`Settings shares caption control colors and focus in ${theme}`,async({page})=>{
    await page.addInitScript(()=>{
      (window as any).__TAURI__={core:{invoke:async(cmd:string)=>{
        if(cmd==='load_settings')return {version:1,theme:'light',language:'en',profiles:[],history:{},exclusions:{},syncOptions:{}};
        if(cmd==='default_folder')return 'C:\\generated';
        if(cmd==='list_drives'||cmd==='list_local')return [];
        if(cmd==='save_settings')return 2;
      }}};
    });
    await page.goto('/');
    await expect(page.locator('#settings-toggle')).toBeVisible();
    await expect(page.locator('#window-minimize')).toBeEnabled();
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.mouse.move(100,400);

    const normal=await appearance(page,'#window-minimize');
    for(const selector of controls) expect(await appearance(page,selector),`${theme}: normal ${selector}`).toEqual(normal);

    const hovered=[];
    for(const selector of controls) {await page.locator(selector).hover();hovered.push(await appearance(page,selector));}
    expect(hovered[0],`${theme}: Settings hover`).toEqual(hovered[1]);
    expect(hovered[0],`${theme}: maximize hover`).toEqual(hovered[2]);
    expect(hovered[0].background).not.toBe(normal.background);

    await page.mouse.move(100,400);await page.keyboard.press('Tab');
    const focused=[];
    for(const selector of controls) {
      await page.locator(selector).focus();
      expect(await page.locator(selector).evaluate(el=>el.matches(':focus-visible'))).toBe(true);
      focused.push(await appearance(page,selector,true));
    }
    expect(focused[0],`${theme}: Settings keyboard focus`).toEqual(focused[1]);
    expect(focused[0],`${theme}: maximize keyboard focus`).toEqual(focused[2]);
    expect(focused[0].outlineStyle).toBe('solid');expect(focused[0].outlineWidth).toBe('2px');

    await page.locator('#window-close').hover();
    const close=await appearance(page,'#window-close');
    expect(close.background,`${theme}: Close retains distinct danger hover`).not.toBe(hovered[0].background);
    expect(close.color).toBe('rgb(255, 255, 255)');
    const [r,g,b]=close.background.match(/\d+/g)!.slice(0,3).map(Number);
    expect(r).toBeGreaterThan(g);expect(r).toBeGreaterThan(b);

    await expect(page.locator('#settings-toggle')).toHaveAttribute('aria-expanded','false');
    await page.locator('#settings-toggle').click();
    await expect(page.locator('#settings-popup')).toBeVisible();
    await expect(page.locator('#settings-toggle')).toHaveAttribute('aria-expanded','true');
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-popup')).not.toBeVisible();
    await expect(page.locator('#settings-toggle')).toHaveAttribute('aria-expanded','false');
  });
}
