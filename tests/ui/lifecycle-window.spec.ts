import { test, expect, type BrowserContext, type Page } from "@playwright/test";

type Call = { label: string; cmd: string; args: any };
// Browser-only native protocol model. This never claims to exercise OS dragging,
// physical window placement, or a real second executable/process.
async function registry(
  context: BrowserContext,
  count = 3,
  theme = "light",
  language = "en",
  sessionStopped = false,
) {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const profiles = Array.from({ length: count + 2 }, (_, i) => ({
    id: `profile-${i}`,
    name: `Fixture ${i}`,
    host: `host-${i}.invalid`,
    port: 22,
    user: "fixture",
    mode: "sftp",
    auth: "key",
    keyFile: "C:\\fixture\\fake.ppk",
    hostKey: `SHA256:fixture${i}`,
  }));
  let settings: any = {
    version: 1,
    settingsRevision: 10,
    theme,
    language,
    profiles,
    history: {},
    retainedSyncs: profiles.map((profile, i) => ({
      id: `record-${i}`,
      profile,
      local: `C:\\fixture\\root-${i}`,
      remote: `/srv/${i}`,
      ownerTabId: `owner-${i}`,
      ownerTabClosed: false,
      exclusionRules: "*.tmp",
      deleteRemoved: false,
      recursive: true,
      pendingState: "unknown",
    })),
  };
  const pages = new Map<Page, string>(),
    calls: Call[] = [],
    jobs = new Map<string, any>();
  let closeFailure = false;
  let drag: any,
    transfer: any,
    holdReady = false,
    readyResolve: (() => void) | undefined;
  async function emit(name: string, payload: any) {
    await Promise.all(
      [...pages.keys()]
        .filter((p) => !p.isClosed())
        .map((p) =>
          p.evaluate(
            ({ name, payload }) => {
              for (const listener of (window as any).fixtureListeners[name] ??
                [])
                listener({ payload });
            },
            { name, payload: clone(payload) },
          ),
        ),
    );
  }
  await context.exposeBinding(
    "fixtureInvoke",
    async ({ page }, cmd: string, args: any = {}) => {
      const label = pages.get(page)!;
      calls.push({ label, cmd, args: clone(args) });
      if (cmd === "close_empty_window" && closeFailure) {
        closeFailure = false;
        throw Error("Fixture close refused");
      }
      if (cmd === "register_window")
        return {
          label,
          freshProcess: label === "fresh",
          ownedWorkspaceIds:
            label === "main"
              ? Array.from({ length: count }, (_, i) => `owner-${i}`)
              : label === "existing"
                ? ["owner-3", "owner-4"]
                : [],
          // Persisted entries alone never establish a session Resume. Only these
          // explicitly supplied native descriptors attest the prior stopped job.
          jobs: sessionStopped && label === "main" ? settings.retainedSyncs.slice(0,count).map((r:any)=>({id:`stopped-${r.id}`,workspaceId:r.ownerTabId,job:{id:`stopped-${r.id}`,profile:r.profile,local:r.local,remote:r.remote,status:"stopped",sent:0,speed:0,latency:0,logs:[],pending:0,errorCount:0,exclusionRules:r.exclusionRules,deleteRemoved:r.deleteRemoved,recursive:r.recursive}})) : [],
          workspaces: sessionStopped && label === "main" ? settings.retainedSyncs.slice(0,count).map((r:any)=>({id:r.ownerTabId,connection:r.profile})) : [],
          ...(transfer?.sourceLabel === label && transfer.phase === "pending"
            ? { outgoingTransfers: [clone(transfer)] }
            : {}),
          ...(transfer?.targetLabel === label && transfer.phase === "pending"
            ? { pendingTransfer: clone(transfer) }
            : {}),
        };
      if(cmd === 'request_text_editor_origin_close') return true;
          if (cmd === "load_settings") return clone(settings);
      if (cmd === "save_settings") {
        settings = {
          ...clone(args.data),
          settingsRevision: settings.settingsRevision + 1,
        };
        return settings.settingsRevision;
      }
      if (cmd === "begin_tab_drag") {
        drag = {
          dragId: "drag-1",
          sourceLabel: label,
          workspaceId: args.workspaceId,
          phase: "dragging",
          targetLabel: null,
          beforeId: null,
          targetIndex: null,
          token: null,
          reason: null,
        };
        return clone(drag);
      }
      if (cmd === "tab_drag_status") return clone(drag);
      if (cmd === "cancel_tab_drag") {
        drag.phase = "cancelled";
        await emit("tab-drag", drag);
        return clone(drag);
      }
      if (cmd === "workspace_transfer_status") return clone(transfer);
      if (cmd === "workspace_transfer_ready") {
        if (holdReady)
          await new Promise<void>((resolve) => {
            readyResolve = resolve;
          });
        if (transfer.phase === "pending") {
          transfer.phase = "committed";
          await emit("workspace-transfer", transfer);
        }
        return clone(transfer);
      }
      if (cmd === "abort_workspace_transfer") {
        if (transfer.phase === "pending") transfer.phase = "aborted";
        await emit("workspace-transfer", transfer);
        return clone(transfer);
      }
      if (cmd === "default_folder") return "C:\\fixture";
      if (cmd === "list_drives") return [{ path: "C:\\", name: "C:" }];
      if (cmd === "list_local" || cmd === "list_remote")
        return [
          { name: "keep.txt", dir: false, size: 12 },
          { name: "other.txt", dir: false, size: 4 },
        ];
      if (cmd === "connect_session")
        return {
          path: "/",
          entries: [{ name: "remote.txt", dir: false, size: 8 }],
        };
      if (cmd === "start_sync") {
        jobs.set(args.id, clone(args));
        return;
      }
      if (cmd === "stop_sync") {
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
          logs: ["Fixture live job"],
          remoteChanges: { revision: 0, records: [], truncated: false },
        };
      if (cmd === "watch_local_directory" || cmd === "local_watch_status")
        return { token: args.token ?? 1, revision: 0 };
      if (/run_file_operation|run_local_archive/.test(cmd))
        throw Error(`Unexpected destructive fixture call ${cmd}`);
    },
  );
  await context.addInitScript(() => {
    const w = window as any;
    w.fixtureListeners = {};
    w.__TAURI__ = {
      core: { invoke: (cmd: string, args: any) => w.fixtureInvoke(cmd, args) },
      event: {
        listen: async (name: string, callback: any) => {
          (w.fixtureListeners[name] ??= []).push(callback);
          return () => {
            w.fixtureListeners[name] = w.fixtureListeners[name].filter(
              (c: any) => c !== callback,
            );
          };
        },
      },
    };
  });
  return {
    failClose: () => {
      closeFailure = true;
    },
    updateSettings: (change: any) => {
      settings = { ...settings, ...clone(change) };
    },
    calls,
    jobs,
    settings: () => clone(settings),
    transfer: () => clone(transfer),
    holdReady: () => {
      holdReady = true;
    },
    releaseReady: () => readyResolve?.(),
    async open(label = "main") {
      const p = await context.newPage();
      pages.set(p, label);
      await p.goto("/");
      await expect(p.locator("html")).toHaveAttribute(
        "data-window-label",
        label,
      );
      return p;
    },
    async feedback(updates: any) {
      drag = { ...drag, ...updates };
      await emit("tab-drag", drag);
    },
    async drop(
      targetKind: "new" | "existing",
      beforeId: string | null = null,
      targetIndex = 0,
    ) {
      const start = calls.findLast((c) => c.cmd === "begin_tab_drag")!;
      transfer = {
        token: "transfer-1",
        workspaceId: drag.workspaceId,
        sourceLabel: "main",
        targetLabel: targetKind === "new" ? "child-1" : "existing",
        phase: "pending",
        payload: clone(start.args.payload),
        targetKind,
        beforeId,
        targetIndex,
      };
      drag = {
        ...drag,
        phase: "pending",
        targetLabel: transfer.targetLabel,
        beforeId,
        targetIndex,
        token: transfer.token,
      };
      await emit("workspace-transfer", transfer);
      await emit("tab-drag", drag);
    },
    async outcome(phase: "aborted" | "committed", silent = false) {
      transfer.phase = phase;
      if (!silent) await emit("workspace-transfer", transfer);
    },
  };
}
const tab = (p: Page, id: string) => p.locator(`[data-tab="${id}"]`);
const ids = (p: Page) =>
  p
    .locator("[data-tab]")
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.tab));
const effects = (calls: Call[]) =>
  calls.filter((c) =>
    /connect_session|disconnect_session|start_sync|stop_sync|prepare_session|prepare_sync/.test(
      c.cmd,
    ),
  );
async function box(p: Page, id: string) {
  await tab(p,id).click({trial:true});
  return (await tab(p, id).boundingBox())!;
}
async function hold(p: Page, id = "owner-0") {
  const b = await box(p, id);
  const x = b.x + Math.min(30, b.width / 2),
    y = b.y + b.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  return { x, y };
}
async function external(p: Page, id = "owner-0") {
  const origin = await hold(p, id);
  const strip = (await p.locator(".tabs").boundingBox())!;
  await p.mouse.move(origin.x + 8, origin.y);
  await p.mouse.move(origin.x, strip.y + strip.height + 48, { steps: 5 });
  await expect(tab(p, id)).toHaveAttribute("data-transfer-pending", "true");
  return origin;
}
async function pending(p: Page, id = "owner-0") {
  await expect(tab(p, id)).toHaveAttribute("data-transfer-pending", "true");
  await expect(p.locator(`[data-close="${id}"]`)).toBeDisabled();
}

test("closing the last stopped owner calls empty-window close without a placeholder or restore UI", async ({
  context,
}) => {
  const n = await registry(context, 1),
    p = await n.open();
  await expect(p.locator("#restore-tab")).toHaveCount(0);
  await p.locator('[data-close="owner-0"]').click();
  await expect
    .poll(() => n.calls.filter((c) => c.cmd === "close_empty_window").length)
    .toBe(1);
  await expect(p.locator("html")).toHaveAttribute(
    "data-window-closing",
    "true",
  );
  await expect(p.locator("[data-tab]")).toHaveCount(0);
  expect(
    n.calls.filter(
      (c) => c.cmd === "register_workspace" && c.args.id !== "owner-0",
    ),
  ).toEqual([]);
  expect(n.calls.filter((c) => c.cmd === "stop_sync")).toEqual([]);
  await expect(p.locator("#restore-tab")).toHaveCount(0);
});

test("closing one of two owners retains the other tab and never offers closed-tab restore", async ({
  context,
}) => {
  const n = await registry(context, 2),
    p = await n.open();
  await p.locator('[data-close="owner-0"]').click();
  await expect.poll(() => ids(p)).toEqual(["owner-1"]);
  expect(n.calls.filter((c) => c.cmd === "close_empty_window")).toEqual([]);
  await expect(p.locator("#restore-tab")).toHaveCount(0);
  expect(
    n.settings().retainedSyncs.find((r: any) => r.id === "record-0"),
  ).toBeUndefined();
});

for (const phase of ["committed", "aborted"] as const)
  test(`last transferred source closes only when ${phase}`, async ({
    context,
  }) => {
    const n = await registry(context, 1),
      p = await n.open();
    await external(p);
    await p.mouse.up();
    await n.drop("new");
    await pending(p);
    expect(n.calls.filter((c) => c.cmd === "close_empty_window")).toEqual([]);
    await n.outcome(phase);
    if (phase === "committed") {
      await expect
        .poll(
          () => n.calls.filter((c) => c.cmd === "close_empty_window").length,
        )
        .toBe(1);
      await expect(p.locator("[data-tab]")).toHaveCount(0);
    } else {
      await expect(p.locator('[data-close="owner-0"]')).toBeEnabled();
      expect(await ids(p)).toEqual(["owner-0"]);
      expect(n.calls.filter((c) => c.cmd === "close_empty_window")).toEqual([]);
    }
    expect(n.calls.filter((c) => c.cmd === "stop_sync")).toEqual([]);
  });

async function startOwned(p: Page) {
  await p.locator("#connect-form .primary").click();
  await expect(p.locator("#local-path")).toBeVisible();
  await expect(p.locator("#retained-resume")).toHaveCount(0);
  await p.locator("#prepare").click();
  await p.locator("#start-form .primary").click();
  await expect(p.locator("#start-form")).toHaveCount(0);
  await expect(p.locator("#sent-count")).toContainText("1234");
}

test("running owner close shows one visible notice without stopping or disconnecting its job", async ({
  context,
}) => {
  const n = await registry(context, 1),
    p = await n.open();
  await startOwned(p);
  const jobs = [...n.jobs];
  for (let i = 0; i < 3; i++) await p.locator('[data-close="owner-0"]').click();
  await expect(p.locator("#window-close-notice")).toBeVisible();
  await expect(p.locator("#window-close-notice")).toHaveCount(1);
  await expect(p.locator("#window-close-notice")).toContainText(/stop/i);
  expect(
    n.calls.filter((c) =>
      /stop_sync|disconnect_session|close_empty_window/.test(c.cmd),
    ),
  ).toEqual([]);
  expect([...n.jobs]).toEqual(jobs);
  expect(await ids(p)).toEqual(["owner-0"]);
});

test("session Resume is compact and reveals its frozen paths on hover and keyboard focus", async ({
  context,
}) => {
  const n = await registry(context, 1, "light", "en", true),
    p = await n.open();
  await expect(p.locator("#tab-sync-context")).toHaveCount(0);
  await expect(p.locator(".stopped-context")).toHaveCount(0);
  const stopped = p.locator("#retained-resume");
  await expect(p.locator("#retained-resume")).toBeVisible();
  await expect(p.locator("#retained-open")).toBeVisible();
  const tip = p.locator("#sync-resume-help");
  await expect(tip).toBeHidden();
  await stopped.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("C:\\fixture\\root-0");
  await expect(tip).toContainText("/srv/0");
  await p.locator("#add-tab").hover();
  await expect(tip).toBeHidden();
  await stopped.focus();
  await expect(tip).toBeVisible();
  await p.locator("#add-tab").focus();
  await expect(tip).toBeHidden();
});

test("Open locations loads session stopped paths without starting a job", async ({
  context,
}) => {
  const n = await registry(context, 1, "light", "en", true),
    p = await n.open();
  await expect(p.locator("#retained-resume")).toBeEnabled();
  expect(n.calls.filter((c) => c.cmd === "connect_session")).toEqual([]);
  await p.locator("#local-path").fill("C:\\elsewhere");
  await p.locator("#local-path").press("Enter");
  await expect(p.locator("#local-path")).toBeVisible();
  await p.locator("#retained-open").click();
  await expect(p.locator("#local-path")).toHaveValue("C:\\fixture\\root-0");
  await expect(p.locator("#remote-path")).toHaveValue("/srv/0");
  expect(n.calls.filter((c) => c.cmd === "start_sync")).toEqual([]);
  await expect(p.locator("#retained-resume")).toBeEnabled();
});

test("stopped session context is absent on independent startup while connection browse restores without auto-connect", async ({
  context,
}) => {
  const n = await registry(context, 1),
    settings = n.settings(),
    profile = settings.profiles[0],
    key = JSON.stringify([
      profile.id,
      profile.mode,
      profile.host,
      profile.port,
      profile.user,
      profile.hostKey,
    ]);
  n.updateSettings({
    browseLocations: {
      [key]: { local: "C:\\remembered", remote: "/remembered" },
    },
    history: {},
    retainedSyncs: settings.retainedSyncs,
  });
  const p = await n.open("fresh");
  await expect(p.locator("[data-tab]")).toHaveCount(1);
  await expect(
    p.locator(
      "#restore-tab,#tab-sync-context,.stopped-context,#retained-resume",
    ),
  ).toHaveCount(0);
  expect(
    n.calls.filter((c) =>
      /connect_session|start_sync|list_local|list_remote/.test(c.cmd),
    ),
  ).toEqual([]);
  await p.locator('[data-connection-select="profile-0"]').click();
  await p.locator("#connect-form .primary").click();
  await expect(p.locator("#local-path")).toHaveValue("C:\\remembered");
  await expect(p.locator("#remote-path")).toHaveValue("/remembered");
  expect(n.calls.filter((c) => c.cmd === "start_sync")).toEqual([]);
});

for (const recovery of ["retry", "add-tab"] as const)
  test(`refused empty-window close recovers zero-tab chrome for ${recovery}`, async ({
    context,
  }) => {
    const n = await registry(context, 1),
      p = await n.open();
    n.failClose();
    await p.locator('[data-close="owner-0"]').click();
    await expect(p.locator("#window-close-notice")).toContainText(
      "Fixture close refused",
    );
    await expect(p.locator("html")).toHaveAttribute(
      "data-window-closing",
      "false",
    );
    await expect(p.locator("[data-tab]")).toHaveCount(0);
    await expect(p.locator("#app")).toHaveJSProperty("inert", false);
    if (recovery === "retry") {
      await p.locator("#window-close").click();
      await expect
        .poll(
          () => n.calls.filter((c) => c.cmd === "close_empty_window").length,
        )
        .toBe(2);
    } else {
      await p.locator("#add-tab").click();
      await expect(p.locator("[data-tab]")).toHaveCount(1);
      await expect(p.locator("#connect-form")).toBeVisible();
      expect(
        n.calls.filter((c) => c.cmd === "close_empty_window"),
      ).toHaveLength(1);
    }
    expect(n.calls.filter((c) => c.cmd === "stop_sync")).toEqual([]);
  });

test("each saved connection restores its own browse pair only after explicit connect", async ({
  context,
}) => {
  const n = await registry(context, 1),
    profiles = n.settings().profiles.slice(0, 2),
    browseLocations = Object.fromEntries(
      profiles.map((p: any, i: number) => [
        JSON.stringify([p.id, p.mode, p.host, p.port, p.user, p.hostKey]),
        { local: `C:\\remembered-${i}`, remote: `/remembered-${i}` },
      ]),
    );
  n.updateSettings({ retainedSyncs: [], browseLocations });
  const p = await n.open("fresh");
  expect(n.calls.filter((c) => c.cmd === "connect_session")).toHaveLength(0);
  await p.locator('[data-connection-select="profile-0"]').click();
  await p.locator("#connect-form .primary").click();
  await expect(p.locator("#local-path")).toHaveValue("C:\\remembered-0");
  await expect(p.locator("#remote-path")).toHaveValue("/remembered-0");
  await p.locator("#add-tab").click();
  expect(n.calls.filter((c) => c.cmd === "connect_session")).toHaveLength(1);
  await p.locator('[data-connection-select="profile-1"]').click();
  await p.locator("#connect-form .primary").click();
  await expect(p.locator("#local-path")).toHaveValue("C:\\remembered-1");
  await expect(p.locator("#remote-path")).toHaveValue("/remembered-1");
  expect(n.calls.filter((c) => c.cmd === "connect_session")).toHaveLength(2);
  expect(n.calls.filter((c) => c.cmd === "start_sync")).toEqual([]);
});

test("fresh native Sync uses the current explorer pair instead of the historical mapping", async ({
  context,
}) => {
  const n = await registry(context, 1),
    profile = n.settings().profiles[0],
    connectionKey = JSON.stringify([
      profile.id,
      profile.mode,
      profile.host,
      profile.port,
      profile.user,
      profile.hostKey,
    ]),
    mappingKey = JSON.stringify([connectionKey, "/mapped-remote"]);
  n.updateSettings({
    retainedSyncs: [],
    browseLocations: {
      [connectionKey]: {
        local: "C:\\browse-current",
        remote: "/mapped-remote",
      },
    },
    history: { [mappingKey]: "C:\\previous-sync-local" },
  });
  const p = await n.open("fresh");
  expect(n.calls.filter((c) => c.cmd === "connect_session")).toHaveLength(0);
  await p.locator("#connect-form .primary").click();
  await expect(p.locator("#local-path")).toHaveValue("C:\\browse-current");
  await expect(p.locator("#remote-path")).toHaveValue("/mapped-remote");
  await expect(p.locator("#retained-resume,.stopped-context")).toHaveCount(0);
  await p.locator("#prepare").click();
  await expect(p.locator("#start-form [name=local]")).toHaveValue(
    "C:\\browse-current",
  );
  await expect(p.locator("#start-form [name=local]")).toHaveAttribute("type", "hidden");
  await expect(p.locator("[data-sync-source]")).toHaveText("C:\\browse-current");
  await expect(p.locator("#local-path")).toHaveValue("C:\\browse-current");
  await expect(p.locator("#remote-path")).toHaveValue("/mapped-remote");
  expect(n.calls.filter((c) => c.cmd === "start_sync")).toEqual([]);
});
