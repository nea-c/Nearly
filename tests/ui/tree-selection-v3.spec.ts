import { test, expect } from '@playwright/test';
import { boot, expand, go, treeControl } from './transfer-v2-fixture';

const selected = (page: import('@playwright/test').Page, side: string) => page.locator(`[data-tree=${side}] [role=treeitem][aria-selected=true] > [data-tree-row].selected`);

for (const language of ['ja', 'en']) for (const theme of ['light', 'dark', 'midnight', 'forest', 'mint'])
test(`visible folder selection follows collapse and panel reopening ${language} ${theme}`, async ({ page }) => {
  await boot(page, language);
  await page.locator('#settings-toggle').click();
  await page.locator('#theme-select').selectOption(theme);
  await page.locator('#settings-close').click();
  for (const side of ['local', 'remote']) {
    if (side === 'local') { await expand(page, side, '@pc'); await expand(page, side, 'C:\\'); }
    const parent = side === 'local' ? 'C:\\root' : '/';
    const current = parent + (side === 'local' ? '\\' : '') + 'directory-089';
    await expand(page, side, parent); await go(page, side, current);
    await expect(selected(page, side)).toHaveAttribute('data-tree-path', current);
    await treeControl(page, side, parent, 'toggle').click();
    await expect(selected(page, side)).toHaveCount(1);
    await expect(selected(page, side)).toHaveAttribute('data-tree-path', parent);
    await page.locator(`[data-tree-visibility=${side}]`).click();
    await page.locator(`[data-tree-visibility=${side}]`).click();
    await expect(selected(page, side)).toHaveAttribute('data-tree-path', parent);
    await treeControl(page, side, parent, 'toggle').click();
    await expect(selected(page, side)).toHaveAttribute('data-tree-path', current);
    await page.locator('#' + side + '-path').focus();
    await expect(selected(page, side)).toHaveAttribute('data-tree-path', current);
    await expect(page.locator('#' + side + '-path')).toHaveValue(current);
    expect(await treeControl(page, side, current).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
  }
});

test('selection updates after held tree loading even after focus cancellation', async ({ page }) => {
  await boot(page); await go(page, 'remote', '/directory-089/directory-001'); await expand(page, 'remote', '/');
  const parent = '/directory-089', current = parent + '/directory-001';
  await page.evaluate(parent => {
    const original = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args: any) => {
      if (cmd === 'list_remote' && args.path === parent) await new Promise(resolve => (window as any).releaseSelectionTree = resolve);
      return original(cmd, args);
    };
  }, parent);
  await expect(selected(page, 'remote')).toHaveAttribute('data-tree-path', parent);
  await treeControl(page, 'remote', parent, 'toggle').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseSelectionTree)).toBe('function');
  await page.locator('#local-path').focus();
  await page.evaluate(() => (window as any).releaseSelectionTree());
  await expect(selected(page, 'remote')).toHaveAttribute('data-tree-path', current);
  await expect(page.locator('#local-path')).toBeFocused();
});

test('vertical tree reveal preserves horizontal offsets of nested scroll containers', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const { scrollTreeVertically } = await import('/src/tree-focus.ts');
    const outer = document.createElement('div'); outer.style.cssText = 'position:fixed;left:10px;top:10px;width:180px;height:120px;overflow:auto;z-index:99999';
    const content = document.createElement('div'); content.style.cssText = 'width:700px;height:700px;padding-top:300px';
    const inner = document.createElement('div'); inner.style.cssText = 'width:300px;height:100px;overflow:auto;margin-left:220px';
    const rows = document.createElement('div'); rows.style.cssText = 'width:900px;height:600px;padding-top:420px';
    const target = document.createElement('button'); target.textContent = 'deep folder'; target.style.marginLeft = '650px';
    rows.append(target); inner.append(rows); content.append(inner); outer.append(content); document.body.append(outer);
    outer.scrollLeft = 130; inner.scrollLeft = 240;
    const ancestors: Element[] = []; for (let el: Element | null = target.parentElement; el; el = el.parentElement) ancestors.push(el);
    const before = ancestors.map(el => el.scrollLeft);
    target.focus({ preventScroll: true }); scrollTreeVertically(target);
    const after = ancestors.map(el => el.scrollLeft), top = [outer.scrollTop, inner.scrollTop]; outer.remove();
    return { before, after, top };
  });
  expect(result.after).toEqual(result.before);
  expect(result.top.every(top => top > 0)).toBe(true);
});

test('committed navigation selects its visible ancestor without stealing focus on async completion', async ({ page }) => {
  await boot(page); await expand(page, 'remote', '/'); await go(page, 'remote', '/directory-001');
  await page.evaluate(() => {
    const original = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args: any) => {
      if (cmd === 'list_remote' && args.path === '/directory-089/child') await new Promise(resolve => (window as any).releaseNavigationSelection = resolve);
      return original(cmd, args);
    };
  });
  await page.locator('#remote-path').fill('/directory-089/child'); await page.locator('#remote-path').press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseNavigationSelection)).toBe('function');
  await expect(selected(page, 'remote')).toHaveAttribute('data-tree-path', '/directory-001');
  await page.locator('#local-path').focus(); await page.evaluate(() => (window as any).releaseNavigationSelection());
  await expect(selected(page, 'remote')).toHaveAttribute('data-tree-path', '/directory-089');
  await expect(page.locator('#local-path')).toBeFocused();
  await expect(treeControl(page, 'remote', '/directory-089', 'toggle').locator('xpath=../..')).toHaveAttribute('aria-expanded', 'false');
});

test('panel reopening and keyboard reveal preserve the actual tree horizontal offset', async ({ page }) => {
  await boot(page); await expand(page, 'remote', '/');
  const current = '/' + 'long-folder-'.repeat(35); await go(page, 'remote', current);
  const before = await page.locator('[data-tree=remote]').evaluate(el => { el.scrollLeft = 160; return el.scrollLeft; });
  expect(before).toBeGreaterThan(0);
  // Dispatch directly so the test driver cannot reveal the button horizontally.
  await page.locator('[data-tree-visibility=remote]').evaluate((el: HTMLButtonElement) => el.click());
  await page.locator('[data-tree-visibility=remote]').evaluate((el: HTMLButtonElement) => el.click());
  await expect(selected(page, 'remote')).toHaveAttribute('data-tree-path', current);
  await expect.poll(() => page.locator('[data-tree=remote]').evaluate(el => el.scrollLeft)).toBe(before);
  await page.keyboard.press('Home');
  await expect(treeControl(page, 'remote', '/')).toBeFocused();
  expect(await page.locator('[data-tree=remote]').evaluate(el => el.scrollLeft)).toBe(before);
});

test('panel hide captures horizontal scrolling before its queued scroll event', async ({ page }) => {
  await boot(page); await expand(page, 'remote', '/');
  await go(page, 'remote', '/' + 'long-folder-'.repeat(35));
  const before = await page.evaluate(() => {
    const tree = document.querySelector<HTMLElement>('[data-tree=remote]')!;
    tree.scrollLeft = 160;
    const left = tree.scrollLeft;
    document.querySelector<HTMLButtonElement>('[data-tree-visibility=remote]')!.click();
    document.querySelector<HTMLButtonElement>('[data-tree-visibility=remote]')!.click();
    return left;
  });
  expect(before).toBeGreaterThan(0);
  await expect.poll(() => page.locator('[data-tree=remote]').evaluate(el => el.scrollLeft)).toBe(before);
});
