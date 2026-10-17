import { test, expect } from '@playwright/test';

test('Forest checkboxes have a contrasting visible mark, pointer and keyboard states', async ({page}) => {
  await page.goto('/');
  // The actual styles run on normal checkbox controls; no application data or
  // connection is needed to inspect the appearance contract.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'forest';
    const panel = document.createElement('section');
    panel.id = 'forest-checkbox-probe';
    panel.className = 'dialog sync-option-flags';
    panel.style.cssText = 'position:fixed;z-index:20000;top:80px;left:80px;width:420px;padding:24px';
    panel.innerHTML = '<label><input id="unchecked" type="checkbox">Off</label><label><input id="checked" type="checkbox" checked>On</label><label><input id="disabled-off" type="checkbox" disabled>Disabled off</label><label><input id="disabled-on" type="checkbox" checked disabled>Disabled on</label>';
    document.body.append(panel);
  });
  const appearance = (id:string) => page.locator(`#${id}`).evaluate(el => {
    const s=getComputedStyle(el), mark=getComputedStyle(el,'::before');
    return {appearance:s.appearance,background:s.backgroundColor,color:s.color,border:s.borderColor,mark:mark.transform,clip:mark.clipPath,outline:s.outlineStyle,outlineWidth:s.outlineWidth};
  });
  const off=await appearance('unchecked'),on=await appearance('checked');
  expect(on.appearance).toBe('none');
  expect(on.background).not.toBe(off.background);
  expect(on.color).not.toBe(on.background);
  expect(on.mark).toBe('matrix(1, 0, 0, 1, 0, 0)');
  expect(on.clip).toContain('polygon');
  expect(off.mark).toBe('matrix(0, 0, 0, 0, 0, 0)');
  await page.locator('#checked').hover();
  expect((await appearance('checked')).background).not.toBe(on.background);
  await page.locator('#unchecked').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#unchecked')).toBeChecked();
  expect(parseFloat((await appearance('unchecked')).outlineWidth)).toBeGreaterThanOrEqual(2);
  expect((await appearance('disabled-on')).mark).toBe(on.mark);
  expect((await appearance('disabled-on')).background).not.toBe((await appearance('disabled-off')).background);
  await page.screenshot({path:'test-results/forest-checkbox-states.png'});
  await page.emulateMedia({forcedColors:'active'});
  expect((await appearance('checked')).appearance).toBe('none');
  expect((await appearance('checked')).color).not.toBe((await appearance('checked')).background);
});

test('Compact stopped paths appear for pointer and keyboard focus without a permanent panel', async ({page}) => {
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme='forest';
    const actions=document.createElement('div');
    actions.className='tab-sync-actions';
    actions.innerHTML='<span class="stopped-context" tabindex="0" aria-describedby="stopped-context-paths">Stopped<span id="stopped-context-paths" class="stopped-context-paths" role="tooltip"><span>Local <code>C:\\fixture\\project</code></span><span>Remote <code>/srv/project</code></span></span></span>';
    document.querySelector('[data-pane="remote"]>header')!.prepend(actions);
  });
  const label=page.locator('.stopped-context'),tooltip=page.getByRole('tooltip');
  await expect(tooltip).toBeHidden();
  await label.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(10,10);
  await expect(tooltip).toBeHidden();
  await label.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('C:\\fixture\\project');
  await expect(tooltip).toContainText('/srv/project');
  await page.setViewportSize({width:800,height:650});
  const box=await tooltip.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(800);
  expect(await tooltip.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+5,b.y+5));})).toBe(true);
  await page.screenshot({path:'test-results/forest-stopped-tooltip.png'});
});
