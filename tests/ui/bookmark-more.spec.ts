import {test,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
for(const theme of ['light','dark'])test(`bookmark more SVG stays centered with unchanged hit area and root actions in ${theme}`,async({page})=>{
 await page.goto('/');await page.locator('#connect-form .primary').click();
 await page.locator('#settings-toggle').click();await page.locator('#theme-select').selectOption(theme);await page.locator('#settings-close').click();
 const button=page.locator('#bookmark-more');await expect(button).toBeEnabled();
 const measured=await button.evaluate(el=>{
  const b=el.getBoundingClientRect(),style=getComputedStyle(el);return {width:b.width,height:b.height,center:{x:b.x+b.width/2,y:b.y+b.height/2},title:el.title,label:el.getAttribute('aria-label'),fontSize:style.fontSize,padding:style.padding};
 });
 console.log(`MORE_MEASUREMENT_${theme} ${JSON.stringify(measured)}`);
 writeFileSync(`test-results/bookmark-more-${theme}-measurement.json`,JSON.stringify(measured,null,2));
 await expect(button.locator('svg')).toHaveCount(1);
 await expect(button.locator('svg circle')).toHaveCount(3);
 await expect(button.locator('svg')).toHaveAttribute('aria-hidden','true');
 await expect(button).toHaveAttribute('aria-label','ブックマークメニュー');
 await expect(button).toHaveAttribute('title','ブックマークメニュー');
 const geometry=await button.evaluate(el=>{
  const b=el.getBoundingClientRect(),s=el.querySelector('svg').getBoundingClientRect();
  const circles=[...el.querySelectorAll('circle')].map(c=>({x:+c.getAttribute('cx'),y:+c.getAttribute('cy'),r:+c.getAttribute('r')}));
  return {viewBox:el.querySelector('svg').getAttribute('viewBox').split(/\s+/).map(Number),width:b.width,height:b.height,dx:s.x+s.width/2-b.x-b.width/2,dy:s.y+s.height/2-b.y-b.height/2,circles};
 });
 expect(geometry.width).toBeCloseTo(24.0625,2);expect(geometry.height).toBeCloseTo(24.5,1);
 expect(Math.abs(geometry.dx)).toBeLessThanOrEqual(.5);expect(Math.abs(geometry.dy)).toBeLessThanOrEqual(.5);
 expect((geometry.circles[0].x+geometry.circles[2].x)/2).toBeCloseTo(geometry.viewBox[0]+geometry.viewBox[2]/2);expect(geometry.circles[1].y).toBeCloseTo(geometry.viewBox[1]+geometry.viewBox[3]/2);
 expect(new Set(geometry.circles.map(c=>c.y)).size).toBe(1);expect(geometry.circles[0].x).toBeLessThan(geometry.circles[1].x);expect(geometry.circles[1].x).toBeLessThan(geometry.circles[2].x);
 await button.click();await expect(page.locator('#bookmark-tree-context')).toBeVisible();
 expect(await page.locator('#bookmark-tree-context [data-bookmark-action]').evaluateAll(es=>es.map(e=>e.getAttribute('data-bookmark-action')))).toEqual(['register','create','history']);
 await button.click();await expect(page.locator('#bookmark-tree-context')).toHaveCount(0);
 // The same outer hit area remains clickable near its left edge.
 await button.click({position:{x:2,y:geometry.height/2}});await expect(page.locator('#bookmark-tree-context')).toBeVisible();
 await page.keyboard.press('Escape');await button.focus();await expect(button).toBeFocused();
 await page.screenshot({path:`test-results/bookmark-more-${theme}.png`});
});
