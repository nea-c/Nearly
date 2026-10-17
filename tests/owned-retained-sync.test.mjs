import test from "node:test";
import assert from "node:assert/strict";
const { Store, Queue } = await import(
  new URL(
    (process.env.NEARLY_RETAINED_MODEL_DIR ?? "../.test-build") + "/core.js",
    import.meta.url,
  )
);
const p = {
  id: "p",
  name: "P",
  host: "example.invalid",
  port: 22,
  user: "fixture",
  auth: "key",
  mode: "sftp",
  keyFile: "",
  hostKey: "",
};
const rec = (id, ownerTabId, ownerTabClosed = false) => ({
  id,
  profile: { ...p },
  local: "C:\\fixture\\" + id,
  remote: "/" + id,
  exclusionRules: "*.tmp",
  deleteRemoved: false,
  recursive: true,
  pendingState: "unknown",
  ...(ownerTabId === undefined ? {} : { ownerTabId, ownerTabClosed }),
});
test("owned open contexts restore only their stable disconnected tab, legacy stays hidden", () => {
  const s = new Store({
    profiles: [p],
    retainedSyncs: [rec("legacy"), rec("a", "tab-a"), rec("b", "tab-b", true)],
  });
  assert.equal(s.workspaces.length, 1);
  const w = s.workspaces[0];
  assert.equal(w.id, "tab-a");
  assert.equal(w.connection, undefined);
  assert.equal(w.jobId, undefined);
  assert.equal(s.tabs.length, 0);
  assert.equal(w.localBrowse, "C:\\fixture\\a");
  assert.equal(w.remoteBrowse, "/a");
  assert.equal(s.ownRetainedForWorkspace(w.id).id, "a");
  assert.equal(s.ownRetainedForWorkspace("tab-b"), undefined);
  assert.equal(s.ownRetainedForWorkspace("unowned"), undefined);
  assert.equal(s.retainedSyncs[0].id, "legacy");
  const copy = s.ownRetainedForWorkspace(w.id);
  copy.local = "changed";
  assert.equal(s.ownRetainedForWorkspace(w.id).local, w.localBrowse);
});
test("closing persists dormant owner and explicit undo restores same isolated tab without connection", () => {
  const s = new Store({
    profiles: [p],
    retainedSyncs: [rec("a", "tab-a"), rec("b", "tab-b")],
  });
  s.closeWorkspace("tab-a");
  assert.equal(s.retainedSyncs.find((x) => x.id === "a").ownerTabClosed, true);
  assert.equal(s.workspaces.length, 1);
  assert.equal(s.ownRetainedForWorkspace("tab-b").id, "b");
  const loaded = new Store(s.serialize());
  assert.equal(loaded.workspaces[0].id, "tab-b");
  const reopened = loaded.restoreLastRetainedWorkspace();
  assert.equal(reopened.id, "tab-a");
  assert.equal(reopened.remoteBrowse, "/a");
  assert.equal(reopened.connection, undefined);
  assert.equal(loaded.tabs.length, 0);
  assert.equal(loaded.restoreLastRetainedWorkspace(), undefined);
});
test("owner schema and assignment are strict and atomically reject conflicts", () => {
  for (const bad of [
    { ...rec("a"), ownerTabId: "tab" },
    { ...rec("a"), ownerTabClosed: false },
    rec("a", ""),
    rec("a", "x".repeat(129)),
    { ...rec("a", "tab"), ownerTabClosed: null },
  ])
    assert.throws(() => new Store({ retainedSyncs: [bad] }));
  assert.throws(
    () =>
      new Store({ retainedSyncs: [rec("a", "same"), rec("b", "same", true)] }),
  );
  assert.throws(
    () =>
      new Store({
        retainedSyncs: Array.from({ length: 17 }, (_, i) =>
          rec("r" + i, "tab" + i),
        ),
      }),
  );
  const s = new Store({ profiles: [p], retainedSyncs: [rec("a", "tab-a")] });
  const before = JSON.stringify(s.serialize());
  assert.throws(() => s.upsertRetainedSync(rec("b", "tab-a")));
  assert.throws(() => s.upsertRetainedSync(rec("a", "tab-b")));
  assert.throws(() => s.upsertRetainedSync(rec("a")));
  assert.equal(JSON.stringify(s.serialize()), before);
});
test("attach rejects another owner and closed owner, closure refuses busy work", () => {
  const s = new Store({
    profiles: [p],
    retainedSyncs: [rec("a", "tab-a"), rec("b", "tab-b")],
  });
  for (const w of s.workspaces) s.connectWorkspace(w.id, p);
  const job = {
    id: "runtime",
    retainedId: "a",
    profile: p,
    local: "C:\\fixture\\a",
    remote: "/a",
    status: "running",
    sent: 0,
    speed: 0,
    latency: 0,
    logs: [],
    queue: new Queue(),
  };
  assert.throws(() => s.attachJob("tab-b", job));
  s.attachJob("tab-a", job);
  assert.throws(() => s.closeRetainedWorkspace("tab-a"));
  assert.throws(() => s.closeWorkspace("tab-a"));
  assert.equal(s.ownRetainedForWorkspace("tab-a").ownerTabClosed, false);
});
test("new tabs cannot reuse stable IDs of dormant owners and green themes remain explicit", () => {
  const s = new Store({
    profiles: [p],
    retainedSyncs: [rec("a", "tab-a", true)],
  });
  const a = s.createWorkspace();
  const b = s.createWorkspace();
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, "tab-a");
  for (const theme of ["forest", "mint"]) {
    const t = new Store({ theme });
    assert.equal(t.resolveInitialTheme(!false), false);
    assert.equal(new Store(t.serialize()).theme, theme);
  }
});
test("restore capacity failure preserves dormant ownership and legacy cannot be adopted", () => {
  const s = new Store({
    profiles: [p],
    retainedSyncs: [rec("legacy"), rec("dormant", "closed", true)],
  });
  for (let i = 0; i < 16; i++) s.createWorkspace();
  const before = JSON.stringify(s.serialize());
  assert.throws(() => s.restoreLastRetainedWorkspace());
  assert.equal(JSON.stringify(s.serialize()), before);
  assert.throws(() => s.upsertRetainedSync(rec("legacy", s.workspaces[0].id)));
  assert.equal(s.ensureRetainedWorkspace("closed"), undefined);
  assert.equal(s.ensureRetainedWorkspace("legacy"), undefined);
});
test("ordinary data validation refuses ownership accessors without evaluating them", () => {
  const value = rec("a", "tab-a");
  Object.defineProperty(value, "ownerTabId", {
    get() {
      throw Error("getter executed");
    },
    enumerable: true,
  });
  assert.throws(
    () => new Store({ retainedSyncs: [value] }),
    (error) => !error.message.includes("getter executed"),
  );
});
test("owned restored tab IDs must be usable native session IDs, not markup or Unicode", () => {
  for (const id of [
    'tab"quote',
    "<tab>",
    "日本語",
    "tab space",
    "x".repeat(65),
  ])
    assert.throws(() => new Store({ retainedSyncs: [rec("a", id)] }));
  for (const id of ["a", "A_z-09", "x".repeat(64)])
    assert.equal(
      new Store({ retainedSyncs: [rec("a", id)] }).workspaces[0].id,
      id,
    );
});
test("owned preset identity roundtrips without applying changed global preset contents", () => {
  const value = { ...rec("a", "tab-a"), presetId: "custom-preset" };
  const s = new Store({
    profiles: [p],
    retainedSyncs: [value],
    syncPresets: [
      {
        id: "custom-preset",
        name: "Changed global",
        exclusionRules: "different/",
        recursive: false,
        deleteRemoved: true,
      },
    ],
  });
  assert.equal(s.ownRetainedForWorkspace("tab-a").presetId, "custom-preset");
  s.closeWorkspace("tab-a");
  const loaded = new Store(s.serialize());
  const w = loaded.restoreLastRetainedWorkspace();
  assert.equal(loaded.ownRetainedForWorkspace(w.id).presetId, "custom-preset");
  assert.equal(loaded.ownRetainedForWorkspace(w.id).recursive, true);
  assert.equal(loaded.ownRetainedForWorkspace(w.id).exclusionRules, "*.tmp");
});
test("optional retained preset identity rejects invalid schema and remains absent for old records", () => {
  for (const presetId of [
    null,
    42,
    false,
    "",
    "x".repeat(129),
    "界".repeat(43),
    "bad\nvalue",
  ])
    assert.throws(
      () => new Store({ retainedSyncs: [{ ...rec("a", "tab-a"), presetId }] }),
    );
  for (const presetId of ["x".repeat(128), "界".repeat(42)])
    assert.equal(
      new Store({ retainedSyncs: [{ ...rec("a", "tab-a"), presetId }] })
        .retainedSyncs[0].presetId,
      presetId,
    );
  const s = new Store({ retainedSyncs: [rec("a", "tab-a")] });
  assert.equal(
    Object.hasOwn(s.serialize().retainedSyncs[0], "presetId"),
    false,
  );
  assert.throws(
    () =>
      new Store({
        retainedSyncs: [
          { ...rec("a", "tab-a"), presetId: "custom", secret: "bad" },
        ],
      }),
  );
});
