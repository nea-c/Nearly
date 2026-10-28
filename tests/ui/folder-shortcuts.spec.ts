import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const profile = { id: 'shortcut', name: 'Fixture', mode: 'sftp', host: 'fixture.invalid', port: 22, user: 'test', auth: 'key', hostKey: 'pin' };
    w.shortcutCalls = []; w.shortcutError = ''; w.shortcutHold = false;
    w.releaseShortcuts = {}; w.returnedShortcuts = [];
    w.__TAURI__ = { core: { invoke: async (cmd: string, args: any) => {
      w.shortcutCalls.push({ cmd, args });
      if (cmd === 'load_settings') return { version: 1, language: 'en', profiles: [profile], history: {} };
      if (cmd === 'save_settings') { w.shortcutSettings = args.data; return; }
      if (cmd === 'default_folder') return 'C:\\fixture';
      if (cmd === 'list_drives') return [{ name: 'C:', path: 'C:\\' }, { name: 'D:', path: 'D:\\' }];
      if (cmd === 'connect_session') return { path: '/', entries: [{ name: 'remote.lnk', dir: false, size: 10 }] };
      if (cmd === 'list_remote') return [];
      if (cmd === 'list_local') return args.path === 'C:\\fixture' ? [
        { name: 'ordinary', dir: true, size: 0 },
        { name: 'folder.LNK', dir: false, size: 100 },
        { name: 'second.lnk', dir: false, size: 100 },
        { name: 'note.txt', dir: false, size: 10 },
      ] : [];
      if (cmd === 'resolve_local_folder_shortcut') {
        if (w.shortcutHold) await new Promise(resolve => { w.releaseShortcut = resolve; w.releaseShortcuts[args.path] = resolve; });
        if (w.shortcutError) throw Error(w.shortcutError);
        w.returnedShortcuts.push(args.path);
        return args.path.endsWith('second.lnk') ? 'E:\\second' : 'D:\\target';
      }
    } } };
  });
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('[data-pane=local]')).toHaveAttribute('aria-busy', 'false');
});
const link = (page: any) => page.locator('[data-pane=local] [data-entry][data-name="folder.LNK"]');
const resolutions = (page: any) => page.evaluate(() => (window as any).shortcutCalls.filter((c: any) => c.cmd === 'resolve_local_folder_shortcut'));

test('single click selects shortcut without resolving or navigating', async ({ page }) => {
  await link(page).click();
  await expect(link(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
  expect(await resolutions(page)).toEqual([]);
});
for (const action of ['double-click', 'Enter']) test(`folder shortcut ${action} navigates and participates in Back/Forward history`, async ({ page }) => {
  if (action === 'double-click') await link(page).dblclick(); else await link(page).press('Enter');
  await expect(page.locator('#local-path')).toHaveValue('D:\\target');
  expect(await resolutions(page)).toEqual([{ cmd: 'resolve_local_folder_shortcut', args: { path: 'C:\\fixture\\folder.LNK' } }]);
  await page.locator('[data-back=local]').click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
  await page.locator('[data-forward=local]').click();
  await expect(page.locator('#local-path')).toHaveValue('D:\\target');
  await expect(page.locator('#remote-path')).toHaveValue('/');
});
test('ordinary folders still open; plain files and remote shortcuts are not resolved', async ({ page }) => {
  await page.locator('[data-pane=local] [data-name="note.txt"]').dblclick();
  await page.locator('[data-pane=remote] [data-name="remote.lnk"]').press('Enter');
  expect(await resolutions(page)).toEqual([]);
  await page.locator('[data-pane=local] [data-entry][data-name=ordinary]').dblclick();
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture\\ordinary');
  expect(await resolutions(page)).toEqual([]);
});
test('failed resolution leaves location and history unchanged and permits retry', async ({ page }) => {
  await page.evaluate(() => { (window as any).shortcutError = 'Folder shortcut target is unavailable or is not a folder'; });
  await link(page).dblclick();
  await expect(page.locator('.notice')).toContainText('Folder shortcut target is unavailable or is not a folder');
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
  await expect(page.locator('[data-back=local]')).toBeDisabled();
  await page.evaluate(() => { (window as any).shortcutError = ''; });
  await link(page).press('Enter');
  await expect(page.locator('#local-path')).toHaveValue('D:\\target');
});
test('a late resolver result cannot replace deliberate navigation', async ({ page }) => {
  await page.evaluate(() => { (window as any).shortcutHold = true; });
  await link(page).dblclick();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseShortcut)).toBe('function');
  await page.locator('[data-pane=local] [data-entry][data-name=ordinary]').dblclick();
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture\\ordinary');
  await page.evaluate(() => { (window as any).releaseShortcut(); });
  await expect.poll(() => page.evaluate(() => (window as any).returnedShortcuts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).shortcutCalls.filter((c: any) => c.cmd === 'list_local' && c.args.path === 'D:\\target').length)).toBe(0);
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture\\ordinary');
});

for (const order of ['first-request-first', 'second-request-first']) test(`latest shortcut activation wins when ${order}`, async ({ page }) => {
  await page.evaluate(() => { (window as any).shortcutHold = true; });
  await link(page).press('Enter');
  await page.locator('[data-pane=local] [data-entry][data-name="second.lnk"]').press('Enter');
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).releaseShortcuts).length)).toBe(2);
  const first = order === 'first-request-first' ? 'folder.LNK' : 'second.lnk';
  const second = order === 'first-request-first' ? 'second.lnk' : 'folder.LNK';
  await page.evaluate(name => { (window as any).releaseShortcuts['C:\\fixture\\' + name](); }, first);
  await expect.poll(() => page.evaluate(() => (window as any).returnedShortcuts.length)).toBe(1);
  await expect(page.locator('#local-path')).toHaveValue(order === 'first-request-first' ? 'C:\\fixture' : 'E:\\second');
  await page.evaluate(name => { (window as any).releaseShortcuts['C:\\fixture\\' + name](); }, second);
  await expect.poll(() => page.evaluate(() => (window as any).returnedShortcuts.length)).toBe(2);
  await expect(page.locator('#local-path')).toHaveValue('E:\\second');
});

for (const returnFirst of [false, true]) test(`a late shortcut result cannot navigate a switched tab (return first: ${returnFirst})`, async ({ page }) => {
  await page.evaluate(() => { (window as any).shortcutHold = true; });
  await link(page).press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseShortcut)).toBe('function');
  await page.keyboard.press('Control+t');
  await page.locator('#connect-form .primary').click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
  if (returnFirst) await page.locator('[role=tab]').first().click();
  await page.evaluate(() => { (window as any).releaseShortcut(); });
  await expect.poll(() => page.evaluate(() => (window as any).returnedShortcuts.length)).toBe(1);
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
  if (!returnFirst) await page.locator('[role=tab]').first().click();
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture');
});
