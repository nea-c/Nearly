import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.calls = [];
    const entries = [
      { name: "folder10", dir: true, size: 0 },
      { name: "folder2", dir: true, size: 0, hidden: true },
      { name: "a.txt", dir: false, size: 4 },
      { name: ".visible-local", dir: false, size: 4 },
      { name: ".hidden-remote", dir: false, size: 4 },
    ];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          window.calls.push({ cmd, args });
          if (cmd === "load_settings")
            return {
              version: 1,
              profiles: [
                {
                  id: "a",
                  name: "Fixture",
                  host: "fixture.invalid",
                  port: 22,
                  user: "test",
                  mode: "sftp",
                  auth: "key",
                  keyFile: "generated",
                  hostKey: "pin",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\root";
          if (cmd === "list_drives") return [{ name: "C:", path: "C:\\" }];
          if (cmd === "connect_session")
            return {
              path: "/root",
              entries: entries.map((e) => ({
                ...e,
                hidden: e.name.startsWith(".") || e.hidden,
              })),
            };
          if (cmd === "list_local") return entries;
          if (cmd === "list_remote")
            return entries.map((e) => ({
              ...e,
              hidden: e.name.startsWith(".") || e.hidden,
            }));
          if (cmd === "run_file_operation")
            throw Error("unexpected file operation");
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-list=local] [data-entry]")).toHaveCount(5);
});

for (const theme of ["light", "dark"])
  test(`hidden icon and name only are muted and selected text stays readable in ${theme}`, async ({
    page,
  }) => {
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await page.locator("#settings-close").click();
    for (const side of ["local", "remote"]) {
      const hidden = page.locator(`[data-list=${side}] [data-name=folder2]`);
      const visible = page.locator(`[data-list=${side}] [data-name=folder10]`);
      await expect(hidden.locator(".hidden-item-label")).toHaveCount(1);
      await expect(visible.locator(".hidden-item-label")).toHaveCount(0);
      const appearance = await hidden.evaluate((row) => ({
        row: getComputedStyle(row).opacity,
        label: getComputedStyle(row.querySelector(".hidden-item-label")).color,
        icon: getComputedStyle(row.querySelector("[data-entry-icon]")).opacity,
      }));
      expect(appearance.row).toBe("1");
      expect(appearance.label).not.toBe(await visible.locator('[data-cell=name]').evaluate(cell=>getComputedStyle(cell).color));
      expect(Number(appearance.icon)).toBeLessThan(1);
      await hidden.click();
      expect(
        await hidden.evaluate((row) =>
          getComputedStyle(row.querySelector(".hidden-item-label")).color,
        ),
      ).not.toBe(appearance.label);
    }
    await expect(
      page.locator(
        '[data-list=local] [data-name=".visible-local"] .hidden-item-label',
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(
        '[data-list=remote] [data-name=".hidden-remote"] .hidden-item-label',
      ),
    ).toHaveCount(1);
  });

test("parent row remains pinned under every sort, navigates like Up and disappears at roots", async ({
  page,
}) => {
  for (const side of ["local", "remote"]) {
    const parent = page.locator(`[data-parent-row=${side}]`);
    await expect(parent).toHaveCount(1);
    await expect(parent).toHaveAttribute("data-no-marquee", "");
    for (const column of ["name", "size"]) {
      await page
        .locator(`[data-pane=${side}] [data-column-sort=${column}]`)
        .click();
      expect(
        await page
          .locator(`[data-list=${side}] tbody tr`)
          .first()
          .getAttribute("data-parent-row"),
      ).toBe(side);
    }
    await parent.dblclick();
    await expect(page.locator(`#${side}-path`)).toHaveValue(
      side === "local" ? "C:\\" : "/",
    );
    await expect(parent).toHaveCount(0);
    await expect(page.locator(`[data-up=${side}]`)).toBeDisabled();
    await page.locator(`[data-back=${side}]`).click();
    await expect(parent).toHaveCount(1);
    await parent.click();
    await parent.press("Enter");
    await expect(page.locator(`#${side}-path`)).toHaveValue(
      side === "local" ? "C:\\" : "/",
    );
  }
});

test("parent is excluded from bulk selection, clipboard and destructive file actions", async ({
  page,
}) => {
  for (const side of ["local", "remote"]) {
    const parent = page.locator(`[data-parent-row=${side}]`);
    const list = page.locator(`[data-list=${side}]`);
    await parent.click();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+x");
    expect(
      await page.evaluate(
        () => window.calls.filter((c) => c.cmd === "run_file_operation").length,
      ),
    ).toBe(0);
    await expect(page.locator("#file-operation-form")).toHaveCount(0);
    await list.focus();
    await page.keyboard.press("Control+a");
    await expect(list.locator("[data-entry][aria-selected=true]")).toHaveCount(
      5,
    );
    await expect(parent).not.toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
  }
});
