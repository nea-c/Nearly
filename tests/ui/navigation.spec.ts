import { test, expect } from "@playwright/test";
async function go(page, side, path) {
  const input = page.locator("#" + side + "-path");
  await input.fill(path);
  await input.press("Enter");
  await expect(page.locator("[data-pane=" + side + "]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}

test("navigation is independent by pane and tab, branches forward history and keeps active sync roots fixed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 650 });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#prepare")).toHaveText("同期");
  for (const side of ["local", "remote"]) {
    await expect(page.locator("[data-back=" + side + "]")).toBeDisabled();
    await expect(page.locator("[data-forward=" + side + "]")).toBeDisabled();
    for (const action of ["back", "forward", "up", "refresh"])
      await expect(
        page.locator("[data-" + action + "=" + side + "] svg"),
      ).toHaveCount(1);
  }
  await expect(page.locator("[data-up=remote]")).toBeDisabled();
  await go(page, "local", "C:\\");
  await expect(page.locator("[data-up=local]")).toBeDisabled();
  await go(page, "local", "C:\\one");
  await go(page, "local", "C:\\two");
  await go(page, "remote", "/one");
  await go(page, "remote", "/two");
  await page.locator("[data-back=local]").click();
  await expect(page.locator("#local-path")).toHaveValue("C:\\one");
  await expect(page.locator("#remote-path")).toHaveValue("/two");
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/one");
  await page.locator("#prepare").click();
  await page.locator("#start-form .primary").click();
  const fixed = await page.locator("#prepare").getAttribute("title");
  await page.locator("[data-forward=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/two");
  await page.locator("[data-up=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/");
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/two");
  await go(page, "remote", "/branch");
  await expect(page.locator("[data-forward=remote]")).toBeDisabled();
  await expect(page.locator("#prepare")).toHaveAttribute("title", fixed);
  await expect(page.locator("#prepare")).toHaveText("同期停止");
  const first = await page
    .locator("[data-tab][aria-selected=true]")
    .getAttribute("data-tab");
  await page.locator("#add-tab").click();
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-back=remote]")).toBeDisabled();
  await expect(page.locator("[data-back=local]")).toBeDisabled();
  await page.locator('[data-tab="' + first + '"]').click();
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/two");
  await page.locator("[data-forward=local]").click();
  await expect(page.locator("#local-path")).toHaveValue("C:\\two");
  for (const side of ["local", "remote"]) {
    const box = await page.locator("[data-path=" + side + "]").boundingBox();
    expect(
      await page
        .locator("[data-path=" + side + "]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    expect(
      (await page.locator("#" + side + "-path").boundingBox()).width,
    ).toBeGreaterThan(80);
  }
  await page.screenshot({ path: "test-results/navigation-workspace-800.png" });
});

test("failed and stale reads never commit path or history; refresh ignores drafts and updates listing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.reads = [];
    window.failPath = "";
    window.holdPath = "";
    window.revision = 0;
    const files = (path) => [
      { name: "folder-" + window.revision, dir: true, size: 0 },
      {
        name: path.replaceAll("/", "_").replaceAll("\\", "_") + ".txt",
        dir: false,
        size: 1,
      },
    ];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "a",
                  name: "Fixture",
                  host: "fixture.invalid",
                  port: 22,
                  user: "fixture",
                  mode: "sftp",
                  hostKey: "SHA256:fixture-existing-pin",
                  auth: "key",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "connect_session")
            return { path: "/home", entries: files("/home") };
          if (cmd === "list_remote" || cmd === "list_local") {
            window.reads.push({ cmd, path: args.path });
            if (args.path === window.failPath)
              throw Error("fixture read failed");
            if (args.path === window.holdPath)
              return await new Promise(
                (resolve) =>
                  (window.releaseRead = () => resolve(files(args.path))),
              );
            return files(args.path);
          }
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
  await expect(page.locator("#remote-path")).toHaveValue("/home");
  await go(page, "remote", "/a");
  await go(page, "remote", "/b");
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/a");
  await page.evaluate(() => (window.failPath = "/bad"));
  await go(page, "remote", "/bad");
  await expect(page.locator(".notice")).toContainText("fixture read failed");
  await expect(page.locator("#remote-path")).toHaveValue("/a");
  await expect(page.locator("[data-list=remote]")).toContainText("_a.txt");
  await page.locator("[data-forward=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/b");
  await page.evaluate(() => (window.failPath = "/a"));
  // Explicit refresh invalidates cached paths before testing a fresh failed Back read.
  await page.locator("[data-refresh=remote]").click();
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute("aria-busy", "false");
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("#remote-path")).toHaveValue("/b");
  await page.evaluate(() => (window.failPath = ""));
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/a");
  await page.evaluate(() => (window.holdPath = "/slow"));
  await page.locator("#remote-path").fill("/slow");
  await page.locator("#remote-path").press("Enter");
  await expect.poll(() => page.evaluate(() => !!window.releaseRead)).toBe(true);
  await go(page, "remote", "/fast");
  await page.evaluate(() => window.releaseRead());
  await page.waitForTimeout(300);
  await expect(page.locator("#remote-path")).toHaveValue("/fast");
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/a");
  await page.evaluate(() => (window.revision = 1));
  await page.locator("#remote-path").fill("/uncommitted");
  const before = await page.evaluate(() => window.reads.length);
  await page.locator("[data-refresh=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/a");
  await expect(page.locator("[data-list=remote]")).toContainText("folder-1");
  const refreshedTree = page.locator('[data-tree-toggle=remote][data-tree-path="/a"]');
  await expect(refreshedTree.locator('xpath=../..')).toHaveAttribute('aria-expanded', 'false');
  await refreshedTree.click();
  await expect(page.locator("[data-tree=remote]")).toContainText("folder-1");
  expect(
    await page.evaluate(
      (start) => window.reads.slice(start).map((r) => r.path),
      before,
    ),
  ).toEqual(["/a"]);
  await page.locator("[data-forward=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/fast");
  await expect(page.locator("#local-path")).toHaveValue("C:\\fixture");
  await page.locator("[data-back=remote]").click();
  await page.locator("[data-back=remote]").click();
  await expect(page.locator("#remote-path")).toHaveValue("/home");
  await expect(page.locator("[data-back=remote]")).toBeDisabled();
});
