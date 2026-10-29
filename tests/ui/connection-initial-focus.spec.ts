import { test, expect } from "@playwright/test";
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
