import { bookmarkRootAction } from './bookmark-context';
import { test, expect, type Page, type Locator } from "@playwright/test";

async function fixture(page: Page, large = false) {
  await page.addInitScript(({ large }) => {
    const a = { id: 'a', name: 'Alpha', mode: 'sftp', host: 'fixture.invalid', port: 22, user: 'tester', auth: 'key', keyFile: 'generated', hostKey: 'pin' };
    const b = { ...a, id: 'b', name: 'Beta', host: 'other.invalid' };
    const key = JSON.stringify(['a', 'sftp', a.host, 22, a.user, a.hostKey]);
    const local = large ? 'C:\\one\\two\\three\\four\\five' : 'C:\\';
    const remote = large ? '/one/two/three/four/five' : '/';
    const entries = large ? Array.from({ length: 220 }, (_, i) => ({ name: 'directory-' + String(i).padStart(3, '0'), dir: true, size: 0 })) : [];
    const initial = { version: 1, profiles: [a, b], history: {}, theme: 'light',
      connectionTree: { version: 1, nodes: [{ id: 'a', kind: 'profile', profileId: 'a', parentId: null }, { id: 'b', kind: 'profile', profileId: 'b', parentId: null }, { id: 'cg', kind: 'group', name: 'Connections', expanded: false, parentId: null }] },
      folderBookmarks: [{ id: 'one', name: 'One', connectionKey: key, local: 'C:\\one', remote: '/one' }, { id: 'two', name: 'Two', connectionKey: key, local: 'C:\\two', remote: '/two' }, { id: 'deep', name: 'Deep target', connectionKey: key, local: 'C:\\deep', remote: '/deep' }],
      bookmarkTree: { version: 1, nodes: [{ id: 'one', kind: 'bookmark', bookmarkId: 'one', connectionKey: key, parentId: null }, { id: 'two', kind: 'bookmark', bookmarkId: 'two', connectionKey: key, parentId: null }, { id: 'bg', kind: 'group', name: 'Saved folders', connectionKey: key, parentId: null }, { id: 'bn', kind: 'group', name: 'Nested folders', connectionKey: key, parentId: 'bg' }, { id: 'deep', kind: 'bookmark', bookmarkId: 'deep', connectionKey: key, parentId: 'bn' }] },
    };
    window.pointerCalls = [];
    window.__TAURI__ = { core: { invoke: async (cmd, args) => {
      window.pointerCalls.push({ cmd, args });
      if (cmd === 'load_settings') return JSON.parse(localStorage.getItem('pointer-fixture') || 'null') || initial;
      if (cmd === 'save_settings') { localStorage.setItem('pointer-fixture', JSON.stringify(args.data)); return; }
      if (cmd === 'default_folder') return local;
      if (cmd === 'list_drives') return [{ name: 'C:', path: 'C:\\' }];
      if (cmd === 'connect_session') return { path: remote, entries };
      if (cmd === 'list_remote' && args.path === '/delayed') return await new Promise(resolve => { window.pointerHeldResolve = () => resolve([{ name: 'completed.txt', dir: false, size: 1 }]); });
      if (cmd === 'list_local' || cmd === 'list_remote') return entries;
    } } };
  }, { large });
  await page.goto('/');
  await expect(page.locator('#connection-tree')).toBeVisible();
}

async function connect(page: Page) {
  await page.locator('#connect-form .primary').click();
  for (const side of ['local', 'remote']) await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy', 'false');
}
async function theme(page: Page, value: string) {
  await page.locator('#settings-toggle').click();
  await page.locator('#theme-select').selectOption(value);
  await page.locator('#settings-close').click();
}
async function mouseDrag(page: Page, source: Locator, target: Locator, targetY = .5) {
  const from = await source.boundingBox(), to = await target.boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  const x = from!.x + Math.min(from!.width - 8, Math.max(15, from!.width * .7));
  const y = from!.y + from!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 2, { steps: 3 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height * targetY, { steps: 16 });
  // A second real move lets both native HTML drag and pointer implementations hit-test the destination.
  await page.mouse.move(to!.x + to!.width / 2 + 1, to!.y + to!.height * targetY, { steps: 2 });
  await page.mouse.up();
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('pointer-fixture') || '{}'));

test('visible connection settings button edits the selected saved profile and Cancel preserves it', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 });
  await fixture(page);
  for (const [id, name, host] of [['a', 'Alpha', 'fixture.invalid'], ['b', 'Beta', 'other.invalid']]) {
    await page.locator(`[data-connection-select=${id}]`).click();
    await expect.poll(async () => (await saved(page)).lastSelectedProfileId).toBe(id);
    const selectedSnapshot = await saved(page);
    const selectionWrites = await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length);
    await expect(page.locator('#edit-profile')).toBeVisible();
    await page.locator('#edit-profile').click();
    await expect(page.locator('#profile-form [name=name]')).toHaveValue(name);
    await expect(page.locator('#profile-form [name=host]')).toHaveValue(host);
    await page.locator('#cancel').click();
    await expect(page.locator('#profile-form')).toHaveCount(0);
    await expect(page.locator(`[data-connection-node=${id}]`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#edit-profile')).toBeVisible();
    expect(await saved(page)).toEqual(selectedSnapshot);
    expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length)).toBe(selectionWrites);
  }
  await expect(page.locator('#add-profile,#add-connection-group,#connection-actions,[data-connection-action]')).toHaveCount(0);
  expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'connect_session').length)).toBe(0);
  await page.screenshot({ path: 'test-results/pointer-connection-settings-800.png' });
});

for (const mode of ['light', 'dark']) test(`empty message has no hover, selection or marquee gesture in ${mode}`, async ({ page }) => {
  await fixture(page); await connect(page); await theme(page, mode);
  for (const side of ['local', 'remote']) {
    const empty = page.locator(`[data-list=${side}] .empty`);
    await page.mouse.move(5, 5);
    const before = await empty.evaluate(e => ({ row: getComputedStyle(e.parentElement!).backgroundColor, cell: getComputedStyle(e).backgroundColor }));
    await empty.hover();
    expect(await empty.evaluate(e => ({ row: getComputedStyle(e.parentElement!).backgroundColor, cell: getComputedStyle(e).backgroundColor }))).toEqual(before);
    await empty.click();
    await expect(page.locator(`[data-list=${side}] [aria-selected=true]`)).toHaveCount(0);
    const box = await empty.locator('.empty-message').boundingBox();
    await page.mouse.move(box!.x + 30, box!.y + 15); await page.mouse.down();
    await page.mouse.move(box!.x + 100, box!.y + 35, { steps: 8 });
    await expect(page.locator('.selection-marquee')).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator(`[data-selection-count=${side}]`)).toHaveText('');
  }
});

for (const surface of ['list', 'tree']) test(`real wheel keeps ${surface} DOM and scrolling continuous across idle status polls`, async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 650 });
  await fixture(page, true); await connect(page);
  await page.waitForTimeout(800); // finish bootstrap before measuring periodic idle updates.
  for (const side of ['local', 'remote']) {
    const selector = `[data-${surface}=${side}]`, area = page.locator(selector);
    await expect.poll(() => area.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(500);
    await area.evaluate(e => { window.pointerScrollNode = e; window.pointerScrollPositions = []; });
    const box = await area.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 170);
      await page.waitForTimeout(160); // samples a real multi-tick wheel gesture across the 700ms poll.
      await area.evaluate(e => window.pointerScrollPositions.push(e.scrollTop));
    }
    const state = await area.evaluate(e => ({ same: e === window.pointerScrollNode, positions: window.pointerScrollPositions, scroll: e.scrollTop }));
    expect(state.scroll).toBeGreaterThan(500);
    expect(state.positions.every((n, i, all) => i === 0 || n >= all[i - 1])).toBe(true);
    expect(state.same).toBe(true);
  }
});

test('bookmark context history and confirmed deletion affect metadata only, with group children retained', async ({ page }) => {
  await fixture(page); await connect(page);
  const context = async (id: string) => page.locator(`[data-bookmark-tree-node=${id}]`).click({ button: 'right' });
  await context('two'); await page.locator('[data-bookmark-action=history]').click();
  await expect(page.locator('.pair-history-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await context('two'); await page.locator('[data-bookmark-action=delete]').click();
  await expect(page.locator('#bookmark-tree-dialog')).toBeVisible();
  await page.locator('#bookmark-tree-cancel').click();
  await expect(page.locator('[data-bookmark-tree-node=two]')).toBeVisible();
  await context('two'); await page.locator('[data-bookmark-action=delete]').click();
  await page.locator('#bookmark-tree-form .primary').click();
  await expect(page.locator('[data-bookmark-tree-node=two]')).toHaveCount(0);
  expect((await saved(page)).folderBookmarks.map(b => b.id)).toEqual(['one', 'deep']);
  await context('bg'); await page.locator('[data-bookmark-action=delete]').click();
  await expect(page.locator('#bookmark-tree-dialog')).toContainText('中');
  await page.locator('#bookmark-tree-form .primary').click();
  await expect(page.locator('[data-bookmark-tree-node=bg]')).toHaveCount(0);
  expect((await saved(page)).bookmarkTree.nodes.find(n => n.id === 'bn').parentId).toBeNull();
  expect((await saved(page)).bookmarkTree.nodes.find(n => n.id === 'deep').parentId).toBe('bn');
  await expect(page.locator('#local-path')).toHaveValue('C:\\');
  await expect(page.locator('#remote-path')).toHaveValue('/');
  expect(await page.evaluate(() => window.pointerCalls.filter(c => /run_file_operation|start_sync/.test(c.cmd)).length)).toBe(0);
});

test('Escape cancels real pointer reordering without committing or triggering a source click', async ({ page }) => {
  await fixture(page);
  const row = page.locator('[data-connection-node=b]'), box = await row.boundingBox();
  await page.mouse.move(box!.x + box!.width - 12, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width - 30, box!.y + box!.height / 2, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length)).toBe(0);
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  await mouseDrag(page, row, page.locator('[data-connection-node=cg]'));
  await expect.poll(async () => (await saved(page)).connectionTree.nodes.find(n => n.id === 'b').parentId).toBe('cg');
  await page.locator('[data-connection-select=a]').click(); await connect(page);
  const bookmark = page.locator('[data-bookmark-tree-node=one]'), b = await bookmark.boundingBox();
  const before = await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length);
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2);
  await page.mouse.down(); await page.mouse.move(b!.x + b!.width / 2 + 15, b!.y + b!.height / 2, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('[data-bookmark-drop]')).toHaveCount(0);
  await expect(page.locator('#local-path')).toHaveValue('C:\\');
  expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length)).toBe(before);
  await mouseDrag(page, bookmark, page.locator('[data-bookmark-tree-node=bg]'));
  await expect.poll(async () => (await saved(page)).bookmarkTree.nodes.find(n => n.id === 'one').parentId).toBe('bg');
});

for (const cancel of ['blur', 'pointercancel']) test(`${cancel} cancels a real gesture and the same connection/bookmark surface accepts a fresh drag`, async ({ page }) => {
  await fixture(page);
  const begin = async (source: Locator) => {
    const b = await source.boundingBox();
    await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2);
    await page.mouse.down(); await page.mouse.move(b!.x + b!.width / 2 + 18, b!.y + b!.height / 2, { steps: 5 });
    await expect(page.locator('html')).toHaveClass(/pointer-reordering/);
  };
  const abort = async () => {
    await page.evaluate(cancel => cancel === 'blur' ? window.dispatchEvent(new Event('blur')) : document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })), cancel);
    await page.mouse.up();
    await expect(page.locator('html')).not.toHaveClass(/pointer-reordering/);
  };
  const row = page.locator('[data-connection-node=b]');
  await begin(row); await abort();
  expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length)).toBe(0);
  await mouseDrag(page, row, page.locator('[data-connection-node=cg]'));
  await expect.poll(async () => (await saved(page)).connectionTree.nodes.find(n => n.id === 'b').parentId).toBe('cg');
  await page.locator('[data-connection-select=a]').click(); await connect(page);
  const bookmark = page.locator('[data-bookmark-tree-node=one]');
  const before = await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length);
  await begin(bookmark); await abort();
  expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'save_settings').length)).toBe(before);
  await mouseDrag(page, bookmark, page.locator('[data-bookmark-tree-node=bg]'));
  await expect.poll(async () => (await saved(page)).bookmarkTree.nodes.find(n => n.id === 'one').parentId).toBe('bg');
});

test('a browse response held during the other pane marquee becomes visible after Escape', async ({ page }) => {
  await fixture(page, true); await connect(page);
  await page.locator('#remote-path').fill('/delayed'); await page.locator('#remote-path').press('Enter');
  await expect.poll(() => page.evaluate(() => typeof window.pointerHeldResolve)).toBe('function');
  const list = page.locator('[data-list=local]'), b = await list.boundingBox();
  const row = await list.locator('[data-entry]').first().boundingBox();
  await page.mouse.move(b!.x + Math.min(240, b!.width - 20), row!.y + row!.height / 2);
  await page.mouse.down(); await page.mouse.move(b!.x + Math.min(230, b!.width - 30), row!.y + row!.height * 2.5, { steps: 6 });
  await expect(page.locator('.selection-marquee')).toHaveCount(1);
  await page.evaluate(() => window.pointerHeldResolve());
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#remote-path')).toHaveValue('/delayed');
  await expect(page.locator('[data-list=remote] [data-name="completed.txt"]')).toBeVisible();
});

test('actual mouse connection drag moves into a group without connecting or expanding it', async ({ page }) => {
  await fixture(page);
  await mouseDrag(page, page.locator('[data-connection-node=b]'), page.locator('[data-connection-node=cg]'));
  await expect.poll(async () => (await saved(page)).connectionTree?.nodes.find(n => n.id === 'b')?.parentId).toBe('cg');
  expect((await saved(page)).connectionTree.nodes.find(n => n.id === 'cg').expanded).toBe(false);
  expect(await page.evaluate(() => window.pointerCalls.filter(c => c.cmd === 'connect_session').length)).toBe(0);
  await page.locator('[data-connection-node=a]').click({ button: 'right' });
  await expect(page.locator('#connection-context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#connection-context-menu')).toHaveCount(0);
});

test('actual mouse bookmark drag moves metadata without browsing and right-click rename remains available', async ({ page }) => {
  await fixture(page); await connect(page);
  await mouseDrag(page, page.locator('[data-bookmark-tree-node=one]'), page.locator('[data-bookmark-tree-node=bg]'));
  await expect.poll(async () => (await saved(page)).bookmarkTree?.nodes.find(n => n.id === 'one')?.parentId).toBe('bg');
  await expect(page.locator('#local-path')).toHaveValue('C:\\');
  await expect(page.locator('#remote-path')).toHaveValue('/');
  await page.locator('[data-bookmark-tree-node=two]').click({ button: 'right' });
  await expect(page.locator('#bookmark-tree-context')).toBeVisible();
  await page.locator('[data-bookmark-action=rename]').click();
  await expect(page.locator('#bookmark-folder-name')).toHaveValue('Two');
  await page.keyboard.press('Escape');
  await expect(page.locator('#bookmark-tree-dialog')).toHaveCount(0);
});

for (const mode of ['light', 'dark']) test(`nested bookmark menus fit ${mode}, retain parent and close with Escape`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 });
  await fixture(page); await connect(page); await theme(page, mode);
  await page.locator('[data-bookmark-tree-node=bg]').click();
  await page.locator('[data-bookmark-tree-node=bn]').click();
  const menus = page.locator('[data-bookmark-folder-menu]');
  await expect(menus).toHaveCount(2);
  for (const menu of await menus.all()) {
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(42);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(800);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
  }
  await page.screenshot({ path: `test-results/pointer-nested-${mode}-800.png` });
  await page.keyboard.press('Escape');
  await expect(menus).toHaveCount(0);
  await bookmarkRootAction(page,'history');
  await expect(page.locator('.pair-history-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#bookmark-overlay')).toHaveCount(0);
});
