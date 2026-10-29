import { test, expect } from "@playwright/test";
test("editor starts with one thin active path and keeps only tab close controls", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.locator(
      ".editor-shell > header,.editor-shell h1,[data-editor-window-close],[data-editor-save],[data-editor-close]",
    ),
  ).toHaveCount(0);
  await expect(page.locator(".text-editor-path")).toHaveCount(1);
  const path = page.locator(".editor-active-path");
  await expect(path).toContainText("fixture@localhost:22");
  await expect(path).toHaveAttribute(
    "title",
    "fixture@localhost:22 · /samples/config.json",
  );
  expect(
    await path.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(18);
  expect(
    await page
      .locator(".editor-shell")
      .evaluate(
        (el) =>
          el.firstElementChild === el.querySelector(".editor-tabs") &&
          el.querySelector(".editor-tabs")!.nextElementSibling ===
            el.querySelector(".editor-active-path"),
      ),
  ).toBe(true);
  await expect(page.locator("[data-editor-tab-close]")).toBeVisible();
  await expect(
    page.locator(".editor-footer .text-editor-format"),
  ).toContainText("UTF-8 BOM");
});
async function open(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const w = window as any;
    w.editorCalls = [];
    w.editorFail = false;
    w.docs = [
      {
        token: "generated-doc",
        text: "original\n",
        encoding: "UTF-8 BOM",
        newline: "CRLF",
        path: "/samples/config.json",
        side: "remote",
        connectionLabel: "fixture@localhost:22",
      },
    ];
    w.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          w.editorCalls.push({ cmd, args });
          if (cmd === "list_text_documents") {
            if (w.editorHoldList) {
              const snapshot = w.docs.map((d) => ({ ...d }));
              return new Promise(
                (resolve) => (w.releaseEditorList = () => resolve(snapshot)),
              );
            }
            return w.docs;
          }
          if (cmd === "close_text_document") {
            w.docs = w.docs.filter((d) => d.token !== args.token);
          }
          if (cmd === "save_text_document") {
            if (w.editorHold)
              return new Promise(
                (resolve) =>
                  (w.releaseEditorSave = () =>
                    resolve({ text: args.text, message: "Saved" })),
              );
            if (w.editorFail) throw "Generated external change conflict";
            return { text: args.text, message: "Saved" };
          }
        },
      },
      event: {
        listen: async (name, handler) => {
          (w.editorHandlers ??= {})[name] = handler;
          return () => {};
        },
      },
    };
    const { setLanguage } = await import("/src/i18n.ts");
    setLanguage("en");
    const { mountTextEditorWindow } = await import("/src/editor-window.ts");
    document.body.classList.add('editor-window');
    document.body.replaceChildren();
    await mountTextEditorWindow(document.body);
  });
}
test('joined editor tabs stay flush with close controls and focus at both scroll edges',async({page})=>{
  await open(page);await page.setViewportSize({width:600,height:500});
  await page.evaluate(()=>{
    const w=window as any;
    for(let i=1;i<8;i++)w.docs.push({...w.docs[0],token:'edge-'+i,path:'/samples/long-file-name-'+i+'.json'});
    w.editorHandlers['text-editor-opened']({payload:'edge-7'});
  });
  await expect(page.locator('.editor-tab')).toHaveCount(8);
  const strip=page.locator('.editor-tabs');
  expect(await strip.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
  for(const last of [false,true]){
    await strip.evaluate((el,last)=>el.scrollLeft=last?el.scrollWidth:0,last);
    const tab=last?page.locator('.editor-tab').last():page.locator('.editor-tab').first();
    await tab.locator('[role=tab]').click();
    const geometry=await tab.evaluate(el=>{
      const t=el.getBoundingClientRect(),s=el.parentElement!.getBoundingClientRect();
      return {left:t.left-s.left,right:s.right-t.right,before:getComputedStyle(el,'::before').content,after:getComputedStyle(el,'::after').content};
    });
    expect(last?geometry.right:geometry.left).toBeCloseTo(0,0);
    expect(geometry.before).toBe('none');expect(geometry.after).toBe('none');
    await page.keyboard.press('Tab');
    await tab.locator('[data-editor-tab-close]').focus();
    await expect(tab.locator('[data-editor-tab-close]')).toBeFocused();
    expect(await tab.locator('[data-editor-tab-close]').evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');
  }
});

test('dirty dot occupies close target across themes, active/inactive tabs, save failure and keyboard focus',async({page})=>{
  await open(page);
  await page.evaluate(()=>{
    const w=window as any;w.docs.push({...w.docs[0],token:'second-dot',path:'/other/config.json'});
    w.editorHandlers['text-editor-opened']({payload:'second-dot'});
  });
  await expect(page.locator('.editor-tab')).toHaveCount(2);
  const first=page.locator('.editor-tab').first(),second=page.locator('.editor-tab').last();
  for(const theme of ['light','dark','midnight','forest','mint']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await first.locator('[role=tab]').click();
    await page.locator('.text-editor:visible textarea').fill('dirty '+theme);
    await page.mouse.move(580,350);
    const close=first.locator('[data-editor-tab-close]');
    await expect(close.locator('.editor-tab-dirty')).toBeVisible();
    await expect(close.locator('.editor-tab-cross')).toBeHidden();
    await expect(first.locator('.editor-tab-label .editor-tab-dirty')).toHaveCount(0);
    await expect(close).toHaveAccessibleName('Close: config.json (unsaved)');
    await close.hover();await expect(close.locator('.editor-tab-cross')).toBeVisible();
    await expect(close.locator('.editor-tab-dirty')).toBeHidden();
    await page.mouse.move(580,350);await first.locator('[role=tab]').focus();
    await page.keyboard.press('Tab');await expect(close).toBeFocused();
    await expect(close.locator('.editor-tab-cross')).toBeVisible();
    await page.locator('.text-editor:visible textarea').click();
    await page.evaluate(()=>((window as any).editorFail=true));
    await page.keyboard.press('Control+s');
    await expect(page.locator('.text-editor-status')).toContainText('Generated external change conflict');
    await expect(close.locator('.editor-tab-dirty')).toBeVisible();
    await second.locator('[role=tab]').click();await page.mouse.move(580,350);
    await expect(first.locator('.editor-tab-dirty')).toBeVisible();
    await close.click();await expect(page.locator('.text-editor-discard')).toBeVisible();
    await page.locator('[data-editor-keep]').click();
    await expect(second.locator('[role=tab]')).toHaveAttribute('aria-selected','true');
    await first.locator('[role=tab]').click();
    await expect(page.locator('.text-editor:visible textarea')).toHaveValue('dirty '+theme);
    await page.evaluate(()=>((window as any).editorFail=false));await page.keyboard.press('Control+s');
    await expect(close.locator('.editor-tab-dirty')).toBeHidden();await expect(close.locator('.editor-tab-cross')).toBeVisible();
    await expect(close).toHaveAccessibleName('Close: config.json');
  }
});

test("explicit save keeps original target token; failed save retains dirty buffer", async ({
  page,
}) => {
  await open(page);
  const input = page.locator(".text-editor textarea");
  await expect(input).toHaveValue("original\n");
  await expect(page.locator(".text-editor-format")).toContainText("UTF-8 BOM");
  await input.fill("changed\n");
  await page.evaluate(() => ((window as any).editorFail = true));
  await page.keyboard.press("Control+s");
  await expect(page.locator(".text-editor-status")).toContainText(
    "Generated external change conflict",
  );
  await expect(input).toHaveValue("changed\n");
  await page.evaluate(() => ((window as any).editorFail = false));
  await page.keyboard.press("Control+s");
  await expect(page.locator(".text-editor-status")).toContainText("Saved");
  const saves = await page.evaluate(() =>
    (window as any).editorCalls.filter((c) => c.cmd === "save_text_document"),
  );
  expect(saves).toHaveLength(2);
  expect(saves[1].args).toMatchObject({
    token: "generated-doc",
    text: "changed\n",
  });
  expect(saves[1].args.path).toBeUndefined();
  expect(saves[1].args.sessionId).toBeUndefined();
});
test("busy close warning clears when its save has finished", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => ((window as any).editorHold = true));
  await page.locator(".text-editor textarea").fill("generated held save");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".text-editor")).toHaveAttribute(
    "data-busy",
    "true",
  );
  await page.evaluate(() =>
    (window as any).editorHandlers["text-editor-close"]({ payload: null }),
  );
  await expect(page.locator(".editor-global-status")).toContainText(
    "Finish or cancel",
  );
  await page.evaluate(() => (window as any).releaseEditorSave());
  await expect(page.locator(".text-editor")).toHaveAttribute(
    "data-busy",
    "false",
  );
  await expect(page.locator(".editor-global-status")).toBeEmpty();
});
test("review delayed native list cannot resurrect a successfully closed token", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as any;
    w.editorHoldList = true;
    w.editorHandlers["text-editor-opened"]({ payload: "generated-doc" });
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseEditorList))
    .toBe("function");
  await page.locator(".editor-tab.active [data-editor-tab-close]").click();
  await expect(page.locator(".editor-tabs [role=tab]")).toHaveCount(0);
  await page.evaluate(() => (window as any).releaseEditorList());
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await expect(page.locator(".editor-tabs [role=tab]")).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).editorHandlers["text-editor-close"]({ payload: null }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).editorCalls.some(
          (c) => c.cmd === "close_text_editor_window",
        ),
      ),
    )
    .toBe(true);
});
test("dirty close requires explicit discard and can be cancelled", async ({
  page,
}) => {
  await open(page);
  await page.locator(".text-editor textarea").fill("unsaved");
  await page.locator(".editor-tab.active [data-editor-tab-close]").click();
  await expect(page.locator(".text-editor-discard")).toBeVisible();
  await page.locator("[data-editor-keep]").click();
  await expect(page.locator(".text-editor textarea")).toHaveValue("unsaved");
  await page.locator(".editor-tab.active [data-editor-tab-close]").click();
  await page.locator("[data-editor-discard]").click();
  await expect(page.locator(".text-editor")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).editorCalls.filter(
          (c) => c.cmd === "save_text_document",
        ).length,
    ),
  ).toBe(0);
});
test("multiple tabs retain dirty buffers, deduplicate tokens and confirm whole window close", async ({
  page,
}) => {
  await open(page);
  await page.locator(".text-editor textarea").fill("unsaved first");
  await page.evaluate(async () => {
    const w = window as any;
    w.docs.push({
      ...w.docs[0],
      token: "second",
      path: "/other/config.json",
      text: "second file",
    });
    w.editorHandlers["text-editor-opened"]({ payload: "second" });
  });
  await expect(page.locator(".editor-tabs [role=tab]")).toHaveCount(2);
  await expect(page.locator(".text-editor:visible textarea")).toHaveValue(
    "second file",
  );
  await page.locator(".editor-tabs [role=tab]").first().click();
  await expect(page.locator(".text-editor:visible textarea")).toHaveValue(
    "unsaved first",
  );
  await page.evaluate(() =>
    (window as any).editorHandlers["text-editor-opened"]({
      payload: "generated-doc",
    }),
  );
  await expect(page.locator(".editor-tabs [role=tab]")).toHaveCount(2);
  await page.evaluate(() =>
    (window as any).editorHandlers["text-editor-close"]({ payload: null }),
  );
  await expect(page.locator(".text-editor-discard")).toBeVisible();
  await page.locator("[data-editor-keep]").click();
  await expect(page.locator(".text-editor:visible textarea")).toHaveValue(
    "unsaved first",
  );
  expect(
    await page.evaluate(() =>
      (window as any).editorCalls.some(
        (c) => c.cmd === "close_text_editor_window",
      ),
    ),
  ).toBe(false);
});
test("tab discard prompt serializes a simultaneous native window close", async ({
  page,
}) => {
  await open(page);
  await page.locator(".text-editor textarea").fill("keep during close race");
  await page.locator(".editor-tab.active [data-editor-tab-close]").click();
  await page.evaluate(() =>
    (window as any).editorHandlers["text-editor-close"]({ payload: null }),
  );
  await expect(page.locator(".text-editor-discard")).toHaveCount(1);
  await page.locator("[data-editor-keep]").click();
  await expect(page.locator(".text-editor textarea")).toHaveValue(
    "keep during close race",
  );
  expect(
    await page.evaluate(() =>
      (window as any).editorCalls.some((c) => c.cmd === "close_text_document"),
    ),
  ).toBe(false);
});
test("background tab close cross keeps active document and cancel preserves dirty text", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as any;
    w.docs.push({
      ...w.docs[0],
      token: "second",
      path: "/other/config.json",
      text: "second file",
    });
    w.editorHandlers["text-editor-opened"]({ payload: "second" });
  });
  await expect(page.locator(".editor-tabs [role=tab]")).toHaveCount(2);
  await page.locator(".text-editor:visible textarea").fill("dirty second");
  await page.locator(".editor-tabs [role=tab]").first().click();
  await page
    .locator(".editor-tab")
    .nth(1)
    .locator("[data-editor-tab-close]")
    .click();
  await expect(page.locator(".text-editor-discard")).toBeVisible();
  await page.locator("[data-editor-keep]").click();
  await expect(page.locator(".editor-tabs [role=tab]").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".text-editor:visible textarea")).toHaveValue(
    "original\n",
  );
  await page.locator(".editor-tabs [role=tab]").nth(1).click();
  await expect(page.locator(".text-editor:visible textarea")).toHaveValue(
    "dirty second",
  );
  expect(
    await page.evaluate(() =>
      (window as any).editorCalls.some(
        (c) =>
          c.cmd === "save_text_document" || c.cmd === "close_text_document",
      ),
    ),
  ).toBe(false);
});
