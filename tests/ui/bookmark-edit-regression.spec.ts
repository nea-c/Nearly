import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, theme = 'light') {
  await page.addInitScript(({ theme }) => {
    const p = { id: 'edit', name: 'Fixture', mode: 'sftp', host: 'fixture.invalid', port: 22, user: 'test', auth: 'key', hostKey: 'pin' };
    const key = JSON.stringify([p.id, p.mode, p.host, p.port, p.user, p.hostKey]);
    const otherKey = JSON.stringify(['other', p.mode, 'other.invalid', p.port, p.user, p.hostKey]);
    const initial = { version: 1, language: 'en', theme, profiles: [p], history: {},
      folderBookmarks: [
        { id: 'pair', name: 'Original <pair>', local: 'C:\\saved', remote: '/saved', connectionKey: key },
        { id: 'neighbor', name: 'Neighbor', local: 'D:\\neighbor', remote: '/neighbor', connectionKey: key },
        { id: 'foreign', name: 'Foreign', local: 'E:\\foreign', remote: '/foreign', connectionKey: otherKey },
      ],
      bookmarkTree: { version: 1, nodes: [
        { id: 'group', kind: 'group', name: 'Group', parentId: null, connectionKey: key },
        { id: 'pair', kind: 'bookmark', bookmarkId: 'pair', parentId: 'group', connectionKey: key },
        { id: 'neighbor', kind: 'bookmark', bookmarkId: 'neighbor', parentId: null, connectionKey: key },
        { id: 'foreign', kind: 'bookmark', bookmarkId: 'foreign', parentId: null, connectionKey: otherKey },
      ] },
      localBookmarks: [{ id: 'local', name: 'Local', path: 'C:\\local' }],
      remoteBookmarks: [{ id: 'remote', name: 'Remote', path: '/remote', connectionKey: key }],
    };
    const w = window as any;
    w.editCalls = []; w.failEditSave = false;
    w.__TAURI__ = { core: { invoke: async (cmd: string, args: any) => {
      w.editCalls.push({ cmd, args });
      if (cmd === 'load_settings') return JSON.parse(localStorage.getItem('bookmark-edit-fixture') || 'null') || initial;
      if (cmd === 'save_settings') {
        if (w.failEditSave) throw Error('Fixture save refused');
        localStorage.setItem('bookmark-edit-fixture', JSON.stringify(args.data)); return;
      }
      if (cmd === 'default_folder') return 'C:\\browse';
      if (cmd === 'list_drives') return [{ name: 'C:', path: 'C:\\' }];
      if (cmd === 'connect_session') return { path: '/', entries: [] };
      if (cmd === 'list_local' || cmd === 'list_remote') return [];
    } } };
  }, { theme });
  await page.goto('/');
  await connect(page);
}
async function connect(page: Page) {
  await page.locator('#connect-form .primary').click();
  for (const side of ['local', 'remote']) await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy', 'false');
}
async function editPair(page: Page, expected = { name: 'Original <pair>', local: 'C:\\saved', remote: '/saved' }) {
  await page.locator('.bookmark-bar [data-bookmark-group=group]').click();
  await page.locator('[data-bookmark-folder-menu=group] [data-bookmark-open=pair]').click({ button: 'right' });
  await expect(page.locator('#bookmark-tree-context [data-bookmark-action=edit]')).toBeVisible();
  await page.locator('#bookmark-tree-context [data-bookmark-action=edit]').click();
  await expect(page.locator('#bookmark-name')).toHaveValue(expected.name);
  await expect(page.locator('#bookmark-local')).toHaveValue(expected.local);
  await expect(page.locator('#bookmark-remote')).toHaveValue(expected.remote);
}
const snapshot = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('bookmark-edit-fixture')!));

test('paired context edit loads saved values, cancels, persists exact identity and survives reload', async ({ page }) => {
  await boot(page);
  const before = await snapshot(page);
  for (const close of ['cancel', 'escape', 'close']) {
    await editPair(page);
    await page.locator('#bookmark-name').fill('Discarded');
    await page.locator('#bookmark-local').fill('C:\\discarded');
    await page.locator('#bookmark-remote').fill('/discarded');
    if (close === 'escape') await page.keyboard.press('Escape');
    else await page.locator(close === 'cancel' ? '#bookmark-cancel' : '#bookmark-close').click();
    await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
    expect((await snapshot(page)).folderBookmarks).toEqual(before.folderBookmarks);
  }
  await editPair(page);
  await page.locator('#bookmark-name').fill('Renamed <pair>');
  await page.locator('#bookmark-local').fill('D:\\edited');
  await page.locator('#bookmark-remote').fill('/edited');
  await page.locator('#bookmark-save').click();
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
  const saved = await snapshot(page);
  expect(saved.folderBookmarks).toEqual(before.folderBookmarks.map((b: any) => b.id === 'pair' ? { ...b, name: 'Renamed <pair>', local: 'D:\\edited', remote: '/edited' } : b));
  expect(saved.bookmarkTree).toEqual(before.bookmarkTree);
  expect(saved.localBookmarks).toEqual(before.localBookmarks);
  expect(saved.remoteBookmarks).toEqual(before.remoteBookmarks);
  await expect(page.locator('#local-path')).toHaveValue('C:\\browse');
  await expect(page.locator('#remote-path')).toHaveValue('/');
  expect(await page.evaluate(() => (window as any).editCalls.filter((c: any) => ['start_sync', 'delete_files', 'rename_file'].includes(c.cmd)))).toEqual([]);
  await page.reload(); await connect(page);
  await editPair(page, { name: 'Renamed <pair>', local: 'D:\\edited', remote: '/edited' });
  await page.locator('#bookmark-name').fill('Edited twice');
  await page.locator('#bookmark-local').fill('E:\\second');
  await page.locator('#bookmark-remote').fill('/second');
  await page.locator('#bookmark-save').click();
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
  await editPair(page, { name: 'Edited twice', local: 'E:\\second', remote: '/second' });
  await page.locator('#bookmark-cancel').click();
  const twice = await snapshot(page);
  expect(twice.folderBookmarks).toEqual(before.folderBookmarks.map((b: any) => b.id === 'pair' ? { ...b, name: 'Edited twice', local: 'E:\\second', remote: '/second' } : b));
  expect(twice.bookmarkTree).toEqual(before.bookmarkTree);
});

test('root paired bookmark opens edit from keyboard context without opening folders', async ({ page }) => {
  await boot(page);
  const before = await snapshot(page);
  const item = page.locator('.bookmark-bar [data-bookmark-open=neighbor]');
  await item.focus();
  await page.keyboard.press('Shift+F10');
  await page.locator('#bookmark-tree-context [data-bookmark-action=edit]').click();
  await expect(page.locator('#bookmark-name')).toHaveValue('Neighbor');
  await expect(page.locator('#bookmark-local')).toHaveValue('D:\\neighbor');
  await expect(page.locator('#bookmark-remote')).toHaveValue('/neighbor');
  await page.locator('#bookmark-cancel').click();
  expect((await snapshot(page)).folderBookmarks).toEqual(before.folderBookmarks);
  await expect(page.locator('#local-path')).toHaveValue('C:\\browse');
  await expect(page.locator('#remote-path')).toHaveValue('/');
});

test('paired history edit failed save preserves data and allows retry and metadata-only deletion', async ({ page }) => {
  await boot(page);
  const before = await snapshot(page);
  await page.locator('.bookmark-bar').click({ button: 'right', position: { x: 2, y: 2 } });
  await page.locator('[data-bookmark-action=history]').click();
  await page.locator('[data-bookmark-edit="0"]').click();
  await expect(page.locator('#bookmark-name')).toHaveValue('Original <pair>');
  await page.locator('#bookmark-name').fill('Retry name');
  await page.locator('#bookmark-local').fill('D:\\retry');
  await page.locator('#bookmark-remote').fill('/retry');
  await page.evaluate(() => { (window as any).failEditSave = true; });
  await page.locator('#bookmark-save').click();
  await expect(page.locator('#bookmark-overlay .form-error')).toContainText('Fixture save refused');
  await expect(page.locator('#bookmark-save')).toBeEnabled();
  expect((await snapshot(page)).folderBookmarks).toEqual(before.folderBookmarks);
  await expect(page.locator('#bookmark-local')).toHaveValue('D:\\retry');
  await expect(page.locator('#bookmark-remote')).toHaveValue('/retry');
  await page.evaluate(() => { (window as any).failEditSave = false; });
  await page.locator('#bookmark-save').click();
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
  expect((await snapshot(page)).folderBookmarks.find((b: any) => b.id === 'pair').name).toBe('Retry name');
  await page.locator('.bookmark-bar').click({ button: 'right', position: { x: 2, y: 2 } });
  await page.locator('[data-bookmark-action=history]').click();
  await page.locator('[data-bookmark-edit="0"]').click();
  await expect(page.locator('#bookmark-local')).toHaveValue('D:\\retry');
  await expect(page.locator('#bookmark-remote')).toHaveValue('/retry');
  await page.locator('#bookmark-delete').click();
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
  const saved = await snapshot(page);
  expect(saved.folderBookmarks).toEqual(before.folderBookmarks.filter((b: any) => b.id !== 'pair'));
  expect(saved.bookmarkTree.nodes).toEqual(before.bookmarkTree.nodes.filter((n: any) => n.id !== 'pair'));
});

test('paired path validation rejects invalid and duplicate pairs without publishing changes', async ({ page }) => {
  await boot(page);
  const before = await snapshot(page);
  await editPair(page);
  for (const [local, remote] of [['relative', '/valid'], ['C:\\valid', '../invalid'], ['D:\\neighbor', '/neighbor']]) {
    await page.locator('#bookmark-local').fill(local);
    await page.locator('#bookmark-remote').fill(remote);
    await page.locator('#bookmark-save').click();
    await expect(page.locator('#bookmark-overlay .form-error')).not.toBeEmpty();
    await expect(page.locator('#bookmark-save')).toBeEnabled();
    expect((await snapshot(page)).folderBookmarks).toEqual(before.folderBookmarks);
  }
  await page.locator('#bookmark-local').fill('');
  await page.locator('#bookmark-save').click();
  expect(await page.locator('#bookmark-local').evaluate((e: HTMLInputElement) => e.validity.valueMissing)).toBe(true);
  await page.locator('#bookmark-cancel').click();
  expect((await snapshot(page)).folderBookmarks).toEqual(before.folderBookmarks);
});

for (const theme of ['light', 'dark', 'midnight', 'forest', 'mint']) test(`edit delete buttons match destructive menu in ${theme}, including hover and keyboard focus`, async ({ page }) => {
  await boot(page, theme);
  await page.locator('[data-side-open=local]').click({ button: 'right' });
  const reference = page.locator('#side-bookmark-context [data-side-action=delete]');
  const color = await reference.evaluate(e => getComputedStyle(e).color);
  await reference.hover();
  const hover = await reference.evaluate(e => ({ color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor }));
  await page.keyboard.press('Escape');
  for (const side of ['local', 'remote', 'pair']) {
    if (side === 'pair') {
      await page.locator('.bookmark-bar').click({ button: 'right', position: { x: 2, y: 2 } });
      await page.locator('[data-bookmark-action=history]').click();
      await page.locator('[data-bookmark-edit="0"]').click();
    } else {
      await page.locator(`[data-side-open=${side}]`).click({ button: 'right' });
      await page.locator('[data-side-action=edit]').click();
    }
    const button = page.locator(side === 'pair' ? '#bookmark-delete' : '#side-bookmark-remove');
    expect(await button.evaluate(e => getComputedStyle(e).color)).toBe(color);
    await button.hover();
    expect(await button.evaluate(e => ({ color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor }))).toEqual(hover);
    await page.mouse.move(0, 0);
    await page.locator(side === 'pair' ? '#bookmark-remote' : '#side-bookmark-path').focus();
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    expect(await button.evaluate(e => getComputedStyle(e).outlineStyle)).toBe('solid');
    expect(await button.evaluate(e => getComputedStyle(e).color)).toBe(hover.color);
    if (side === 'pair') await page.screenshot({ path: test.info().outputPath(`paired-edit-${theme}.png`) });
    await page.keyboard.press('Escape');
  }
});
