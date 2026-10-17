import { test, expect } from "@playwright/test";

for (const theme of ["light", "dark"])
  test(`remote metadata has finite fixed widths and reachable right edge under narrow ${theme} CSP`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 760 });
    await page.route("**/", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          "<head>",
          '<head><meta http-equiv="Content-Security-Policy" content="style-src-attr \'none\'">',
        ),
      });
    });
    await page.addInitScript(
      ({ theme }) => {
        const legacy = {
          order: ["name", "size", "type", "modified"],
          hidden: [],
          widths: {},
        };
        const entries = [
          { name: "a-file", dir: false, size: 1 },
          { name: "folder10", dir: true, size: 0 },
          { name: "folder2", dir: true, size: 0 },
        ];
        let saved = {
          version: 1,
          theme,
          profiles: [
            {
              id: "a",
              name: "Fixture",
              host: "fixture.invalid",
              port: 22,
              user: "test",
              mode: "sftp",
              auth: "key",
              keyFile: "fixture",
              hostKey: "pin",
            },
          ],
          history: {},
          paneColumns: { local: legacy, remote: legacy },
        };
        window.__TAURI__ = {
          core: {
            invoke: async (cmd, args) => {
              if (cmd === "load_settings") return saved;
              if (cmd === "save_settings") {
                saved = args.data;
                return;
              }
              if (cmd === "default_folder") return "C:\\root";
              if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
              if (cmd === "connect_session") return { path: "/", entries };
              if (cmd === "list_local" || cmd === "list_remote") return entries;
            },
          },
        };
      },
      { theme },
    );
    await page.goto("/");
    await page.locator("#connect-form .primary").click();
    const pane = page.locator('[data-list="remote"]');
    await expect(pane.locator('th[data-column="name"]')).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(
      await pane
        .locator("[data-entry]")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-name"))),
    ).toEqual(["folder2", "folder10", "a-file"]);
    await pane.locator('[data-column-sort="name"]').click({ button: "right" });
    await page.locator('[data-column-visible="permissions"]').check();
    await page.locator('[data-column-visible="owner"]').check();
    await page.locator("[data-column-close]").click();
    const widths = await pane.evaluate((el) => ({
      width: (el.querySelector("table") as HTMLElement).style.width,
      cols: Array.from(el.querySelectorAll("col")).map(
        (c) => (c as HTMLElement).style.width,
      ),
      client: el.clientWidth,
      scroll: el.scrollWidth,
    }));
    expect(widths.width).toBe("890px");
    expect(widths.cols).toEqual([
      "280px",
      "100px",
      "100px",
      "170px",
      "120px",
      "120px",
    ]);
    expect(widths.scroll).toBeGreaterThan(widths.client + 100);
    await pane.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const edge = await pane.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      max: el.scrollWidth - el.clientWidth,
      right: el
        .querySelector('th[data-column="owner"]')!
        .getBoundingClientRect().right,
      viewport: el.getBoundingClientRect().right,
    }));
    expect(edge.scrollLeft).toBeGreaterThan(0);
    expect(Math.abs(edge.scrollLeft - edge.max)).toBeLessThanOrEqual(1);
    expect(edge.right).toBeLessThanOrEqual(edge.viewport + 2);
    await expect(
      page.locator('[data-list="local"] th[data-column="owner"]'),
    ).toHaveCount(0);
  });
