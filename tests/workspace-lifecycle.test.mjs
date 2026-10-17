import test from "node:test";
import assert from "node:assert/strict";
import { Store, Queue } from "../.test-build/core.js";
import { detachTransferredWorkspace } from "../.test-build/workspace-transfer.js";
const profile = {
  id: "p",
  name: "Fixture",
  host: "example.invalid",
  port: 22,
  user: "me",
  auth: "key",
  mode: "sftp",
  keyFile: "",
  hostKey: "",
};
const record = (id, closed = false) => ({
  id: "r-" + id,
  ownerTabId: id,
  ownerTabClosed: closed,
  profile,
  local: "C:\\sync",
  remote: "/sync",
  exclusionRules: "",
  recursive: true,
  deleteRemoved: false,
  pendingState: "unknown",
});

test("more than 100 start stop close cycles release only their own retained records", () => {
  const foreign = [record("foreign-live"), record("foreign-closed", true)];
  const legacy = record("legacy");
  delete legacy.ownerTabId;
  delete legacy.ownerTabClosed;
  const store = new Store({
    profiles: [profile],
    retainedSyncs: [...foreign, legacy],
  });
  const untouched = JSON.stringify(store.retainedSyncs);
  for (let i = 0; i < 110; i++) {
    const w = store.createWorkspace(profile.id);
    store.connectWorkspace(w.id, profile);
    const retained = {
      ...record(w.id),
      local: w.localBrowse,
      remote: w.remoteBrowse,
    };
    store.upsertRetainedSync(retained);
    store.attachJob(w.id, {
      id: "job-" + i,
      retainedId: retained.id,
      profile,
      local: w.localBrowse,
      remote: w.remoteBrowse,
      status: "running",
      queue: new Queue(),
      sent: 0,
      speed: 0,
      latency: 0,
      logs: [],
    });
    assert.throws(() => store.closeWorkspace(w.id));
    store.tabs[0].status = "stopped";
    assert.equal(store.ownRetainedForWorkspace(w.id).id, retained.id);
    store.closeWorkspace(w.id);
    assert.equal(store.workspaces.length, 0);
    assert.equal(store.tabs.length, 0);
    assert.equal(JSON.stringify(store.retainedSyncs), untouched);
  }
  assert.equal(
    JSON.stringify(new Store(store.serialize()).retainedSyncs),
    untouched,
  );
});
test("process restart keeps saved settings but never opens dormant stopped or closed tabs", () => {
  const settings = {
    profiles: [profile],
    theme: "forest",
    retainedSyncs: [record("stopped"), record("closed", true)],
  };
  const store = new Store(settings);
  assert.equal(store.workspaces.length, 0);
  assert.equal(store.restoreLastRetainedWorkspace(), undefined);
  assert.deepEqual(store.retainedSyncs, settings.retainedSyncs);
  assert.equal(store.theme, "forest");
});
test("native-owned recovery only materializes explicit owners without connecting or starting work", () => {
  const store = new Store(
    {
      profiles: [profile],
      retainedSyncs: [
        record("live"),
        record("foreign"),
        record("closed", true),
      ],
    },
    { ownedWorkspaceIds: ["live", "closed"] },
  );
  assert.deepEqual(
    store.workspaces.map((w) => w.id),
    ["live"],
  );
  assert.equal(store.workspaces[0].connection, undefined);
  assert.equal(store.tabs.length, 0);
  assert.equal(store.retainedSyncs.length, 3);
});
test("current session stopped job remains available until close and last tab never creates a placeholder", () => {
  const store = new Store({ profiles: [profile] });
  const w = store.createWorkspace();
  store.connectWorkspace(w.id, profile);
  store.attachJob(w.id, {
    id: "job",
    profile,
    local: w.localBrowse,
    remote: w.remoteBrowse,
    status: "stopped",
    queue: new Queue(),
    sent: 3,
    speed: 0,
    latency: 0,
    logs: [],
  });
  assert.equal(store.tabs[0].status, "stopped");
  assert.equal(store.workspaces[0], w);
  store.closeWorkspace(w.id);
  assert.equal(store.workspaces.length, 0);
  assert.equal(store.tabs.length, 0);
  const moved = store.createWorkspace();
  detachTransferredWorkspace(store, moved.id);
  assert.equal(store.workspaces.length, 0);
});
test("new disconnected connection tabs adopt only their endpoint and account last successful paths", () => {
  const store = new Store({ profiles: [profile] });
  for (const [side, path] of [
    ["local", "D:\\last"],
    ["remote", "/last"],
  ])
    store.rememberSuccessfulBrowse(
      profile,
      side,
      path,
      store.beginBrowse(profile, side),
    );
  const restarted = new Store(store.serialize());
  const w = restarted.createWorkspace(profile.id);
  assert.equal(w.localBrowse, "D:\\last");
  assert.equal(w.remoteBrowse, "/last");
  assert.equal(w.connection, undefined);
  assert.equal(
    restarted.createWorkspace(profile.id, "E:\\explicit").localBrowse,
    "E:\\explicit",
  );
  restarted.saveProfile({ ...profile, host: "different.invalid" });
  const other = restarted.createWorkspace(profile.id);
  assert.equal(other.localBrowse, "C:\\Projects");
  assert.equal(other.remoteBrowse, "/");
  restarted.saveProfile({ ...profile, user: "another" });
  assert.equal(restarted.createWorkspace(profile.id).remoteBrowse, "/");
});
