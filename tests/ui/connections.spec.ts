import { editSelectedProfile, addRootProfile } from "./connection-context";
import { test, expect } from "@playwright/test";
async function connect(page) {
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await expect(page.locator("#prepare")).toBeEnabled();
}
async function browse(page, side, path) {
  await page.locator(`[data-path=${side}] input`).fill(path);
  await page.locator(`[data-path=${side}] input`).press("Enter");
}
async function start(page, local?) {
  if (local) {
    await browse(page, "local", local);
    await expect(page.locator("#local-path")).toHaveValue(local);
  }
  await page.locator("#prepare").click();
  await expect(page.locator("#start-form [name=local]")).toHaveAttribute("type", "hidden");
  await page.locator("#start-form .primary").click();
}
async function addProfile(page, name, host) {
  await addRootProfile(page);
  await page.getByLabel("名前", { exact: true }).fill(name);
  await page.getByLabel("ホスト", { exact: true }).fill(host);
  await page.getByLabel("ユーザー名", { exact: true }).fill("fixture");
  await page.locator("#profile-form .primary").click();
  await expect(page.locator("#profile-form")).toHaveCount(0);
  await expect(page.locator("#connect-form")).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});
test("idle connection has no cancel and profile editing returns to connection", async ({
  page,
}) => {
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await expect(page.locator("#prepare")).toHaveCount(0);
  await expect(page.locator("[data-entry]")).toHaveCount(0);
  await editSelectedProfile(page);
  await page.locator("#cancel").click();
  await expect(page.locator("#connect-form")).toBeVisible();
  await addProfile(page, "My site", "example.invalid");
  await editSelectedProfile(page);
  await page.getByLabel("名前", { exact: true }).fill("Edited site");
  await page.locator("#profile-form .primary").click();
  await expect(
    page.locator(
      "[data-connection-node][aria-selected=true] [data-connection-select]",
    ),
  ).toContainText("Edited site");
  await connect(page);
  await expect(page.locator("[data-tab][aria-selected=true]")).toContainText(
    "Edited site",
  );
  await expect(
    page.locator("#connection-tree, #profile-select, #edit-profile"),
  ).toHaveCount(0);
});
test("connected profiles stay fixed and closed stopped context cannot reopen from history", async ({
  page,
}) => {
  await addProfile(page, "My site", "example.invalid");
  await connect(page);
  const ownerId = await page
    .locator("[role=tab][aria-selected=true]")
    .getAttribute("data-tab");
  await browse(page, "remote", "/one");
  await start(page, "C:\\custom");
  await browse(page, "remote", "/other");
  await expect(page.locator("#prepare")).toHaveAttribute("title", /\/one/);
  await page.locator("[data-close]").click();
  await expect(page.locator("#window-close-notice")).toBeVisible();
  await page.locator("#prepare").click();
  await expect(page.locator("#retained-resume")).toBeVisible();
  await browse(page, "local", "C:\\browse-current");
  await expect(page.locator("[data-tab][aria-selected=true]")).toHaveAttribute(
    "title",
    /example.invalid/,
  );
  await page.locator("[data-close]").click();
  await expect(page.locator("[data-tab]")).toHaveCount(0);
  await expect(page.locator("#restore-tab")).toHaveCount(0);
  const history = await page.evaluate(
    () => JSON.parse(localStorage.getItem("syncfiles-v1")).history,
  );
  expect(Object.values(history)).toContain("C:\\custom");
  await page.reload();
  await page
    .locator("[data-connection-select]")
    .filter({ hasText: "My site" })
    .click();
  await connect(page);
  const freshLocal = await page.locator("#local-path").inputValue();
  expect(freshLocal).not.toBe("C:\\custom");
  await expect(page.locator("#retained-resume")).toHaveCount(0);
  await browse(page, "remote", "/one");
  await page.locator("#prepare").click();
  await expect(page.locator("#start-form [name=local]")).toHaveValue(
    freshLocal,
  );
  await expect(page.locator("[data-sync-source]")).toHaveText(freshLocal);
  await expect(page.locator("#local-path")).toHaveValue(freshLocal);
  await expect(page.locator(".sync-roots")).toHaveCount(0);
  await page.locator("#cancel").click();
  await page.reload();
  await expect(page.locator("#connect-form")).toBeVisible();
  await expect(
    page.locator("#restore-tab,.stopped-context,#retained-resume"),
  ).toHaveCount(0);
  await expect(page.locator(`[data-tab="${ownerId}"]`)).toHaveCount(0);
  await page
    .locator("[data-connection-select]")
    .filter({ hasText: "My site" })
    .click();
  await connect(page);
  await expect(page.locator("#local-path")).toHaveValue(freshLocal);
  await expect(page.locator("#remote-path")).toHaveValue("/one");
  await expect(page.locator("#retained-resume")).toHaveCount(0);
});
test("titlebar tabs separate connections, browsing positions and log drawers", async ({
  page,
}) => {
  await addProfile(page, "Site A", "a.invalid");
  await connect(page);
  await browse(page, "local", "C:\\site-a");
  await browse(page, "remote", "/site-a");
  const a = await page.locator("[data-tab]").getAttribute("data-tab");
  await page.locator("#toggle-logs").click();
  await page.locator("#add-tab").click();
  await addProfile(page, "Site B", "b.invalid");
  await connect(page);
  await browse(page, "local", "C:\\site-b");
  await browse(page, "remote", "/site-b");
  const b = await page
    .locator("[role=tab][aria-selected=true]")
    .getAttribute("data-tab");
  await expect(page.locator("#log-drawer")).toHaveCount(0);
  await page.locator(`[data-tab="${a}"]`).click();
  await expect(page.locator("[data-tab][aria-selected=true]")).toContainText(
    "Site A",
  );
  await expect(page.locator("[data-path=local] input")).toHaveValue(
    "C:\\site-a",
  );
  await expect(page.locator("[data-path=remote] input")).toHaveValue("/site-a");
  await expect(page.locator("#log-drawer")).toBeVisible();
  await page.waitForTimeout(1600);
  await expect(page.locator("#log-drawer")).toBeVisible();
  await page.locator(`[data-tab="${b}"]`).click();
  await expect(page.locator("[data-tab][aria-selected=true]")).toContainText(
    "Site B",
  );
  await expect(page.locator("#log-drawer")).toHaveCount(0);
  await page.keyboard.press("Control+Tab");
  await expect(page.locator(`[data-tab="${a}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Control+t");
  await expect(page.locator("#connect-form")).toBeVisible();
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-tab]")).toHaveCount(2);
});
test("coalescing and errors keep logs closed until requested; retry and overlap work", async ({
  page,
}) => {
  await connect(page);
  await browse(page, "remote", "/one");
  await start(page);
  const a = await page.locator("[data-tab]").getAttribute("data-tab");
  await expect(page.locator("#log-drawer")).toHaveCount(0);
  await page.locator("#toggle-logs").click();
  await page.locator("#burst").click();
  await expect(page.locator("#sent-count")).toHaveText("送信 1");
  await page.locator("#fail").click();
  await page.locator("#toggle-logs").click();
  await expect(page.locator("#sync-state")).toHaveText("失敗・再試行が必要");
  await expect(page.locator("#error-count")).toHaveText("エラー 1");
  await expect(page.locator("#error-count")).toHaveClass(/has-errors/);
  await expect(page.locator("#log-drawer")).toHaveCount(0);
  await page.locator("#error-count").click();
  await expect(page.locator(".logs")).toContainText("通信失敗");
  await page.waitForTimeout(900);
  await expect(page.locator("#sent-count")).toHaveText("送信 1");
  await page.locator("#retry").click();
  await expect(page.locator("#start-form")).toBeVisible();
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#start-form")).toHaveCount(0);
  await expect(page.locator("#sent-count")).toHaveText("送信 0");
  await page.locator("#burst").click();
  await expect(page.locator("#sent-count")).toHaveText("送信 1");
  await page.locator("#burst").click();
  await page.locator("#add-tab").click();
  await connect(page);
  await start(page);
  await expect(page.locator(".form-error")).toContainText("重なる同期");
  await page.locator("#cancel").click();
  await browse(page, "remote", "/two");
  await start(page);
  await page.locator(`[data-tab="${a}"]`).click();
  await expect(page.locator("#sent-count")).toHaveText("送信 2");
  await expect(page.locator(".roots")).toContainText("/one");
});
