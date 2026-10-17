import { test, expect } from "@playwright/test";
const defaultId = "nearly:sync-default:v1";
async function boot(page, language) {
  await page.addInitScript(
    ({ language }) => {
      const profile = {
        id: "fixture",
        name: "Fixture",
        host: "fixture.invalid",
        port: 22,
        user: "fixture",
        auth: "key",
        mode: "sftp",
        keyFile: "C:\\fixture.ppk",
        hostKey: "SHA256:fixture",
      };
      const key = JSON.stringify(["fixture", "/", "c:\\fixture"]);
      if (!localStorage.getItem("profile-safety"))
        localStorage.setItem(
          "profile-safety",
          JSON.stringify({
            version: 1,
            settingsRevision: 30,
            theme: "midnight",
            language,
            profiles: [profile],
            history: { sentinel: "keep" },
            exclusions: { [key]: "old/", other: "keep/" },
            syncOptions: {
              [key]: { presetId: "on", deleteRemoved: true, recursive: false },
            },
            syncPresets: [
              {
                id: "on",
                name: "On",
                exclusionRules: "on/",
                deleteRemoved: true,
                recursive: false,
              },
              {
                id: "off",
                name: "Off",
                exclusionRules: "off/",
                deleteRemoved: false,
                recursive: true,
              },
              { id: "missing", name: "Missing", exclusionRules: "" },
              { id: "dup1", name: "Duplicate", exclusionRules: "first/" },
              { id: "dup2", name: "Duplicate", exclusionRules: "second/" },
            ],
          }),
        );
      window.calls = [];
      window.failNextSave = false;
      window.__TAURI__ = {
        event: {listen: async (name, callback) => {window.nativeEvents ??= {};window.nativeEvents[name]=callback;return ()=>{delete window.nativeEvents[name];};}},
        core: {
          invoke: async (cmd, args) => {
            window.calls.push({ cmd, args });
            // This focused fixture intentionally has no multiwindow coordinator.
            if (cmd === "register_window") return undefined;
            if (cmd === "load_settings")
              return JSON.parse(localStorage.getItem("profile-safety"));
            if (cmd === "save_settings") {
              if (window.holdSave)
                await new Promise((resolve) => (window.releaseSave = resolve));
              if (window.failNextSave) {
                window.failNextSave = false;
                throw "fixture revision conflict";
              }
              const prior = JSON.parse(localStorage.getItem("profile-safety"));
              if (prior.settingsRevision !== args.data.settingsRevision)
                throw "stale revision";
              const revision = prior.settingsRevision + 1;
              localStorage.setItem(
                "profile-safety",
                JSON.stringify({ ...args.data, settingsRevision: revision }),
              );
              return revision;
            }
            if (cmd === "watch_local_directory" || cmd === "local_watch_status") return {token:args.token ?? 0, revision:0};
            if (cmd === "unwatch_local_directory") return true;
            if (cmd === "default_folder") return "C:\\fixture";
            if (["prepare_session", "disconnect_session"].includes(cmd)) return;
            if (cmd === "connect_session") return { path: "/", entries: [] };
            if (cmd === "list_drives") return [{ name: "C:", path: "C:\\" }];
            if (cmd === "list_local" || cmd === "list_remote") return [];
            throw Error("Forbidden fixture action: " + cmd);
          },
        },
      };
    },
    { language },
  );
  await page.goto("/");
  await open(page);
}
async function open(page) {
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#prepare")).toBeEnabled();
  await page.locator("#prepare").click();
  await page.locator("#exclusion-details summary").click();
}
const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("profile-safety")));
async function flags(page, remove, recursive) {
  await expect(page.locator("#delete-removed")).toBeChecked({
    checked: remove,
  });
  await expect(page.locator("#recursive-sync")).toBeChecked({
    checked: recursive,
  });
}
for (const language of ["ja", "en"]) {
  test(`profile switching and editable default save/restart are safe (${language})`, async ({
    page,
  }) => {
    await boot(page, language);
    await page.locator("#sync-preset").selectOption("on");
    await flags(page, true, false);
    await page.locator("#sync-preset").selectOption("off");
    await flags(page, false, true);
    await page.locator("#sync-preset").selectOption("missing");
    await flags(page, false, true);
    await page.locator("#sync-preset").selectOption("");
    await flags(page, false, true);
    await expect(page.locator("#preset-delete")).toBeDisabled();
    await page.screenshot({
      path: "test-results/profile-" + language + ".png",
    });
    expect(
      await page
        .locator(".preset-controls")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.locator("#delete-removed").check();
    await page.locator("#recursive-sync").uncheck();
    await page.locator("#exclusion-rules").fill("default/");
    await page.locator("#preset-save").click();
    await expect
      .poll(async () =>
        (await stored(page)).syncPresets.some((p) => p.id === defaultId),
      )
      .toBe(true);
    await page.locator("#sync-preset").selectOption("off");
    await flags(page, false, true);
    await page.locator("#sync-preset").selectOption("");
    await flags(page, true, false);
    const data = await stored(page);
    expect(data.syncPresets.find((p) => p.id === defaultId)).toMatchObject({
      deleteRemoved: true,
      recursive: false,
      exclusionRules: "default/",
    });
    expect(data.history.sentinel).toBe("keep");
    expect(data.theme).toBe("midnight");
    await page.reload();
    await open(page);
    await page.locator("#sync-preset").selectOption("");
    await flags(page, true, false);
    expect(
      await page.evaluate(() =>
        window.calls.some((x) => x.cmd === "start_sync"),
      ),
    ).toBe(false);
  });
  test(`same-name updates, existing duplicates, delete/cancel and fallback (${language})`, async ({
    page,
  }) => {
    await boot(page, language);
    const initial = await stored(page);
    await page.locator("#sync-preset").selectOption("");
    await page.locator("#preset-name").fill("Off");
    await page.locator("#preset-save").click();
    await expect(page.locator("#sync-preset")).toHaveValue("off");
    expect((await stored(page)).syncPresets.length).toBe(
      initial.syncPresets.length,
    );
    await page.locator("#sync-preset").selectOption("");
    await page.locator("#preset-name").fill("Duplicate");
    await page.locator("#preset-save").click();
    await expect(page.locator("#preset-result")).toContainText(
      language === "ja" ? "同名" : "Multiple presets",
    );
    expect(
      (await stored(page)).syncPresets
        .filter((p) => p.name === "Duplicate")
        .map((p) => p.id),
    ).toEqual(["dup1", "dup2"]);
    await page.locator("#sync-preset").selectOption("dup2");
    await page.locator("#delete-removed").check();
    await page.locator("#preset-save").click();
    await expect(page.locator("#preset-result")).toContainText(
      language === "ja" ? "保存" : "saved",
    );
    const duplicates = (await stored(page)).syncPresets.filter(
      (p) => p.name === "Duplicate",
    );
    expect(duplicates[0].deleteRemoved).toBe(false);
    expect(duplicates[1].deleteRemoved).toBe(true);
    await page.locator("#sync-preset").selectOption("on");
    await page.locator("#preset-delete").click();
    await page.locator("#preset-removal-cancel").click();
    expect((await stored(page)).syncPresets.some((p) => p.id === "on")).toBe(
      true,
    );
    await flags(page, true, false);
    await page.locator("#preset-delete").click();
    await page.locator("#preset-removal-confirm").click();
    await expect(page.locator("#sync-preset")).toHaveValue("");
    await flags(page, false, true);
    const deleted = await stored(page);
    expect(deleted.syncPresets.some((p) => p.id === "on")).toBe(false);
    expect(
      deleted.syncOptions[JSON.stringify(["fixture", "/", "c:\\fixture"])],
    ).toEqual({ deleteRemoved: false, recursive: true });
    expect(deleted.exclusions.other).toBe("keep/");
    await page.reload();
    await open(page);
    await expect(page.locator("#sync-preset")).toHaveValue("");
    await flags(page, false, true);
  });
  test(`failed persistence restores profiles and references; pending controls cannot leak values (${language})`, async ({
    page,
  }) => {
    await boot(page, language);
    await page.locator("#sync-preset").selectOption("on");
    const before = await stored(page);
    await page.evaluate(() => {
      window.holdSave = true;
      window.failNextSave = true;
    });
    await page.locator("#delete-removed").uncheck();
    await page.locator("#recursive-sync").check();
    await page.locator("#preset-save").click();
    await expect(page.locator("#sync-preset")).toBeDisabled();
    await expect(page.locator("#delete-removed")).toBeDisabled();
    await expect(page.locator("#start-form .primary")).toBeDisabled();
    await page.evaluate(() => window.releaseSave());
    await expect(page.locator("#preset-result")).toContainText(
      "fixture revision conflict",
    );
    expect(await stored(page)).toEqual(before);
    await page.locator("#sync-preset").selectOption("off");
    await page.locator("#sync-preset").selectOption("on");
    await flags(page, true, false);
    await page.evaluate(() => {
      window.holdSave = false;
      window.failNextSave = true;
    });
    await page.locator("#preset-delete").click();
    await page.locator("#preset-removal-confirm").click();
    await expect(page.locator("#preset-result")).toContainText(
      "fixture revision conflict",
    );
    expect(await stored(page)).toEqual(before);
    await flags(page, true, false);
    await page.locator("#preset-duplicate").click();
    await expect(page.locator("#preset-result")).toContainText(
      language === "ja" ? "保存" : "saved",
    );
    await page.locator("#preset-duplicate").click();
    await expect
      .poll(async () => (await stored(page)).syncPresets.length)
      .toBe(before.syncPresets.length + 2);
    const names = (await stored(page)).syncPresets.map((p) => p.name);
    expect(new Set(names.filter((n) => n !== "Duplicate")).size).toBe(
      names.length - 2,
    );
  });
}
for (const language of ["ja", "en"]) {
  test(`preset deletion is a nested top-layer modal with keyboard safety (${language})`, async ({page}) => {
    await boot(page, language);
    await page.locator("#sync-preset").selectOption("on");
    const before = await stored(page);
    await page.locator("#preset-delete").click();
    const confirmation = page.locator("#preset-removal-dialog");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('On');
    await expect(confirmation).toContainText(language === 'ja' ? 'ファイルは削除しません' : 'Files will not be deleted');
    expect(await confirmation.evaluate(el => el.matches(':modal'))).toBe(true);
    await page.screenshot({path: `test-results/nested-modal/confirmation-${language}.png`});
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#preset-removal-confirm')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await page.locator('#sync-preset').evaluate(el => el.focus());
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator('#start-form')).toBeVisible();
    await expect(page.locator('#preset-delete')).toBeFocused();
    expect(await stored(page)).toEqual(before);
    await page.locator('#preset-delete').click();
    await page.locator('#preset-removal-cancel').click();
    await expect(page.locator('#preset-delete')).toBeFocused();
    expect(await stored(page)).toEqual(before);
    // Even a scripted selection change during confirmation cannot redirect removal.
    await page.locator('#preset-delete').click();
    await page.locator('#sync-preset').evaluate(el => {el.value='off';el.dispatchEvent(new Event('change'));});
    await page.locator('#preset-removal-confirm').click();
    await expect(confirmation).toHaveCount(0);
    expect(await stored(page)).toEqual(before);
    await expect(page.locator('#sync-preset')).toHaveValue('off');
    await page.locator('#preset-delete').click();
    await expect(confirmation).toContainText('Off');
    await page.locator('#preset-removal-confirm').click();
    await expect(page.locator('#sync-preset')).toHaveValue('');
    await expect(page.locator('#preset-delete')).toBeDisabled();
    const after = await stored(page);
    expect(after.syncPresets.some(p=>p.id==='on')).toBe(true);
    expect(after.syncPresets.some(p=>p.id==='off')).toBe(false);
    expect(await page.evaluate(()=>window.calls.filter(x=>!/settings$/.test(x.cmd)).map(x=>x.cmd))).not.toContain('delete_remote');
  });
}

for (const language of ['ja','en']) {
  test('blocked close notice above preset confirmation stays usable ('+language+')', async ({page})=>{
    await boot(page,language);
    await page.locator('#sync-preset').selectOption('on');
    await page.locator('#preset-delete').click();
    await expect(page.locator('#preset-removal-dialog')).toBeVisible();
    const before=await stored(page);
    await page.evaluate(()=>window.nativeEvents['sync-close-blocked']({payload:'同期中はウィンドウを閉じられません。各タブの同期停止を押し、停止完了後に改めて閉じてください。'}));
    await expect(page.locator('#window-close-notice')).toBeVisible();
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#preset-removal-confirm')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#window-close-notice button')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#window-close-notice')).toHaveCount(0);
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await page.evaluate(()=>{const send=window.nativeEvents['sync-close-blocked'];send({payload:'同期中'});send({payload:'同期中'});});
    await expect(page.locator('#window-close-notice')).toHaveCount(1);
    await page.locator('#window-close-notice button').click({timeout:2000});
    await expect(page.locator('#window-close-notice')).toHaveCount(0);
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await expect(page.locator('#preset-removal-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#preset-removal-dialog')).toHaveCount(0);
    await expect(page.locator('#start-form')).toBeVisible();
    expect(await stored(page)).toEqual(before);
  });
}
for (const language of ['ja','en']) {
  test('existing blocked-close notice follows modal opening ('+language+')',async({page})=>{
    await boot(page,language);
    await page.evaluate(()=>window.nativeEvents['sync-close-blocked']({payload:'同期中'}));
    await expect(page.locator('#window-close-notice')).toBeVisible();
    await page.locator('#sync-preset').selectOption('on');
    await page.locator('#preset-delete').click();
    await expect(page.locator('#preset-removal-dialog #window-close-notice')).toBeVisible();
    await page.locator('#window-close-notice button').click();
    await expect(page.locator('#preset-removal-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#start-form')).toBeVisible();
  });
  test('nested preset confirmation has readable colors across all five themes ('+language+')',async({page})=>{
    await boot(page,language);
    await page.locator('#sync-preset').selectOption('on');
    for(const theme of ['light','dark','midnight','forest','mint']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.locator('#preset-delete').click();
      await expect(page.locator('#preset-removal-dialog')).toBeVisible();
      const colors=await page.locator('#preset-removal-dialog').evaluate(dialog=>{
        const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
        const lum=s=>rgb(s).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
        const ratio=(fg,bg)=>{const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
        const base=getComputedStyle(dialog),desc=getComputedStyle(dialog.querySelector('p'));
        return {background:base.backgroundColor,description:ratio(desc.color,base.backgroundColor),buttons:Array.from(dialog.querySelectorAll('button')).map(button=>{const s=getComputedStyle(button);return {id:button.id,fg:s.color,bg:s.backgroundColor,contrast:ratio(s.color,s.backgroundColor)};})};
      });
      expect(colors.description,JSON.stringify({theme,colors})).toBeGreaterThanOrEqual(4.5);
      for(const button of colors.buttons) expect(button.contrast,JSON.stringify({theme,button})).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path:`test-results/nested-modal/${language}-${theme}.png`});
      await page.locator('#preset-removal-cancel').click();
      await expect(page.locator('#preset-delete')).toBeFocused();
    }
  });
}
