import { test, expect } from "@playwright/test";

async function boot(
  page,
  options: {
    language?: string;
    compactExplorer?: boolean;
    theme?: string;
    preferenceWarnings?: string[];
    holdSave?: boolean;
    failSave?: boolean;
  } = {},
) {
  await page.addInitScript((options) => {
    window.calls = [];
    const profile = {
      id: "literal",
      name: "設定",
      host: "fixture.invalid",
      port: 22,
      user: "設定",
      auth: "key",
      mode: "sftp",
      keyFile: "C:\\設定.ppk",
      hostKey: "SHA256:fixture",
    };
    const entries = Array.from({ length: 150 }, (_, i) => ({
      name: i === 0 ? "設定" : `file${String(i).padStart(3, "0")}.txt`,
      dir: i === 0,
      size: i + 1,
    }));
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          window.calls.push({ cmd, args });
          if (cmd === "load_settings") {
            if (!localStorage.getItem("compact-locale"))
              localStorage.setItem(
                "compact-locale",
                JSON.stringify({
                  version: 1,
                  settingsRevision: 18,
                  preferenceWarnings: options.preferenceWarnings,
                  theme: options.theme ?? "light",
                  language: options.language,
                  compactExplorer: options.compactExplorer,
                  profiles: [profile],
                  history: { sentinel: "設定" },
                  localPaneRatio: 0.62,
                  exclusions: { sentinel: "設定/**" },
                }),
              );
            return JSON.parse(localStorage.getItem("compact-locale"));
          }
          if (cmd === "save_settings") {
            if (options.holdSave)
              await new Promise(
                (resolve) => (window.releaseAppearance = resolve),
              );
            if (options.failSave) throw Error("fixture revision conflict");
            const prior = JSON.parse(localStorage.getItem("compact-locale"));
            if (prior.settingsRevision !== args.data.settingsRevision)
              throw Error("stale settings revision");
            localStorage.setItem(
              "compact-locale",
              JSON.stringify({
                ...args.data,
                settingsRevision: prior.settingsRevision + 1,
              }),
            );
            return prior.settingsRevision + 1;
          }
          if (cmd === "default_folder") return "C:\\設定";
          if (cmd === "prepare_session" || cmd === "disconnect_session") return;
          if (cmd === "connect_session") return { path: "/設定", entries };
          if (cmd === "list_drives") return [{ name: "C:", path: "C:\\" }];
          if (cmd === "list_local" || cmd === "list_remote") return entries;
          if (cmd === "start_sync" || cmd === "run_file_operation")
            throw Error("Unexpected transfer");
        },
      },
    };
  }, options);
  await page.goto("/");
  await expect(page.locator("#connect-form")).toBeVisible();
}
const saved = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("compact-locale")));
const saves = (page) =>
  page.evaluate(() => window.calls.filter((c) => c.cmd === "save_settings"));
async function settings(page) {
  if (!(await page.locator("#settings-popup").isVisible()))
    await page.locator("#settings-toggle").click();
}
async function language(page, value) {
  await settings(page);
  await page.locator("#language-select").selectOption(value);
  await expect(page.locator("#language-select")).toBeEnabled();
}
async function connect(page) {
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-pane=local]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}

test("missing defaults do not write settings; language is first in DOM and visual order", async ({
  page,
}) => {
  await boot(page);
  expect(await saves(page)).toEqual([]);
  await settings(page);
  await expect(page.locator("#language-select")).toHaveValue("ja");
  await expect(page.locator("#compact-explorer")).not.toBeChecked();
  await expect(page.locator("#language-select option")).toHaveText([
    "English",
    "日本語",
  ]);
  await expect(page.locator(".language-picker")).toContainText(
    "Language / 言語",
  );
  expect(
    await page
      .locator("#settings-popup select,#settings-popup input")
      .evaluateAll((nodes) => nodes.map((n) => n.id)),
  ).toEqual(["language-select", "theme-select", "compact-explorer"]);
  const boxes = await Promise.all(
    [".language-picker", ".theme-picker", ".compact-explorer-option"].map((s) =>
      page.locator(s).boundingBox(),
    ),
  );
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
  expect(await saves(page)).toEqual([]);
});

test("language switch preserves inline password, user names and exact settings values", async ({
  page,
}) => {
  await boot(page);
  await page.locator("[name=passphrase]").fill("設定 secret");
  await page
    .locator("[name=passphrase]")
    .evaluate((n: HTMLInputElement) => n.setSelectionRange(1, 4));
  await language(page, "en");
  await expect(page.locator("#connection-title")).toHaveText("Connection");
  await expect(page.locator("#connect-form h2")).toHaveText("設定");
  await expect(page.locator("[name=passphrase]")).toHaveValue("設定 secret");
  expect(
    await page
      .locator("[name=passphrase]")
      .evaluate((n: HTMLInputElement) => [n.selectionStart, n.selectionEnd]),
  ).toEqual([1, 4]);
  const data = await saved(page);
  expect(data.language).toBe("en");
  expect(data.settingsRevision).toBe(19);
  expect(data.history.sentinel).toBe("設定");
  expect(data.exclusions.sentinel).toBe("設定/**");
  expect(data.profiles[0].name).toBe("設定");
  expect(JSON.stringify(data)).not.toContain("secret");
  expect(
    await page.evaluate(() =>
      window.calls.filter((c) =>
        ["connect_session", "start_sync", "run_file_operation"].includes(c.cmd),
      ),
    ),
  ).toEqual([]);
  await page.reload();
  await expect(page.locator("#connection-title")).toHaveText("Connection");
  await expect(page.locator("[name=passphrase]")).toHaveValue("");
});

test("profile modal preserves drafts when its overlay blocks settings; locale changes after closing", async ({page})=>{
 await boot(page);
 await page.locator('#edit-profile').click();
 await page.locator('#profile-form [name=name]').fill('設定 / draft');
 await page.locator('#profile-form [name=keyFile]').fill('C:\\設定\\秘密鍵.ppk');
 const gear=await page.locator('#settings-toggle').boundingBox();
 await page.mouse.click(gear!.x+gear!.width/2,gear!.y+gear!.height/2);
 await expect(page.locator('#language-select')).toHaveCount(0);
 await expect(page.locator('#profile-form [name=name]')).toHaveValue('設定 / draft');
 await expect(page.locator('#profile-form [name=keyFile]')).toHaveValue('C:\\設定\\秘密鍵.ppk');
 expect(await saves(page)).toEqual([]);
 await page.locator('#cancel').click();
 await language(page,'en');
 await page.locator('#settings-close').click();
 await page.locator('#edit-profile').click();
 await expect(page.locator('#dialog-title')).toHaveText('Connection profile');
 await expect(page.locator('#profile-form [name=name]')).toHaveValue('設定');
 await expect(page.locator('#cancel')).toHaveText('Cancel');
});

for (const theme of ["light", "dark", "midnight"])
  test(`${theme} compact uses existing row nodes and keeps selection, scroll and text size`, async ({
    page,
  }) => {
    await boot(page, { theme });
    await connect(page);
    const row = page.locator('[data-entry="local:4"]');
    await row.click();
    const before = await page.locator("[data-list=local]").evaluate((list) => {
      list.scrollTop = 400;
      const rows = [...list.querySelectorAll<HTMLElement>("[data-entry]")];
      const top =
        list.getBoundingClientRect().top +
        list.querySelector("thead")!.getBoundingClientRect().height;
      const anchor = rows.find((n) => n.getBoundingClientRect().bottom > top)!;
      window.compactRow = rows[4];
      window.compactAnchor = anchor;
      return {
        height: rows[4].getBoundingClientRect().height,
        font: getComputedStyle(rows[4]).fontSize,
        anchor: anchor.dataset.name,
        offset: anchor.getBoundingClientRect().top - top,
      };
    });
    await settings(page);
    await page.locator("#compact-explorer").check();
    await expect(page.locator("#compact-explorer")).toBeEnabled();
    const after = await page.locator("[data-list=local]").evaluate((list) => {
      const row = window.compactRow,
        anchor = window.compactAnchor;
      return {
        same: row.isConnected,
        height: row.getBoundingClientRect().height,
        font: getComputedStyle(row).fontSize,
        selected: row.getAttribute("aria-selected"),
        offset:
          anchor.getBoundingClientRect().top -
          list.getBoundingClientRect().top -
          list.querySelector("thead")!.getBoundingClientRect().height,
      };
    });
    expect(after.same).toBe(true);
    expect(after.height).toBeLessThan(before.height);
    expect(after.font).toBe(before.font);
    expect(after.selected).toBe("true");
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(1.5);
    await language(page, "en");
    await expect(page.locator('[data-name="設定"]').first()).toContainText(
      "設定",
    );
    await page.screenshot({path: `test-results/compact-locale-${theme}-en-on.png`});
 await page.locator('#compact-explorer').uncheck();
 await expect(page.locator('#compact-explorer')).toBeEnabled();
 await expect(page.locator('html')).not.toHaveAttribute('data-compact-explorer','true');
 await page.screenshot({path: `test-results/compact-locale-${theme}-en-off.png`});
 await page.locator('#compact-explorer').check();
 await expect(page.locator('#compact-explorer')).toBeEnabled();
 await page.screenshot({ path: `test-results/compact-locale-${theme}.png` });
    const disk = await saved(page);
    expect(disk.compactExplorer).toBe(true);
    expect(disk.language).toBe("en");
    expect(disk.theme).toBe(theme);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-compact-explorer",
      "true",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

test("held preference save uses loaded CAS and disables competing preferences until acknowledgment", async ({
  page,
}) => {
  await boot(page, { holdSave: true });
  await settings(page);
  await page.locator("#language-select").selectOption("en");
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseAppearance))
    .toBe("function");
  for (const id of ["language-select", "theme-select", "compact-explorer"])
    await expect(page.locator("#" + id)).toBeDisabled();
  const payload = (await saves(page))[0].args.data;
  expect(payload.settingsRevision).toBe(18);
  expect(payload.language).toBe("en");
  expect(payload.localPaneRatio).toBe(0.62);
  await page.evaluate(() => window.releaseAppearance());
  await expect(page.locator("#compact-explorer")).toBeEnabled();
  await page.locator("#compact-explorer").check();
  await expect.poll(() => saves(page).then((s) => s.length)).toBe(2);
  expect((await saves(page))[1].args.data.settingsRevision).toBe(19);
  await page.evaluate(() => window.releaseAppearance());
  await expect(page.locator("#compact-explorer")).toBeEnabled();
});

test("failed preference persistence locks further writes without retry or profile loss", async ({
  page,
}) => {
  await boot(page, { failSave: true });
  await languageFailure();
  async function languageFailure() {
    await settings(page);
    await page.locator("#language-select").selectOption("en");
    await expect(page.locator(".notice")).toContainText(
      "fixture revision conflict",
    );
  }
  for (const id of ["language-select", "theme-select", "compact-explorer"])
    await expect(page.locator("#" + id)).toBeDisabled();
  expect((await saves(page)).length).toBe(1);
  expect((await saved(page)).profiles[0].name).toBe("設定");
  expect((await saved(page)).settingsRevision).toBe(18);
  await page.locator("#language-select").evaluate((n: HTMLSelectElement) => {
    n.value = "ja";
    n.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect((await saves(page)).length).toBe(1);
});

test("connection tree compact chevrons stay within rows and language changes keep expansion", async ({
  page,
}) => {
  await boot(page);
  await settings(page);
  await page.locator("#compact-explorer").check();
  await expect(page.locator("#compact-explorer")).toBeEnabled();
  const boxes = await page.locator(".connection-node-row").evaluateAll((rows) =>
    rows.map((row) => {
      const toggle = row.querySelector(
        ".connection-toggle,.connection-toggle-placeholder",
      )!;
      return {
        row: row.getBoundingClientRect().toJSON(),
        toggle: toggle.getBoundingClientRect().toJSON(),
      };
    }),
  );
  for (const box of boxes) {
    expect(box.toggle.top).toBeGreaterThanOrEqual(box.row.top);
    expect(box.toggle.bottom).toBeLessThanOrEqual(box.row.bottom);
  }
  await language(page, "en");
  await expect(page.locator("[data-connection-select=literal]")).toContainText(
    "設定",
  );
});

test("dirty path draft and displayed selection survive language changes without navigation", async ({
  page,
}) => {
  await boot(page);
  await connect(page);
  await page.locator('[data-entry="local:2"]').click();
  const selected = await page
    .locator("[data-list=local] [aria-selected=true][data-entry]")
    .getAttribute("data-name");
  await page.locator("#local-path").fill("C:\\設定\\not-submitted");
  const requests = await page.evaluate(
    () => window.calls.filter((c) => c.cmd === "list_local").length,
  );
  await language(page, "en");
  await expect(page.locator("#local-path")).toHaveValue(
    "C:\\設定\\not-submitted",
  );
  await expect(
    page.locator("[data-list=local] [aria-selected=true][data-entry]"),
  ).toHaveAttribute("data-name", selected!);
  expect(
    await page.evaluate(
      () => window.calls.filter((c) => c.cmd === "list_local").length,
    ),
  ).toBe(requests);
  await language(page, "ja");
  await expect(page.locator("#local-path")).toHaveValue(
    "C:\\設定\\not-submitted",
  );
});

test("IME composition defers language and density changes without replacing its input", async ({
  page,
}) => {
  await boot(page);
  const field = page.locator("[name=passphrase]");
  await field.fill("設定");
  await field.evaluate((n) => {
    window.composingField = n;
    n.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "設" }),
    );
  });
  await settings(page);
  await expect(page.locator("#language-select")).toBeDisabled();
  await expect(page.locator("#compact-explorer")).toBeDisabled();
  expect(await page.evaluate(() => window.composingField.isConnected)).toBe(
    true,
  );
  expect(await saves(page)).toEqual([]);
  await field.evaluate((n) =>
    n.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "設定" }),
    ),
  );
  await page.locator("#settings-close").click();
  await language(page, "en");
  await expect(field).toHaveValue("設定");
});

test("English startup translates owned profile editor labels while preserving Japanese values", async ({
  page,
}) => {
  await boot(page, {
    language: "en",
    compactExplorer: true,
    theme: "midnight",
  });
  expect(await saves(page)).toEqual([]);
  await expect(page.locator("#edit-profile")).toHaveText("Connection settings");
  await page.locator("#edit-profile").click();
  await expect(page.locator("#dialog-title")).toHaveText("Connection profile");
  const literalText = await page.locator("#profile-form").innerText();
  expect(literalText).not.toMatch(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  );
  await expect(page.locator("#profile-form [name=name]")).toHaveValue("設定");
  await expect(page.locator("#profile-form [name=user]")).toHaveValue("設定");
  await expect(page.locator("#profile-form [name=hostKey]")).toHaveAttribute(
    "readonly",
    "",
  );
  expect(
    await page.evaluate(() =>
      window.calls.filter((c) =>
        [
          "probe_host_key",
          "connect_session",
          "start_sync",
          "run_file_operation",
        ].includes(c.cmd),
      ),
    ),
  ).toEqual([]);
});

test("fixed sync confirmation preserves its draft and delete warning while locale is deferred", async ({
  page,
}) => {
  await boot(page);
  await connect(page);
  await page.locator("#local-path").fill("C:\\draft-one");
  await page.locator("#local-path").press("Enter");
  await expect(page.locator("#local-path")).toHaveValue("C:\\draft-one");
  await page.locator("#prepare").click();
  // Sync captures the current explorer source; confirmation cannot select a
  // different folder. Per-pair settings are exercised through explorer browsing.
  await expect(page.locator("#start-form [name=local]")).toHaveAttribute("type", "hidden");
  await expect(page.locator("[data-sync-source]")).toHaveText("C:\\draft-one");
  await page.locator("#delete-removed").check();
  await page
    .locator("#exclusion-details")
    .evaluate((n: HTMLDetailsElement) => (n.open = true));
  await page.locator("#exclusion-rules").fill("設定/**");
  await expect(page.locator("#delete-warning")).toBeVisible();
  await page
    .locator("#start-form")
    .evaluate((n) => (window.startDraftForm = n));
  const count = (await saves(page)).length;
  // Actual pointer input cannot open settings through the modal overlay.
  const gear = await page.locator('#settings-toggle').boundingBox();
  await page.mouse.click(gear!.x + gear!.width/2, gear!.y + gear!.height/2);
  await expect(page.locator('#language-select')).toHaveCount(0);
  // Adversarial DOM dispatch separately proves the guarded handler cannot bypass
  // the private sync-settings controller lifecycle.
  await page.locator('#settings-toggle').evaluate((n: HTMLButtonElement)=>n.click());
  await expect(page.locator('#language-select')).toBeDisabled();
  await page.locator('#language-select').evaluate((n: HTMLSelectElement)=>{
    n.value='en'; n.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await expect(page.locator('#language-select')).toHaveValue('ja');
  expect((await saves(page)).length).toBe(count);
  expect(
    await page.evaluate(
      () => window.startDraftForm === document.querySelector("#start-form"),
    ),
  ).toBe(true);
  await expect(page.locator("#delete-warning")).toBeVisible();
  await page.locator("#settings-close").click();
  await expect(page.locator("[data-sync-source]")).toHaveText("C:\\draft-one");
  await expect(page.locator("#start-form [name=local]")).toHaveValue("C:\\draft-one");
  await expect(page.locator("#local-path")).toHaveValue("C:\\draft-one");
  await expect(page.locator("#delete-removed")).toBeChecked();
  await expect(page.locator("#exclusion-rules")).toHaveValue("設定/**");
  await expect(page.locator("#delete-warning")).toBeVisible();
  expect(await page.evaluate(()=>window.startDraftForm===document.querySelector('#start-form'))).toBe(true);
  expect((await saves(page)).length).toBe(count);
});

test("a queued profile save cannot retry after a held appearance write fails", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await boot(page, { holdSave: true, failSave: true });
  await settings(page);
  await page.locator("#language-select").selectOption("en");
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseAppearance))
    .toBe("function");
  await page.locator("#settings-close").click();
  await page.locator("#edit-profile").click();
  await page.locator("#profile-form [name=name]").fill("Uncommitted name");
  await page.locator("#profile-form .primary").click();
  await expect(page.locator("#profile-form")).toHaveAttribute(
    "data-busy",
    "true",
  );
  await page.evaluate(() => window.releaseAppearance());
  await expect(page.locator("#profile-form")).not.toHaveAttribute(
    "data-busy",
    "true",
  );
  expect((await saves(page)).length).toBe(1);
  expect((await saved(page)).profiles[0].name).toBe("設定");
  expect(errors).toEqual([]);
});

test('multiple owned recovery warnings retranslate as a group without splitting arbitrary details',async({page})=>{
 await boot(page,{language:'en',preferenceWarnings:['保存された列幅の一部を既定値に戻しました。','保存された画面分割比の一部を既定値に戻しました。']});
 await expect(page.locator('.notice')).toContainText('Some saved column widths were reset to defaults.');
 await expect(page.locator('.notice')).toContainText('Some saved pane ratios were reset to defaults.');
 await language(page,'ja');
 await expect(page.locator('.notice')).toContainText('保存された列幅の一部を既定値に戻しました。');
 await expect(page.locator('.notice')).toContainText('保存された画面分割比の一部を既定値に戻しました。');
});
