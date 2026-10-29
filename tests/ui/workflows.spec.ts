import { test, expect } from "@playwright/test";
for (const fail of [false, true]) {
  test(`late native status ${fail ? "error" : "success"} cannot revive a stopped tab`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ fail }) => {
        window.__TAURI__ = {
          core: {
            invoke: async (cmd, args) => {
              if(cmd === 'request_text_editor_origin_close') return true;
          if (cmd === "load_settings")
                return {
                  version: 1,
                  profiles: [
                    {
                      id: "sftp",
                      name: "test",
                      host: "test.invalid",
                      port: 22,
                      user: "test",
                      auth: "key",
                      mode: "sftp",
                      hostKey: "SHA256:fixture-existing-pin",
                    },
                  ],
                  history: {},
                };
              if (cmd === "connect_session") return { path: "/", entries: [] };
              if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
              if (cmd === "connect_session") return { path: "/", entries: [] };
              if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
              if (cmd === "default_folder") return "C:\\fixture";
              if (cmd === "list_local") return [];
              if (cmd === "sync_status") {
                window.statusRequested = true;
                await new Promise((resolve) => {
                  window.releaseStatus = resolve;
                });
                if (fail) throw Error("late failure");
                return {
                  status: "running",
                  pending: 0,
                  sent: 0,
                  speed: 0,
                  latency: 0,
                  logs: [],
                };
              }
            },
          },
        };
      },
      { fail },
    );
    await page.goto("/");
    await page.locator("#connect-form .primary").click();
    await expect(page.locator("#connect-form")).toHaveCount(0);
    await page.locator("#toggle-logs").click();
    await page.locator("#prepare").click();
    await page.locator("#start-form .primary").click();
    await expect
      .poll(() => page.evaluate(() => !!window.statusRequested))
      .toBe(true);
    await page.locator("#prepare").click();
    await expect(page.locator("#prepare")).toHaveText("同期");
    await page.evaluate(() => window.releaseStatus());
    await page.waitForTimeout(900);
    await expect(page.locator("#prepare")).toHaveText("同期");
    await expect(page.locator("#retry")).toBeDisabled();
    await page.locator("[data-close]").click();
    await expect(page.locator(".sync-roots")).toHaveCount(0);
    await expect(page.locator("[data-close]")).toHaveCount(0);
    await expect(page.locator("#restore-tab")).toHaveCount(0);
  });
}
test("late directory response cannot replace the current folder", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          if(cmd === 'request_text_editor_origin_close') return true;
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "fixture",
                  name: "Fixture",
                  mode: "mock",
                  host: "fixture.invalid",
                  port: 22,
                  user: "test",
                  auth: "key",
                },
              ],
              history: {},
            };
          if (cmd === "connect_session") return { path: "/", entries: [] };
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "default_folder") return "C:\\default";
          if (cmd === "list_local") {
            if (args.path.endsWith("slow"))
              await new Promise((r) => setTimeout(r, 1000));
            return [
              {
                name: args.path.endsWith("slow") ? "slow.txt" : "fast.txt",
                dir: false,
                size: 1,
              },
            ];
          }
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("#toggle-logs").click();
  await expect(page.getByRole("gridcell", { name: /fast.txt/ })).toBeVisible();
  await page.getByLabel("ローカルフォルダ", { exact: true }).fill("C:\\slow");
  await page.getByLabel("ローカルフォルダ", { exact: true }).press("Enter");
  await page.getByLabel("ローカルフォルダ", { exact: true }).fill("C:\\fast");
  await page.getByLabel("ローカルフォルダ", { exact: true }).press("Enter");
  await page.waitForTimeout(1200);
  await expect(page.getByRole("gridcell", { name: /fast.txt/ })).toBeVisible();
  await expect(page.getByRole("gridcell", { name: /slow.txt/ })).toHaveCount(0);
});
test("keyboard focus survives background status updates", async ({ page }) => {
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("#toggle-logs").click();
  const button = page.getByRole("button", {
    name: "同期",
    exact: true,
  });
  await button.focus();
  await page.waitForTimeout(1000);
  await expect(button).toBeFocused();
});
test("delayed stop and cancelled restart review cannot revive a stopped job", async ({ page }) => {
  await page.addInitScript(() => {
    window.restartCalls=[];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          window.restartCalls.push(cmd);
          if(cmd === 'request_text_editor_origin_close') return true;
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "retry",
                  name: "Retry",
                  host: "fixture",
                  port: 22,
                  user: "fixture",
                  auth: "key",
                  mode: "sftp",
                  hostKey: "SHA256:fixture-existing-pin",
                },
              ],
              history: {},
            };
          if (cmd === "connect_session") return { path: "/", entries: [] };
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "list_local") return [];
          if (cmd === "sync_status")
            return {
              status: "failed",
              pending: 1,
              sent: 0,
              speed: 0,
              latency: 0,
              logs: [],
            };
          if (cmd === "stop_sync")
            await new Promise((resolve) => {
              window.releaseRestartStop = resolve;
            });
          if (cmd === "retry_sync")throw Error('Automatic retry is forbidden');
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("#toggle-logs").click();
  await page.locator("#prepare").click();
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#retry")).toBeEnabled();
  await page.locator("#retry").click();
  await expect
    .poll(() => page.evaluate(() => !!window.releaseRestartStop))
    .toBe(true);
  expect(await page.evaluate(()=>window.restartCalls.filter(cmd=>cmd==='start_sync').length)).toBe(1);
  await expect(page.locator('#start-form')).toHaveCount(0);
  await page.evaluate(() => window.releaseRestartStop());
  await expect(page.locator('#start-form')).toBeVisible();
  await page.locator('#cancel').click();
  await page.waitForTimeout(900);
  await expect(page.locator("#retry")).toBeDisabled();
  await expect(page.locator("#prepare")).toHaveText("同期");
  expect(await page.evaluate(()=>window.restartCalls.filter(cmd=>cmd==='start_sync').length)).toBe(1);
  expect(await page.evaluate(()=>window.restartCalls.filter(cmd=>cmd==='retry_sync').length)).toBe(0);
});

test("pending sync startup freezes settings and cancellation restores them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__TAURI__ = {
      event: {
        listen: async (_name, handler) => {
          if (_name === "sync-close-blocked") window.closeBlockedHandler = handler;
          return () => {};
        },
      },
      core: {
        invoke: async (cmd) => {
          if(cmd === 'request_text_editor_origin_close') return true;
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "cancel",
                  name: "Cancel",
                  host: "fixture",
                  port: 22,
                  user: "fixture",
                  auth: "key",
                  mode: "sftp",
                  hostKey: "SHA256:fixture-existing-pin",
                },
              ],
              history: {},
            };
          if (cmd === "connect_session") return { path: "/", entries: [] };
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "list_local") return [];
          if (cmd === "prepare_sync") window.prepared = true;
          if (cmd === "start_sync")
            await new Promise((_, reject) => {
              window.cancelStart = () => reject(Error("fixture cancelled"));
            });
          if (cmd === "stop_sync") {
            if (!window.prepared) throw Error("unprepared cancellation");
            window.cancelStart();
          }
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("#toggle-logs").click();
  await page.locator("#prepare").click();
  await page.locator("#delete-removed").check();
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#cancel")).toBeEnabled();
  await expect(page.locator("#delete-removed")).toBeDisabled();
  await expect(page.locator("#delete-removed")).toBeChecked();
  await expect(page.locator("#recursive-sync")).toBeDisabled();
  await expect(page.locator("#start-form [name=local]")).toBeDisabled();
  await expect(page.locator("#sync-preset")).toBeDisabled();
  await expect(page.locator("#preset-save")).toBeDisabled();
  await expect(page.locator("#exclusion-rules")).toBeDisabled();
  await expect(page.locator("#delete-warning")).toBeVisible();
  await expect(page.locator("#prepare")).toHaveText("開始中…");
  await expect(page.locator("#prepare")).toBeDisabled();
  await page.evaluate(() =>
    window.closeBlockedHandler({
      payload: "同期中です。停止完了後に閉じてください。",
    }),
  );
  await expect(page.locator(".notice")).toContainText("停止完了後");
  await expect(page.locator("#start-form .primary")).toBeDisabled();
  await expect(page.locator("#cancel")).toHaveText("接続を中止");
  await page.locator("#cancel").click();
  await expect(page.locator(".form-error")).toContainText("fixture cancelled");
  await expect(page.locator("#start-form .primary")).toBeEnabled();
  await expect(page.locator("#delete-removed")).toBeEnabled();
  await expect(page.locator("#delete-removed")).toBeChecked();
  await page.locator("#cancel").click();
  await expect(page.locator(".sync-roots")).toHaveCount(0);
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("#toggle-logs").click();
  await expect(
    page.getByRole("heading", { name: "リモート", exact: true }),
  ).toBeVisible();
});

