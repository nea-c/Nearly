import { test, expect, type Page } from '@playwright/test';

// Real dialogs and ownership/refresh handling; only the native IPC boundary is faked.
async function setup(page: Page, mode = 'sftp', language = 'en') {
  await page.addInitScript(({ mode, language }) => {
    const w = window as any;
    w.calls = []; w.hold = false; w.holdPrepare = false; w.failure = '';
    const profile = { id: 'duplicate', name: 'Fixture', host: 'fixture.invalid', port: 22, user: 'fixture', auth: 'key', mode, hostKey: 'pin' };
    const entries = [{ name: 'folder', dir: true, size: 0 }, { name: 'one.txt', dir: false, size: 1 }, { name: 'keep.txt', dir: false, size: 2 }];
    w.__TAURI__ = { core: { invoke: async (cmd, args) => {
      w.calls.push({ cmd, args });
      if (cmd === 'load_settings') return { version: 1, settingsRevision: 1, profiles: [profile], history: {}, theme: 'light', language };
      if (cmd === 'save_settings') return 2;
      if (cmd === 'default_folder') return 'C:\\fixture';
      if (cmd === 'list_drives') return [{ path: 'C:\\', name: 'C:' }];
      if (cmd === 'connect_session') return { path: '/', entries };
      if (cmd === 'list_local' || cmd === 'list_remote') return entries;
      if (cmd === 'prepare_file_operation' && w.holdPrepare) await new Promise(r => w.releasePrepare = r);
      if (cmd === 'run_file_operation') {
        if (w.hold) await new Promise(r => w.release = r);
        if (w.failure) throw w.failure;
        return { completed: 1, message: 'done' };
      }
    } } };
  }, { mode, language });
  await page.goto('/');
  await page.locator('#connect-form .primary').click();
  for (const side of ['local', 'remote']) await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy', 'false');
}
async function duplicate(page: Page, side: string, name = 'one.txt') {
  await page.locator(`[data-list=${side}] [data-name="${name}"]`).click({ button: 'right' });
  await page.locator('[data-file-action=duplicate]').click();
}
const requests = (page: Page) => page.evaluate(() => (window as any).calls.filter(c => c.cmd === 'run_file_operation').map(c => c.args.request));

for (const fixture of [
  { side: 'local', folder: 'D:\\copies', target: 'D:\\copies\\renamed.txt', source: 'C:\\fixture\\one.txt', parent: 'C:\\fixture' },
  { side: 'remote', folder: '/copies', target: '/copies/renamed.txt', source: '/one.txt', parent: '/' },
]) {
  test(`${fixture.side} Duplicate sends chosen name and directory, preserves frozen source`, async ({ page }) => {
    await setup(page); await duplicate(page, fixture.side);
    await expect(page.getByLabel('Duplicate name', { exact: true })).toHaveValue('one.txt');
    await expect(page.getByLabel('Existing destination directory', { exact: true })).toHaveValue(fixture.parent);
    await page.locator('[name=operation-destination]').fill('renamed.txt');
    await page.locator('[name=operation-folder]').fill(fixture.folder);
    await expect(page.locator('.operation-dialog .target')).toHaveCount(0);
    await page.locator('#file-operation-confirm').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.locator('[role=dialog]')).toHaveCount(0);
    await expect.poll(async () => (await requests(page)).length).toBe(1);
    expect((await requests(page))[0]).toMatchObject({ side: fixture.side, action: 'copy', source: fixture.source, destination: fixture.target, confirmDelete: false });
    if (fixture.side === 'remote') expect((await requests(page))[0].profile).toMatchObject({ id: 'duplicate', host: 'fixture.invalid', mode: 'sftp' });
  });

  test(`${fixture.side} directory Duplicate defaults beside source and cancel sends nothing`, async ({ page }) => {
    await setup(page, 'sftp', 'ja'); await duplicate(page, fixture.side, 'folder');
    await expect(page.locator('[name=operation-folder]')).toHaveValue(fixture.parent);
    await expect(page.locator('.operation-dialog .target')).toHaveCount(0);
    await page.locator('#file-operation-cancel').click();
    expect(await requests(page)).toEqual([]);
  });

  test(`${fixture.side} invalid duplicate names and destination traversal stay editable without dispatch`, async ({ page }) => {
    await setup(page); await duplicate(page, fixture.side);
    for (const [name, folder] of [['../bad', fixture.folder], ['copy.txt', 'relative'], ['copy.txt', fixture.side === 'local' ? 'C:\\copies\\..\\elsewhere' : '/copies/../elsewhere'], ['copy.txt', '']]) {
      await page.locator('[name=operation-destination]').fill(name);
      await page.locator('[name=operation-folder]').fill(folder);
      await page.locator('#file-operation-confirm').click();
      await expect(page.locator('.operation-dialog .operation-results')).not.toBeEmpty();
      await expect(page.locator('[name=operation-folder]')).toBeEditable();
      expect(await requests(page)).toEqual([]);
    }
  });
}

test('duplicate collision remains an explicit failure without overwrite or retry', async ({ page }) => {
  await setup(page); await duplicate(page, 'local');
  await page.locator('[name=operation-folder]').fill('D:\\copies');
  await page.evaluate(() => (window as any).failure = 'Destination already exists; overwrite is unsupported');
  await page.locator('#file-operation-confirm').click();
  await expect(page.locator('.operation-feedback')).toContainText('overwrite');
  expect(await requests(page)).toHaveLength(1);
  expect((await requests(page))[0].destination).toBe('D:\\copies\\one.txt');
  expect((await requests(page))[0]).not.toHaveProperty('overwrite');
});

test('held duplicate completion keeps later navigation and selection', async ({ page }) => {
  await setup(page); await page.evaluate(() => (window as any).hold = true);
  await duplicate(page, 'local'); await page.locator('[name=operation-folder]').fill('D:\\copies');
  await page.locator('#file-operation-confirm').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).release)).toBe('function');
  await page.locator('[data-list=local] [data-name=folder]').dblclick();
  await page.locator('[data-list=local] [data-name="keep.txt"]').click();
  await page.evaluate(() => (window as any).release());
  await expect(page.locator('[data-feedback-close]')).toBeEnabled();
  await expect(page.locator('#local-path')).toHaveValue('C:\\fixture\\folder');
  await expect(page.locator('[data-list=local] [data-name="keep.txt"]')).toHaveAttribute('aria-selected', 'true');
  expect((await requests(page))[0].source).toBe('C:\\fixture\\one.txt');
});

test('cancel during duplicate prepare prevents copy dispatch', async ({ page }) => {
  await setup(page); await page.evaluate(() => (window as any).holdPrepare = true);
  await duplicate(page, 'remote'); await page.locator('[name=operation-folder]').fill('/copies');
  await page.locator('#file-operation-confirm').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).releasePrepare)).toBe('function');
  await page.locator('#file-operation-cancel').click();
  await page.evaluate(() => (window as any).releasePrepare());
  await expect(page.locator('[data-feedback-close]')).toBeEnabled();
  expect(await requests(page)).toEqual([]);
});
