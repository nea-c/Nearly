import { test, expect } from "@playwright/test";
test.use({ deviceScaleFactor: 2 });
async function setup(page, mode = "sftp", connect = true, language = "en") {
  await page.addInitScript(
    ({ mode, language }) => {
      window.calls = [];
      window.holdPrepare = false;
      window.holdRun = false;
      const entries = [
        { name: "folder", dir: true, size: 0 },
        { name: "one.txt", dir: false, size: 1 },
        { name: "two.txt", dir: false, size: 2 },
      ];
      const profile = {
        id: "a",
        name: "Fixture",
        host: "fixture.invalid",
        port: 22,
        user: "test",
        mode,
        auth: "key",
        hostKey: "pin",
      };
      window.__TAURI__ = {
        event: { listen: async (name, fn) => { if(name === 'native-file-drop') window.nativeDrop = fn; return () => {}; } },
        webview: {
          getCurrentWebview: () => ({
            onDragDropEvent: async (fn) => {
              window.nativeDrop = fn;
              return () => {};
            },
          }),
        },
        core: {
          invoke: async (cmd, args) => {
            window.calls.push({ cmd, args });
            if (cmd === "load_settings")
              return {
                version: 1,
                language,
                profiles: [profile],
                history: {},
              };
            if (cmd === "save_settings") return 2;
            if (cmd === "default_folder") return "C:\\fixture";
            if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
            if (cmd === "connect_session") return { path: "/", entries };
            if (
              cmd === "list_remote" &&
              window.recreated &&
              args.path === "/folder/nested"
            )
              return [{ name: "fresh.txt", dir: false, size: 1 }];
            if (cmd === "list_local" || cmd === "list_remote") return entries;
            if (cmd === "prepare_file_operation" && window.holdPrepare)
              await new Promise((r) => (window.releasePrepare = r));
            if (cmd === "run_upload") {
              if (window.simulateRecreate) window.recreated = true;
              if (window.holdRun)
                await new Promise((r) => (window.releaseRun = r));
              return {
                status: window.uploadStatus || "completed",
                completed: 1,
                bytes: 1,
                message: window.uploadMessage || "done",
              };
            }
          },
        },
      };
    },
    { mode, language },
  );
  await page.goto("/");
  if (!connect) return;
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function nativeDrop(
  page,
  selector = "[data-list=remote] [data-name=folder]",
  paths = ["C:\\external.txt"],
) {
  const box = await page.locator(selector).first().boundingBox();
  await page.evaluate(
    ({ box, paths }) =>
      window.nativeDrop({
        payload: {
          type: "drop", ownOutbound: false,
          paths,
          position: {
            x: (box.x + 10) * devicePixelRatio,
            y: (box.y + box.height / 2) * devicePixelRatio,
          },
        },
      }),
    { box, paths },
  );
}
test("native physical drop freezes exact directory and requires explicit confirmation", async ({
  page,
}) => {
  await setup(page);
  await nativeDrop(page);
  await expect(page.locator("#upload-confirm")).toBeVisible();
  expect(
    await page.evaluate(
      () => window.calls.filter((c) => c.cmd === "run_upload").length,
    ),
  ).toBe(0);
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.calls.filter((c) => c.cmd === "run_upload").length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => window.calls.find((c) => c.cmd === "run_upload").args.request,
    ),
  ).toMatchObject({
    sources: ["C:\\external.txt"],
    remote: "/folder",
    recursive: true,
    interactive: true,
  });
});
test("pending prepare cancellation abandons without dispatch", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => (window.holdPrepare = true));
  await nativeDrop(page);
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releasePrepare))
    .toBe("function");
  await page.locator("#upload-cancel").click();
  await page.evaluate(() => window.releasePrepare());
  await expect(page.locator("[data-feedback-close]")).toBeEnabled();
  expect(
    await page.evaluate(() =>
      window.calls.some(
        (c) => c.cmd === "cancel_file_operation" && c.args.abandon,
      ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
  ).toBe(false);
});
test("native headers and local pane are ignored; pointer local text uploads copy", async ({
  page,
}) => {
  await setup(page);
  await nativeDrop(page, "[data-list=remote] thead");
  await nativeDrop(page, "[data-list=local] [data-name=folder]");
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
  const source = page.locator(
    '[data-list=local] [data-name="one.txt"] [data-entry-icon]',
  );
  const a = await source.boundingBox(),
    b = await page
      .locator("[data-list=remote] [data-name=folder]")
      .boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        window.calls.find((c) => c.cmd === "run_upload").args.request.sources,
    ),
  ).toEqual(["C:\\fixture\\one.txt"]);
});

test("held preparation keeps original destination across browse and tab switch", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => (window.holdPrepare = true));
  await nativeDrop(page);
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releasePrepare))
    .toBe("function");
  await page.locator("[data-list=remote] [data-name=folder]").dblclick();
  await expect(page.locator("#remote-path")).toHaveValue("/folder");
  await page.locator("#add-tab").click();
  await page.locator("#connect-form .primary").click();
  await page.locator("#remote-path").fill("/");
  await page.locator("#remote-path").press("Enter");
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator('[data-list=remote] [data-name="two.txt"]').click();
  await page.evaluate(() => window.releasePrepare());
  await expect
    .poll(() =>
      page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        window.calls.find((c) => c.cmd === "run_upload").args.request.remote,
    ),
  ).toBe("/folder");
  await expect(page.locator("#remote-path")).toHaveValue("/");
  await expect(
    page.locator('[data-list=remote] [data-name="two.txt"]'),
  ).toHaveAttribute("aria-selected", "true");
});
test("partial and cancelled are typed warnings; running cancel never abandons", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.holdRun = true;
    window.uploadStatus = "partial";
  });
  await nativeDrop(page);
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseRun))
    .toBe("function");
  await page.locator("#upload-cancel").click();
  expect(
    await page.evaluate(() =>
      window.calls
        .filter((c) => c.cmd === "cancel_file_operation")
        .every((c) => !c.args.abandon),
    ),
  ).toBe(true);
  await page.evaluate(() => window.releaseRun());
  await expect(page.locator(".operation-feedback")).toContainText("Partial");
  await expect(page.locator(".operation-feedback")).toContainText(
    "New partial targets may remain",
  );
  await page.locator("[data-feedback-close]").click();
  await page.evaluate(() => {
    window.holdRun = false;
    window.uploadStatus = "cancelled";
  });
  await nativeDrop(page);
  await page.locator("#upload-confirm").click();
  await expect(page.locator(".operation-feedback")).toContainText("Cancelled");
});
test("folder pointer upload includes contents by default and Escape cancels gestures", async ({
  page,
}) => {
  await setup(page);
  const drag = async () => {
    const a = await page
        .locator("[data-list=local] [data-name=folder] [data-entry-icon]")
        .boundingBox(),
      b = await page
        .locator("[data-list=remote] [data-name=folder]")
        .boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 8 });
  };
  await drag();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
  await drag();
  await page.mouse.up();
  await page.locator("#upload-confirm").click();
  await expect(page.locator("#upload-recursive")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        window.calls.find((c) => c.cmd === "run_upload").args.request.recursive,
    ),
  ).toBe(true);
});
test("busy upload rejects new drops and browser File paths are never trusted", async ({
  page,
}) => {
  await setup(page);
  await page.locator("[data-list=remote]").evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "fake.txt"));
    el.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      }),
    );
  });
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
  await page.evaluate(() => (window.holdRun = true));
  await nativeDrop(page);
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseRun))
    .toBe("function");
  await nativeDrop(page);
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
  await page.evaluate(() => window.releaseRun());
});
test("confirmation rejects a changed view and native blank list targets browse folder", async ({
  page,
}) => {
  await setup(page);
  await nativeDrop(page);
  await page.locator("#remote-path").evaluate((input) => {
    input.value = "/other";
    input
      .closest("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(page.locator("#remote-path")).toHaveValue("/other");
  await page.locator("#upload-confirm").click();
  await expect(page.locator("[role=alert]")).toContainText("changed");
  expect(
    await page.evaluate(() =>
      window.calls.some((c) => c.cmd === "prepare_file_operation"),
    ),
  ).toBe(false);
  await page.locator("#upload-cancel").click();
  const b = await page.locator("[data-list=remote]").boundingBox();
  await page.evaluate(
    (b) =>
      window.nativeDrop({
        payload: {
          type: "drop", ownOutbound: false,
          paths: ["C:\\new.txt"],
          position: {
            x: (b.x + 20) * devicePixelRatio,
            y: (b.y + b.height - 10) * devicePixelRatio,
          },
        },
      }),
    b,
  );
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        window.calls.find((c) => c.cmd === "run_upload").args.request.remote,
    ),
  ).toBe("/other");
});

test("disconnected and mock sessions reject native upload", async ({
  page,
}) => {
  await setup(page, "sftp", false);
  await page.evaluate(() =>
    window.nativeDrop?.({
      payload: {
        type: "drop", ownOutbound: false,
        paths: ["C:\\a.txt"],
        position: { x: 800, y: 500 },
      },
    }),
  );
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
  expect(
    await page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
  ).toBe(false);
  await setup(page, "mock");
  const box = await page.locator("[data-list=remote]").boundingBox();
  await page.evaluate(
    (box) =>
      window.nativeDrop({
        payload: {
          type: "drop", ownOutbound: false,
          paths: ["C:\\a.txt"],
          position: {
            x: (box.x + 20) * devicePixelRatio,
            y: (box.y + box.height - 10) * devicePixelRatio,
          },
        },
      }),
    box,
  );
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
});
test("native tree directory uses exact model path and rejects forged DOM paths", async ({
  page,
}) => {
  await setup(page);
  const toggle = page.locator("[data-tree-toggle=remote]").first();
  if ((await toggle.count()) === 0) {
    await page.locator("[data-tree-visibility=remote]").click();
  }
  const row = page.locator("[data-tree-row=remote]").first();
  await expect(row).toBeVisible();
  const path = await row.getAttribute("data-tree-path");
  await nativeDrop(page, "[data-tree-select=remote]");
  await page.locator("#upload-confirm").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.calls.some((c) => c.cmd === "run_upload")),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () =>
        window.calls.find((c) => c.cmd === "run_upload").args.request.remote,
    ),
  ).toBe(path);
  await page.locator("[data-feedback-close]").click();
  await row.evaluate((el) => el.setAttribute("data-tree-path", "/forged"));
  await nativeDrop(page, "[data-tree-select=remote]");
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
});
test("column pointer cancel and below threshold preserve sort; resize remains separate", async ({
  page,
}) => {
  await setup(page);
  const source = page.locator("[data-list=local] [data-column-sort=name]"),
    target = page.locator("[data-list=local] [data-column-sort=size]");
  const a = await source.boundingBox(),
    b = await target.boundingBox();
  await page.mouse.move(a.x + 8, a.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + 8, b.y + 8, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-list=local] th").first()).toHaveAttribute(
    "data-column",
    "name",
  );
  await expect(page.locator("[data-list=local] th").first()).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  const handle = page.locator('[data-column-resize="local:name"]');
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 10));
});

test("selected pointer batch freezes all full paths; jitter remains a selection click", async ({
  page,
}) => {
  await setup(page);
  const one = page.locator('[data-list=local] [data-name="one.txt"]'),
    two = page.locator('[data-list=local] [data-name="two.txt"]');
  await one.click();
  await two.click({ modifiers: ["Control"] });
  const a = await one.locator("[data-entry-icon]").boundingBox(),
    b = await page
      .locator("[data-list=remote] [data-name=folder]")
      .boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 2, a.y + a.height / 2 + 1);
  await page.mouse.up();
  await expect(page.locator("#upload-confirm")).toHaveCount(0);
  await one.click();
  await two.click({ modifiers: ["Control"] });
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.locator("#upload-confirm").evaluate((button) => {
    button.click();
    button.click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.calls.filter((c) => c.cmd === "run_upload").length,
      ),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.calls.find((c) => c.cmd === "run_upload").args.request.sources,
    ),
  ).toEqual(["C:\\fixture\\one.txt", "C:\\fixture\\two.txt"]);
});

test("Japanese partial upload renders typed status and nested native diagnostics", async ({
  page,
}) => {
  await setup(page, "sftp", true, "ja");
  await page.evaluate(() => {
    window.uploadStatus = "partial";
    window.uploadMessage =
      "Source changed during upload. Upload incomplete; new partial targets may remain. Preexisting targets were not replaced; local sources retained. Refresh before retrying.";
  });
  await nativeDrop(page);
  await page.locator("#upload-confirm").click();
  await expect(page.locator(".operation-feedback")).toContainText(
    "一部のみ完了",
  );
  await expect(page.locator(".operation-feedback")).toContainText(
    "アップロード中に元データが変更されました",
  );
  await expect(page.locator(".operation-feedback")).not.toContainText(
    "Upload incomplete",
  );
});

test("upload invalidates attempted root descendants while preserving sibling cache", async ({
  page,
}) => {
  await setup(page);
  const navigate = async (path) => {
    await page.locator("#remote-path").fill(path);
    await page.locator("#remote-path").press("Enter");
    await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  };
  await navigate("/folder/nested");
  await navigate("/folder-other");
  const siblingsBefore = await page.evaluate(
    () =>
      window.calls.filter(
        (c) => c.cmd === "list_remote" && c.args.path === "/folder-other",
      ).length,
  );
  await navigate("/");
  await page.evaluate(() => (window.simulateRecreate = true));
  const box = await page.locator("[data-list=remote]").boundingBox();
  await page.evaluate(
    (box) =>
      window.nativeDrop({
        payload: {
          type: "drop", ownOutbound: false,
          paths: ["C:\\folder"],
          position: {
            x: (box.x + 20) * devicePixelRatio,
            y: (box.y + box.height - 10) * devicePixelRatio,
          },
        },
      }),
    box,
  );
  await expect(page.locator("#upload-recursive")).toHaveCount(0);
  await page.locator("#upload-confirm").click();
  await expect(page.locator("[data-feedback-close]")).toBeEnabled();
  await navigate("/folder-other");
  expect(
    await page.evaluate(
      () =>
        window.calls.filter(
          (c) => c.cmd === "list_remote" && c.args.path === "/folder-other",
        ).length,
    ),
  ).toBe(siblingsBefore);
  await navigate("/folder/nested");
  await expect(
    page.locator('[data-list=remote] [data-name="fresh.txt"]'),
  ).toBeVisible();
});
