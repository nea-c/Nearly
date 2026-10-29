import { test, expect, type Page } from "@playwright/test";

const KEY = "tab-drag-fixture";
type Options = {
  language?: string;
  theme?: string;
  compactExplorer?: boolean;
  count?: number;
};
async function boot(page: Page, options: Options = {}) {
  await page.addInitScript(
    ({ options, KEY }) => {
      if (!localStorage.getItem(KEY)) {
        const profiles = Array.from({ length: options.count ?? 4 }, (_, i) => ({
          id: `profile-${i}`,
          name: `Owned context ${i} — unique server`,
          host: `server-${i}.invalid`,
          port: 2200 + i,
          user: `user-${i}`,
          mode: "sftp",
          auth: "key",
          keyFile: `C:\\fixture\\key-${i}.ppk`,
          hostKey: `SHA256:fixture${i}`,
        }));
        const owned = profiles.map((profile, i) => ({
          id: `record-${i}`,
          profile,
          local: `C:\\fixture\\root-${i}`,
          remote: `/srv/root-${i}`,
          exclusionRules: `owner-${i}/\n*.tmp`,
          deleteRemoved: i % 2 === 1,
          recursive: i % 2 === 0,
          presetId: `preset-${i}`,
          pendingState: "unknown",
          ownerTabId: `owner-${i}`,
          ownerTabClosed: false,
        }));
        const legacy = {
          ...owned[0],
          id: "legacy",
          local: "C:\\legacy-hidden",
          remote: "/legacy-hidden",
        };
        delete legacy.ownerTabId;
        delete legacy.ownerTabClosed;
        const closed = {
          ...owned[1],
          id: "closed",
          ownerTabId: "closed-owner",
          ownerTabClosed: true,
          local: "C:\\closed-hidden",
          remote: "/closed-hidden",
        };
        localStorage.setItem(
          KEY,
          JSON.stringify({
            version: 1,
            settingsRevision: 20,
            language: "en",
            theme: "light",
            compactExplorer: false,
            ...options,
            profiles,
            history: {},
            retainedSyncs: [owned[0], legacy, ...owned.slice(1), closed],
          }),
        );
      }
      const fixture = { calls: [], jobs: {}, failSave: false, holdSave: false };
      window.tabDragFixture = fixture;
      window.__TAURI__ = {
        event: { listen: async () => () => {} },
        core: {
          invoke: async (cmd, args = {}) => {
            fixture.calls.push({ cmd, args });
            if (cmd === "request_text_editor_origin_close") return true;
            if (cmd === "register_window") {
              const s = JSON.parse(localStorage.getItem(KEY));
              return {
                label: "main",
                ownedWorkspaceIds: s.retainedSyncs
                  .filter((r) => r.ownerTabId && !r.ownerTabClosed)
                  .map((r) => r.ownerTabId),
                jobs: [],
                workspaces: [],
              };
            }
            if (cmd === "load_settings")
              return JSON.parse(localStorage.getItem(KEY));
            if (cmd === "save_settings") {
              if (fixture.holdSave)
                await new Promise((resolve) => (fixture.releaseSave = resolve));
              if (fixture.failSave) {
                fixture.failSave = false;
                throw "Generated settings save conflict";
              }
              const prior = JSON.parse(localStorage.getItem(KEY));
              if (args.data.settingsRevision !== prior.settingsRevision)
                throw "Generated stale revision";
              const next = {
                ...args.data,
                settingsRevision: prior.settingsRevision + 1,
              };
              localStorage.setItem(KEY, JSON.stringify(next));
              return next.settingsRevision;
            }
            if (cmd === "default_folder") return "C:\\fixture";
            if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
            if (cmd === "list_local" || cmd === "list_remote") return [];
            if (cmd === "connect_session") return { path: "/", entries: [] };
            if (cmd === "start_sync") {
              fixture.jobs[args.id] = args;
              return;
            }
            if (cmd === "stop_sync") {
              delete fixture.jobs[args.id];
              return { knownUnreflected: false };
            }
            if (cmd === "sync_status")
              return {
                status: "running",
                pending: 0,
                sent: 0,
                speed: 0,
                latency: 0,
                errorCount: 0,
                logs: [],
                remoteChanges: { revision: 0, records: [], truncated: false },
              };
            if (["run_file_operation", "run_local_archive"].includes(cmd))
              throw Error("Filesystem mutation forbidden");
          },
        },
      };
    },
    { options, KEY },
  );
  await page.goto("/");
  await expect(page.locator("[data-tab]")).toHaveCount(options.count ?? 4);
}
const tab = (page: Page, id: string) => page.locator(`[data-tab="${id}"]`);
const order = (page: Page) =>
  page
    .locator("[data-tab]")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.tab));
const active = (page: Page) =>
  page.locator("[data-tab][aria-selected=true]").getAttribute("data-tab");
const stored = (page: Page) =>
  page.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)!), KEY);
const storedOwned = async (page: Page) =>
  (await stored(page)).retainedSyncs
    .filter((r) => r.ownerTabId && !r.ownerTabClosed)
    .map((r) => r.ownerTabId);
const calls = (page: Page) => page.evaluate(() => window.tabDragFixture.calls);
const sideEffects = (list: any[]) =>
  list.filter((c) =>
    /connect|auth|start_sync|stop_sync|window_control|drag/i.test(c.cmd),
  );
async function begin(page: Page, id: string) {
  await tab(page, id).scrollIntoViewIfNeeded();
  const b = (await tab(page, id).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page: Page, id: string, target: string, after: boolean) {
  const from = await begin(page, id);
  const b = (await tab(page, target).boundingBox())!;
  await page.mouse.move(b.x + b.width * (after ? 0.85 : 0.15), from.y, {
    steps: 14,
  });
  await page.mouse.up();
}
async function clean(page: Page) {
  await expect(
    page.locator(".tab-drag-placeholder,.tab-drag-source,.tabs.tab-reordering"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function start(page: Page, id: string) {
  await tab(page, id).click();
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#local-path")).toBeVisible();
  await page.locator("#prepare").click();
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#start-form")).toHaveCount(0);
}

test("drag moves inactive and active IDs across several positions without changing owner records or commands", async ({
  page,
}) => {
  await boot(page);
  await tab(page, "owner-1").click();
  const records = (await stored(page)).retainedSyncs,
    before = sideEffects(await calls(page));
  await drag(page, "owner-0", "owner-3", true);
  await expect
    .poll(() => order(page))
    .toEqual(["owner-1", "owner-2", "owner-3", "owner-0"]);
  expect(await active(page)).toBe("owner-1");
  await drag(page, "owner-1", "owner-3", true);
  await expect
    .poll(() => order(page))
    .toEqual(["owner-2", "owner-3", "owner-1", "owner-0"]);
  expect(await active(page)).toBe("owner-1");
  await drag(page, "owner-0", "owner-2", false);
  await expect
    .poll(() => order(page))
    .toEqual(["owner-0", "owner-2", "owner-3", "owner-1"]);
  expect(
    (await stored(page)).retainedSyncs
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual(records.slice().sort((a, b) => a.id.localeCompare(b.id)));
  expect(sideEffects(await calls(page))).toEqual(before);
  for (const i of [0, 1, 2, 3]) {
    await tab(page, `owner-${i}`).click();
    await expect(page.locator("#connect-form")).toBeVisible();
    await expect(page.getByRole("heading",{name:(await stored(page)).profiles[i].name,exact:true})).toBeVisible();
    await expect(page.locator("#retained-resume")).toHaveCount(0);

  }
  await clean(page);
});

test("running background jobs and selected owner survive reordering; restart restores owned order disconnected", async ({
  page,
}) => {
  await boot(page);
  await start(page, "owner-0");
  await start(page, "owner-1");
  await tab(page, "owner-2").click();
  const before = sideEffects(await calls(page)),
    jobs = await page.evaluate(() => window.tabDragFixture.jobs);
  await drag(page, "owner-0", "owner-3", true);
  expect(await active(page)).toBe("owner-2");
  expect(sideEffects(await calls(page))).toEqual(before);
  expect(await page.evaluate(() => window.tabDragFixture.jobs)).toEqual(jobs);
  await tab(page, "owner-0").click();
  await expect(page.locator("#retained-resume")).toHaveCount(0);
  await page.locator("#prepare").click();
  await tab(page, "owner-1").click();
  await expect(page.locator("#retained-resume")).toHaveCount(0);
  await page.locator("#prepare").click();
  const expected = await order(page);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(expected);
  expect(sideEffects(await calls(page))).toEqual([]);
  await expect(page.locator("#connect-form")).toBeVisible();
  await clean(page);
});

for (const cancel of ["Escape", "blur", "pointercancel", "outside"])
  test(`drag ${cancel} cancels and removes feedback without saving or activating`, async ({
    page,
  }) => {
    await boot(page);
    await tab(page, "owner-1").click();
    const before = await calls(page),
      from = await begin(page, "owner-0"),
      b = (await tab(page, "owner-3").boundingBox())!;
    await page.mouse.move(b.x + b.width * 0.8, from.y, { steps: 12 });
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else if (cancel === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else if (cancel === "pointercancel")
      await page.evaluate(() =>
        document.dispatchEvent(
          new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }),
        ),
      );
    else await page.mouse.move(1100, 400, { steps: 8 });
    await page.mouse.up();
    expect(await order(page)).toEqual([
      "owner-0",
      "owner-1",
      "owner-2",
      "owner-3",
    ]);
    expect(await active(page)).toBe("owner-1");
    expect(
      (await calls(page)).filter((c) => c.cmd === "save_settings"),
    ).toEqual(before.filter((c) => c.cmd === "save_settings"));
    await clean(page);
  });

test("threshold jitter remains a normal click and the close button keeps its normal action", async ({
  page,
}) => {
  await boot(page);
  const from = await begin(page, "owner-2");
  await page.mouse.move(from.x + 2, from.y + 1);
  await page.mouse.up();
  expect(await active(page)).toBe("owner-2");
  expect(await order(page)).toEqual([
    "owner-0",
    "owner-1",
    "owner-2",
    "owner-3",
  ]);
  const close = page.locator('[data-close="owner-0"]'),
    b = (await close.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(900, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  expect(await order(page)).toEqual([
    "owner-0",
    "owner-1",
    "owner-2",
    "owner-3",
  ]);
  await close.click();
  await expect(tab(page, "owner-0")).toHaveCount(0);
  await expect
    .poll(() =>
      stored(page).then((s) =>
        s.retainedSyncs.some((r) => r.id === "record-0"),
      ),
    )
    .toBe(false);
  await clean(page);
});

test("drag feedback tracks the pointer inside the strip and is cleared on cancellation", async ({
  page,
}) => {
  await boot(page);
  const from = await begin(page, "owner-0"),
    target = (await tab(page, "owner-2").boundingBox())!;
  await page.mouse.move(target.x + target.width * 0.75, from.y, { steps: 14 });
  await expect(page.locator(".tabs.tab-reordering")).toHaveCount(1);
  await expect(page.locator(".tab-drag-source")).toHaveCount(1);
  await expect(page.locator(".tab-drag-placeholder")).toHaveCount(1);
  const geometry = await page.locator(".tab-drag-source").evaluate((el) => {
    const source = el.getBoundingClientRect(),
      strip = el.closest(".tabs")!,
      bounds = strip.getBoundingClientRect();
    return {
      sourceLeft: source.left,
      sourceRight: source.right,
      left: bounds.left,
      right: bounds.right,
      overflow: getComputedStyle(strip).overflowX,
    };
  });
  expect(["auto", "scroll", "hidden", "clip"]).toContain(geometry.overflow);
  expect(geometry.sourceRight).toBeGreaterThan(target.x);
  expect(geometry.sourceLeft).toBeLessThan(geometry.right);
  await page.screenshot({ path: "test-results/tab-drag-ui/drag-feedback.png" });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await clean(page);
});

test("repeated owned persistence preserves legacy, closed records and unsaved gap order", async ({
  page,
}) => {
  await boot(page);
  const original = (await stored(page)).retainedSyncs;
  await page.locator("#add-tab").click();
  const fresh = (await order(page)).find((id) => !id.startsWith("owner-"))!;
  await drag(page, "owner-3", "owner-0", false);
  await drag(page, "owner-1", "owner-3", false);
  const expected = (await order(page)).filter((id) => id !== fresh);
  await expect
    .poll(() =>
      stored(page).then((s) =>
        s.retainedSyncs
          .filter((r) => r.ownerTabId && !r.ownerTabClosed)
          .map((r) => r.ownerTabId),
      ),
    )
    .toEqual(expected);
  const after = (await stored(page)).retainedSyncs;
  for (const id of ["legacy", "closed"])
    expect(after.find((r) => r.id === id)).toEqual(
      original.find((r) => r.id === id),
    );
  await page.reload();
  await expect.poll(() => order(page)).toEqual(expected);
  expect(sideEffects(await calls(page))).toEqual([]);
  await clean(page);
});

test("fresh tab dragged first keeps that order when its explicit first synchronization registers ownership", async ({
  page,
}) => {
  await boot(page);
  const original = (await stored(page)).retainedSyncs;
  await page.locator("#add-tab").click();
  const fresh = (await active(page))!;
  await drag(page, fresh, "owner-0", false);
  const expected = await order(page);
  expect(expected[0]).toBe(fresh);
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#local-path")).toBeVisible();
  await page.locator("#remote-path").fill("/fresh-registration");
  await page.locator("#remote-path").press("Enter");
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator("#local-path").fill("C:\\fixture\\fresh-registration");
  await page.locator("#local-path").press("Enter");
  await expect(page.locator("[data-pane=local]")).toHaveAttribute("aria-busy","false");
  await page.locator("#prepare").click();
  await expect(page.locator("[data-sync-source]")).toHaveText("C:\\fixture\\fresh-registration");
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#start-form")).toHaveCount(0);
  await expect.poll(() => storedOwned(page)).toEqual(expected);
  const registration = (await stored(page)).retainedSyncs.find(
    (r) => r.ownerTabId === fresh,
  );
  expect(registration.remote).toBe("/fresh-registration");
  expect(registration.ownerTabClosed).toBe(false);
  for (const id of ["legacy", "closed"])
    expect((await stored(page)).retainedSyncs.find((r) => r.id === id)).toEqual(
      original.find((r) => r.id === id),
    );
  await page.locator("#prepare").click();
  await expect(page.locator("#retained-resume")).toBeVisible();
  await page.reload();
  await expect.poll(() => order(page)).toEqual(expected);
  expect(sideEffects(await calls(page))).toEqual([]);
  await clean(page);
});

test("closing a reordered owner preserves remaining visible order without restoring the closed tab", async ({
  page,
}) => {
  await boot(page);
  const original = (await stored(page)).retainedSyncs;
  await drag(page, "owner-3", "owner-0", false);
  await page.locator('[data-close="owner-0"]').click();
  await expect(tab(page, "owner-0")).toHaveCount(0);
  await expect
    .poll(() =>
      stored(page).then((s) =>
        s.retainedSyncs.some((r) => r.id === "record-0"),
      ),
    )
    .toBe(false);
  await expect(page.locator("#restore-tab")).toHaveCount(0);
  const expected = await order(page);
  expect(expected).toEqual(["owner-3", "owner-1", "owner-2"]);
  await expect.poll(() => storedOwned(page)).toEqual(expected);
  const after = (await stored(page)).retainedSyncs;
  for (const id of ["legacy", "closed"])
    expect(after.find((r) => r.id === id)).toEqual(
      original.find((r) => r.id === id),
    );
  expect(after.find((r) => r.id === "record-0")).toBeUndefined();
  await page.reload();
  await expect.poll(() => order(page)).toEqual(expected);
  expect(sideEffects(await calls(page))).toEqual([]);
  await clean(page);
});

test("stationary drag source remains anchored during horizontal wheel scrolling and commits its visible slot", async ({
  page,
}) => {
  await boot(page, { count: 16 });
  await page.setViewportSize({ width: 800, height: 850 });
  const strip = page.locator(".tabs"),
    from = await begin(page, "owner-0"),
    bounds = (await strip.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, from.y, { steps: 12 });
  await expect(page.locator(".tab-drag-source")).toHaveCount(1);
  const source = page.locator(".tab-drag-source"),
    before = (await source.boundingBox())!,
    scrollBefore = await strip.evaluate((el) => el.scrollLeft);
  await page.mouse.wheel(220, 0);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(scrollBefore + 100);
  await expect
    .poll(async () => Math.abs((await source.boundingBox())!.x - before.x))
    .toBeLessThan(3);
  const visibleSlot = await strip.evaluate((el) =>
    Array.from(el.children).flatMap((node) => {
      if (node.classList.contains("tab-drag-source")) return [];
      if (node.classList.contains("tab-drag-placeholder")) return ["owner-0"];
      const id = node.querySelector("[data-tab]")?.getAttribute("data-tab");
      return id ? [id] : [];
    }),
  );
  expect(visibleSlot.indexOf("owner-0")).toBeGreaterThan(1);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(visibleSlot);
  await clean(page);
});

test("sixteen tabs autoscroll both edges while pointer is idle and keep the destination in view", async ({
  page,
}) => {
  await boot(page, { count: 16 });
  await page.setViewportSize({ width: 800, height: 850 });
  const strip = page.locator(".tabs");
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  await begin(page, "owner-0");
  let b = (await strip.boundingBox())!;
  await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 12 });
  const initial = await strip.evaluate((el) => el.scrollLeft);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(initial + 100);
  await expect
    .poll(
      () =>
        strip.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft),
      { timeout: 10000 },
    )
    .toBeLessThan(3);
  await page.mouse.up();
  await expect.poll(() => order(page).then((a) => a.at(-1))).toBe("owner-0");
  const rightScroll = await strip.evaluate((el) => el.scrollLeft);
  expect(rightScroll).toBeGreaterThan(100);
  await begin(page, "owner-0");
  b = (await strip.boundingBox())!;
  await page.mouse.move(b.x + 4, b.y + b.height / 2, { steps: 12 });
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft))
    .toBeLessThan(rightScroll - 100);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollLeft), { timeout: 10000 })
    .toBeLessThan(3);
  await page.mouse.up();
  await expect.poll(() => order(page).then((a) => a[0])).toBe("owner-0");
  await clean(page);
  await page.screenshot({ path: "test-results/tab-drag-ui/overflow-16.png" });
});

test("failed CAS retains in-memory order while healthy pending writes serialize the latest reorder", async ({
  page,
}) => {
  await boot(page);
  const disk = await stored(page);
  await page.evaluate(() => (window.tabDragFixture.failSave = true));
  await drag(page, "owner-0", "owner-3", true);
  await expect
    .poll(() => order(page))
    .toEqual(["owner-1", "owner-2", "owner-3", "owner-0"]);
  await expect(page.locator("body")).toContainText(
    "Generated settings save conflict",
  );
  expect((await stored(page)).retainedSyncs).toEqual(disk.retainedSyncs);
  expect(sideEffects(await calls(page))).toEqual([]);
  const failedOrder = await order(page),
    failedSaves = (await calls(page)).filter(
      (c) => c.cmd === "save_settings",
    ).length;
  await drag(page, "owner-1", "owner-3", true);
  expect(await order(page)).toEqual(failedOrder);
  expect(
    (await calls(page)).filter((c) => c.cmd === "save_settings"),
  ).toHaveLength(failedSaves);
  await page.reload();
  await page.evaluate(() => (window.tabDragFixture.holdSave = true));
  await drag(page, "owner-1", "owner-3", true);
  await expect
    .poll(() => page.evaluate(() => typeof window.tabDragFixture.releaseSave))
    .toBe("function");
  const firstOrder = await order(page),
    saveCount = (await calls(page)).filter(
      (c) => c.cmd === "save_settings",
    ).length;
  await drag(page, "owner-3", "owner-0", false);
  const latest = await order(page);
  expect(latest).toEqual(["owner-3", "owner-0", "owner-2", "owner-1"]);
  expect(latest).not.toEqual(firstOrder);
  expect(
    (await calls(page)).filter((c) => c.cmd === "save_settings"),
  ).toHaveLength(saveCount);
  await page.evaluate(() => {
    window.tabDragFixture.holdSave = false;
    window.tabDragFixture.releaseSave();
  });
  await expect.poll(() => storedOwned(page)).toEqual(latest);
  await expect
    .poll(() =>
      calls(page).then(
        (list) => list.filter((c) => c.cmd === "save_settings").length,
      ),
    )
    .toBe(saveCount + 1);
  expect((await stored(page)).settingsRevision).toBe(disk.settingsRevision + 2);
  expect(sideEffects(await calls(page))).toEqual([]);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(latest);
  await clean(page);
});

for (const [i, theme] of [
  "light",
  "dark",
  "midnight",
  "forest",
  "mint",
].entries())
  for (const language of ["en", "ja"])
    test(`pointer layout ${theme} ${language} compact=${i % 2 === 0}`, async ({
      page,
    }) => {
      await boot(page, { theme, language, compactExplorer: i % 2 === 0 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      for (const width of [800, 1180]) {
        await page.setViewportSize({ width, height: 850 });
        const before = await order(page);
        await drag(page, before[0], before[2], true);
        await expect
          .poll(() => order(page))
          .toEqual([before[1], before[2], before[0], before[3]]);
        await clean(page);
        if (width === 800)
          await page.screenshot({
            path: `test-results/tab-drag-ui/${theme}-${language}-800.png`,
          });
      }
      expect(sideEffects(await calls(page))).toEqual([]);
    });
