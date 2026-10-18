import { expandTreePath } from './tree-expansion';
import { editSelectedProfile, addRootProfile } from "./connection-context";
import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.fixtureCalls = [];
    window.operationCalls = [];
    window.fakeMax = false;
    const entry = (name, dir = false) => ({ name, dir, size: dir ? 0 : 4 });
    window.__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          isMaximized: async () => window.fakeMax,
          onResized: async () => () => {},
          toggleMaximize: async () => {
            window.fakeMax = !window.fakeMax;
          },
          minimize: async () => {},
          close: async () => {
            window.closeCalls = (window.closeCalls || 0) + 1;
          },
        }),
      },
      core: {
        invoke: async (cmd, args) => {
          window.fixtureCalls.push({ cmd, args });
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: ["a", "b"].map((id) => ({
                id,
                name: "Server " + id,
                host: id + ".invalid",
                port: 22,
                user: "fixture",
                auth: "key",
                mode: "sftp",
                keyFile: "synthetic.ppk",
                hostKey: "SHA256:" + "A".repeat(43),
              })),
              history: {},
            };
          if (cmd === "list_drives")
            return [
              { path: "C:\\", name: "C:" },
              { path: "D:\\", name: "D:" },
            ];
          if (cmd === "connect_session")
            return {
              path: "/",
              entries: await window.__TAURI__.core.invoke("list_remote", {
                ...args,
                path: "/",
              }),
            };
          if (cmd === "default_folder") return "C:\\root";
          if (cmd === "stop_sync" && window.holdStop)
            await new Promise((resolve) => {
              window.releaseStop = resolve;
            });
          if (cmd === "list_local" && args.path === "C:\\") return [entry("root", true)];
          if (cmd === "list_local")
            return args.path === "C:\\root"
              ? [
                  entry("alpha", true),
                  entry("beta", true),
                  entry("a.txt"),
                  entry("b.txt"),
                  entry("c.txt"),
                ]
              : args.path.endsWith("alpha")
                ? [entry("nested", true), entry("inside.txt")]
                : [entry("leaf.txt")];
          if (cmd === "list_remote") {
            if (args.path === "/slow")
              await new Promise((resolve) => {
                window.releaseTree = resolve;
              });
            return args.path === "/"
              ? [
                  entry("site", true),
                  entry("slow", true),
                  entry("a.txt"),
                  entry("b.txt"),
                  ...(window.includeBadNames
                    ? [entry("bad\\name.txt"), entry("line\nbreak.txt")]
                    : []),
                ]
              : [entry(args.profile.id + "-child", true), entry("inside.txt")];
          }
          if (cmd === "sync_status")
            return {
              status: "running",
              pending: 0,
              sent: 0,
              speed: 0,
              latency: 0,
              logs: [],
            };
          if (cmd === "run_file_operation") {
            window.operationCalls.push(
              JSON.parse(JSON.stringify(args.request)),
            );
            if (window.holdOperation)
              await new Promise((resolve) => {
                window.releaseOperation = resolve;
              });
            if (args.request.source.endsWith("b.txt"))
              throw Error("fixture b failure");
            return { completed: 1, message: "fixture complete" };
          }
        },
      },
    };
  });
  await page.goto("/");
  await authorize(page);
  await expect(page.locator("[data-list=local] [data-entry]")).toHaveCount(5);
});

for (const theme of ["light", "dark"])
  test(`${theme} primary stop is red and waits; active or background jobs block close`, async ({
    page,
  }) => {
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await page.locator("#settings-close").click();
    await expect(page.locator("#prepare")).toHaveText("同期");
    await page.locator("#prepare").click();
    await page.locator("#start-form .primary").click();
    await expect(page.locator("#prepare")).toHaveText("同期停止");
    await expect(page.locator("#prepare")).toHaveClass(/destructive/);
    const stopColor = await page
      .locator("#prepare")
      .evaluate((el) =>
        getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number),
      );
    expect(stopColor[0]).toBeGreaterThan(stopColor[2]);
    await expect(page.locator("#stop")).toHaveCount(0);
    const first = await page
      .locator("[data-tab]")
      .first()
      .getAttribute("data-tab");
    await page.locator("[data-close]").click();
    await expect(page.locator(".notice")).toContainText("停止完了後");
    await expect(page.locator("[data-tab]")).toHaveCount(1);
    await page.locator("#add-tab").click();
    await expect(page.locator("#connect-cancel")).toHaveCount(0);
    await page.locator("#window-close").click();
    expect(await page.evaluate(() => window.closeCalls || 0)).toBe(0);
    await expect(page.locator(".notice")).toContainText("停止完了後");
    await page.locator(`[data-tab="${first}"]`).click();
    await page.evaluate(() => {
      window.holdStop = true;
    });
    await page.locator("#prepare").click();
    await expect(page.locator("#prepare")).toHaveText("停止中…");
    await expect(page.locator("#prepare")).toBeDisabled();
    await expect(page.locator("#prepare")).toHaveClass(/destructive/);
    await page.locator("#window-close").click();
    expect(await page.evaluate(() => window.closeCalls || 0)).toBe(0);
    await page.evaluate(() => window.releaseStop());
    await expect(page.locator("#prepare")).toHaveText("同期");
    await expect(page.locator("#prepare")).toBeEnabled();
    await expect(page.locator("#prepare")).not.toHaveClass(/destructive/);
    await page.locator("#window-close").click();
    expect(await page.evaluate(() => window.closeCalls)).toBe(1);
  });
async function authorize(page) {
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
}
test("trees load lazily, collapse from cache, and never move the other pane", async ({
  page,
}) => {
  await expandTreePath(page,'local','C:\\root');
  await expandTreePath(page,'remote','/');
  const local = page.locator("[data-tree=local]");
  await expect(local.locator("[data-tree-select]")).toHaveCount(5);
  await expect(
    local.locator('[data-tree-select][data-tree-path="@pc"]'),
  ).toHaveCount(0);
  await local
    .locator('[data-tree-toggle][data-tree-path="C:\\\\root\\\\alpha"]')
    .click();
  await expect(
    local.getByRole("button", { name: "nested", exact: true }),
  ).toBeVisible();
  const count = await page.evaluate(
    () => window.fixtureCalls.filter((c) => c.cmd === "list_local").length,
  );
  await local
    .locator('[data-tree-toggle][data-tree-path="C:\\\\root\\\\alpha"]')
    .click();
  await local
    .locator('[data-tree-toggle][data-tree-path="C:\\\\root\\\\alpha"]')
    .click();
  expect(
    await page.evaluate(
      () => window.fixtureCalls.filter((c) => c.cmd === "list_local").length,
    ),
  ).toBe(count);
  await expect(page.locator("[data-path=local] input")).toHaveValue("C:\\root");
  await page.locator('[data-tree-toggle=remote][data-tree-path="/"]').click();
  expect(
    await page.evaluate(
      () => window.fixtureCalls.filter((c) => c.cmd === "list_remote").length,
    ),
  ).toBe(1);
  await page.locator('[data-tree-toggle=remote][data-tree-path="/"]').click();
  await expect(
    page
      .locator("[data-tree=remote]")
      .getByRole("button", { name: "site", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-path=local] input")).toHaveValue("C:\\root");
});
test("late tree replies stay with their immutable connection tab", async ({
  page,
}) => {
  await expandTreePath(page,'remote','/');
  await page
    .locator('[data-tree-toggle=remote][data-tree-path="/slow"]')
    .click();
  await expect.poll(() => page.evaluate(() => !!window.releaseTree)).toBe(true);
  const first = await page.locator("[data-tab]").getAttribute("data-tab");
  await page.locator("#add-tab").click();
  await page.locator('[data-connection-select="b"]').click();
  await authorize(page);
  await page.evaluate(() => window.releaseTree());
  await expect(page.locator("[data-tree=remote]")).not.toContainText("a-child");
  await page.locator(`[data-tab="${first}"]`).click();
  await expect(page.locator("[data-tree=remote]")).toContainText("a-child");
  await expect(page.locator("#profile-select")).toHaveCount(0);
});
test("file selection supports Ctrl, Shift, marquee, keyboard and directory reset", async ({
  page,
}) => {
  const rows = page.locator("[data-list=local] [data-entry]");
  await rows.nth(2).click();
  await rows.nth(4).click({ modifiers: ["Control"] });
  await expect(
    page.locator("[data-list=local] [aria-selected=true]"),
  ).toHaveCount(2);
  await rows.nth(3).click({ modifiers: ["Shift"] });
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "false");
  await expect(rows.nth(3)).toHaveAttribute("aria-selected", "true");
  const area = await page.locator("[data-list=local]").boundingBox(),
    first = await rows.first().boundingBox();
  await page.mouse.move(area.x + area.width - 8, area.y + area.height - 25);
  await page.mouse.down();
  await page.mouse.move(area.x + 8, first.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.locator("[data-list=local] [aria-selected=true]"),
  ).toHaveCount(5);
  await expect(page.locator("[data-list=local]")).toBeFocused();
  await page.keyboard.press("Control+C");
  await rows.first().click({ button: "right" });
  await expect(page.locator('[data-file-action="paste"]')).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(
    page.locator("[data-list=remote] [aria-selected=true]"),
  ).toHaveCount(0);
  await page.locator("[data-path=local] input").focus();
  await page.keyboard.press("Control+A");
  expect(
    await page
      .locator("[data-path=local] input")
      .evaluate((el) => el.selectionEnd - el.selectionStart),
  ).toBe(7);
  await expandTreePath(page,'local','C:\\root');
  await page
    .locator("[data-tree=local]")
    .getByRole("button", { name: "alpha", exact: true })
    .click();
  await expect(
    page.locator("[data-list=local] [aria-selected=true]"),
  ).toHaveCount(0);
});

test("horizontal list scroll survives polling and tab switches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 650 });
  const list = page.locator("[data-list=local]");
  expect(await list.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await list.evaluate((el) => {
    el.scrollLeft = 93;
  });
  const initial = await list.evaluate((el) => el.scrollLeft);
  const first = await page
    .locator("[data-tab]")
    .first()
    .getAttribute("data-tab");
  await page.waitForTimeout(900);
  expect(await list.evaluate((el) => el.scrollLeft)).toBe(initial);
  await page.locator("#add-tab").click();
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await page.locator(`[data-tab="${first}"]`).click();
  expect(await list.evaluate((el) => el.scrollLeft)).toBe(initial);
});

test("confirmed batch freezes its targets and cancellation skips remaining items", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.holdOperation = true;
  });
  const rows = page.locator("[data-list=local] [data-entry]");
  await rows.nth(2).click();
  await rows.nth(3).click({ modifiers: ["Control"] });
  await rows.nth(2).click({ button: "right" });
  await page.locator('[data-file-action="copy"]').click();
  await rows.first().click({ button: "right" });
  await page.locator('[data-file-action="paste"]').click();
  await page.locator("#file-operation-confirm").click();
  await expect
    .poll(() => page.evaluate(() => window.operationCalls.length))
    .toBe(1);
  await page.locator("#file-operation-cancel").click();
  await page.evaluate(() => window.releaseOperation());
  await expect(page.locator(".operation-results")).toContainText("b.txt");
  expect(
    await page.evaluate(() => window.operationCalls.map((c) => c.source)),
  ).toEqual(["C:\\root\\a.txt"]);
  await expect(page.locator(".operation-summary")).toContainText("1");
});
test("right click preserves multiple targets and reports partial failures per item", async ({
  page,
}) => {
  const rows = page.locator("[data-list=local] [data-entry]");
  await rows.nth(2).click();
  await rows.nth(3).click({ modifiers: ["Control"] });
  await rows.nth(2).click({ button: "right" });
  await expect(page.locator(".menu-context")).toHaveText("2 件を選択");
  await page.getByRole("menuitem", { name: /^コピー/ }).click();
  await rows.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /^貼り付け/ }).click();
  await expect(
    page.getByRole("heading", { name: "2 件をコピー", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".operation-targets li")).toHaveCount(2);
  await page.locator("#file-operation-confirm").click();
  await expect(page.locator(".operation-summary")).toHaveText(
    "1 件完了 / 1 件失敗",
  );
  await expect(page.locator(".operation-results .failed")).toContainText(
    "fixture b failure",
  );
  const calls = await page.evaluate(() => window.operationCalls);
  expect(calls.map((c) => c.source)).toEqual([
    "C:\\root\\a.txt",
    "C:\\root\\b.txt",
  ]);
  expect(calls.map((c) => c.destination)).toEqual([
    "C:\\root\\alpha\\a.txt",
    "C:\\root\\alpha\\b.txt",
  ]);
});
test("remote delete has explicit endpoint, count, targets and irreversible warning", async ({
  page,
}) => {
  await page.locator('[data-tree-toggle=remote][data-tree-path="/"]').click();
  // Expanding a tree loads only its children, not the file pane. Open the root explicitly.
  await page.locator("[data-path=remote] input").press("Enter");
  const rows = page.locator("[data-list=remote] [data-entry]");
  await rows.nth(2).click();
  await rows.nth(3).click({ modifiers: ["Control"] });
  await rows.nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^削除/ }).click();
  await expect(page.locator(".operation-endpoint")).toContainText(
    "fixture@a.invalid:22",
  );
  await expect(page.locator(".operation-targets li")).toHaveCount(2);
  await expect(page.locator(".operation-dialog .warning")).toContainText(
    "元に戻せない可能性",
  );
  expect(await page.evaluate(() => window.operationCalls.length)).toBe(0);
  await page.locator("#file-operation-cancel").click();
  expect(await page.evaluate(() => window.operationCalls.length)).toBe(0);
});
test("caption controls use line SVGs and panes fill remaining height when resized", async ({
  page,
}) => {
  await expect(page.locator(".brandmark")).toHaveCount(0);
  await expect(page.locator(".window-controls .caption-icon")).toHaveCount(3);
  await page.locator("#window-maximize").click();
  await expect(page.locator("#window-maximize")).toHaveAttribute(
    "aria-label",
    "元のサイズに戻す",
  );
  await page.locator("#window-maximize").click();
  await expect(page.locator("#window-maximize")).toHaveAttribute(
    "aria-label",
    "最大化",
  );
  await expect(page.locator(".workspace-heading,.toolbar")).toHaveCount(0);
  for (const size of [
    { width: 800, height: 650 },
    { width: 1180, height: 850 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    const panes = await page.locator(".panes").boundingBox(),
      status = await page.locator(".statusbar").boundingBox();
    expect(Math.abs(panes.y + panes.height - status.y)).toBeLessThanOrEqual(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "test-results/explorer-layout.png",
    fullPage: true,
  });
});

test("stopping preserves the connected snapshot after shared profile edits", async ({
  page,
}) => {
  await page.locator("[data-path=remote] input").press("Enter");
  await page.locator("#prepare").click();
  await page.locator("#start-form .primary").click();
  const first = await page.locator("[data-tab]").getAttribute("data-tab");
  await page.locator("#add-tab").click();
  await editSelectedProfile(page);
  await page.getByLabel("ホスト", { exact: true }).fill("new-host.invalid");
  await page.locator("#profile-form .primary").click();
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await page.locator(`[data-tab="${first}"]`).click();
  await page.locator("[data-list=remote] [data-entry]").nth(2).click();
  await page.locator("#prepare").click();
  await expect(page.locator("[data-list=remote] [data-entry]")).toHaveCount(4);
  await expect(page.locator("[data-tab][aria-selected=true]")).toHaveAttribute(
    "title",
    /a.invalid/,
  );
  await page.locator("[data-path=remote] input").press("Enter");
  expect(
    await page.evaluate(
      () =>
        window.fixtureCalls.filter((c) => c.cmd === "list_remote").at(-1).args
          .profile.host,
    ),
  ).toBe("a.invalid");
});
test("unsupported remote names are inert without breaking other file actions", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.includeBadNames = true;
  });
  await page.locator("[data-refresh=remote]").click();
  await expect(page.locator("[data-list=remote] [data-inert]")).toHaveCount(2);
  await page
    .locator('[data-list=remote] [data-entry][data-name="a.txt"]')
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^コピー/ })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page
    .locator('[data-list=local] [data-entry][data-name="a.txt"]')
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^コピー/ })).toBeEnabled();
});
