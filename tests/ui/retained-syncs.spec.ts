import { test, expect } from "@playwright/test";
async function boot(
  page,
  options = { language: "en", theme: "light", compactExplorer: false },
) {
  await page.addInitScript((options) => {
    const profile = {
      id: "retained-profile",
      name: "Saved connection",
      host: "fixture.invalid",
      port: 22,
      user: "fixture",
      mode: "sftp",
      auth: "key",
      keyFile: "C:\\generated.ppk",
      hostKey: "SHA256:fixture",
    };
    const other = {
      ...profile,
      id: "other-profile",
      name: "Long saved connection name for layout verification",
    };
    if (!localStorage.getItem("retained-fixture"))
      localStorage.setItem(
        "retained-fixture",
        JSON.stringify({
          version: 1,
          settingsRevision: 20,
          ...options,
          profiles: [profile, other],
          history: {},
          retainedSyncs: [
            {
              id: "saved-one",
              profile,
              local: "C:\\work\\site",
              remote: "/srv/site",
              exclusionRules: "cache/\n*.tmp",
              deleteRemoved: false,
              recursive: false,
              pendingState: "unknown",
              ownerTabId: "owner-one",
              ownerTabClosed: false,
            },
            {
              id: "saved-two",
              profile: other,
              local: "C:\\work\\other-directory-with-a-long-name",
              remote: "/srv/other-directory-with-a-long-name",
              exclusionRules: "",
              deleteRemoved: true,
              recursive: true,
              pendingState: "unreflected",
              ownerTabId: "owner-two",
              ownerTabClosed: false,
            },
            {
              id: "legacy",
              profile,
              local: "C:\\legacy-hidden",
              remote: "/legacy-hidden",
              exclusionRules: "",
              deleteRemoved: false,
              recursive: true,
              pendingState: "unknown",
            },
          ],
        }),
      );
    window.retainedFixture = {
      calls: [],
      stopKnown: true,
      failSave: false,
      failStart: false,
      failStop: false,
      holdStart: false,
      holdStop: false,
      jobs: {},
    };
    window.__TAURI__ = {
      event: {
        listen: async (name, callback) => {
          window.retainedFixture.listeners ??= {};
          window.retainedFixture.listeners[name] = callback;
          return () => {};
        },
      },
      core: {
        invoke: async (cmd, args = {}) => {
          const f = window.retainedFixture;
          f.calls.push({ cmd, args });
          if (cmd === "register_window") {
            const s = JSON.parse(localStorage.getItem("retained-fixture"));
            return {
              label: "main",
              ownedWorkspaceIds: s.retainedSyncs
                .filter((r) => r.ownerTabId && !r.ownerTabClosed)
                .map((r) => r.ownerTabId),
              // Native descriptors represent jobs from this still-running process, not settings restoration.
              jobs: s.retainedSyncs.filter(r=>r.ownerTabId&&!r.ownerTabClosed).map((r,i)=>({id:'live-job-'+i,workspaceId:r.ownerTabId,job:{id:'live-job-'+i,profile:r.profile,local:r.local,remote:r.remote,exclusionRules:r.exclusionRules,deleteRemoved:r.deleteRemoved,recursive:r.recursive,status:'stopped',sent:0,speed:0,latency:0,logs:[]}})),
              workspaces: s.retainedSyncs.filter(r=>r.ownerTabId&&!r.ownerTabClosed).map(r=>({id:r.ownerTabId})),
            };
          }
          if (cmd === "load_settings")
            return JSON.parse(localStorage.getItem("retained-fixture"));
          if (cmd === "save_settings") {
            if (f.holdSave)
              await new Promise((resolve) => (f.releaseSave = resolve));
            if (f.failSave) {
              f.failSave = false;
              throw "Generated settings save conflict";
            }
            const prior = JSON.parse(localStorage.getItem("retained-fixture"));
            if (args.data.settingsRevision !== prior.settingsRevision)
              throw "Generated stale revision";
            const next = {
              ...args.data,
              settingsRevision: prior.settingsRevision + 1,
            };
            localStorage.setItem("retained-fixture", JSON.stringify(next));
            return next.settingsRevision;
          }
          if (cmd === "default_folder") return "C:\\fixture";
          if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
          if (cmd === "list_remote" && f.holdRemotePath === args.path) {
            f.holdRemotePath = undefined;
            await new Promise((resolve) => (f.releaseRemote = resolve));
            return [];
          }
          if (cmd === "list_local" || cmd === "list_remote") return [];
          if (cmd === "connect_session") {
            if (f.holdConnect)
              await new Promise((resolve) => (f.releaseConnect = resolve));
            return { path: "/", entries: [] };
          }
          if (cmd === "start_sync") {
            if (f.holdStart)
              await new Promise((resolve) => (f.releaseStart = resolve));
            if (f.failStart) {
              f.failStart = false;
              throw "Generated start failed";
            }
            f.jobs[args.id] = true;
            return;
          }
          if (cmd === "stop_sync") {
            if (f.holdStop)
              await new Promise((resolve) => (f.releaseStop = resolve));
            if (f.failStop) {
              f.failStop = false;
              throw "Generated stop failed";
            }
            delete f.jobs[args.id];
            return { knownUnreflected: f.stopKnown };
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
          if (cmd === "run_file_operation" || cmd === "run_local_archive")
            throw Error(
              "Filesystem mutation forbidden in retained-sync UI fixture",
            );
          return undefined;
        },
      },
    };
  }, options);
  await page.goto("/");
}
test("shared synchronization list is absent", async ({ page }) => {
  await boot(page);
  await expect(page.locator("#retained-sync-list")).toHaveCount(0);
});

const context = (page) => page.locator(".tab-sync-actions");
const calls = (page, cmd) =>
  page.evaluate(
    (cmd) => window.retainedFixture.calls.filter((c) => c.cmd === cmd),
    cmd,
  );
const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("retained-fixture")));
const owner = (page, id = "owner-one") => page.locator(`[data-tab="${id}"]`);
async function owned(page, id = "owner-one", record = "saved-one") {
  await owner(page, id).click();
  await expect(owner(page, id)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#retained-open")).toHaveAttribute(
    "data-retained-open",
    record,
  );
}
async function connect(page) {
  if(await page.locator("#connect-form .primary").isVisible()) await page.locator("#connect-form .primary").click();
  await expect(page.locator("#local-path")).toBeVisible();
  for (const side of ["local", "remote"])
    await expect(page.locator(`[data-pane=${side}]`)).toHaveAttribute(
      "aria-busy",
      "false",
    );
}
async function resumeForm(page) {
  if (!(await page.locator("#local-path").isVisible())) await connect(page);
  await page.locator("#retained-resume").click();
  await expect(page.locator("#start-form")).toBeVisible();
}
async function start(page) {
  await resumeForm(page);
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#start-form")).toHaveCount(0);
  await expect
    .poll(() => calls(page, "start_sync").then((a) => a.length))
    .toBeGreaterThan(0);
  await expect(page.locator("#prepare")).toBeEnabled();
}

test("only the selected owner exposes its paths and actions, within the current native process", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  await expect(context(page)).toContainText("C:\\work\\site");
  await expect(context(page)).toContainText("/srv/site");
  await expect(page.locator("main")).not.toContainText("/srv/other-directory");
  await expect(page.locator("main")).not.toContainText("/legacy-hidden");
  await expect(page.locator("#retained-open")).toHaveAttribute(
    "data-retained-open",
    "saved-one",
  );
  await expect(page.locator("#prepare")).toBeVisible();
  await owned(page, "owner-two", "saved-two");
  await expect(context(page)).toContainText("/srv/other-directory");
  await expect(page.locator("main")).not.toContainText("C:\\work\\site");
  await expect(page.locator("#retained-resume")).toHaveAttribute(
    "data-retained-resume",
    "saved-two",
  );
  expect(await calls(page, "connect_session")).toHaveLength(0);
  expect(await calls(page, "start_sync")).toHaveLength(0);
  expect(await calls(page, "prepare_sync")).toHaveLength(0);
  await page.reload();
  await owned(page, "owner-two", "saved-two");
  expect(await calls(page, "connect_session")).toHaveLength(0);
  expect(await calls(page, "start_sync")).toHaveLength(0);
});

test("brand new tab retains owner isolation while Sync uses its current Explorer source", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("retained-fixture")),
      p = s.profiles[0],
      key = JSON.stringify([
        p.id,
        p.mode,
        p.host.trim().toLowerCase(),
        p.port,
        p.user,
        p.hostKey.trim(),
      ]);
    s.history[JSON.stringify([key, "/srv/site"])] = "C:\\work\\site";
    localStorage.setItem("retained-fixture", JSON.stringify(s));
  });
  await page.reload();
  await owned(page);
  await page.locator("#add-tab").click();
  await expect(context(page)).toHaveCount(0);
  await expect(page.locator("#retained-open")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("/srv/site");
  await expect(page.locator("main")).not.toContainText("/legacy-hidden");
  await connect(page);
  await expect(context(page)).toHaveCount(0);
  await expect(page.locator("#retained-resume")).toHaveCount(0);
  await page.locator("#local-path").fill("C:\\fixture");
  await page.locator("#local-path").press("Enter");
  await expect(page.locator("[data-pane=local]")).toHaveAttribute("aria-busy","false");
  await expect(page.locator("#local-path")).toHaveValue("C:\\fixture");
  expect(await calls(page, "start_sync")).toHaveLength(0);
  const freshLocal = await page.locator("#local-path").inputValue();
  await page.locator("#remote-path").fill("/srv/site");
  await page.locator("#remote-path").press("Enter");
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator("#prepare").click();
  await expect(page.locator("#start-form [name=local]")).toHaveValue(freshLocal);
  await expect(page.locator("#local-path")).toHaveValue(freshLocal);
  await expect(page.locator("#recursive-sync")).toBeChecked();
  await expect(page.locator("#delete-removed")).not.toBeChecked();
  await page.locator("#exclusion-details summary").click();
  await expect(page.locator("#exclusion-rules")).not.toHaveValue(
    "cache/\n*.tmp",
  );
  await page.locator("#cancel").click();
  await owned(page);
  await expect(context(page)).toContainText("/srv/site");
});

test("close removes only its owned session record without a restore action or automatic reopen", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  const before = (await stored(page)).retainedSyncs;
  await page.locator('[data-close="owner-one"]').click();
  await expect(owner(page)).toHaveCount(0);
  await expect(page.locator("#restore-tab")).toHaveCount(0);
  const records = (await stored(page)).retainedSyncs;
  expect(records.find((r) => r.id === "saved-one")).toBeUndefined();
  expect(records.find((r) => r.id === "saved-two")).toEqual(
    before.find((r) => r.id === "saved-two"),
  );
  await page.reload();
  await expect(owner(page)).toHaveCount(0);
  await expect(page.locator("#restore-tab")).toHaveCount(0);
  expect(await calls(page, "connect_session")).toHaveLength(0);
  expect(await calls(page, "start_sync")).toHaveLength(0);
});
test("open locations stays in its owner and never starts synchronization", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  const before = (await stored(page)).retainedSyncs;
  expect(await calls(page, "connect_session")).toHaveLength(0);
  await connect(page);
  await page.locator("#retained-open").click();
  await expect(page.locator("#local-path")).toHaveValue("C:\\work\\site");
  await expect(page.locator("#remote-path")).toHaveValue("/srv/site");
  expect((await stored(page)).retainedSyncs).toEqual(before);
  expect(await calls(page, "start_sync")).toHaveLength(0);
  const boxes = await page.locator("#retained-open").evaluate((b) => {
    const resume = document.querySelector("#retained-resume"),
      sync = document.querySelector("#prepare");
    return {
      open: b.getBoundingClientRect().right,
      resumeLeft: resume.getBoundingClientRect().left,
      resumeRight: resume.getBoundingClientRect().right,
      syncRight: sync.getBoundingClientRect().right,
      sync: sync.getBoundingClientRect().left,
      parent:
        b.closest("header") === resume.closest("header") &&
        b.closest("header") === sync.closest("header"),
    };
  });
  expect(boxes.parent).toBe(true);
  expect(boxes.open).toBeLessThanOrEqual(boxes.sync);
  expect(boxes.syncRight).toBeLessThanOrEqual(boxes.resumeLeft);
  expect(boxes.resumeLeft - boxes.syncRight).toBeLessThanOrEqual(12);
  await page.setViewportSize({ width: 800, height: 850 });
  await page.screenshot({
    path: "test-results/tab-context-ui/owned-connected-en-light-800.png",
  });
});

test("resume confirms owner-specific rules and new jobs; stopping retains truthful unknown or pending", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  await resumeForm(page);
  await expect(page.locator("#start-form [name=local]")).toHaveValue(
    "C:\\work\\site",
  );
  await expect(page.locator("#start-form")).toContainText("/srv/site");
  await expect(page.locator("#delete-removed")).not.toBeChecked();
  await expect(page.locator("#recursive-sync")).not.toBeChecked();
  await expect(page.locator(".resume-exclusions pre")).toHaveText("cache/\n*.tmp");
  await page.locator("#cancel").click();
  expect(await calls(page, "start_sync")).toHaveLength(0);
  for (let i = 0; i < 2; i++) {
    await start(page);
    await page.evaluate((i) => (window.retainedFixture.stopKnown = i === 0), i);
    await page.locator("#prepare").click();
    await expect(page.locator("#retained-resume")).toBeVisible();
    await expect(page.locator(".stopped-context")).toHaveCount(0);
    expect(
      (await stored(page)).retainedSyncs.find((r) => r.id === "saved-one")
        .pendingState,
    ).toBe(i === 0 ? "unreflected" : "unknown");
  }
  const starts = await calls(page, "start_sync");
  expect(starts).toHaveLength(2);
  expect(starts[0].args.id).not.toBe(starts[1].args.id);
  for (const { args } of starts) {
    expect(args.local).toBe("C:\\work\\site");
    expect(args.remote).toBe("/srv/site");
    expect(args.recursive).toBe(false);
    expect(args.deleteRemoved).toBe(false);
  }
  await owned(page, "owner-two", "saved-two");
  await resumeForm(page);
  await expect(page.locator("#start-form [name=local]")).toHaveValue(
    "C:\\work\\other-directory-with-a-long-name",
  );
  await expect(page.locator("#delete-removed")).toBeChecked();
  await expect(page.locator("#recursive-sync")).toBeChecked();
  await page.locator("#cancel").click();
});

test("save and start failures retain owner context, and stop failure retains active ownership", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  await resumeForm(page);
  await page.evaluate(() => (window.retainedFixture.failSave = true));
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#modal-root .form-error")).toContainText(
    "Generated settings save conflict",
  );
  expect(await calls(page, "prepare_sync")).toHaveLength(0);
  expect(await calls(page, "start_sync")).toHaveLength(0);
  await page.reload();
  await owned(page);
  await resumeForm(page);
  await page.evaluate(() => (window.retainedFixture.failStart = true));
  await page.locator("#start-form .primary").click();
  await expect(page.locator("#modal-root .form-error")).toContainText(
    "Generated start failed",
  );
  await page.locator("#cancel").click();
  await expect(owner(page, "owner-one")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await start(page);
  await page.evaluate(() => {
    window.retainedFixture.holdStop = true;
    window.retainedFixture.failStop = true;
  });
  await page.locator("#prepare").evaluate((b) => {
    b.click();
    b.click();
  });
  await expect
    .poll(() => calls(page, "stop_sync").then((a) => a.length))
    .toBe(1);
  await page.evaluate(() => {
    window.retainedFixture.holdStop = false;
    window.retainedFixture.releaseStop();
  });
  await expect(page.locator("main")).toContainText("Generated stop failed");
  await expect(page.locator("#retained-resume")).toHaveCount(0);
  await page.locator("#prepare").click();
  await expect(page.locator("#retained-resume")).toBeVisible();
});

test("pending connect cannot be replaced by owner actions or leak cancellation UI", async ({
  page,
}) => {
  await boot(page);
  await page.locator("#add-tab").click();
  await page.evaluate(() => (window.retainedFixture.holdConnect = true));
  await page.locator("#connect-form .primary").click();
  await expect(page.locator("#connect-cancel")).toBeEnabled();
  await expect(page.locator("#retained-open,#retained-resume")).toHaveCount(0);
  await page.locator("#connect-cancel").click();
  await page.evaluate(() => window.retainedFixture.releaseConnect());
  await expect(page.locator("#connect-form .primary")).toBeEnabled();
  expect(await calls(page, "start_sync")).toHaveLength(0);
});

test("delayed owner path reads never replace another selected tab", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  await connect(page);
  await page.locator("#remote-path").fill("/different-browse-folder");
  await page.locator("#remote-path").press("Enter");
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator("[data-refresh=remote]").click();
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.evaluate(
    () => (window.retainedFixture.holdRemotePath = "/srv/site"),
  );
  await page.locator("#retained-open").click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.retainedFixture.releaseRemote),
    )
    .toBe("function");
  await owner(page, "owner-two").click();
  await page.evaluate(() => window.retainedFixture.releaseRemote());
  await expect(owner(page, "owner-two")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("main")).not.toContainText("C:\\work\\site");
  expect(await calls(page, "start_sync")).toHaveLength(0);
});

test("edited endpoint blocks resume and open without connecting to a different server", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("retained-fixture"));
    s.profiles[0].host = "changed.invalid";
    localStorage.setItem("retained-fixture", JSON.stringify(s));
  });
  await page.reload();
  await owned(page);
  await page.locator("#retained-open").click();
  expect(await calls(page, "connect_session")).toHaveLength(0);
  await page.locator("#retained-resume").click();
  await expect(page.locator("#start-form")).toHaveCount(0);
  expect(await calls(page, "start_sync")).toHaveLength(0);
});

test("legacy unowned records remain invisible and unchanged across owner writes", async ({
  page,
}) => {
  await boot(page);
  const legacy = (await stored(page)).retainedSyncs.find(
    (r) => r.id === "legacy",
  );
  await owned(page);
  await page.locator('[data-close="owner-one"]').click();
  expect(
    (await stored(page)).retainedSyncs.find((r) => r.id === "legacy"),
  ).toEqual(legacy);
  await page.reload();
  await expect(page.locator("main")).not.toContainText("/legacy-hidden");
  await page.locator("#add-tab").click();
  await expect(context(page)).toHaveCount(0);
});

test("closed history has no restore action and the final explicit new tab respects the tab limit", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("retained-fixture"));
    s.retainedSyncs[0].ownerTabClosed = true;
    for (let i = 0; i < 14; i++)
      s.retainedSyncs.push({
        ...s.retainedSyncs[1],
        id: "extra-record-" + i,
        ownerTabId: "extra-owner-" + i,
        ownerTabClosed: false,
        local: "C:\\private-" + i,
        remote: "/private-" + i,
      });
    localStorage.setItem("retained-fixture", JSON.stringify(s));
  });
  await page.reload();
  await expect(page.locator("[role=tab]")).toHaveCount(15);
  await expect(page.locator("#restore-tab")).toHaveCount(0);
  await expect(owner(page)).toHaveCount(0);
  await owner(page, "extra-owner-0").click();
  await page.locator("#add-tab").click();
  await expect(page.locator("[role=tab]")).toHaveCount(16);
  await expect(page.locator("#add-tab")).toBeDisabled();
  await expect(page.locator("#restore-tab")).toHaveCount(0);
  expect(await calls(page, "connect_session")).toHaveLength(0);
  expect(await calls(page, "start_sync")).toHaveLength(0);
});
test("explicitly choosing an exact saved pair restores its preferences without adopting another owner", async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("retained-fixture")),
      key = JSON.stringify([
        s.profiles[0].id,
        "/srv/site",
        "c:\\work\\other-directory-with-a-long-name",
      ]);
    s.syncOptions = { [key]: { deleteRemoved: true, recursive: false } };
    s.exclusions = { [key]: "other-owner-private/" };
    localStorage.setItem("retained-fixture", JSON.stringify(s));
  });
  await page.reload();
  await page.locator("#add-tab").click();
  await connect(page);
  await page.locator("#remote-path").fill("/srv/site");
  await page.locator("#remote-path").press("Enter");
  await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator("#local-path").fill("C:\\work\\other-directory-with-a-long-name");
  await page.locator("#local-path").press("Enter");
  await expect(page.locator("[data-pane=local]")).toHaveAttribute("aria-busy","false");
  await page.locator("#prepare").click();
  await expect(page.locator("#delete-removed")).toBeChecked();
  await expect(page.locator("#recursive-sync")).not.toBeChecked();
  await page.locator("#exclusion-details summary").click();
  await expect(page.locator("#exclusion-rules")).toHaveValue(
    "other-owner-private/",
  );
  await page.locator("#cancel").click();
  await expect(page.locator("#retained-resume,.stopped-context")).toHaveCount(
    0,
  );
  expect(await calls(page, "start_sync")).toHaveLength(0);
});

for (const legacyOnly of [false, true])
  test(`startup restores exact saved pair preferences without reopening ${legacyOnly ? "legacy unowned" : "closed owner"} session context`, async ({
    page,
  }) => {
    await boot(page);
    await page.evaluate((legacyOnly) => {
      const s = JSON.parse(localStorage.getItem("retained-fixture")),
        p = s.profiles[0],
        connection = JSON.stringify([
          p.id,
          p.mode,
          p.host.trim().toLowerCase(),
          p.port,
          p.user,
          p.hostKey.trim(),
        ]);
      s.retainedSyncs = legacyOnly
        ? s.retainedSyncs.filter((r) => r.id === "legacy")
        : s.retainedSyncs.map((r) =>
            r.ownerTabId ? { ...r, ownerTabClosed: true } : r,
          );
      s.browseLocations = {
        [connection]: { local: "C:\\work\\site", remote: "/srv/site" },
      };
      s.history[JSON.stringify([connection, "/srv/site"])] = "C:\\work\\site";
      s.syncOptions = {};
      s.exclusions = {};
      for (const local of ["c:\\fixture", "c:\\work\\site"]) {
        const key = JSON.stringify([p.id, "/srv/site", local]);
        s.syncOptions[key] = { deleteRemoved: true, recursive: false };
        s.exclusions[key] = "closed-owner-only/";
      }
      localStorage.setItem("retained-fixture", JSON.stringify(s));
    }, legacyOnly);
    await page.reload();
    await expect(context(page)).toHaveCount(0);
    await expect(page.locator("#retained-resume")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("/srv/site");
    expect(await calls(page, "connect_session")).toHaveLength(0);
    await connect(page);
    await expect(page.locator("#local-path")).toHaveValue("C:\\work\\site");
    await expect(page.locator("#remote-path")).toHaveValue("/srv/site");
    await page.locator("#remote-path").fill("/srv/site");
    await page.locator("#remote-path").press("Enter");
    await expect(page.locator("[data-pane=remote]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await page.locator("#prepare").click();
    await expect(page.locator("#start-form [name=local]")).toHaveValue(
      "C:\\work\\site",
    );
    await expect(page.locator("#recursive-sync")).not.toBeChecked();
    await expect(page.locator("#delete-removed")).toBeChecked();
    await page.locator("#exclusion-details summary").click();
    await expect(page.locator("#exclusion-rules")).toHaveValue(
      "closed-owner-only/",
    );
    await page.locator("#cancel").click();
    expect(await calls(page, "start_sync")).toHaveLength(0);
    await expect(page.locator("#restore-tab")).toHaveCount(0);
  });

test("quoted owned record identifiers remain inert and actions address only their own record", async ({
  page,
}) => {
  await boot(page);
  const id = 'quoted"><img data-injected src=x onerror=alert(1)>';
  await page.evaluate((id) => {
    const s = JSON.parse(localStorage.getItem("retained-fixture"));
    s.retainedSyncs[0].id = id;
    localStorage.setItem("retained-fixture", JSON.stringify(s));
  }, id);
  await page.reload();
  await owner(page).click();
  await expect(page.locator("#retained-open")).toHaveAttribute(
    "data-retained-open",
    id,
  );
  await expect(page.locator("[data-injected]")).toHaveCount(0);
  await expect(page.locator("#retained-resume")).toHaveAttribute(
    "data-retained-resume",
    id,
  );
  await resumeForm(page);
  await expect(page.locator("#start-form [name=local]")).toHaveValue(
    "C:\\work\\site",
  );
  await page.locator("#cancel").click();
  expect(await calls(page, "start_sync")).toHaveLength(0);
});

test("two owners run independently and returning to a tab does not show the other job", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  await start(page);
  await owned(page, "owner-two", "saved-two");
  await start(page);
  let starts = await calls(page, "start_sync");
  expect(starts).toHaveLength(2);
  expect(starts[0].args.remote).toBe("/srv/site");
  expect(starts[1].args.remote).toBe("/srv/other-directory-with-a-long-name");
  await owned(page);
  await expect(page.locator("main")).not.toContainText("/srv/other-directory");
  await page.locator("#prepare").click();
  await expect(page.locator("#retained-resume")).toBeVisible();
  await owned(page, "owner-two", "saved-two");
  await expect(page.locator("#retained-resume")).toHaveCount(0);
  expect(await calls(page, "stop_sync")).toHaveLength(1);
  await page.locator("#prepare").click();
  await expect(page.locator("#retained-resume")).toBeVisible();
});

test("blocked-close notice is visible and deduplicated for button and native events; job is untouched", async ({
  page,
}) => {
  await boot(page);
  await owned(page);
  await start(page);
  const starts = await calls(page, "start_sync");
  for (let i = 0; i < 3; i++) await page.locator("#window-close").click();
  await expect(page.locator("#window-close-notice")).toBeVisible();
  await expect(page.locator("#window-close-notice")).toHaveCount(1);
  expect(await calls(page, "stop_sync")).toHaveLength(0);
  expect(await calls(page, "start_sync")).toEqual(starts);
  await page.evaluate(() => {
    const f = window.retainedFixture;
    for (let i = 0; i < 3; i++)
      f.listeners["sync-close-blocked"]({
        payload: "Generated native blocked-close feedback",
      });
  });
  await expect(page.locator("#window-close-notice")).toContainText(
    "Generated native blocked-close feedback",
  );
  await expect(page.locator("#window-close-notice")).toHaveCount(1);
  expect(await calls(page, "stop_sync")).toHaveLength(0);
  await expect(page.locator("#prepare")).toBeEnabled();
});

test("language order is English first without resetting the saved Japanese selection", async ({
  page,
}) => {
  await boot(page, { language: "ja", theme: "light", compactExplorer: false });
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#language-select")).toHaveValue("ja");
  expect(
    await page
      .locator("#language-select option")
      .evaluateAll((options) =>
        options.map((o) => ({ value: o.value, text: o.textContent?.trim() })),
      ),
  ).toEqual([
    { value: "en", text: "English" },
    { value: "ja", text: "日本語" },
  ]);
  await page.reload();
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#language-select")).toHaveValue("ja");
});

for (const language of ["ja", "en"])
  for (const theme of ["forest", "mint"])
    for (const compactExplorer of [false, true])
      test(`green owned controls fit ${language} ${theme} compact=${compactExplorer}`, async ({
        page,
      }) => {
        await boot(page, { language, theme, compactExplorer });
        await owned(page);
        await connect(page);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        for (const width of [800, 1180]) {
          await page.setViewportSize({ width, height: 850 });
          await expect(page.locator("#retained-open")).toBeVisible();
          await expect(page.locator("#retained-resume")).toBeVisible();
          const boxes = await page
            .locator("#retained-open")
            .evaluate((open) => {
              const buttons = [
                open,
                document.querySelector("#prepare"),
                document.querySelector("#retained-resume"),
              ];
              return buttons.map((b) => {
                const r = b.getBoundingClientRect();
                return {
                  left: r.left,
                  right: r.right,
                  top: r.top,
                  bottom: r.bottom,
                  width: r.width,
                };
              });
            });
          for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            expect(b.left).toBeGreaterThanOrEqual(0);
            expect(b.right).toBeLessThanOrEqual(width);
            expect(b.width).toBeGreaterThan(20);
            if (i) expect(boxes[i - 1].right).toBeLessThanOrEqual(b.left);
            if (i === 2)
              expect(b.left - boxes[i - 1].right).toBeLessThanOrEqual(12);
          }
          await expect(page.locator("main")).not.toContainText(
            "/srv/other-directory",
          );
          await expect(page.locator("main")).not.toContainText(
            "/legacy-hidden",
          );
          if (width === 800)
            await page.screenshot({
              path: `test-results/tab-context-ui/owned-${language}-${theme}-${compactExplorer}-800.png`,
            });
        }
        expect(await calls(page, "start_sync")).toHaveLength(0);
      });
