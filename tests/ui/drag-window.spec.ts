import { test, expect, type BrowserContext, type Page } from "@playwright/test";

type Call = { label: string; cmd: string; args: any };
// Browser-only native protocol model. This never claims to exercise OS dragging,
// physical window placement, or a real second executable/process.
async function registry(
  context: BrowserContext,
  count = 3,
  theme = "light",
  language = "en",
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
          jobs: [],
          workspaces: [],
          ...(transfer?.sourceLabel === label && transfer.phase === "pending"
            ? { outgoingTransfers: [clone(transfer)] }
            : {}),
          ...(transfer?.targetLabel === label && transfer.phase === "pending"
            ? { pendingTransfer: clone(transfer) }
            : {}),
        };
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
      if (
        /run_file_operation|run_local_archive|stop_sync|disconnect_session/.test(
          cmd,
        )
      )
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

test("real pointer threshold, in-strip first-to-last reorder, and Escape restore", async ({
  context,
}) => {
  const n = await registry(context),
    p = await n.open();
  await expect(p.locator("[data-tab]")).toHaveCount(3);
  let o = await hold(p);
  await p.mouse.move(o.x + 3, o.y);
  await expect(p.locator(".tab-drag-source")).toHaveCount(0);
  await p.mouse.up();
  const last = await box(p, "owner-2");
  o = await hold(p);
  await p.mouse.move(last.x + last.width - 8, o.y, { steps: 12 });
  await expect(p.locator(".tab-drag-source")).toHaveCount(1);
  await p.mouse.up();
  await expect.poll(() => ids(p)).toEqual(["owner-1", "owner-2", "owner-0"]);
  const first = await box(p, "owner-1");
  o = await hold(p);
  await p.mouse.move(first.x + 4, o.y, { steps: 10 });
  await p.keyboard.press("Escape");
  await p.mouse.up();
  expect(await ids(p)).toEqual(["owner-1", "owner-2", "owner-0"]);
  expect(n.calls.filter((c) => c.cmd === "begin_tab_drag")).toEqual([]);
});

test("close button cannot arm dragging and the removed menu action is absent for mouse and keyboard", async ({
  context,
}) => {
  const n = await registry(context),
    p = await n.open();
  const close = (await p.locator('[data-close="owner-0"]').boundingBox())!;
  await p.mouse.move(close.x + close.width / 2, close.y + close.height / 2);
  await p.mouse.down();
  await p.mouse.move(close.x, close.y + 150, { steps: 5 });
  await p.mouse.up();
  await expect(p.locator(".tab-drag-source")).toHaveCount(0);
  expect(n.calls.filter((c) => c.cmd === "begin_tab_drag")).toEqual([]);
  await tab(p, "owner-1").click({ button: "right" });
  await expect(p.locator("[data-tab-move-window]")).toHaveCount(0);
  await p.keyboard.press("Escape");
  await tab(p, "owner-1").focus();
  await p.keyboard.press("Shift+F10");
  await expect(p.locator("[data-tab-move-window]")).toHaveCount(0);
});

test("42px hysteresis permits reentry; native handoff releases capture and Escape restores source", async ({
  context,
}) => {
  const n = await registry(context),
    p = await n.open();
  let o = await hold(p);
  const strip = (await p.locator(".tabs").boundingBox())!;
  await p.mouse.move(o.x + 8, o.y);
  await p.mouse.move(o.x, strip.y + strip.height + 25);
  expect(n.calls.filter((c) => c.cmd === "begin_tab_drag")).toEqual([]);
  await p.mouse.move(o.x, o.y);
  await p.mouse.up();
  expect(await ids(p)).toEqual(["owner-0", "owner-1", "owner-2"]);
  await external(p);
  await expect
    .poll(() => n.calls.filter((c) => c.cmd === "begin_tab_drag").length)
    .toBe(1);
  await expect(p.locator(".tab-drag-source")).toHaveCount(0);
  await p.mouse.up();
  await pending(p);
  await p.keyboard.press("Escape");
  await expect
    .poll(() => n.calls.filter((c) => c.cmd === "cancel_tab_drag").length)
    .toBe(1);
  await expect(p.locator('[data-close="owner-0"]')).toBeEnabled();
  expect(await ids(p)).toEqual(["owner-0", "owner-1", "owner-2"]);
  expect(effects(n.calls)).toEqual([]);
});

for (const slot of [
  { before: "owner-3", index: 0, want: ["owner-0", "owner-3", "owner-4"] },
  { before: "owner-4", index: 1, want: ["owner-3", "owner-0", "owner-4"] },
  { before: null, index: 2, want: ["owner-3", "owner-4", "owner-0"] },
])
  test(`existing target inserts at slot ${slot.index} only after ready without losing target owners`, async ({
    context,
  }) => {
    const n = await registry(context),
      source = await n.open(),
      target = await n.open("existing");
    const records = n.settings().retainedSyncs;
    n.holdReady();
    await external(source);
    await source.mouse.up();
    await n.feedback({
      targetLabel: "existing",
      beforeId: slot.before,
      targetIndex: slot.index,
    });
    await expect(target.locator(".tab-drop-indicator")).toBeVisible();
    await n.drop("existing", slot.before, slot.index);
    await expect.poll(() => ids(target)).toEqual(slot.want);
    await pending(source);
    await pending(target);
    expect(n.transfer().phase).toBe("pending");
    expect(await ids(source)).toEqual(["owner-0", "owner-1", "owner-2"]);
    n.releaseReady();
    await expect(source.locator("html")).toHaveAttribute(
      "data-transfer-phase",
      "committed",
    );
    expect(await ids(source)).toEqual(["owner-1", "owner-2"]);
    expect(await ids(target)).toEqual(slot.want);
    expect(
      [...n.settings().retainedSyncs].sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([...records].sort((a, b) => a.id.localeCompare(b.id)));
    expect(effects(n.calls)).toEqual([]);
  });

test("aborted existing-target staging preserves target tabs and active selection; late ready cannot commit", async ({
  context,
}) => {
  const n = await registry(context),
    source = await n.open(),
    target = await n.open("existing");
  await tab(target, "owner-4").click();
  n.holdReady();
  await external(source);
  await source.mouse.up();
  await n.drop("existing", "owner-4", 1);
  await expect
    .poll(() => ids(target))
    .toEqual(["owner-3", "owner-0", "owner-4"]);
  await n.outcome("aborted");
  n.releaseReady();
  await expect.poll(() => ids(target)).toEqual(["owner-3", "owner-4"]);
  await expect(tab(target, "owner-4")).toHaveAttribute("aria-selected", "true");
  await expect(source.locator('[data-close="owner-0"]')).toBeEnabled();
  expect(await ids(source)).toEqual(["owner-0", "owner-1", "owner-2"]);
  expect(effects(n.calls)).toEqual([]);
});

test("single-tab drag to new window waits for readiness and leaves a clean source workspace", async ({
  context,
}) => {
  const n = await registry(context, 1),
    source = await n.open();
  n.holdReady();
  await external(source);
  await source.mouse.up();
  await n.drop("new");
  await pending(source);
  const child = await n.open("child-1");
  await expect.poll(() => ids(child)).toEqual(["owner-0"]);
  await pending(source);
  n.releaseReady();
  await expect(tab(source, "owner-0")).toHaveCount(0);
  await expect(source.locator("[data-tab]")).toHaveCount(1);
  await expect(source.locator("#connect-form")).toBeVisible();
  await expect(child.locator("#tab-sync-context")).toContainText("root-0");
  expect(n.settings().retainedSyncs[0].ownerTabClosed).toBe(false);
  expect(effects(n.calls)).toEqual([]);
});

for (const phase of ["committed", "aborted"] as const)
  test(`pending source reload reconciles silent ${phase}`, async ({
    context,
  }) => {
    const n = await registry(context),
      p = await n.open();
    await external(p);
    await p.mouse.up();
    await n.drop("new");
    await pending(p);
    await p.reload();
    await pending(p);
    await n.outcome(phase, true);
    await expect(p.locator("html")).toHaveAttribute(
      "data-transfer-phase",
      phase,
    );
    expect(await ids(p)).toEqual(
      phase === "committed"
        ? ["owner-1", "owner-2"]
        : ["owner-0", "owner-1", "owner-2"],
    );
    expect(n.calls.filter((c) => c.cmd === "begin_tab_drag")).toHaveLength(1);
  });

for (const theme of ["light", "dark", "mint", "forest"])
  test(`${theme} Japanese strip retains native drag and has no move menu`, async ({
    context,
  }) => {
    const n = await registry(context, 3, theme, "ja"),
      p = await n.open();
    await expect(p.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(p.locator("html")).toHaveAttribute("lang", "ja");
    await tab(p, "owner-1").click({ button: "right" });
    await expect(p.locator("[data-tab-move-window]")).toHaveCount(0);
    await p.keyboard.press("Escape");
    await external(p);
    await p.mouse.up();
    await n.feedback({
      phase: "reordered",
      targetLabel: "main",
      beforeId: "owner-2",
      targetIndex: 1,
    });
    await expect.poll(() => ids(p)).toEqual(["owner-1", "owner-0", "owner-2"]);
    await expect(p.locator('[data-close="owner-0"]')).toBeEnabled();
  });

test("live job identity, local selection, settings and existing target job survive merge", async ({
  context,
}) => {
  const n = await registry(context),
    source = await n.open(),
    target = await n.open("existing");
  for (const [page, id] of [
    [source, "owner-0"],
    [target, "owner-3"],
  ] as [Page, string][]) {
    await tab(page, id).click();
    await page.locator("#connect-form .primary").click();
    await expect(page.locator("#local-path")).toBeVisible();
    await page.locator("#retained-resume").click();
    await page.locator("#start-form .primary").click();
    await expect(page.locator("#start-form")).toHaveCount(0);
    await expect(page.locator("#sent-count")).toContainText("1234");
  }
  const row = source.locator('[data-list="local"] [data-name="keep.txt"]');
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  const jobs = [...n.jobs],
    before = effects(n.calls),
    settings = n.settings();
  await external(source);
  await source.mouse.up();
  const payload = n.calls.findLast((c) => c.cmd === "begin_tab_drag")!.args
    .payload;
  expect(payload.workspace.id).toBe("owner-0");
  expect(payload.job.id).toBe(jobs[0][0]);
  expect(payload.job.status).toBe("running");
  expect(payload.viewState.selection.local).toBeDefined();
  expect(JSON.stringify(payload)).not.toMatch(/passphrase|password/);
  await n.drop("existing", "owner-4", 1);
  await expect(source.locator("html")).toHaveAttribute(
    "data-transfer-phase",
    "committed",
  );
  await expect
    .poll(() => ids(target))
    .toEqual(["owner-3", "owner-0", "owner-4"]);
  await expect(
    target.locator('[data-list="local"] [data-name="keep.txt"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect(target.locator("#sent-count")).toContainText("1234");
  await tab(target, "owner-3").click();
  await expect(target.locator("#sent-count")).toContainText("1234");
  expect([...n.jobs]).toEqual(jobs);
  expect(effects(n.calls)).toEqual(before);
  expect(n.settings().profiles).toEqual(settings.profiles);
  expect(n.settings().retainedSyncs).toHaveLength(
    settings.retainedSyncs.length,
  );
});

test("independently registered fresh process starts one blank tab without inherited history", async ({
  context,
}) => {
  const n = await registry(context),
    p = await n.open("fresh");
  await expect(p.locator("[data-tab]")).toHaveCount(1);
  expect(await ids(p)).not.toContain("owner-0");
  await expect(p.locator("#connect-form")).toBeVisible();
  await p.locator('[data-connection-select="profile-0"]').click();
  await p.locator("#connect-form .primary").click();
  await expect(p.locator("#local-path")).toHaveValue("C:\\fixture");
  await expect(p.locator("#remote-path")).toHaveValue("/");
  expect(n.calls.filter((c) => c.cmd === "start_sync")).toEqual([]);
});

test("target close abort and a stale drag result leave the original owner usable", async ({
  context,
}) => {
  const n = await registry(context),
    source = await n.open(),
    target = await n.open("existing");
  n.holdReady();
  await external(source);
  await source.mouse.up();
  await n.feedback({ dragId: "stale-drag", phase: "cancelled" });
  await pending(source);
  await n.feedback({ dragId: "drag-1", phase: "dragging" });
  await n.drop("existing");
  await expect.poll(() => ids(target)).toContain("owner-0");
  await target.close();
  await n.outcome("aborted");
  n.releaseReady();
  await expect(source.locator('[data-close="owner-0"]')).toBeEnabled();
  expect(await ids(source)).toEqual(["owner-0", "owner-1", "owner-2"]);
  expect(effects(n.calls)).toEqual([]);
});
