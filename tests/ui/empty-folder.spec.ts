import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, nested: boolean, heldLocal = false) {
  await page.addInitScript(({ nested, heldLocal }) => {
    const local = nested ? "C:\\empty" : "C:\\";
    const remote = nested ? "/empty" : "/";
    window.emptyReadMode = heldLocal ? "hold" : "empty";
    window.__TAURI__ = { core: { invoke: async (cmd, args) => {
      if (cmd === "load_settings") return { version: 1, history: {}, profiles: [{ id: "a", name: "Fixture", host: "fixture.invalid", port: 22, user: "test", mode: "sftp", auth: "key", keyFile: "generated", hostKey: "pin" }], folderBookmarks: [{ id: "same", name: "Same folders", connectionKey: JSON.stringify(["a", "sftp", "fixture.invalid", 22, "test", "pin"]), local, remote }] };
      if (cmd === "default_folder") return local;
      if (cmd === "list_drives") return [{ name: "C:", path: "C:\\" }];
      if (cmd === "connect_session") return { path: remote, entries: [] };
      if (cmd === "list_local" || cmd === "list_remote") {
        if (args.path.includes("missing")) throw Error("fixture missing folder");
        const mode = window.emptyReadMode;
        if (mode === "pair-failure") {
          if (cmd === "list_local") throw Error("fixture local pair failure");
          return await new Promise((resolve, reject) => { window.emptyReadComplete = () => reject(Error("fixture remote pair failure")); });
        }
        if (mode === "hold") return await new Promise((resolve, reject) => { window.emptyReadComplete = (error) => error ? reject(Error("fixture read failure")) : resolve([]); });
        if (mode === "error") throw Error("fixture read failure");
        return [];
      }
    } } };
  }, { nested, heldLocal });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
}

for (const side of ["local", "remote"] as const) for (const nested of [false, true]) {
  test(`empty ${side} ${nested ? "nested" : "root"} uses exact message and only removes its bottom line`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 650 });
    await fixture(page, nested);
    const pane = page.locator(`[data-pane=${side}]`), list = pane.locator(`[data-list=${side}]`);
    await expect(pane).toHaveAttribute("aria-busy", "false");
    await expect(list.locator(".empty")).toHaveText("このフォルダーは空です");
    await expect(list.locator("[data-entry]")).toHaveCount(0);
    await expect(list.locator("[data-parent-row]")).toHaveCount(nested ? 1 : 0);
    for (const theme of ["light", "dark"]) {
      await page.locator("#settings-toggle").click();
      await page.locator("#theme-select").selectOption(theme);
      await expect(page.locator("#theme-select")).toBeEnabled();
      await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
      await page.locator("#settings-close").click();
      await expect(list.locator(".empty")).toHaveCSS("border-bottom-width","0px");
      const bounds = await list.evaluate(e => {
        const outer = e.getBoundingClientRect(), message = e.querySelector('.empty-message')!.getBoundingClientRect();
        return { left: message.left - outer.left, right: outer.right - message.right };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeGreaterThanOrEqual(0);
      // Re-resolve through any committed redraw; persistent missing borders still fail.
      await expect.poll(()=>list.locator("th").first().evaluate(e => parseFloat(getComputedStyle(e).borderBottomWidth))).toBeGreaterThan(0);
      if (nested) await expect.poll(()=>list.locator("[data-parent-row] td").first().evaluate(e => parseFloat(getComputedStyle(e).borderBottomWidth))).toBeGreaterThan(0);
      await page.screenshot({ path: `test-results/empty-${side}-${nested ? "nested" : "root"}-${theme}.png` });
    }
  });
}

test("unloaded, loading and failed reads never claim empty; opposite-pane error preserves confirmed listing", async ({ page }) => {
  await fixture(page, true, true);
  const local = page.locator('[data-pane=local]'), remote = page.locator('[data-pane=remote]');
  await expect(local).toHaveAttribute("aria-busy", "true");
  await expect(local.locator(".empty")).toHaveCount(0);
  await expect(remote.locator(".empty")).toHaveText("このフォルダーは空です");
  await page.evaluate(() => { window.emptyReadMode = "error"; window.emptyReadComplete(true); });
  await expect(local).toHaveAttribute("aria-busy", "false");
  await expect(local.locator(".empty")).toHaveCount(0);
  await expect(remote.locator(".empty")).toHaveText("このフォルダーは空です");
  for (const side of ["local", "remote"]) {
    const pane = page.locator(`[data-pane=${side}]`);
    await page.evaluate(() => { window.emptyReadMode = "empty"; });
    await pane.locator(`[data-refresh=${side}]`).click();
    await expect(pane.locator(".empty")).toHaveText("このフォルダーは空です");
    await pane.locator("input[name=path]").fill(side === "local" ? "C:\\missing" : "/missing");
    await pane.locator("input[name=path]").press("Enter");
    await expect(pane).toHaveAttribute("aria-busy", "false");
    await expect(pane.locator(".empty")).toHaveText("このフォルダーは空です");
    await page.evaluate(() => { window.emptyReadMode = "hold"; });
    await pane.locator(`[data-refresh=${side}]`).click();
    await expect(pane).toHaveAttribute("aria-busy", "true");
    await expect(pane.locator(".empty")).toHaveCount(0);
    await page.evaluate(() => { window.emptyReadMode = "error"; window.emptyReadComplete(true); });
    await expect(pane).toHaveAttribute("aria-busy", "false");
    await expect(pane.locator(".empty")).toHaveCount(0);
  }
});

test("a failed pair keeps its other pending read busy and never redisplays an unverified empty state", async ({ page }) => {
  await fixture(page, true);
  await expect(page.locator('.empty')).toHaveCount(2);
  await page.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 20_000;
    window.emptyReadMode = "pair-failure";
  });
  await page.locator('[data-bookmark-tree-node=same]').click();
  await expect.poll(() => page.evaluate(() => typeof window.emptyReadComplete)).toBe("function");
  await expect(page.locator('[data-pane=remote]')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.empty')).toHaveCount(0);
  await page.evaluate(() => window.emptyReadComplete(true));
  for (const side of ['local', 'remote']) await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.empty')).toHaveCount(0);
  await expect(page.locator('#local-path')).toHaveValue('C:\\empty');
  await expect(page.locator('#remote-path')).toHaveValue('/empty');
});
