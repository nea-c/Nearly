import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.calls = [];
    const entries = [
      {
        name: "file10.txt",
        dir: false,
        size: 10,
        modifiedAt: 100,
        permissions: 0o644,
        owner: "1001:1001",
      },
      {
        name: "file2.txt",
        dir: false,
        size: 2,
        modifiedAt: 200,
        permissions: 0o600,
        owner: "1002:1002",
      },
      { name: "file1.txt", dir: false, size: 100 },
    ];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          window.calls.push({ cmd, args });
          if (cmd === "load_settings")
            return (
              JSON.parse(
                localStorage.getItem("column-sort-fixture") || "null",
              ) || {
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
                    keyFile: "fixture",
                    hostKey: "pin",
                  },
                ],
                history: {},
              }
            );
          if (cmd === "save_settings") {
            localStorage.setItem(
              "column-sort-fixture",
              JSON.stringify(args.data),
            );
            return;
          }
          if (cmd === "default_folder") return "C:\\root";
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "connect_session") return { path: "/", entries };
          if (cmd === "list_local" || cmd === "list_remote") return entries;
        },
      },
    };
  });
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator('[data-pane="local"]')).toHaveAttribute(
    "aria-busy",
    "false",
  );
});
const names = (page, side) =>
  page
    .locator(`[data-list="${side}"] [data-entry]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-name")));
const header = (page, side, id) =>
  page.locator(`[data-list="${side}"] [data-column-sort="${id}"]`);
test("left header sorts natural names and numeric values independently while selection keeps file identity", async ({
  page,
}) => {
  const local = page.locator('[data-list="local"]');
  expect(await names(page, "local")).toEqual([
    "file1.txt",
    "file2.txt",
    "file10.txt",
  ]);
  expect(await names(page, "remote")).toEqual([
    "file1.txt",
    "file2.txt",
    "file10.txt",
  ]);
  await expect(local.locator('th[data-column="name"]')).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await local.locator('[data-name="file10.txt"]').click();
  await header(page, "local", "name").click();
  expect(await names(page, "local")).toEqual([
    "file10.txt",
    "file2.txt",
    "file1.txt",
  ]);
  await expect(local.locator('[data-name="file10.txt"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await names(page, "remote")).toEqual([
    "file1.txt",
    "file2.txt",
    "file10.txt",
  ]);
  await header(page, "local", "name").click();
  expect(await names(page, "local")).toEqual([
    "file1.txt",
    "file2.txt",
    "file10.txt",
  ]);
  await header(page, "local", "size").click();
  expect(await names(page, "local")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  await header(page, "remote", "modified").click();
  expect(await names(page, "remote")).toEqual([
    "file10.txt",
    "file2.txt",
    "file1.txt",
  ]);
  await header(page, "remote", "modified").click();
  expect(await names(page, "remote")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  await page.locator('[data-refresh="local"]').click();
  await expect(page.locator('[data-pane="local"]')).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(await names(page, "local")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  const first = await page.locator("[data-tab]").getAttribute("data-tab");
  await page.locator("#add-tab").click();
  await page.locator("#connect-form .primary").click();
  expect(await names(page, "remote")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  await page.locator(`[data-tab="${first}"]`).click();
  expect(await names(page, "remote")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("column-sort-fixture") || "{}")
            .paneColumns?.remote?.sort,
      ),
    )
    .toEqual({ column: "modified", direction: "descending" });
  await page.reload();
  await page.locator("#connect-form .primary").click();
  expect(await names(page, "remote")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  expect(await names(page, "local")).toEqual([
    "file2.txt",
    "file10.txt",
    "file1.txt",
  ]);
  await expect(
    page.locator('[data-list="remote"] th[data-column="modified"]'),
  ).toHaveAttribute("aria-sort", "descending");
});
test("right menu is visibility only, metadata remote-only and name mandatory even after header drag", async ({
  page,
}) => {
  await header(page, "local", "name").click({ button: "right" });
  await expect(page.locator('[data-column-visible="permissions"]')).toHaveCount(
    0,
  );
  await expect(page.locator("[data-column-move]")).toHaveCount(0);
  await page.locator("[data-column-close]").click();
  await header(page, "remote", "name").click({ button: "right" });
  await page.locator('[data-column-visible="permissions"]').check();
  await page.locator('[data-column-visible="owner"]').check();
  await page.locator("[data-column-close]").click();
  await expect(
    page.locator(
      '[data-list="remote"] [data-name="file10.txt"] [data-cell="permissions"]',
    ),
  ).toHaveText("rw-r--r--");
  await expect(
    page.locator(
      '[data-list="remote"] [data-name="file10.txt"] [data-cell="owner"]',
    ),
  ).toHaveText("1001:1001");
  await page.evaluate(() => {
    const pane = document.querySelector('[data-list="local"]'),
      from = pane.querySelector('[data-column-sort="name"]'),
      to = pane.querySelector('th[data-column="size"]'),
      bounds = to.getBoundingClientRect(),
      dataTransfer = new DataTransfer();
    from.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer }),
    );
    to.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: bounds.right - 2,
      }),
    );
  });
  await expect(page.locator('[data-list="local"] th').first()).toHaveAttribute(
    "data-column",
    "size",
  );
  await expect(
    page.locator('[data-list="local"] th[data-column="name"]'),
  ).toHaveAttribute("aria-sort", "ascending");
  await header(page, "local", "size").click({ button: "right" });
  await expect(page.locator('[data-column-visible="name"]')).toBeDisabled();
  await page.locator('[data-column-visible="size"]').uncheck();
  await page.locator("[data-column-close]").click();
  await expect(page.locator('[data-list="local"] th').first()).toHaveAttribute(
    "data-column",
    "name",
  );
  expect(await names(page, "local")).toEqual([
    "file1.txt",
    "file2.txt",
    "file10.txt",
  ]);
});
