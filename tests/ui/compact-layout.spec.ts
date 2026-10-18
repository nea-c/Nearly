import { expandTreePath } from './tree-expansion';
import { test, expect } from "@playwright/test";

test("empty tabs show inline connection only and settings remain globally accessible", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("main #connect-form")).toBeVisible();
  await expect(
    page.locator(".overlay,.panes,#prepare,.workspace-heading,.toolbar"),
  ).toHaveCount(0);
  await page.locator("#settings-toggle").click();
  await page.locator("#theme-select").selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-popup")).toHaveCount(0);
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await expect(page.locator(".panes,#prepare")).toHaveCount(0);
  await page.locator("#connect-form .primary").click();
  await expect(
    page.locator("[data-pane=remote] > header #prepare"),
  ).toBeVisible();
  await expect(
    page.locator("[data-path] button:not(.path-navigation)"),
  ).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#add-tab").click();
  await expect(page.locator("main #connect-form")).toBeVisible();
  await expect(page.locator(".panes,#prepare")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("independent tree widths persist on release, cancel safely and retain horizontal scrolling", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  const drag = async (side: string, ratio: number, cancel = false) => {
    const area = await page
      .locator(`[data-pane=${side}] .pane-body`)
      .boundingBox();
    const handle = await page.locator(`#${side}-tree-splitter`).boundingBox();
    await page.mouse.move(handle.x + 3, handle.y + 80);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * ratio, handle.y + 80, {
      steps: 5,
    });
    if (cancel)
      await page
        .locator(`#${side}-tree-splitter`)
        .dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
  };
  await drag("local", 0.42);
  await drag("remote", 0.36);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("syncfiles-v1")).localTreeRatio,
      ),
    )
    .toBeGreaterThan(0.4);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("syncfiles-v1")),
  );
  expect(saved.remoteTreeRatio).toBeGreaterThan(0.34);
  expect(saved.remoteTreeRatio).toBeLessThan(0.38);
  await drag("local", 0.55, true);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("syncfiles-v1")).localTreeRatio,
    ),
  ).toBe(saved.localTreeRatio);
  await expandTreePath(page,'local','C:\\');
  await page
    .locator("#local-path")
    .fill(
      "C:\\Projects\\a-long-directory-name-that-needs-horizontal-scrolling",
    );
  await page.locator("#local-path").press("Enter");
  await expandTreePath(page,'local','C:\\Projects');
  const tree = page.locator("[data-tree=local]");
  await tree.hover();
  await page.mouse.wheel(500, 0);
  await expect
    .poll(() => tree.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const left = await tree.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(900);
  expect(await tree.evaluate((el) => el.scrollLeft)).toBe(left);
  await page.setViewportSize({ width: 800, height: 650 });
  await page.locator("#pane-splitter").focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  for (const side of ["local", "remote"]) {
    expect(
      (await page.locator(`[data-tree=${side}]`).boundingBox()).width,
    ).toBeGreaterThanOrEqual(99);
    expect(
      (await page.locator(`[data-list=${side}]`).boundingBox()).width,
    ).toBeGreaterThanOrEqual(139);
  }
  await page.reload();
  await page.locator("#connect-form .primary").click();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("syncfiles-v1")).remoteTreeRatio,
    ),
  ).toBe(saved.remoteTreeRatio);
  await expect(page.locator(".selection-marquee")).toHaveCount(0);
});

test("sixteen tabs shrink equally, wheel in both directions and preserve manual scroll on polling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 650 });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  for (let i = 1; i < 16; i++) await page.locator("#add-tab").click();
  await expect(page.locator("[data-tab]")).toHaveCount(16);
  await expect(page.locator("#add-tab")).toBeDisabled();
  const tabs = page.locator(".tabs");
  const geometry = await tabs.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    heights: [el.clientHeight, el.offsetHeight],
    widths: [...el.children].map((c) => c.getBoundingClientRect().width),
  }));
  expect(geometry.scroll).toBeGreaterThan(geometry.width);
  expect(
    Math.max(...geometry.widths) - Math.min(...geometry.widths),
  ).toBeLessThan(1);
  expect(Math.min(...geometry.widths)).toBeGreaterThanOrEqual(107);
  expect(geometry.heights[1] - geometry.heights[0]).toBeLessThanOrEqual(1);
  for (const id of [
    "add-tab",
    "settings-toggle",
    "window-minimize",
    "window-close",
  ])
    await expect(page.locator("#" + id)).toBeInViewport({ ratio: 1 });
  await page.locator(".title-drag").hover();
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => tabs.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.waitForTimeout(1000);
  expect(await tabs.evaluate((el) => el.scrollLeft)).toBe(0);
  await tabs.hover();
  await page.mouse.wheel(10000, 0);
  await expect
    .poll(() => tabs.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(500);
  const end = await tabs.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(1000);
  expect(await tabs.evaluate((el) => el.scrollLeft)).toBe(end);
  await page.keyboard.press("Control+Tab");
  await expect(page.locator("[data-tab]").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await tabs.evaluate((el) => el.scrollLeft)).toBeLessThanOrEqual(6);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.locator("[data-tab]").last()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.setViewportSize({ width: 1180, height: 850 });
  await page.locator("[data-close]").nth(7).click();
  await expect(page.locator("[data-tab]")).toHaveCount(15);
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-tab]")).toHaveCount(14);
  await expect(page.locator(".tab.active")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "test-results/current-tabs-overflow.png" });
});

test("keyboard tab changes leave dirty path editors before replacing the workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  const first = await page.locator("[data-tab]").getAttribute("data-tab");
  await page.locator("#local-path").fill("C:\\unsubmitted-new-tab");
  await page.keyboard.press("Control+t");
  await expect(page.locator("main #connect-form")).toBeVisible();
  await expect(page.locator(".panes")).toHaveCount(0);
  await page.locator("#connect-form .primary").click();
  const second = await page
    .locator("[data-tab][aria-selected=true]")
    .getAttribute("data-tab");
  await page.locator("#local-path").fill("C:\\second-draft");
  await page.keyboard.press("Control+Tab");
  await expect(page.locator(`[data-tab="${first}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#local-path")).toHaveValue("C:\\Projects");
  await expect(page.locator("[data-list=local]")).toHaveAttribute(
    "data-workspace",
    first,
  );
  await page.locator("#local-path").fill("C:\\closing-draft");
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-tab]")).toHaveCount(1);
  await expect(page.locator(`[data-tab="${second}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#local-path")).toHaveValue("C:\\Projects");
  await expect(page.locator("[data-list=local]")).toHaveAttribute(
    "data-workspace",
    second,
  );
});

test("IME Enter and a cross-pane late response preserve an uncommitted path draft", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "s",
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
          if (cmd === "connect_session")
            return {
              path: "/",
              entries: [{ name: "slow", dir: true, size: 0 }],
            };
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "list_local") {
            window.localReads = (window.localReads || 0) + 1;
            return [];
          }
          if (cmd === "list_remote")
            return await new Promise((resolve) => {
              window.releaseTree = () => resolve([]);
            });
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
  await expandTreePath(page,'remote','/');
  await page
    .locator('[data-tree-toggle=remote][data-tree-path="/slow"]')
    .click();
  await expect.poll(() => page.evaluate(() => !!window.releaseTree)).toBe(true);
  const input = page.locator("#local-path");
  await input.fill("C:\\draft-日本語");
  await input.dispatchEvent("compositionstart");
  await page.evaluate(() => {
    window.draftInput = document.querySelector("#local-path");
    window.releaseTree();
  });
  await page.waitForTimeout(900);
  expect(
    await page.evaluate(
      () => window.draftInput === document.querySelector("#local-path"),
    ),
  ).toBe(true);
  await expect(input).toHaveValue("C:\\draft-日本語");
  await expect(input).toBeFocused();
  const before = await page.evaluate(() => window.localReads);
  await input.press("Enter");
  expect(await page.evaluate(() => window.localReads)).toBe(before);
  const allowed = await input.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(allowed).toBe(false);
  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.localReads))
    .toBe(before + 1);
});

test("add follows short tabs while a clear drag region and caption controls remain fixed", async ({
  page,
}) => {
  for (const width of [800, 1180]) {
    await page.setViewportSize({ width, height: 650 });
    await page.goto("/");
    const controls = await page.locator(".window-controls").boundingBox();
    for (let count = 1; count <= 3; count++) {
      const tabs = await page.locator(".tabs").boundingBox();
      const last = await page.locator(".tab").last().boundingBox();
      const add = await page.locator("#add-tab").boundingBox();
      const drag = await page.locator(".title-drag").boundingBox();
      expect(add.x - (last.x + last.width)).toBeGreaterThanOrEqual(0);
      expect(add.x - (last.x + last.width)).toBeLessThanOrEqual(5);
      expect(add.x - (tabs.x + tabs.width)).toBeLessThanOrEqual(3);
      expect(drag.width).toBeGreaterThanOrEqual(96);
      expect(await page.locator(".window-controls").boundingBox()).toEqual(
        controls,
      );
      expect(
        await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.matches(".title-drag[data-tauri-drag-region]"),
          { x: drag.x + drag.width / 2, y: drag.y + drag.height / 2 },
        ),
      ).toBe(true);
      for (const selector of [
        ".tab.active",
        "#add-tab",
        "#settings-toggle",
        "#window-minimize",
      ]) {
        expect(
          await page
            .locator(selector)
            .evaluate((el) => !!el.closest("[data-tauri-drag-region]")),
        ).toBe(false);
      }
      await expect(page.locator("#connect-cancel")).toHaveCount(0);
      if (count < 3) await page.locator("#add-tab").click();
    }
    await page.screenshot({
      path: "test-results/titlebar-few-" + width + ".png",
    });
    for (let count = 3; count < 16; count++)
      await page.locator("#add-tab").click();
    const tabs = await page.locator(".tabs").boundingBox();
    const add = await page.locator("#add-tab").boundingBox();
    const drag = await page.locator(".title-drag").boundingBox();
    expect(add.x - (tabs.x + tabs.width)).toBeGreaterThanOrEqual(0);
    expect(add.x - (tabs.x + tabs.width)).toBeLessThanOrEqual(3);
    expect(drag.width).toBeGreaterThanOrEqual(96);
    expect(await page.locator(".window-controls").boundingBox()).toEqual(
      controls,
    );
    const fixed = add.x;
    await page.locator(".title-drag").hover();
    await page.mouse.wheel(0, -10000);
    await expect
      .poll(() => page.locator(".tabs").evaluate((el) => el.scrollLeft))
      .toBe(0);
    expect((await page.locator("#add-tab").boundingBox()).x).toBe(fixed);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.matches(".title-drag[data-tauri-drag-region]"),
        { x: drag.x + drag.width / 2, y: drag.y + drag.height / 2 },
      ),
    ).toBe(true);
    await page.locator("#settings-toggle").click();
    await expect(page.locator("#theme-select option")).toHaveCount(5);
    expect(await page.locator("#theme-select option").evaluateAll(options=>options.map(option=>option.value))).toEqual(["light","dark","midnight","forest","mint"]);
    await expect(page.locator("#settings-popup p")).toHaveCount(1);
    await expect(page.locator("#settings-popup p")).toHaveClass("compact-explorer-help");
    await expect(page.locator("#settings-popup p")).toHaveText("一覧とツリーの行間を狭くします");
    await page.screenshot({
      path: "test-results/titlebar-many-" + width + ".png",
    });
  }
});
