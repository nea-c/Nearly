import { test, expect } from "@playwright/test";

test("background drive and directory completion preserves drafts and pending startup controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.startCalls = 0;
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
                  name: "Fixture",
                  host: "fixture.invalid",
                  port: 22,
                  user: "fixture",
                  auth: "key",
                  mode: "sftp",
                  hostKey: "SHA256:fixture-existing-pin",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "connect_session") return { path: "/", entries: [{ name: "lazy", dir: true, size: 0 }] };
          if (cmd === "list_drives")
            return await new Promise((resolve) => {
              window.releaseDrives = () =>
                resolve([{ path: "C:\\", name: "C:" }]);
            });
          if (cmd === "list_local") return [];
          if (cmd === "list_remote" && args.path === "/lazy")
            return await new Promise((resolve) => {
              window.releaseLocal = () => resolve([]);
            });
          if (cmd === "start_sync") {
            window.startCalls++;
            return await new Promise((_, reject) => {
              window.rejectStart = reject;
            });
          }
          if (cmd === "stop_sync")
            window.rejectStart(Error("fixture cancelled"));
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await expect(page.locator("[data-pane=local]")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-tree-toggle=remote][data-tree-path="/"]').click();
  await page.locator('[data-tree-toggle=remote][data-tree-path="/lazy"]').click();
  await expect.poll(() => page.evaluate(() => !!window.releaseLocal)).toBe(true);
  await page.locator("#prepare").click();
  await page.locator("#exclusion-details summary").click();
  await page.locator("#exclusion-rules").fill("draft-before-background/");
  await page.locator("#preset-name").fill("Unsaved name");
  await page.locator("#delete-removed").check();
  await page.evaluate(() => {
    window.originalForm = document.querySelector("#start-form");
    window.releaseDrives();
  });
  await expect
    .poll(() => page.evaluate(() => !!window.releaseLocal))
    .toBe(true);
  await expect(page.locator("#exclusion-rules")).toHaveValue(
    "draft-before-background/",
  );
  await expect(page.locator("#preset-name")).toHaveValue("Unsaved name");
  expect(
    await page.evaluate(
      () => window.originalForm === document.querySelector("#start-form"),
    ),
  ).toBe(true);
  await page.locator("#start-form .primary").click();
  await expect.poll(() => page.evaluate(() => window.startCalls)).toBe(1);
  await page.evaluate(() => window.releaseLocal());
  await expect(page.locator("[data-pane=local]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("#delete-removed")).toBeDisabled();
  await expect(page.locator("#start-form .primary")).toBeDisabled();
  await expect(page.locator("#cancel")).toBeEnabled();
  expect(
    await page.evaluate(
      () => window.originalForm === document.querySelector("#start-form"),
    ),
  ).toBe(true);
  await page.locator("#cancel").click();
  await expect(page.locator(".form-error")).toContainText("fixture cancelled");
  await expect(page.locator("#delete-removed")).toBeEnabled();
});

test("a delayed tab disconnect cannot dismiss another tab connection modal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if(cmd === 'request_text_editor_origin_close') return true;
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "sftp",
                  name: "Fixture",
                  host: "fixture.invalid",
                  port: 22,
                  user: "fixture",
                  auth: "key",
                  mode: "sftp",
                  hostKey: "SHA256:fixture-existing-pin",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "connect_session") return { path: "/", entries: [] };
          if (cmd === "list_drives" || cmd === "list_local") return [];
          if (cmd === "disconnect_session")
            return await new Promise((resolve) => {
              window.finishDisconnect = resolve;
            });
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("[data-close]").click();
  await expect
    .poll(() => page.evaluate(() => !!window.finishDisconnect))
    .toBe(true);
  await expect(page.locator("#prepare")).toBeDisabled();
  await page.locator("#add-tab").click();
  await page.locator("#connect-form [name=passphrase]").fill("draft-secret");
  await page.evaluate(() => window.finishDisconnect());
  await expect(page.locator("[data-close]")).toHaveCount(1);
  await expect(page.locator("#connect-form [name=passphrase]")).toHaveValue(
    "draft-secret",
  );
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await expect(page.locator("#connect-form")).toBeVisible();
});
