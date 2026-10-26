import {test,expect} from '@playwright/test';
for(const language of ['ja','en'])test(`settings displays r3.7-pre.2 immediately left of close in ${language}`,async({page})=>{
  await page.addInitScript(language=>localStorage.setItem('syncfiles-v1',JSON.stringify({version:1,theme:'forest',language})),language);
  await page.goto('/');await page.locator('#settings-toggle').click();
  const version=page.locator('#settings-version'),close=page.locator('#settings-close');
  await expect(version).toHaveText('r3.7-pre.2');await expect(close).toBeVisible();
  const a=await version.boundingBox(),b=await close.boundingBox();expect(a).not.toBeNull();expect(b).not.toBeNull();
  expect(a!.x+a!.width).toBeLessThan(b!.x);expect(b!.x-a!.x-a!.width).toBeLessThanOrEqual(16);
  expect(Math.abs(a!.y+a!.height/2-b!.y-b!.height/2)).toBeLessThanOrEqual(1);
  await page.screenshot({path:`test-results/r1/settings-${language}-jade.png`});
  await close.click();await expect(page.locator('#settings-popup')).toHaveCount(0);
});
