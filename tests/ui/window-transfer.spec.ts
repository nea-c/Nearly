import { test, expect, type BrowserContext, type Page } from "@playwright/test";

type Call = { label: string; cmd: string; args: any };
type Transfer = {
  token: string;
  workspaceId: string;
  sourceLabel: string;
  targetLabel: string;
  phase: "pending" | "committed" | "aborted";
  payload: any;
};

// This models the native coordinator, not a second copy of the frontend store.
// Each page gets its own JS realm; settings and native jobs remain global.
async function coordinator(context: BrowserContext, count = 3) {
  const profiles = Array.from({ length: count }, (_, i) => ({
    id: `profile-${i}`,
    name: `Transfer server ${i}`,
    host: `server-${i}.invalid`,
    port: 2200 + i,
    user: `user-${i}`,
    mode: "sftp",
    auth: "key",
    keyFile: `C:\\fixture\\key-${i}.ppk`,
    hostKey: `SHA256:fixture${i}`,
  }));
  let settings: any = {
    version: 1,
    settingsRevision: 20,
    language: "en",
    theme: "light",
    profiles,
    history: {},
    retainedSyncs: profiles.map((profile, i) => ({
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
    })),
  };
  const calls: Call[] = [],
    pages = new Map<Page, string>(),
    jobs = new Map<string, any>();
  let transfer: Transfer | undefined,
    failBegin = false,
    holdReady = false;
  let releaseReady: (() => void) | undefined;
  let holdSettingsLabel: string | undefined,
    settingsLoadHeld = false;
  let releaseSettingsLoad: (() => void) | undefined;
  let nativeRuntimeBootstrap = false,
    holdStop = false;
  let releaseStop: (() => void) | undefined;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  async function emit(record: Transfer) {
    await Promise.all(
      [...pages.keys()]
        .filter((p) => !p.isClosed())
        .map((p) =>
          p.evaluate((record) => {
            for (const callback of (window as any).transferListeners?.[
              "workspace-transfer"
            ] ?? [])
              callback({ payload: record });
          }, record),
        ),
    );
  }
  await context.exposeBinding(
    "transferInvoke",
    async ({ page }, cmd: string, args: any = {}) => {
      const label = pages.get(page)!;
      calls.push({ label, cmd, args: copy(args) });
      if (cmd === "register_window")
        return {
          label,
          ownedWorkspaceIds:
            label === "main" ? profiles.map((_, i) => `owner-${i}`) : [],
          jobs: nativeRuntimeBootstrap
            ? [...jobs.values()].map((job) => ({
                id: job.id,
                workspaceId: job.sessionId,
                job: {
                  id: job.id,
                  profile: Object.fromEntries(
                    Object.entries(job.profile).reverse(),
                  ),
                  local: job.local,
                  remote: job.remote,
                  status: "running",
                  sent: 1234,
                  speed: 8,
                  latency: 9,
                  logs: ["Generated native job remains alive"],
                  pending: 7,
                  errorCount: 0,
                  exclusionRules: job.exclusionRules,
                  deleteRemoved: job.deleteRemoved,
                  recursive: job.recursive,
                },
              }))
            : [],
          workspaces: nativeRuntimeBootstrap
            ? [...jobs.values()].map((job) => ({
                id: job.sessionId,
                connection: Object.fromEntries(
                  Object.entries(job.profile).reverse(),
                ),
              }))
            : [],
          ...(label === "main" && transfer?.phase === "pending"
            ? { outgoingTransfers: [copy(transfer)] }
            : {}),
          ...(label !== "main" && transfer
            ? { pendingTransfer: copy(transfer) }
            : {}),
        };
      if (cmd === "register_workspace") return;
      if (cmd === "load_settings") {
        const snapshot = copy(settings);
        if (label === holdSettingsLabel) {
          holdSettingsLabel = undefined;
          settingsLoadHeld = true;
          await new Promise<void>((resolve) => {
            releaseSettingsLoad = resolve;
          });
          settingsLoadHeld = false;
        }
        return snapshot;
      }
      if (cmd === "save_settings") {
        if (args.data.settingsRevision !== settings.settingsRevision)
          throw Error("Generated stale settings revision");
        settings = copy({
          ...args.data,
          settingsRevision: settings.settingsRevision + 1,
        });
        return settings.settingsRevision;
      }
      if (cmd === "begin_tab_drag") {
        if (failBegin) throw Error("Generated child creation failure");
        transfer = {
          token: "transfer-1",
          workspaceId: args.workspaceId,
          sourceLabel: label,
          targetLabel: "child-1",
          phase: "pending",
          payload: copy(args.payload),
        };
        return {
          dragId: "drag-legacy",
          sourceLabel: label,
          workspaceId: args.workspaceId,
          phase: "pending",
          targetLabel: "child-1",
          beforeId: null,
          targetIndex: 0,
          token: transfer.token,
          reason: null,
        };
      }
      if (cmd === "workspace_transfer_status") return copy(transfer);
      if (cmd === "abort_workspace_transfer") {
        transfer!.phase = "aborted";
        await emit(transfer!);
        return copy(transfer);
      }
      if (cmd === "workspace_transfer_ready") {
        if (holdReady)
          await new Promise<void>((resolve) => {
            releaseReady = resolve;
          });
        transfer!.phase = "committed";
        await emit(transfer!);
        return copy(transfer);
      }
      if (cmd === "default_folder") return "C:\\fixture";
      if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
      if (cmd === "list_local" || cmd === "list_remote") return [];
      if (cmd === "connect_session") return { path: "/", entries: [] };
      if (cmd === "start_sync") {
        jobs.set(args.id, copy(args));
        return;
      }
      if (cmd === "stop_sync") {
        if (holdStop)
          await new Promise<void>((resolve) => {
            releaseStop = resolve;
          });
        jobs.delete(args.id);
        return { knownUnreflected: false };
      }
      if (cmd === "sync_status")
        return {
          status: jobs.has(args.id) ? "running" : "stopped",
          pending: 7,
          sent: 1234,
          speed: 8,
          latency: 9,
          errorCount: 0,
          logs: ["Generated native job remains alive"],
          remoteChanges: { revision: 0, records: [], truncated: false },
        };
      if (cmd === "watch_local_directory" || cmd === "local_watch_status")
        return { token: args.token ?? 1, revision: 0 };
      if (/run_file_operation|run_local_archive/.test(cmd))
        throw Error("Filesystem mutation forbidden in generated fixture");
    },
  );
  await context.addInitScript(() => {
    const state = window as any;
    state.transferListeners = {};
    state.__TAURI__ = {
      core: {
        invoke: (cmd: string, args: any) => state.transferInvoke(cmd, args),
      },
      event: {
        listen: async (name: string, callback: any) => {
          (state.transferListeners[name] ??= []).push(callback);
          return () => {
            state.transferListeners[name] = state.transferListeners[
              name
            ].filter((c: any) => c !== callback);
          };
        },
      },
    };
  });
  return {
    calls,
    jobs,
    settings: () => copy(settings),
    transfer: () => {
      if (!transfer) throw Error("No generated transfer has begun");
      return copy(transfer);
    },
    failBegin: () => {
      failBegin = true;
    },
    holdReady: () => {
      holdReady = true;
    },
    releaseReady: () => releaseReady?.(),
    holdSettingsLoad: (label: string) => {
      holdSettingsLabel = label;
    },
    settingsLoadHeld: () => settingsLoadHeld,
    releaseSettingsLoad: () => releaseSettingsLoad?.(),
    nativeRuntimeBootstrap: () => {
      nativeRuntimeBootstrap = true;
    },
    holdStop: () => {
      holdStop = true;
    },
    releaseStop: () => releaseStop?.(),
    finishSilently: (phase: "committed" | "aborted") => {
      transfer!.phase = phase;
    },
    changeSettings: async (updates: any) => {
      settings = copy({
        ...settings,
        ...updates,
        settingsRevision: settings.settingsRevision + 1,
      });
      await Promise.all(
        [...pages.keys()]
          .filter((p) => !p.isClosed())
          .map((p) =>
            p.evaluate((revision) => {
              for (const callback of (window as any).transferListeners?.[
                "settings-changed"
              ] ?? [])
                callback({ payload: { settingsRevision: revision } });
            }, settings.settingsRevision),
          ),
      );
    },
    async open(label = "main") {
      const page = await context.newPage();
      pages.set(page, label);
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute(
        "data-window-label",
        label,
      );
      return page;
    },
  };
}
const tab = (page: Page, id: string) => page.locator(`[data-tab="${id}"]`);
const ids = (page: Page) =>
  page
    .locator("[data-tab]")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.tab));
const effects = (calls: Call[]) =>
  calls.filter((c) =>
    /connect_session|disconnect_session|start_sync|stop_sync|prepare_session|prepare_sync/.test(
      c.cmd,
    ),
  );
async function move(page: Page, id: string, _keyboard = false) {
  // The former context-menu milestone now enters the native protocol through
  // the same real DOM pointer gesture as the dedicated drag regression suite.
  await tab(page,id).click({trial:true});
  const bounds = (await tab(page, id).boundingBox())!;
  const strip = (await page.locator(".tabs").boundingBox())!;
  const x = bounds.x + Math.min(30, bounds.width / 2),
    y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y);
  await page.mouse.move(x, strip.y + strip.height + 48, { steps: 5 });
  await page.mouse.up();
}
async function pending(page: Page, id: string) {
  await expect(tab(page, id)).toHaveAttribute("data-transfer-pending", "true");
  await expect(tab(page, id).locator("..")).toHaveAttribute(
    "data-transfer-pending",
    "true",
  );
  if ((await tab(page, id).getAttribute("aria-selected")) === "true")
    await expect(page.locator("main")).toHaveJSProperty("inert", true);
}

test("mouse and keyboard context menus have no move-window action", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  await tab(source, "owner-1").click();
  await tab(source, "owner-0").click({ button: "right" });
  await expect(source.locator("[data-tab-move-window]")).toHaveCount(0);
  await expect(tab(source, "owner-1")).toHaveAttribute("aria-selected", "true");
  await source.keyboard.press("Escape");
  await tab(source, "owner-1").focus();
  await source.keyboard.press("Shift+F10");
  await expect(source.locator("[data-tab-move-window]")).toHaveCount(0);
  expect(native.calls.filter((c) => c.cmd === "begin_tab_drag")).toEqual([]);
});
test("pending transfer freezes its source; child readiness commits only that owner without global duplication", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  const records = native.settings().retainedSyncs;
  await tab(source, "owner-1").click();
  await move(source, "owner-0");
  await pending(source, "owner-0");
  await expect(source.locator("html")).toHaveAttribute(
    "data-tab-drag-phase",
    "pending",
  );
  await expect(source.locator('[data-close="owner-0"]')).toBeDisabled();
  await tab(source, "owner-0").click({ button: "right" });
  await expect(source.locator('[data-tab-move-window="owner-0"]')).toHaveCount(
    0,
  );
  await source.keyboard.press("Escape");
  expect(native.calls.filter((c) => c.cmd === "begin_tab_drag")).toHaveLength(
    1,
  );
  native.holdReady();
  const child = await native.open("child-1");
  await expect
    .poll(() =>
      native.calls.some(
        (c) => c.label === "child-1" && c.cmd === "workspace_transfer_ready",
      ),
    )
    .toBe(true);
  await expect(tab(source, "owner-0")).toHaveCount(1);
  expect(native.transfer().phase).toBe("pending");
  await expect.poll(() => ids(child)).toEqual(["owner-0"]);
  native.releaseReady();
  await expect(source.locator("html")).toHaveAttribute(
    "data-transfer-phase",
    "committed",
  );
  await expect(child.locator("html")).toHaveAttribute(
    "data-transfer-phase",
    "committed",
  );
  expect(await ids(source)).toEqual(["owner-1", "owner-2"]);
  await expect(tab(source, "owner-1")).toHaveAttribute("aria-selected", "true");
  expect(native.settings().retainedSyncs).toEqual(records);
  expect(effects(native.calls)).toEqual([]);
});

for (const outcome of ["creation failure", "timeout"] as const)
  test(`${outcome} leaves retained owners and original source usable`, async ({
    context,
  }) => {
    const native = await coordinator(context),
      source = await native.open();
    const records = native.settings().retainedSyncs;
    if (outcome === "creation failure") native.failBegin();
    else await source.clock.install();
    await move(source, "owner-0", true);
    if (outcome === "timeout") {
      await pending(source, "owner-0");
      await source.clock.fastForward(36000);
      await expect
        .poll(() =>
          native.calls.some((c) => c.cmd === "abort_workspace_transfer"),
        )
        .toBe(true);
      await expect(source.locator("html")).toHaveAttribute(
        "data-transfer-phase",
        "aborted",
      );
    }
    await expect(source.locator('[data-close="owner-0"]')).toBeEnabled();
    await tab(source, "owner-0").click();
    await expect(source.locator("#connect-form")).toBeVisible();
    // Settings metadata alone is not a previous job in this session.
    await expect(source.locator("#retained-resume,.stopped-context")).toHaveCount(0);
    expect(await ids(source)).toEqual(["owner-0", "owner-1", "owner-2"]);
    expect(native.settings().retainedSyncs).toEqual(records);
    expect(effects(native.calls)).toEqual([]);
  });

test("moving the last owner closes the source only after readiness and preserves target owner", async ({
  context,
}) => {
  const native = await coordinator(context, 1),
    source = await native.open();
  native.holdReady();
  await move(source, "owner-0");
  await pending(source, "owner-0");
  const child = await native.open("child-1");
  await expect(tab(child, "owner-0")).toBeVisible();
  expect(native.calls.filter((c) => c.cmd === "close_empty_window")).toEqual(
    [],
  );
  native.releaseReady();
  await expect
    .poll(
      () => native.calls.filter((c) => c.cmd === "close_empty_window").length,
    )
    .toBe(1);
  await expect(source.locator("[data-tab]")).toHaveCount(0);
  expect(native.settings().retainedSyncs[0].ownerTabClosed).toBe(false);
  expect(effects(native.calls)).toEqual([]);
  await expect(child.locator("#retained-resume,.stopped-context")).toHaveCount(0);
});
test("shared settings notifications refresh both windows without recreating global owners", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  await move(source, "owner-0");
  await pending(source, "owner-0");
  const child = await native.open("child-1");
  await expect(child.locator("html")).toHaveAttribute(
    "data-transfer-phase",
    "committed",
  );
  await expect(tab(source, "owner-0")).toHaveCount(0);
  const records = native.settings().retainedSyncs,
    before = effects(native.calls);
  await native.changeSettings({ theme: "dark", language: "ja" });
  for (const page of [source, child]) {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  }
  expect(await ids(source)).toEqual(["owner-1", "owner-2"]);
  expect(await ids(child)).toEqual(["owner-0"]);
  expect(native.settings().retainedSyncs).toEqual(records);
  expect(effects(native.calls)).toEqual(before);
});

for (const outcome of ["committed", "aborted"] as const)
  test(`source reload restores pending freeze and reconciles ${outcome} without an event`, async ({
    context,
  }) => {
    const native = await coordinator(context),
      source = await native.open();
    const records = native.settings().retainedSyncs;
    await move(source, "owner-0");
    await pending(source, "owner-0");
    await source.reload();
    await expect(source.locator("html")).toHaveAttribute(
      "data-window-label",
      "main",
    );
    await pending(source, "owner-0");
    await expect(source.locator('[data-close="owner-0"]')).toBeDisabled();
    await tab(source, "owner-0").focus();
    await source.keyboard.press("Shift+F10");
    await expect(
      source.locator('[data-tab-move-window="owner-0"]'),
    ).toHaveCount(0);
    await source.keyboard.press("Escape");
    native.finishSilently(outcome);
    await expect(source.locator("html")).toHaveAttribute(
      "data-transfer-phase",
      outcome,
    );
    if (outcome === "committed")
      expect(await ids(source)).toEqual(["owner-1", "owner-2"]);
    else {
      expect(await ids(source)).toEqual(["owner-0", "owner-1", "owner-2"]);
      await expect(source.locator('[data-close="owner-0"]')).toBeEnabled();
      await tab(source, "owner-0").click();
      await expect(source.locator("#connect-form")).toBeVisible();
    }
    expect(native.calls.filter((c) => c.cmd === "begin_tab_drag")).toHaveLength(
      1,
    );
    expect(native.settings().retainedSyncs).toEqual(records);
    expect(effects(native.calls)).toEqual([]);
  });

test("a second settings notification during a delayed load is refreshed on the next read", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  const records = native.settings().retainedSyncs;
  native.holdSettingsLoad("main");
  await native.changeSettings({ theme: "dark" });
  await expect.poll(() => native.settingsLoadHeld()).toBe(true);
  await native.changeSettings({ theme: "mint", language: "ja" });
  native.releaseSettingsLoad();
  await expect(source.locator("html")).toHaveAttribute("data-theme", "mint");
  await expect(source.locator("html")).toHaveAttribute("lang", "ja");
  expect(await ids(source)).toEqual(["owner-0", "owner-1", "owner-2"]);
  expect(native.settings().retainedSyncs).toEqual(records);
  expect(effects(native.calls)).toEqual([]);
});

test("a missed commit after 35 seconds is checked before attempting abort", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  await source.clock.install();
  await move(source, "owner-0");
  await pending(source, "owner-0");
  native.finishSilently("committed");
  await source.clock.fastForward(36000);
  await expect(source.locator("html")).toHaveAttribute(
    "data-transfer-phase",
    "committed",
  );
  expect(await ids(source)).toEqual(["owner-1", "owner-2"]);
  expect(
    native.calls.filter((c) => c.cmd === "abort_workspace_transfer"),
  ).toEqual([]);
  expect(
    native.calls.filter((c) => c.cmd === "workspace_transfer_status").length,
  ).toBeGreaterThan(0);
  expect(effects(native.calls)).toEqual([]);
});

test("running SFTP transfer keeps native job identity and status without reconnect or restart", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  await tab(source, "owner-0").click();
  await source.locator("#connect-form .primary").click();
  await expect(source.locator("#local-path")).toBeVisible();
  await expect(source.locator("#retained-resume")).toHaveCount(0);
  await source.locator("#prepare").click();
  await source.locator("#start-form .primary").click();
  await expect(source.locator("#start-form")).toHaveCount(0);
  await expect.poll(() => native.jobs.size).toBe(1);
  await expect(source.locator("#sent-count")).toContainText("1234");
  const before = effects(native.calls),
    jobs = [...native.jobs],
    records = native.settings().retainedSyncs;
  await move(source, "owner-0");
  await pending(source, "owner-0");
  const dto = native.transfer().payload;
  expect(dto.workspace.id).toBe("owner-0");
  expect(dto.job.id).toBe(jobs[0][0]);
  expect(dto.job.status).toBe("running");
  expect(dto.job.sent).toBe(1234);
  expect(dto.job.profile.mode).toBe("sftp");
  expect(dto.job.retainedId).toBe("record-0");
  expect(dto).not.toHaveProperty("passphrase");
  const child = await native.open("child-1");
  await expect(child.locator("html")).toHaveAttribute(
    "data-transfer-phase",
    "committed",
  );
  await expect(tab(source, "owner-0")).toHaveCount(0);
  await expect(child.locator("#local-path")).toHaveValue(
    dto.workspace.localBrowse,
  );
  await expect(child.locator("#retained-resume")).toHaveCount(0);
  await expect(child.locator("#sent-count")).toContainText("1234");
  await expect(child.locator("main")).toHaveJSProperty("inert", false);
  expect([...native.jobs]).toEqual(jobs);
  expect(effects(native.calls)).toEqual(before);
  expect(native.settings().retainedSyncs).toEqual(records);
});

test("native reload associates reordered profile fields with its retained running job and awaits the real stop", async ({
  context,
}) => {
  const native = await coordinator(context),
    source = await native.open();
  await tab(source, "owner-0").click();
  await source.locator("#connect-form .primary").click();
  await expect(source.locator("#local-path")).toBeVisible();
  await expect(source.locator("#retained-resume")).toHaveCount(0);
  await source.locator("#prepare").click();
  await source.locator("#start-form .primary").click();
  await expect(source.locator("#start-form")).toHaveCount(0);
  await expect(source.locator("#sync-state")).toHaveText("Watching");
  await expect.poll(() => native.jobs.size).toBe(1);
  const [jobId, job] = [...native.jobs][0],
    before = effects(native.calls);
  // Native serde_json maps can order fields differently from the settings struct.
  const reordered = Object.fromEntries(Object.entries(job.profile).reverse());
  expect(reordered).toEqual(job.profile);
  expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(job.profile));
  native.nativeRuntimeBootstrap();
  await source.reload();
  await expect
    .poll(() => ids(source))
    .toEqual(["owner-0", "owner-1", "owner-2"]);
  await expect(tab(source, "owner-0")).toHaveAttribute("aria-selected", "true");
  await tab(source, "owner-0").click();
  await expect(source.locator("#retained-open")).toHaveAttribute(
    "data-retained-open",
    "record-0",
  );
  await expect(source.locator("#sync-state")).toHaveText("Watching");
  await expect(source.locator("#sent-count")).toContainText("1234");
  await expect(source.locator("#retained-resume")).toHaveCount(0);
  expect(effects(native.calls)).toEqual(before);
  native.holdStop();
  await source.locator("#prepare").click();
  await expect
    .poll(() => native.calls.filter((c) => c.cmd === "stop_sync"))
    .toEqual([{ label: "main", cmd: "stop_sync", args: { id: jobId } }]);
  await expect(source.locator("#sync-state")).toHaveText("Stopping");
  expect(native.jobs.has(jobId)).toBe(true);
  await expect(source.locator("#retained-resume")).toHaveCount(0);
  native.releaseStop();
  await expect.poll(() => native.jobs.has(jobId)).toBe(false);
  await expect(source.locator(".stopped-context")).toHaveCount(0);
  await expect(source.locator("#retained-resume")).toBeEnabled();
  await expect(source.locator("#retained-resume")).toHaveAttribute("title", /C:\\fixture\\root-0/);
  await expect(source.locator("#retained-resume")).toBeVisible();
  expect(native.calls.filter((c) => c.cmd === "start_sync")).toHaveLength(1);
  expect(
    native.settings().retainedSyncs.find((r: any) => r.id === "record-0")
      .ownerTabClosed,
  ).toBe(false);
});
