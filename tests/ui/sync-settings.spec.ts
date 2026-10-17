import { test, expect } from "@playwright/test";
async function connected(page) {
  await page.goto("/");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await expect(page.locator("#prepare")).toBeEnabled();
}
async function currentPair(page, path, committed = path) {
  await page.locator("#cancel").click();
  await page.locator("#local-path").fill(path);
  await page.locator("#local-path").press("Enter");
  await expect(page.locator("#local-path")).toHaveValue(committed);
  await page.locator("#prepare").click();
  await expect(page.locator("#start-form [name=local]")).toHaveAttribute("type", "hidden");
  await expect(page.locator("[data-sync-source]")).toHaveText(committed);
  await page.locator("#exclusion-details summary").click();
}
test("splitter persists only on release, survives resize and keeps global theme", async ({
  page,
}) => {
  await connected(page);
  await page.locator("#settings-toggle").click();
  await page.locator("#theme-select").selectOption("dark");
  await page.locator("#settings-close").click();
  const area = await page.locator(".panes").boundingBox();
  const handle = await page.locator("#pane-splitter").boundingBox();
  const before = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("syncfiles-v1")).localPaneRatio ?? 0.5,
  );
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 60);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.63, handle.y + 60, {
    steps: 5,
  });
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("syncfiles-v1")).localPaneRatio ?? 0.5,
    ),
  ).toBe(before);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("syncfiles-v1")).localPaneRatio,
      ),
    )
    .toBeGreaterThan(0.6);
  const ratio = await page.evaluate(
    () => JSON.parse(localStorage.getItem("syncfiles-v1")).localPaneRatio,
  );
  await page.setViewportSize({ width: 800, height: 650 });
  const left = await page.locator("[data-pane=local]").boundingBox();
  const right = await page.locator("[data-pane=remote]").boundingBox();
  expect(left.width).toBeGreaterThanOrEqual(239);
  expect(right.width).toBeGreaterThanOrEqual(239);
  await page.setViewportSize({ width: 1280, height: 920 });
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#theme-select")).toHaveValue("dark");
  await page.locator("#settings-close").click();
  const after = await page.locator("[data-pane=local]").boundingBox(),
    all = await page.locator(".panes").boundingBox();
  expect(Math.abs(after.width / (all.width - 6) - ratio)).toBeLessThan(0.01);
  await page.locator("#pane-splitter").focus();
  await page.keyboard.press("Home");
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("syncfiles-v1")).localPaneRatio,
      ),
    )
    .toBe(0.5);
});
test("sync setting presets save, duplicate, rename and retain independent combo drafts", async ({
  page,
}) => {
  await connected(page);
  await page.locator("#prepare").click();
  await expect(page.locator("#delete-removed")).not.toBeChecked();
  await expect(page.locator("#recursive-sync")).toBeChecked();
  await expect(page.locator("#exclusion-details")).not.toHaveAttribute("open");
  await page.locator("#exclusion-details summary").click();
  await page
    .locator("#exclusion-rules")
    .fill("node_modules/\n*.log\n!keep.log");
  await page.locator("#preset-name").fill("Web");
  await page.locator("#preset-save").click();
  await expect(page.locator("#preset-result")).toContainText("保存しました");
  const original = await page.locator("#sync-preset").inputValue();
  await page.locator("#preset-duplicate").click();
  await expect(page.locator("#preset-result")).toContainText("複製");
  const copy = await page.locator("#sync-preset").inputValue();
  expect(copy).not.toBe(original);
  await page.locator("#preset-name").fill("Top-level");
  await page.locator("#recursive-sync").uncheck();
  await page.locator("#delete-removed").check();
  await expect(page.locator("#delete-warning")).toBeVisible();
  await expect(page.locator("#delete-warning")).toContainText("開始時の比較");
  await expect(page.locator("#delete-warning")).toContainText("ローカルにないリモート");
  await page.locator("#preset-save").click();
  await expect(page.locator("#preset-result")).toContainText("保存しました");
  await page.locator("#sync-preset").selectOption(original);
  await expect(page.locator("#recursive-sync")).toBeChecked();
  await expect(page.locator("#delete-removed")).not.toBeChecked();
  await currentPair(page, "C:\\one");
  await expect(page.locator("#exclusion-rules")).toHaveValue("");
  await page.locator("#sync-preset").selectOption(copy);
  await page.locator("#exclusion-rules").fill("custom-one/");
  // Save the first pair by starting it before opening a different explorer pair.
  await page.locator("#start-form .primary").click();
  await page.locator("#prepare").click();
  await page.locator("#prepare").click();
  await currentPair(page, "C:\\two");
  await expect(page.locator("#exclusion-rules")).toHaveValue("");
  await currentPair(page, "c:/one/", "c:\\one");
  await expect(page.locator("#exclusion-rules")).toHaveValue("custom-one/");
  await expect(page.locator("#recursive-sync")).not.toBeChecked();
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#prepare")).toHaveText("同期停止");
  await page.locator("#prepare").click();
  await page.locator("#prepare").click();
  await expect(page.locator("#sync-preset")).toHaveValue(copy);
  await expect(page.locator("#exclusion-rules")).toHaveValue("custom-one/");
  await expect(page.locator("#delete-removed")).toBeChecked();
  await page.locator("#cancel").click();
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await page.locator("#prepare").click();
  await expect(page.locator("#exclusion-rules")).toHaveValue("custom-one/");
  const presets = await page.evaluate(
    () => JSON.parse(localStorage.getItem("syncfiles-v1")).syncPresets,
  );
  expect(presets.map((p) => p.name)).toEqual(["Web", "Top-level"]);
  expect(Object.keys(presets[0]).sort()).toEqual([
    "deleteRemoved",
    "exclusionRules",
    "id",
    "name",
    "recursive",
  ]);
});
test("native session connection clears the secret and cancellation never connects the tab", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.calls = [];
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
                  name: "A",
                  host: "a.invalid",
                  port: 22,
                  user: "fixture",
                  mode: "sftp",
                  auth: "key",
                  keyFile: "fixture.ppk",
                  hostKey: "fixture",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "connect_session")
            return await new Promise((resolve, reject) => {
              window.rejectConnect = reject;
            });
          if (cmd === "disconnect_session") window.disconnectRequested = true;
        },
      },
    };
  });
  await page.goto("/");
  await page
    .locator("#connect-form [name=passphrase]")
    .fill("temporary-secret");
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-cancel")).toBeEnabled();
  await expect(page.locator("#connect-form [name=passphrase]")).toHaveValue("");
  await page.locator("#connect-cancel").click();
  await expect(page.locator("#connect-cancel")).toBeDisabled();
  await expect(page.locator("#connect-form .primary")).toBeDisabled();
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-close]")).toHaveCount(1);
  await expect(page.locator("#connect-form")).toBeVisible();
  expect(
    await page.evaluate(
      () => window.calls.filter((c) => c.cmd === "prepare_session").length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => window.calls.filter((c) => c.cmd === "connect_session").length,
    ),
  ).toBe(1);
  await page.evaluate(() => window.rejectConnect(Error("fixture cancelled")));
  // A cancelled attempt displays the owned localized cancellation, not its late transport error.
  await expect(page.locator("#connect-form .form-error")).toContainText("接続を中止しました");
  await expect(page.locator("#connect-form .primary")).toBeEnabled();
  await page.locator("#connect-form .primary").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.calls.filter((c) => c.cmd === "connect_session").length,
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    window.rejectConnect(Error("fixture retry rejected")),
  );
  await expect(page.locator("#connect-form .form-error")).toContainText("retry rejected");
  await expect(page.locator("#connect-cancel")).toHaveCount(0);
  await expect(page.locator("#connect-form")).toBeVisible();
  await expect(page.locator("[data-entry]")).toHaveCount(0);
  await expect(page.locator("#prepare")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.calls.some(
        (c) => c.cmd === "list_remote" || c.cmd === "start_sync",
      ),
    ),
  ).toBe(false);
});

test("default label and examples never rename saved presets or become actual exclusion rules", async ({
  page,
}) => {
  await connected(page);
  await page.locator("#prepare").click();
  await expect(page.locator('#sync-preset option[value=""]')).toHaveText(
    "デフォルト",
  );
  await page.locator("#exclusion-details summary").click();
  await expect(page.locator("#exclusion-rules")).toHaveAttribute(
    "placeholder",
    "sample/\n*.txt\n!sample.txt",
  );
  await expect(page.locator("#exclusion-rules")).toHaveValue("");
  await page.locator("#preset-name").fill("カスタム設定");
  await page.locator("#preset-save").click();
  await expect(page.locator("#sync-preset option:checked")).toHaveText(
    "カスタム設定",
  );
  const id = await page.locator("#sync-preset").inputValue();
  expect(id).not.toBe("");
  await page.locator("#start-form .primary").click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("syncfiles-v1")),
  );
  expect(saved.syncPresets[0].name).toBe("カスタム設定");
  expect(saved.syncPresets[0].exclusionRules).toBe("");
  expect(Object.values(saved.exclusions)).toEqual([""]);
  await page.locator("#prepare").click();
  await page.reload();
  await page.locator("#connect-form .primary").click();
  await page.locator("#prepare").click();
  await expect(page.locator('#sync-preset option[value=""]')).toHaveText(
    "デフォルト",
  );
  await expect(page.locator("#sync-preset option:checked")).toHaveText(
    "カスタム設定",
  );
  await expect(page.locator("#sync-preset")).toHaveValue(id);
  await expect(page.locator("#exclusion-rules")).toHaveValue("");
});

test("preset buttons align with the input and placeholders remain readable in both themes", async ({
  page,
}) => {
  await connected(page);
  for (const theme of ["light", "dark"]) {
    await page.locator("#settings-toggle").click();
    await page.locator("#theme-select").selectOption(theme);
    await page.locator("#settings-close").click();
    await page.locator("#prepare").click();
    await page.locator("#exclusion-details summary").click();
    for (const width of [1180, 800]) {
      await page.setViewportSize({ width, height: 850 });
      await page.locator("#preset-name").scrollIntoViewIfNeeded();
      const input = await page.locator("#preset-name").boundingBox();
      const label = await page
        .locator('label[for="preset-name"]')
        .boundingBox();
      expect(label.y + label.height).toBeLessThanOrEqual(input.y);
      for (const selector of ["#preset-save", "#preset-duplicate"]) {
        const button = await page.locator(selector).boundingBox();
        expect(
          Math.abs(button.y + button.height / 2 - input.y - input.height / 2),
        ).toBeLessThanOrEqual(1);
      }
      const colors = await page.evaluate(() => {
        const luminance = (value) => {
          const c = value
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              v /= 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
        };
        return ["#preset-name", "#exclusion-rules"].map((selector) => {
          const el = document.querySelector(selector),
            normal = getComputedStyle(el),
            placeholder = getComputedStyle(el, "::placeholder");
          const a = luminance(placeholder.color),
            b = luminance(normal.backgroundColor);
          return {
            normal: normal.color,
            placeholder: placeholder.color,
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
      });
      for (const color of colors) {
        expect(color.normal).not.toBe(color.placeholder);
        expect(color.contrast).toBeGreaterThanOrEqual(4.5);
      }
      await page.screenshot({
        path: "test-results/preset-controls-" + theme + "-" + width + ".png",
      });
    }
    await page.setViewportSize({ width: 400, height: 850 });
    const row = page.locator(".preset-controls");
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await expect(page.locator("#preset-duplicate")).toBeVisible();
    await page.locator("#cancel").click();
    await page.setViewportSize({ width: 1180, height: 850 });
  }
});
