import { test, expect } from "@playwright/test";
test("editor applies every existing theme on startup and subsequent settings changes without losing edits", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.theme = "dark";
    w.handlers = {};
    w.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd === "register_window")
            return { label: "text-editor", ownedWorkspaceIds: [] };
          if (cmd === "load_settings")
            return { theme: w.theme, language: "en" };
          if (cmd === "list_text_documents")
            return [
              {
                token: "sample",
                text: "sample text",
                encoding: "UTF-8",
                newline: "LF",
                path: "/generated/very-long-configuration-file-name-for-tab.json",
                side: "remote",
                connectionLabel: "fixture@localhost:22",
              },
            ];
        },
      },
      event: {
        listen: async (name, handler) => {
          w.handlers[name] = handler;
          return () => {};
        },
      },
    };
  });
  await page.goto("/editor.html");
  await expect(page.locator(".text-editor textarea")).toHaveValue(
    "sample text",
  );
  await page.locator(".text-editor textarea").fill("unsaved themed buffer");
  for (const theme of ["light", "dark", "midnight", "forest", "mint"]) {
    await page.evaluate((theme) => {
      const w = window as any;
      w.theme = theme;
      w.handlers["settings-changed"]({ payload: { settingsRevision: 1 } });
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.mouse.move(1100,850);
    await expect(page.locator(".text-editor textarea")).toHaveValue(
      "unsaved themed buffer",
    );
    const colors = await page
      .locator(".syntax-layer")
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, color: s.color };
      });
    expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.color).not.toBe(colors.background);
    const contrast = async (selector: string) =>
      page.locator(selector).evaluate((el) => {
        // CSS color-mix serializes as color(srgb ...), not necessarily rgb().
        // Resolve through the browser instead of treating normalized channels
        // as 0..255 values, which reported false low hover contrast.
        const rgb = (s: string) => {
          const ctx=document.createElement('canvas').getContext('2d')!;
          ctx.fillStyle=s;ctx.fillRect(0,0,1,1);
          return [...ctx.getImageData(0,0,1,1).data].slice(0,3)
            .map((v) => {
              const n = v / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
        };
        const luminance = (s: string) => {
          const [r, g, b] = rgb(s);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        let node = el as Element;
        let background = getComputedStyle(node).backgroundColor;
        while (background === "rgba(0, 0, 0, 0)" && node.parentElement) {
          node = node.parentElement;
          background = getComputedStyle(node).backgroundColor;
        }
        const a = luminance(getComputedStyle(el).color),
          b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    for (const selector of [
      ".syntax-code",
      ".editor-tab-label",
      ".editor-format-slot",
    ])
      expect(
        await contrast(selector),
        theme + " " + selector,
      ).toBeGreaterThanOrEqual(4.5);
    const pathGeometry = await page.locator(".editor-active-path").evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const tabs = document.querySelector(".editor-tabs")!.getBoundingClientRect();
      const content = document.querySelector(".editor-content")!.getBoundingClientRect();
      return {height: bounds.height, client: el.clientHeight, scroll: el.scrollHeight,
        above: bounds.top - tabs.bottom, below: content.top - bounds.bottom};
    });
    expect(pathGeometry.height, theme + " path height").toBe(18);
    expect(pathGeometry.scroll, theme + " no vertical clipping").toBeLessThanOrEqual(pathGeometry.client);
    expect(pathGeometry.above).toBe(0);
    expect(pathGeometry.below).toBe(0);
    const join = await page.locator('.editor-tab.active').evaluate(el=>({
      background:getComputedStyle(el).backgroundColor,
      foot:getComputedStyle(el,'::after').backgroundImage,
      path:getComputedStyle(document.querySelector('.editor-active-path')!).backgroundColor,
      input:getComputedStyle(document.querySelector('.syntax-layer')!).backgroundColor,
    }));
    expect(join.background,theme).toBe(join.path);
    expect(join.background,theme).toBe(join.input);
    expect(join.foot,theme).toBe('none');
    for(const selector of ['.editor-tab-label','.editor-tab-close'])
      expect(await page.locator(selector).evaluate(el=>getComputedStyle(el).backgroundColor),theme+' transparent tab control').toBe('rgba(0, 0, 0, 0)');
    await page.locator("[data-editor-tab-close]").hover();
    expect(
      await contrast("[data-editor-tab-close]"),
      theme + " close hover",
    ).toBeGreaterThanOrEqual(3);
    await page.locator("[data-editor-tab-close]").click();
    await expect(page.locator(".text-editor-discard")).toBeVisible();
    expect(
      await contrast(".text-editor-discard"),
      theme + " confirmation",
    ).toBeGreaterThanOrEqual(4.5);
    await page.locator("[data-editor-keep]").click();
  }
  await expect(page.locator(".text-editor textarea")).toHaveValue(
    "unsaved themed buffer",
  );
  expect(
    await page
      .locator(".editor-tab-name")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
});
