import { test, expect } from "@playwright/test";
async function setup(page, language = "en") {
  await page.addInitScript(
    ({ language }) => {
      window.calls = [];
      window.pendingPrepare = false;
      window.created = { local: [], remote: [] };
      const profile = {
        id: "create",
        name: "設定",
        host: "fixture.invalid",
        port: 22,
        user: "設定",
        auth: "key",
        mode: "sftp",
        hostKey: "pin",
      };
      const entries = [
        { name: "existing-folder", dir: true, size: 0 },
        { name: "keep.txt", dir: false, size: 4 },
      ];
      window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            window.calls.push({ cmd, args });
            if (cmd === "load_settings")
              return {
                version: 1,
                settingsRevision: 1,
                profiles: [profile],
                history: {},
                theme: "light",
                language,
              };
            if (cmd === "save_settings")
              return (args.data.settingsRevision || 1) + 1;
            if (cmd === "default_folder") return "C:\\fixture";
            if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
            if (cmd === "connect_session") return { path: "/", entries };
            if (cmd === "list_local" || cmd === "list_remote")
              return [
                ...entries,
                ...window.created[cmd === "list_local" ? "local" : "remote"],
              ];
            if (cmd === "prepare_file_operation") {
              if (window.pendingPrepare)
                await new Promise((r) => (window.releasePrepare = r));
              return;
            }
            if (cmd === "run_file_operation") {
              const r = args.request;
              window.created[r.side].push({
                name: r.destination.split(/[\\/]/).pop(),
                dir: r.action === "mkdir",
                size: 0,
              });
              return { completed: 1, message: "created" };
            }
          },
        },
      };
    },
    { language },
  );
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-pane=local]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function create(page, side, action, name, row) {
  const list = page.locator(`[data-list=${side}]`);
  await (row ? list.locator(`[data-name="${row}"]`) : list).click({
    button: "right",
    position: row ? undefined : { x: 20, y: 150 },
  });
  if (await page.locator("html").getAttribute("lang") === "en") await expect(page.locator(".file-menu")).not.toContainText(/[\u3040-\u30ff\u3400-\u9fff]/);
  await page.locator(`[data-file-action=${action}]`).click();
  await page.locator("[name=create-name]").fill(name);
}
const operations = (page) =>
  page.evaluate(() =>
    window.calls
      .filter((c) => c.cmd === "run_file_operation")
      .map((c) => c.args.request),
  );
test("selected directory does not retarget list create; unrelated selection survives", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-list=remote] [data-name="keep.txt"]').click();
  await create(page, "local", "createfile", "設定.txt", "existing-folder");
  await expect(page.locator(".create-entry-dialog .target code")).toHaveText(
    "C:\\fixture",
  );
  await page.locator("#create-entry-confirm").click();
  await expect(page.locator(".operation-results")).toHaveText("Created.");
  expect((await operations(page))[0]).toMatchObject({
    action: "createfile",
    source: "C:\\fixture",
    destination: "C:\\fixture\\設定.txt",
    confirmDelete: false,
  });
  await page.locator("#create-entry-cancel").click();
  await expect(
    page.locator('[data-list=local] [data-name="設定.txt"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('[data-list=remote] [data-name="keep.txt"]'),
  ).toHaveAttribute("aria-selected", "true");
});
test("remote root creation preserves frozen endpoint opaque name and session", async ({
  page,
}) => {
  await setup(page, "ja");
  await create(page, "remote", "mkdir", "設定");
  await expect(page.locator(".create-entry-dialog h2")).toHaveText(
    "新しいフォルダー",
  );
  await expect(page.locator(".operation-endpoint")).toHaveText(
    "設定@fixture.invalid:22",
  );
  await page.locator("#create-entry-confirm").click();
  await expect(page.locator(".operation-results")).toHaveText("作成しました。");
  expect((await operations(page))[0]).toMatchObject({
    action: "mkdir",
    source: "/",
    destination: "/設定",
    passphrase: "",
  });
  expect((await operations(page))[0].sessionId).toBeTruthy();
});
test("invalid name cannot dispatch; prepare acknowledgment gates cancel", async ({
  page,
}) => {
  await setup(page);
  await create(page, "local", "createfile", "CON.txt");
  await page.locator("#create-entry-confirm").click();
  await expect(page.locator(".operation-results")).toContainText(
    "Windows reserved",
  );
  expect(await operations(page)).toEqual([]);
  await page.locator("[name=create-name]").fill("safe.txt");
  await page.evaluate(() => (window.pendingPrepare = true));
  await page.locator("#create-entry-confirm").click();
  await expect(page.locator("#create-entry-cancel")).toBeDisabled();
  await page.evaluate(() => window.releasePrepare());
  await expect(page.locator(".operation-results")).toHaveText("Created.");
  expect(await operations(page)).toHaveLength(1);
});
test("tree create targets clicked directory without navigating either pane", async ({
  page,
}) => {
  await setup(page);
  const node = page
    .locator("[data-tree-select=local]")
    .filter({ hasText: "existing-folder" })
    .first();
  await expect(node).toBeVisible();
  await node.click({ button: "right" });
  await page.locator("[data-file-action=mkdir]").click();
  await expect(page.locator(".target code")).toHaveText(
    "C:\\fixture\\existing-folder",
  );
  await page.locator("[name=create-name]").fill("child");
  await page.locator("#create-entry-confirm").click();
  await expect(page.locator(".operation-results")).toHaveText("Created.");
  expect((await operations(page))[0].destination).toBe(
    "C:\\fixture\\existing-folder\\child",
  );
  await expect(page.locator("#local-path")).toHaveValue("C:\\fixture");
  await expect(page.locator("#remote-path")).toHaveValue("/");
});
test('IME composition Enter never creates before final Japanese text is committed', async ({page}) => {
 await setup(page,'ja');await create(page,'local','createfile','設定');const field=page.locator('[name=create-name]');await field.dispatchEvent('compositionstart');await field.press('Enter');await page.waitForTimeout(80);expect(await operations(page)).toEqual([]);await field.fill('設定完了.txt');await field.dispatchEvent('compositionend');await field.press('Enter');await expect(page.locator('.operation-results')).toHaveText('作成しました。');expect(await operations(page)).toHaveLength(1);expect((await operations(page))[0].destination).toBe('C:\\fixture\\設定完了.txt');
});
