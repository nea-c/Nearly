import { test, expect } from "@playwright/test";

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1180, height: 850 },
    { width: 800, height: 650 },
  ]) {
    test(`${theme} dialogs and workspace fit ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/");
      const prefix = `test-results/current-${theme}-${viewport.width}x${viewport.height}`;
      await expect(page.locator("#connect-form .primary")).toBeInViewport();
      await page.screenshot({ path: `${prefix}-connection.png` });
      await page.locator("#connect-form .primary").click();
      await expect(page.locator("[data-list=local]")).toBeVisible();
      await page.screenshot({ path: `${prefix}-workspace.png` });
      await page.locator("#settings-toggle").click();
      await expect(page.locator("#settings-popup")).toBeInViewport({
        ratio: 1,
      });
      await page.screenshot({ path: `${prefix}-settings-popup.png` });
      await page.locator("#settings-close").click();
      for (const side of ["local", "remote"]) {
        const box = await page.locator(`[data-pane=${side}]`).boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(239);
        expect(box.height).toBeGreaterThan(400);
      }
      await page.locator("#prepare").click();
      await expect(page.locator("#start-form .primary")).toBeInViewport({
        ratio: 1,
      });
      await page.screenshot({ path: `${prefix}-start.png` });
      await page.locator("#exclusion-details summary").click();
      await page
        .locator("#exclusion-rules")
        .fill("node_modules/\n*.log\n!keep.log");
      await page.locator("#preset-name").fill("Web project");
      await page.locator("#preset-save").scrollIntoViewIfNeeded();
      await expect(page.locator("#preset-save")).toBeInViewport();
      await expect(page.locator("#preset-duplicate")).toBeInViewport();
      await page.locator("#start-form .primary").scrollIntoViewIfNeeded();
      await expect(page.locator("#start-form .primary")).toBeInViewport();
      await page.screenshot({ path: `${prefix}-settings-expanded.png` });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const dialog = await page
        .locator(".dialog")
        .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(dialog.scroll).toBeLessThanOrEqual(dialog.width);
    });
  }
}
