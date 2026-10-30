import { bookmarkRootAction } from './bookmark-context';
async function historyEditBookmark(page) {
  await page.keyboard.press("Escape");
  await bookmarkRootAction(page,'history');
  await page.locator("[data-bookmark-edit]").first().click();
}
import { editSelectedProfile, addRootProfile } from "./connection-context";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.calls = [];
    window.failPath = "";
    window.holdPath = "";
    const files = () => [
      { name: "child", dir: true, size: 0, modifiedAt: 1700000000 },
      { name: "notes.TXT", dir: false, size: 42, modifiedAt: 1700000000 },
      { name: "photo.JPG", dir: false, size: 2048 },
      {
        name: "a-very-long-file-name-for-ellipsis.custom",
        dir: false,
        size: 10,
      },
    ];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          window.calls.push({ cmd, args });
          if (cmd === "load_settings")
            return (
              JSON.parse(
                localStorage.getItem("fixture-settings") || "null",
              ) || {
                version: 1,
                profiles: [
                  {
                    id: "a",
                    name: "Server A",
                    host: "same.invalid",
                    port: 22,
                    user: "alice",
                    mode: "sftp",
                    auth: "key",
                    hostKey: "key-a",
                    keyFile: "fixture.ppk",
                  },
                  {
                    id: "b",
                    name: "Server B",
                    host: "same.invalid",
                    port: 22,
                    user: "bob",
                    mode: "sftp",
                    auth: "key",
                    hostKey: "key-a",
                    keyFile: "fixture.ppk",
                  },
                ],
                history: { '["a","/legacy"]': "C:\\legacy" },
              }
            );
          if (cmd === "save_settings") {
            if (window.failSave) throw Error("fixture save denied");
            if (window.holdSave)
              await new Promise((resolve, reject) => {
                window.resolveSave = resolve;
                window.rejectSave = reject;
              });
            localStorage.setItem("fixture-settings", JSON.stringify(args.data));
            return;
          }
          if (cmd === "default_folder") return "C:\\root";
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "connect_session") return { path: "/", entries: files() };
          if (cmd === "list_local" || cmd === "list_remote") {
            if (args.path === window.failPath)
              throw Error("fixture listing denied");
            if (args.path === window.holdPath)
              return await new Promise(
                (resolve) => (window.releaseListing = () => resolve(files())),
              );
            return files();
          }
          if (cmd === "sync_status")
            return {
              status: "running",
              sent: 0,
              pending: 0,
              speed: 0,
              latency: 0,
              errorCount: 0,
              logs: [],
            };
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-pane=local]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
});
async function go(page, side, path) {
  await page.locator(`#${side}-path`).fill(path);
  await page.locator(`#${side}-path`).press("Enter");
  await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function saveBookmark(page, name) {
  await bookmarkRootAction(page,'register');
  await page.locator("#bookmark-name").fill(name);
  await page.locator("#bookmark-save").click();
  await expect(page.locator("#bookmark-form")).toHaveCount(0);
}
async function reorderColumn(page, side, source, target) {
  const from=await page.locator(`[data-list="${side}"] [data-column-sort="${source}"]`).boundingBox();
  const to=await page.locator(`[data-list="${side}"] th[data-column="${target}"]`).boundingBox();
  expect(from).toBeTruthy();expect(to).toBeTruthy();
  await page.mouse.move(from.x+10,from.y+from.height/2);await page.mouse.down();
  await page.mouse.move(to.x+10,to.y+to.height/2,{steps:10});await page.mouse.up();
}

test("bookmarks persist, dedupe and open both panes without changing an active sync root", async ({
  page,
}) => {
  await go(page, "local", "C:\\A");
  await go(page, "remote", "/A");
  await saveBookmark(page, "Site <A> & project");
  await expect(page.locator("[data-bookmark-open]")).toHaveText(
    "Site <A> & project",
  );
  await saveBookmark(page, "Renamed <A>");
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(1);
  await go(page, "local", "C:\\B");
  await go(page, "remote", "/B");
  await page.locator("#prepare").click();
  await page.locator("#start-form .primary").click();
  const roots = await page.locator("#prepare").getAttribute("title");
  await page.locator("[data-bookmark-open]").click();
  await expect(page.locator("#local-path")).toHaveValue("C:\\A");
  await expect(page.locator("#remote-path")).toHaveValue("/A");
  await expect(page.locator("#prepare")).toHaveAttribute("title", roots);
  await expect(page.locator("#prepare")).toHaveText("同期停止");
  await bookmarkRootAction(page,'history');
  const previous = page
    .locator(".pair-row")
    .filter({ hasText: "C:\\B" })
    .filter({ hasText: "/B" });
  await previous.locator("[data-history-register]").click();
  await page.locator("#bookmark-name").fill("Site B");
  await page.locator("#bookmark-save").click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(2);
  await page.locator("#prepare").click();
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(2);
  await page.locator("[data-bookmark-open]").first().click({ button: "right" });
  await historyEditBookmark(page);
  await expect(page.locator("#bookmark-name")).toHaveValue("Renamed <A>");
  await page.locator("#bookmark-delete").click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(1);
  await expect(
    page.locator(".bookmark-bar img,.bookmark-dialog img"),
  ).toHaveCount(0);
});

test("pair failure retains the successful side, legacy paths require confirmation, and identities stay separate", async ({
  page,
}) => {
  await bookmarkRootAction(page,'history');
  await expect(page.locator(".pair-history-list")).toContainText(
    "旧履歴・接続先未確認",
  );
  const before = await page.evaluate(
    () => window.calls.filter((c) => c.cmd === "list_remote").length,
  );
  await page.locator("[data-legacy-register]").click();
  await expect(page.locator("#legacy-confirm")).toBeVisible();
  expect(
    await page.evaluate(
      () => window.calls.filter((c) => c.cmd === "list_remote").length,
    ),
  ).toBe(before);
  await page.locator("#legacy-confirm").click();
  await page.locator("#bookmark-name").fill("Legacy confirmed");
  await page.locator("#bookmark-save").click();
  await page.evaluate(() => (window.failPath = "/legacy"));
  await page.locator("[data-bookmark-open]").click();
  await expect(page.locator(".notice")).toContainText("fixture listing denied");
  await expect(page.locator("#local-path")).toHaveValue("C:\\legacy");
  await expect(page.locator("#remote-path")).toHaveValue("/");
  await page.evaluate(() => {
    window.failPath = "";
    window.holdPath = "/legacy";
  });
  await page.locator("[data-bookmark-open]").click();
  await expect
    .poll(() => page.evaluate(() => !!window.releaseListing))
    .toBe(true);
  await expect(page.locator("[data-bookmark-open]")).toBeDisabled();
  await go(page, "remote", "/newer");
  await page.evaluate(() => window.releaseListing());
  await page.waitForTimeout(200);
  await expect(page.locator("#local-path")).toHaveValue("C:\\legacy");
  await expect(page.locator("#remote-path")).toHaveValue("/newer");
  const first = await page
    .locator("[data-tab][aria-selected=true]")
    .getAttribute("data-tab");
  await page.locator("#add-tab").click();
  await page.locator('[data-connection-select="b"]').click();
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(0);
  await bookmarkRootAction(page,'history');
  await expect(page.locator(".pair-history-list")).not.toContainText(
    "C:\\legacy",
  );
  await page.locator("#bookmark-close").click();
  await page.locator(`[data-tab="${first}"]`).click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(1);
  await page.locator("#add-tab").click();
  await page.locator('[data-connection-select="a"]').click();
  await editSelectedProfile(page);
  await page.locator("[name=port]").fill("2222");
  await page.locator("#profile-form .primary").click();
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(0);
  await page.locator(`[data-tab="${first}"]`).click();
  await expect(page.locator("[data-bookmark-open]")).toHaveCount(1);
});

test("columns use concrete types, fixed pixel widths, separate order and visibility with safe resizing", async ({
  page,
}) => {
  const local = page.locator("[data-list=local]"),
    remote = page.locator("[data-list=remote]");
  await expect(local.locator('[data-name="notes.TXT"] [data-cell=type]')).toHaveText(
    "テキスト ドキュメント",
  );
  await expect(remote.locator('[data-name="photo.JPG"] [data-cell=type]')).toHaveText(
    "JPEG 画像",
  );
  await expect(local.locator('[data-name="child"] [data-cell=modified]')).not.toBeEmpty();
  await expect(local.locator('[data-name="photo.JPG"] [data-cell=modified]')).toBeEmpty();
  await expect(local.locator('[data-name="a-very-long-file-name-for-ellipsis.custom"] [data-cell=name]')).toHaveAttribute(
    "title",
    "a-very-long-file-name-for-ellipsis.custom",
  );
  await local.locator("th[data-column=name]").click({ button: "right" });
  await expect(page.locator("#column-menu")).toBeVisible();
  await expect(page.locator(".file-menu")).toHaveCount(0);
  await expect(page.locator("[data-column-visible=name]")).toBeDisabled();
  await page.locator("[data-column-visible=modified]").uncheck();
  await page.locator("[data-column-close]").click();
  await reorderColumn(page,"local","type","size");
  expect(
    await local
      .locator("th[data-column]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-column"))),
  ).toEqual(["name", "type", "size"]);
  expect(
    await remote
      .locator("th[data-column]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-column"))),
  ).toEqual(["name", "size", "type", "modified"]);
  const handle = local.locator('[data-column-resize="local:name"]');
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("fixture-settings")).paneColumns.local
            .widths.name,
      ),
    )
    .toBe(290);
  const widths = await local
    .locator("th[data-column]")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(widths).toEqual([290, 100, 100]);
  expect(
    (await local.locator("[data-cell=name]").first().boundingBox()).width,
  ).toBe(290);
  const b = await handle.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 80, b.y + 10);
  await page.waitForTimeout(1000);
  await expect(handle).toHaveAttribute("aria-valuenow", /3\d\d/);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "290");
  const b2 = await handle.boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 10);
  await page.mouse.down();
  await page.mouse.move(b2.x + 43.5, b2.y + 10);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("fixture-settings")).paneColumns.local
            .widths.name,
      ),
    )
    .toBe(330);
  await page.locator("#settings-toggle").click();
  await page.locator("#theme-select").selectOption("dark");
  await page.locator("#settings-close").click();
  await page.locator("#pane-splitter").focus();
  await page.keyboard.press("ArrowRight");
  expect(
    (await local.locator("th[data-column=name]").boundingBox()).width,
  ).toBe(330);
  await page.reload();
  await page.locator("#connect-form .primary").click();
  expect(
    (await local.locator("th[data-column=name]").boundingBox()).width,
  ).toBe(330);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fixture-settings")),
  );
  expect(saved.paneColumns.remote.widths.name).toBe(280);
  expect(saved.profiles).toHaveLength(2);
  expect(saved.localPaneRatio).toBeGreaterThan(0.5);
  for (const selector of [
    "#pane-splitter",
    "#local-tree-splitter",
    "#remote-tree-splitter",
  ]) {
    const style = await page.locator(selector).evaluate((el) => ({
      hit: el.getBoundingClientRect().width,
      line: getComputedStyle(el, "::after").width,
      background: getComputedStyle(el).backgroundColor,
    }));
    expect(style.hit).toBe(6);
    expect(style.line).toBe("1px");
    expect(style.background).toBe("rgba(0, 0, 0, 0)");
  }
  await page.setViewportSize({ width: 800, height: 650 });
  await page.screenshot({
    path: "test-results/explorer-preferences-dark-800.png",
  });
});

test("column widths survive native-style CSP, rerenders and saved settings reload", async ({ page }) => {
  await page.route("**/", async route => {
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({ response, body: html.replace("<head>", '<head><meta http-equiv="Content-Security-Policy" content="style-src-attr \'none\'">') });
  });
  await page.reload();
  await page.locator("#connect-form .primary").click();
  const local = page.locator("[data-list=local]"), remote = page.locator("[data-list=remote]");
  await expect(local.locator("th[data-column=name]")).toBeVisible();
  expect(await page.locator(".titlebar").evaluate(el => getComputedStyle(el).getPropertyValue("--tab-count"))).toBe("1");
  // Verify this document really blocks style attributes while permitting CSSOM.
  expect(await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.setAttribute("style", "width:123px");
    document.body.append(probe);
    const blocked = probe.getBoundingClientRect().width !== 123;
    probe.style.width = "123px";
    const cssomAllowed = probe.getBoundingClientRect().width === 123;
    probe.remove();
    return { blocked, cssomAllowed };
  })).toEqual({ blocked: true, cssomAllowed: true });
  const width = (pane, id) => pane.locator(`th[data-column=${id}]`).evaluate(el => el.getBoundingClientRect().width);
  expect(await width(local, "name")).toBe(280);
  expect(await width(remote, "name")).toBe(280);
  await local.locator('[data-column-resize="local:name"]').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await local.locator("th[data-column=name]").click({ button: "right" });
  await page.locator("[data-column-close]").click();
  await reorderColumn(page,"local","modified","size");
  await remote.locator("th[data-column=name]").click({ button: "right" });
  await page.locator("[data-column-visible=size]").uncheck();
  await page.locator("[data-column-close]").click();
  expect(await width(local, "name")).toBe(320);
  expect(await width(local, "modified")).toBe(170);
  expect(await width(remote, "name")).toBe(280);
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await expect(local.locator("th[data-column=name]")).toBeVisible();
  expect(await width(local, "name")).toBe(320);
  expect(await width(local, "modified")).toBe(170);
  expect(await local.locator("[data-cell=name]").first().evaluate(el => el.getBoundingClientRect().width)).toBe(320);
  expect(await remote.locator("th[data-column]").count()).toBe(3);
  expect(await width(remote, "name")).toBe(280);
  await page.setViewportSize({ width: 800, height: 650 });
  const controls = await page.locator(".window-controls").boundingBox();
  for (let count = 1; count <= 16; count++) {
    // Read a single live DOM snapshot: polling can replace titlebar nodes between
    // separate protocol geometry calls, yielding a detached element's null box.
    const { tabs, add, drag, last } = await page.locator('.titlebar').evaluate(bar => {
      const box = selector => { const r=bar.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; };
      return {tabs:box('.tabs'),add:box('#add-tab'),drag:box('.title-drag'),last:box('.tab:last-child')};
    });
    expect(await page.locator(".titlebar").evaluate(el => getComputedStyle(el).getPropertyValue("--tab-count"))).toBe(String(count));
    if (count <= 3) {
      expect(add.x - (last.x + last.width)).toBeGreaterThanOrEqual(0);
      expect(add.x - (last.x + last.width)).toBeLessThanOrEqual(5);
    }
    expect(add.x - (tabs.x + tabs.width)).toBeGreaterThanOrEqual(0);
    expect(add.x - (tabs.x + tabs.width)).toBeLessThanOrEqual(3);
    expect(drag.width).toBeGreaterThanOrEqual(96);
    expect(await page.locator(".window-controls").boundingBox()).toEqual(controls);
    if (count < 16) await page.locator("#add-tab").click();
  }
  const fixedAdd = (await page.locator("#add-tab").boundingBox()).x;
  expect(await page.locator(".tabs").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.locator(".title-drag").hover();
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => page.locator(".tabs").evaluate(el => el.scrollLeft)).toBe(0);
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => page.locator(".tabs").evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect((await page.locator("#add-tab").boundingBox()).x).toBe(fixedAdd);
});

test("failed bookmark writes stay uncommitted and old completions preserve newer dialogs", async ({
  page,
}) => {
  await saveBookmark(page, "Kept");
  await page.locator("[data-bookmark-open]").click({ button: "right" });
  await historyEditBookmark(page);
  await page.locator("#bookmark-name").fill("Rejected");
  await page.evaluate(() => (window.holdSave = true));
  await page.locator("#bookmark-save").click();
  await expect.poll(() => page.evaluate(() => !!window.rejectSave)).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#theme-select")).toBeDisabled();
  await page.locator("#settings-close").click();
  await bookmarkRootAction(page,'history');
  await page.evaluate(() => {
    window.newBookmarkDialog = document.querySelector("#bookmark-overlay");
    window.holdSave = false;
    window.rejectSave(Error("fixture save denied"));
  });
  await expect(page.locator("[data-bookmark-open]")).toHaveText("Kept");

  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fixture-settings")).folderBookmarks.map(
        (b) => b.name,
      ),
    ),
  ).toEqual(["Kept"]);
  expect(
    await page.evaluate(
      () =>
        window.newBookmarkDialog ===
        document.querySelector("#bookmark-overlay"),
    ),
  ).toBe(true);
  await page.locator("#bookmark-close").click();
  await page.locator("#settings-toggle").click();
  await page.locator("#theme-select").selectOption("dark");
  await expect(page.locator("#theme-select")).toBeEnabled();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("fixture-settings")).theme)).toBe("dark");
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("fixture-settings")).folderBookmarks.map(b=>b.name))).toEqual(["Kept"]);
  await page.locator("#settings-close").click();
  await page.locator("[data-bookmark-open]").click({ button: "right" });
  await historyEditBookmark(page);
  await page.locator("#bookmark-name").fill("Updated");
  await page.evaluate(() => {
    window.holdSave = true;
    window.resolveSave = undefined;
  });
  await page.locator("#bookmark-save").click();
  await expect.poll(() => page.evaluate(() => !!window.resolveSave)).toBe(true);
  await page.keyboard.press("Escape");
  await bookmarkRootAction(page,'history');
  await page.evaluate(() => {
    window.newBookmarkDialog = document.querySelector("#bookmark-overlay");
    window.holdSave = false;
    window.resolveSave();
  });
  await expect(page.locator("[data-bookmark-open]")).toHaveText("Updated");
  expect(
    await page.evaluate(
      () =>
        window.newBookmarkDialog ===
        document.querySelector("#bookmark-overlay"),
    ),
  ).toBe(true);
  await page.locator("#bookmark-close").click();
  await page.locator("[data-bookmark-open]").click({ button: "right" });
  await historyEditBookmark(page);
  await page.evaluate(() => (window.failSave = true));
  await page.locator("#bookmark-delete").click();
  await expect(page.locator("#bookmark-overlay .form-error")).toContainText(
    "fixture save denied",
  );
  await expect(page.locator("[data-bookmark-open]")).toHaveText("Updated");
});

test("a pending bookmark save blocks a second candidate until the first commits", async ({
  page,
}) => {
  await saveBookmark(page, "First");
  await go(page, "local", "C:\\other");
  await go(page, "local", "C:\\root");
  await page.locator("[data-bookmark-open]").click({ button: "right" });
  await historyEditBookmark(page);
  await page.locator("#bookmark-name").fill("First updated");
  await page.evaluate(() => (window.holdSave = true));
  await page.locator("#bookmark-save").click();
  await expect.poll(() => page.evaluate(() => !!window.resolveSave)).toBe(true);
  await page.keyboard.press("Escape");
  await bookmarkRootAction(page,'history');
  await page.locator(".pair-row").filter({ hasText: "C:\\other" }).locator("[data-history-register]").click();
  await page.locator("#bookmark-name").fill("Second");
  const saveCount = await page.evaluate(() => window.calls.filter(c => c.cmd === "save_settings").length);
  await page.locator("#bookmark-save").click();
  await expect(page.locator("#bookmark-overlay .form-error")).not.toBeEmpty();
  expect(await page.evaluate(() => window.calls.filter(c => c.cmd === "save_settings").length)).toBe(saveCount);
  await page.locator('#bookmark-name').focus();
  await page.evaluate(()=>{window.replacementName=document.querySelector('#bookmark-name');window.replacementName.setSelectionRange(1,4);window.replacementDialog=document.querySelector('#bookmark-overlay');});
  await page.evaluate(() => {
    window.holdSave = false;
    window.resolveSave();
  });
  await expect(page.locator("[data-bookmark-open]")).toHaveText("First updated");
  await expect(page.locator("#bookmark-name")).toHaveValue("Second");
  await expect(page.locator('#bookmark-name')).toBeFocused();
  expect(await page.evaluate(()=>({sameField:window.replacementName===document.querySelector('#bookmark-name'),sameDialog:window.replacementDialog===document.querySelector('#bookmark-overlay'),start:window.replacementName.selectionStart,end:window.replacementName.selectionEnd}))).toEqual({sameField:true,sameDialog:true,start:1,end:4});
  await page.locator("#bookmark-save").click();
  await expect(page.locator("[data-bookmark-open]")).toHaveText(["First updated", "Second"]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-settings")).folderBookmarks.map(b => b.name))).toEqual(["First updated", "Second"]);
});

test("explorer preference surfaces fit light and dark windows", async ({
  page,
}) => {
  await saveBookmark(page, "Webサイト <本番>");
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 800, height: 650 });
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await page.locator("#settings-close").click();
    await expect(page.locator(".bookmark-bar")).toHaveCSS("height", "39px");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/explorer-plus-" + theme + "-800-workspace.png",
    });
    await page
      .locator("[data-list=local] [data-column-menu=local]")
      .first()
      .click({ button: "right" });
    await expect(page.locator("#column-menu")).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: "test-results/explorer-plus-" + theme + "-800-columns.png",
    });
    await page.keyboard.press("Escape");
    await bookmarkRootAction(page,'history');
    await expect(page.locator("#bookmark-close")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("[data-saved-open]")).toBeVisible();
    await page.screenshot({
      path: "test-results/explorer-plus-" + theme + "-800-history.png",
    });
    await page.locator("#bookmark-close").click();
    await page.setViewportSize({ width: 1180, height: 850 });
    await page.locator("#pane-splitter").focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page.screenshot({
      path: "test-results/explorer-plus-" + theme + "-1180-workspace.png",
    });
  }
});
