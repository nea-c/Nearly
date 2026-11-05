import { test, expect, type Page } from "@playwright/test";
async function generatedConnection(page: Page, registrationDelay = 0) {
  await page.addInitScript((registrationDelay) => {
    (window as any).__TAURI__ = {core:{invoke:async(cmd) => {
      if(cmd === "request_text_editor_origin_close") return true;
      if(cmd === "register_window" && registrationDelay) return {label:"main",freshProcess:true,ownedWorkspaceIds:[],workspaces:[]};
      if(cmd === "register_workspace") {
        await new Promise(resolve => setTimeout(resolve, registrationDelay));
        (window as any).registrationFinished = true;
      }
      if(cmd === "load_settings") return {version:1,theme:"light",language:"en",profiles:[{id:"generated",name:"Generated SFTP",host:"generated.invalid",port:22,user:"fixture",mode:"sftp",auth:"key",keyFile:"generated.ppk",hostKey:"SHA256:fixture"}],history:{}};
      if(cmd === "default_folder") return "C:\\fixture";
      if(cmd === "connect_session") return {path:"/",entries:[]};
      if(cmd === "list_local" || cmd === "list_remote" || cmd === "list_drives") return [];
    }}};
  }, registrationDelay);
  await page.goto("/");
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
}

test("startup keeps passphrase focus after native workspace registration", async ({page}) => {
  await generatedConnection(page, 200);
  await expect.poll(() => page.evaluate(() => (window as any).registrationFinished)).toBe(true);
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
});

test("typing and user-selected focus survive delayed startup completion", async ({page}) => {
  await generatedConnection(page, 1500);
  const input = page.locator("#connect-form [name=passphrase]");
  await input.fill("generated dummy draft");
  await page.locator("#settings-toggle").focus();
  await expect.poll(() => page.evaluate(() => (window as any).registrationFinished)).toBe(true);
  await expect(input).toHaveValue("generated dummy draft");
  await expect(page.locator("#settings-toggle")).toBeFocused();
});

for(const method of ["plus", "enter", "space", "shortcut"] as const) {
  test(`new connection tab initially focuses its passphrase via ${method}`, async({page}) => {
    await generatedConnection(page);
    const passphrase=page.locator("#connect-form [name=passphrase]");
    await expect(passphrase).toHaveAttribute("type","password");
    await expect(page.locator("#connect-form [name=keyFile]")).toHaveCount(0);
    if(method === "plus") await page.locator("#add-tab").click();
    else if(method === "enter" || method === "space") {await page.locator("#add-tab").focus();await page.keyboard.press(method === "enter" ? "Enter" : "Space");}
    else {await page.locator("#settings-toggle").focus();await page.keyboard.press("Control+t");}
    await expect(page.locator("[data-tab]")).toHaveCount(2);
    await expect(passphrase).toBeFocused();
  });
}

test("rapid new tabs, existing tabs and close focus the displayed passphrase", async({page})=>{
  await generatedConnection(page);
  await page.evaluate(()=>{for(let i=0;i<3;i++)document.getElementById("add-tab")!.click();});
  await expect(page.locator("[data-tab]")).toHaveCount(4);
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  await page.locator("#settings-toggle").focus();
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  await page.keyboard.press("Control+w");
  await expect(page.locator("[data-tab]")).toHaveCount(3);
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
});

for (const method of ["click", "shortcut"] as const) {
  test(`returning to disconnected tabs repeatedly focuses the passphrase via ${method}`, async ({page}) => {
    await generatedConnection(page);
    await page.locator("#connect-form [name=passphrase]").fill("dummy first");
    await page.locator("#add-tab").click();
    await page.locator("#connect-form [name=passphrase]").fill("dummy second");
    for (let i = 0; i < 6; i++) {
      if (method === "click") await page.locator("[data-tab]").nth(i % 2).click();
      else { await page.locator("#settings-toggle").focus(); await page.keyboard.press("Control+Tab"); }
      await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
      await expect(page.locator("#connect-form [name=passphrase]")).toHaveValue(i % 2 ? "dummy second" : "dummy first");
    }
  });
}

test("connected tabs keep toolbar focus when switching back", async ({page}) => {
  await generatedConnection(page);
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-form")).toHaveCount(0);
  await page.locator("#add-tab").click();
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  for (let i = 0; i < 3; i++) {
    await page.locator("#settings-toggle").focus();
    await page.keyboard.press("Control+Tab");
    await expect(page.locator("#connect-form")).toHaveCount(0);
    await expect(page.locator("#settings-toggle")).toBeFocused();
    await page.keyboard.press("Control+Tab");
    await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  }
});

test("rapid return to the same cached form focuses only the latest activation", async ({page}) => {
  await generatedConnection(page);
  await page.locator("#add-tab").click();
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  await page.evaluate(() => {
    const tabs = document.querySelectorAll<HTMLElement>("[data-tab]");
    for (const index of [0, 1, 0, 1]) tabs[index].click();
  });
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  await page.locator("#settings-toggle").focus();
  await page.locator("[data-tab]").nth(1).evaluate((tab: HTMLElement) => tab.click());
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.locator("#settings-toggle")).toBeFocused();
});

test("a user focus change after creation survives settings redraw and return",async({page})=>{
  await generatedConnection(page);
  await page.evaluate(()=>{document.getElementById("add-tab")!.click();document.getElementById("settings-toggle")!.focus();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await expect(page.locator("#settings-toggle")).toBeFocused();
  await page.locator("#settings-toggle").click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-root")).toBeEmpty();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await expect(page.locator("#connect-form [name=passphrase]")).not.toBeFocused();
});

test("initial SFTP connection screen focuses the key passphrase input", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd === "load_settings")
            return {
              version: 1,
              theme: "light",
              language: "en",
              profiles: [
                {
                  id: "generated",
                  name: "Generated SFTP",
                  host: "generated.invalid",
                  port: 22,
                  user: "fixture",
                  mode: "sftp",
                  auth: "key",
                  keyFile: "generated.ppk",
                  hostKey: "SHA256:fixture",
                },
              ],
              history: {},
            };
          if (cmd === "default_folder") return "C:\\fixture";
        },
      },
    };
  });
  await page.goto("/");
  await expect(page.locator("#connect-form [name=passphrase]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.locator("#connect-form [name=passphrase]"),
  ).not.toBeFocused();
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#settings-root input").first()).not.toBeFocused();
});
async function fixture(page) {
  await page.goto("/");
  await expect(page.locator("#connect-form")).toBeVisible();
  await page.evaluate(async () => {
    const root = document.createElement("section");
    root.id = "focus-fixture";
    root.style.cssText =
      "position:fixed;inset:10px;z-index:3000;background:white";
    root.innerHTML =
      '<form id="fixture-form"><input name="passphrase" type="password"><input id="other-field"></form>';
    document.body.append(root);
    const { createConnectionFocus } = await import("/src/connection-focus.ts");
    (window as any).focusFixture = createConnectionFocus();
  });
}
test("repeated rendering preserves another field, redisplay focuses once", async ({
  page,
}) => {
  await fixture(page);
  const input = page.locator("#fixture-form [name=passphrase]");
  await page.evaluate(() =>
    (window as any).focusFixture.show(document.querySelector("#fixture-form")),
  );
  await expect(input).toBeFocused();
  await page.locator("#other-field").fill("generated dummy");
  await page.evaluate(() =>
    (window as any).focusFixture.show(document.querySelector("#fixture-form")),
  );
  await expect(page.locator("#other-field")).toBeFocused();
  await expect(page.locator("#other-field")).toHaveValue("generated dummy");
  await page.evaluate(() => {
    const f = (window as any).focusFixture;
    f.show();
    f.show(document.querySelector("#fixture-form"));
  });
  await expect(input).toBeFocused();
});
test("disabled hidden and modal-covered fields never receive initial focus", async ({
  page,
}) => {
  await fixture(page);
  const input = page.locator("#fixture-form [name=passphrase]");
  for (const mode of ["disabled", "hidden", "modal"]) {
    await page.evaluate((mode) => {
      const form = document.querySelector<HTMLFormElement>("#fixture-form")!;
      const input = form.querySelector<HTMLInputElement>("[name=passphrase]")!;
      input.disabled = mode === "disabled";
      form.hidden = mode === "hidden";
      if (mode === "modal") {
        const overlay = document.createElement("div");
        overlay.className = "overlay";
        document.body.append(overlay);
      }
      const f = (window as any).focusFixture;
      f.show();
      f.show(form);
    }, mode);
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await expect(input).not.toBeFocused();
    await page.evaluate(() => document.querySelector(".overlay")?.remove());
  }
});
test("a user focus change before scheduled initial focus cancels it", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).focusFixture.show(document.querySelector("#fixture-form"));
    document.querySelector<HTMLInputElement>("#other-field")!.focus();
  });
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await expect(page.locator("#other-field")).toBeFocused();
});

test("bootstrap replacement focuses the latest form once per owner",async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{
    const owner={};const f=(window as any).focusFixture;
    const old=document.querySelector<HTMLFormElement>("#fixture-form")!;
    f.show(old,{onceFor:owner});
    const next=old.cloneNode(true) as HTMLFormElement;old.replaceWith(next);
    f.show(next,{onceFor:owner});(window as any).initialOwner=owner;
  });
  await expect(page.locator("#fixture-form [name=passphrase]")).toBeFocused();
  await page.evaluate(()=>{
    const outside=document.createElement("input");outside.id="outside-field";document.querySelector("#focus-fixture")!.append(outside);outside.focus();
    const old=document.querySelector<HTMLFormElement>("#fixture-form")!;const next=old.cloneNode(true) as HTMLFormElement;old.replaceWith(next);
    (window as any).focusFixture.show(next,{onceFor:(window as any).initialOwner});
  });
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await expect(page.locator("#outside-field")).toBeFocused();
});

test("cancelled initial attempt is not replayed by a delayed replacement",async({page})=>{
  await fixture(page);
  await page.evaluate(()=>{
    const owner={};(window as any).initialOwner=owner;
    const outside=document.createElement("input");outside.id="outside-field";document.querySelector("#focus-fixture")!.append(outside);
    (window as any).focusFixture.show(document.querySelector("#fixture-form"),{onceFor:owner});outside.focus();
  });
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.evaluate(()=>{const old=document.querySelector<HTMLFormElement>("#fixture-form")!;const next=old.cloneNode(true) as HTMLFormElement;old.replaceWith(next);(window as any).focusFixture.show(next,{onceFor:(window as any).initialOwner});});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await expect(page.locator("#outside-field")).toBeFocused();
});
