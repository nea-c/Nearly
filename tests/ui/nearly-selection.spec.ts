import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.fixtureCalls = [];
    const entries = () => [
      { name: "folder", dir: true, size: 0 },
      ...Array.from({ length: 28 }, (_, i) => ({
        name: `file${String(i).padStart(2, "0")}.txt`,
        dir: false,
        size: 1,
      })),
    ];
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          window.fixtureCalls.push({ cmd, args });
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
                  keyFile: "fixture",
                  hostKey: "pin",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\root";
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "connect_session")
            return { path: "/root", entries: entries() };
          if (cmd === "list_local" || cmd === "list_remote") return entries();
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

async function whitespace(page, name) {
  const row = page.locator(`[data-list="local"] [data-name="${name}"]`);
  const cell = await row.locator('td[data-cell="name"]').boundingBox();
  return { x: cell!.x + cell!.width - 9, y: cell!.y + cell!.height / 2 };
}
const chosen = (page) =>
  page
    .locator('[data-list="local"] [data-entry][aria-selected="true"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-name")));

test("explicit different-row click immediately after marquee is not swallowed", async ({
  page,
}) => {
  const start = await whitespace(page, "file00.txt"),
    end = await whitespace(page, "file03.txt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  expect(await chosen(page)).toEqual([
    "file00.txt",
    "file01.txt",
    "file02.txt",
    "file03.txt",
  ]);
  // No timeout: this must remain usable inside the synthetic-click guard window.
  const next = await whitespace(page, "file05.txt");
  await page.mouse.click(next.x, next.y);
  expect(await chosen(page)).toEqual(["file05.txt"]);
});

test("stationary pointer drag recomputes selected rows when the list scrolls", async ({
  page,
}) => {
  const list = page.locator('[data-list="local"]');
  const start = await whitespace(page, "file00.txt"),
    end = await whitespace(page, "file03.txt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  expect(await chosen(page)).toEqual([
    "file00.txt",
    "file01.txt",
    "file02.txt",
    "file03.txt",
  ]);
  await list.evaluate((el) => (el.scrollTop += 90));
  await expect
    .poll(() => chosen(page))
    .not.toEqual(["file00.txt", "file01.txt", "file02.txt", "file03.txt"]);
  const expected = await chosen(page);
  expect(expected.length).toBeGreaterThan(4);
  await page.mouse.up();
  expect(await chosen(page)).toEqual(expected);
});

test("synthetic parent remains outside file selection and uses existing Up on selected Enter", async ({
  page,
}) => {
  const list = page.locator('[data-list="local"]'),
    parent = list.locator('[data-parent-row="local"]');
  await expect(parent).toHaveCount(1);
  await expect(parent).not.toHaveAttribute("data-entry");
  await expect(parent).toHaveAttribute("data-no-marquee", "");
  expect(
    await list.locator("tbody tr").first().getAttribute("data-parent-row"),
  ).toBe("local");
  await parent.click();
  expect(await chosen(page)).toEqual([]);
  await expect(page.locator('[data-selection-count="local"]')).toHaveText("");
  await page.keyboard.press("Control+a");
  expect((await chosen(page)).length).toBe(29);
  expect(await chosen(page)).not.toContain("..");
  await parent.click();
  await page.keyboard.press("Enter");
  await expect(page.locator("#local-path")).toHaveValue("C:\\");
  await expect(
    page.locator('[data-list="local"] [data-parent-row]'),
  ).toHaveCount(0);
  const paths = await page.evaluate(() =>
    window.fixtureCalls
      .filter((c) => c.cmd === "list_local")
      .map((c) => c.args.path),
  );
  expect(paths).toContain("C:\\");
});

test("deselected parent cannot navigate Up with Enter and parent focus preserves workspace shortcuts", async ({
  page,
}) => {
  const parent = page.locator('[data-parent-row="local"]');
  await parent.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Enter");
  await expect(page.locator("#local-path")).not.toHaveValue("C:\\");
  await parent.click();
  await page.keyboard.press("Control+t");
  await expect(page.locator("[data-tab]")).toHaveCount(2);
  await expect(page.locator("#connect-form")).toBeVisible();
});

test("row whitespace click jitter retains normal ctrl/shift clicks and double-click navigation", async ({
  page,
}) => {
  const point = await whitespace(page, "file00.txt");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 2, point.y + 1);
  await page.mouse.up();
  expect(await chosen(page)).toEqual(["file00.txt"]);
  await page
    .locator('[data-list="local"] [data-name="file02.txt"]')
    .click({ modifiers: ["Control"] });
  expect(await chosen(page)).toEqual(["file00.txt", "file02.txt"]);
  await page
    .locator('[data-list="local"] [data-name="file04.txt"]')
    .click({ modifiers: ["Shift"] });
  expect(await chosen(page)).toEqual([
    "file02.txt",
    "file03.txt",
    "file04.txt",
  ]);
  const folder = await whitespace(page, "folder");
  await page.mouse.dblclick(folder.x, folder.y);
  await expect(page.locator("#local-path")).toHaveValue("C:\\root\\folder");
});

test("row whitespace drag selects range across render without endpoint-click overwrite; Escape and blur restore prior names", async ({
  page,
}) => {
  let start = await whitespace(page, "file00.txt"),
    end = await whitespace(page, "file03.txt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => chosen(page))
    .toEqual(["file00.txt", "file01.txt", "file02.txt", "file03.txt"]);
  await page.waitForTimeout(450);
  start = await whitespace(page, "file04.txt");
  end = await whitespace(page, "file06.txt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await chosen(page)).toEqual([
    "file00.txt",
    "file01.txt",
    "file02.txt",
    "file03.txt",
  ]);
  await page.waitForTimeout(450);
  start = await whitespace(page, "file04.txt");
  end = await whitespace(page, "file06.txt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  expect(await chosen(page)).toEqual([
    "file00.txt",
    "file01.txt",
    "file02.txt",
    "file03.txt",
  ]);
});
