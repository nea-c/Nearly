import test from "node:test";
import assert from "node:assert/strict";
import { Store, Queue } from "../.test-build/core.js";
const profile = (name, host) => ({
  name,
  host,
  user: "fixture",
  port: 22,
  mode: "mock",
});
test("titlebar workspaces own independent profile and browsing state", () => {
  const store = new Store();
  const p = store.saveProfile(profile("A", "a.invalid")),
    q = store.saveProfile(profile("B", "b.invalid"));
  assert.equal(typeof store.createWorkspace, "function");
  const a = store.createWorkspace(p.id),
    b = store.createWorkspace(q.id);
  a.remoteBrowse = "/one";
  a.localBrowse = "C:\\one";
  b.remoteBrowse = "/two";
  assert.equal(a.profileId, p.id);
  assert.equal(b.profileId, q.id);
  assert.equal(a.remoteBrowse, "/one");
  assert.notEqual(a.localBrowse, b.localBrowse);
});
test("profile changes are blocked for a running job and snapshots remain immutable", () => {
  const store = new Store();
  const p = store.saveProfile(profile("A", "a.invalid")),
    q = store.saveProfile(profile("B", "b.invalid"));
  assert.equal(typeof store.attachJob, "function");
  const w = store.createWorkspace(p.id);
  store.connectWorkspace(w.id, p);
  store.attachJob(w.id, {
    id: "job-a",
    profile: p,
    local: "C:\\one",
    remote: "/one",
    status: "running",
    queue: new Queue(),
    sent: 0,
    speed: 0,
    latency: 0,
    logs: [],
  });
  assert.throws(() => store.changeWorkspaceProfile(w.id, q.id));
  store.saveProfile({ ...p, host: "changed.invalid" });
  assert.equal(store.tabs[0].profile.host, "a.invalid");
  assert.equal(store.tabs[0].remote, "/one");
  store.tabs[0].status = "stopped";
  assert.throws(() => store.changeWorkspaceProfile(w.id, q.id));
  assert.equal(w.connection.host, "a.invalid");
  assert.ok(Object.isFrozen(w.connection));
});
test("closing a workspace preserves history and cannot drop a running job", () => {
  const store = new Store();
  const p = store.saveProfile(profile("A", "a.invalid"));
  assert.equal(typeof store.closeWorkspace, "function");
  const w = store.createWorkspace(p.id);
  store.remember(p.id, "/one", "C:\\remembered");
  store.connectWorkspace(w.id, p);
  store.attachJob(w.id, {
    id: "job-a",
    profile: p,
    local: "C:\\one",
    remote: "/one",
    status: "failed",
    queue: new Queue(),
    sent: 0,
    speed: 0,
    latency: 0,
    logs: [],
  });
  assert.throws(() => store.closeWorkspace(w.id));
  store.tabs[0].status = "stopped";
  store.closeWorkspace(w.id);
  assert.equal(store.workspaces.length, 0);
  assert.equal(
    new Store(store.serialize()).local(p.id, "/one"),
    "C:\\remembered",
  );
  assert.equal(store.serialize().workspaces, undefined);
});
