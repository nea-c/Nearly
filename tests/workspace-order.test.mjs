import test from "node:test";
import assert from "node:assert/strict";
import { Store, Queue } from "../.test-build/core.js";

const profile = {
  id: "p",
  name: "Fixture",
  host: "example.invalid",
  port: 22,
  user: "fixture",
  auth: "key",
  mode: "mock",
  keyFile: "",
  hostKey: "",
};
const record = (id, ownerTabId, ownerTabClosed = false) => ({
  id,
  profile: { ...profile },
  local: "C:\\fixture\\" + id,
  remote: "/" + id,
  exclusionRules: "*.tmp",
  deleteRemoved: false,
  recursive: true,
  pendingState: "unknown",
  ...(ownerTabId === undefined ? {} : { ownerTabId, ownerTabClosed }),
});
const ids = (s) => s.workspaces.map((w) => w.id);
const records = (s) => s.serialize().retainedSyncs.map((r) => r.id);
const owned = () =>
  new Store({
    profiles: [profile],
    retainedSyncs: [record("a", "a"), record("b", "b"), record("c", "c")],
  });

test("reorder accepts only an exact complete current-ID permutation, atomically", () => {
  const s = owned(),
    original = s.workspaces;
  for (const invalid of [
    null,
    {},
    "abc",
    [],
    ["a", "b"],
    ["a", "b", "b"],
    ["a", "b", "unknown"],
    ["a", "b", 3],
    new Array(3),
    Array(17).fill("a"),
    ["a", "b", "x".repeat(100000)],
  ]) {
    assert.equal(s.reorderWorkspaces(invalid), false);
    assert.equal(s.workspaces, original);
  }
  assert.equal(s.reorderWorkspaces(["a", "b", "c"]), false);
  assert.equal(s.workspaces, original);
  const accessor = ["a", "b", "c"];
  Object.defineProperty(accessor, "1", {
    get() {
      throw Error("must not execute");
    },
  });
  assert.equal(s.reorderWorkspaces(accessor), false);
  assert.equal(s.workspaces, original);
  assert.equal(s.reorderWorkspaces(["c", "a", "b"]), true);
  assert.deepEqual(ids(s), ["c", "a", "b"]);
  const empty = new Store();
  assert.equal(empty.reorderWorkspaces([]), false);
});

test("reorder preserves every workspace and job identity across all live states", () => {
  const s = new Store({ profiles: [profile], theme: "forest", language: "en" });
  const states = [undefined, "running", "stopped", "failed", "stopping"];
  for (const status of states) {
    const w = s.createWorkspace(profile.id, "C:\\fixture\\" + status);
    w.remoteBrowse = "/" + status;
    if (status) {
      s.connectWorkspace(w.id, profile);
      s.attachJob(w.id, {
        id: "job-" + status,
        profile,
        local: w.localBrowse,
        remote: w.remoteBrowse,
        status,
        queue: new Queue(),
        sent: 2,
        speed: 3,
        latency: 4,
        logs: [status],
      });
    }
  }
  s.workspaces[0].connecting = true;
  s.workspaces[0].starting = true;
  const before = [...s.workspaces],
    jobs = s.tabs,
    jobRefs = [...jobs];
  const snapshots = before.map((w) => JSON.stringify(w));
  const connections = before.map((w) => w.connection);
  const activeWorkspaceId = before[2].id;
  const settings = s.serialize();
  assert.equal(s.reorderWorkspaces(before.map((w) => w.id).reverse()), true);
  for (const [i, w] of before.entries()) {
    assert.equal(
      s.workspaces.find((x) => x.id === w.id),
      w,
    );
    assert.equal(JSON.stringify(w), snapshots[i]);
    assert.equal(w.connection, connections[i]);
  }
  assert.equal(
    s.workspaces.find((w) => w.id === activeWorkspaceId),
    before[2],
  );
  assert.equal(s.tabs, jobs);
  assert.ok(s.tabs.every((job, i) => job === jobRefs[i]));
  assert.deepEqual(s.serialize(), settings);
});

test("serialization fills only owned-open slots and reloads disconnected in live order", () => {
  const s = new Store({
    profiles: [profile],
    retainedSyncs: [
      record("legacy-1"),
      record("a", "a"),
      record("closed-1", "x", true),
      record("legacy-2"),
      record("b", "b"),
      record("closed-2", "y", true),
      record("c", "c"),
      record("legacy-3"),
    ],
  });
  const retained = JSON.stringify(s.retainedSyncs);
  s.reorderWorkspaces(["c", "a", "b"]);
  assert.deepEqual(records(s), [
    "legacy-1",
    "c",
    "closed-1",
    "legacy-2",
    "a",
    "closed-2",
    "b",
    "legacy-3",
  ]);
  assert.equal(JSON.stringify(s.retainedSyncs), retained);
  const loaded = new Store(s.serialize());
  assert.deepEqual(ids(loaded), ["c", "a", "b"]);
  assert.equal(loaded.tabs.length, 0);
  assert.ok(loaded.workspaces.every((w) => !w.connection && !w.jobId));
  assert.deepEqual(
    loaded.retainedSyncs.filter((r) => r.ownerTabClosed),
    s.retainedSyncs.filter((r) => r.ownerTabClosed),
  );
  assert.equal(loaded.restoreLastRetainedWorkspace().id, "y");
  assert.equal(loaded.restoreLastRetainedWorkspace().id, "x");
});

test("close then restore appends the restored owner after a reorder and survives reload", () => {
  const s = owned();
  s.reorderWorkspaces(["c", "a", "b"]);
  s.closeWorkspace("a");
  s.closeWorkspace("c");
  assert.equal(s.restoreLastRetainedWorkspace().id, "c");
  assert.deepEqual(ids(new Store(s.serialize())), ["b", "c"]);
  assert.equal(s.restoreLastRetainedWorkspace().id, "a");
  assert.deepEqual(ids(new Store(s.serialize())), ["b", "c", "a"]);
});

test("unowned gaps and a context created after dragging serialize by current live order", () => {
  const s = owned();
  const gap = s.createWorkspace(),
    fresh = s.createWorkspace();
  s.reorderWorkspaces([fresh.id, "b", gap.id, "c", "a"]);
  assert.deepEqual(records(s), ["b", "c", "a"]);
  s.upsertRetainedSync(record("new", fresh.id));
  assert.deepEqual(records(s), ["new", "b", "c", "a"]);
  assert.deepEqual(ids(new Store(s.serialize())), [fresh.id, "b", "c", "a"]);
});

test("open owner awaiting materialization stays in place while live owners reorder", () => {
  const s = owned();
  s.workspaces.pop();
  const before = JSON.stringify(s.retainedSyncs);
  s.reorderWorkspaces(["b", "a"]);
  assert.deepEqual(records(s), ["b", "a", "c"]);
  assert.equal(JSON.stringify(s.retainedSyncs), before);
  assert.deepEqual(ids(new Store(s.serialize())), ["b", "a", "c"]);
});

test("maximum 16-tab order roundtrips with 100 interleaved retained records", () => {
  const retainedSyncs = Array.from({ length: 100 }, (_, i) =>
    i % 6 === 0 && i < 96
      ? record("r" + i, "tab" + i)
      : i % 2
        ? record("r" + i)
        : record("r" + i, "closed" + i, true),
  );
  const s = new Store({ retainedSyncs });
  const order = ids(s).reverse();
  assert.equal(order.length, 16);
  assert.equal(s.reorderWorkspaces(order), true);
  const saved = s.serialize().retainedSyncs;
  for (const [i, r] of retainedSyncs.entries())
    if (r.ownerTabId === undefined || r.ownerTabClosed)
      assert.deepEqual(saved[i], r);
  assert.equal(saved.length, 100);
  assert.deepEqual(ids(new Store(s.serialize())), order);
});

test("invalid duplicate runtime workspace IDs cannot duplicate or drop persisted contexts", () => {
  const s = owned();
  s.workspaces[1].id = "a";
  const before = JSON.stringify(s.retainedSyncs);
  assert.equal(s.reorderWorkspaces(["a", "a", "c"]), false);
  assert.throws(
    () => s.serialize(),
    /invalid live retained tab workspace order/i,
  );
  assert.equal(JSON.stringify(s.retainedSyncs), before);
});
