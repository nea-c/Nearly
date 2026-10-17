import test from "node:test";
import assert from "node:assert/strict";
import { Store, Queue } from "../.test-build/core.js";
import { FolderTree } from "../.test-build/tree.js";
import { BrowseHistory } from "../.test-build/navigation.js";
import { FileSelection } from "../.test-build/selection.js";
import {
  snapshotWorkspaceTransfer,
  validateWorkspaceTransfer,
  hydrateWorkspaceTransfer,
  detachTransferredWorkspace,
  createWindowStore,
} from "../.test-build/workspace-transfer.js";
const profile = {
  id: "p",
  name: "keep Japanese 日本語",
  host: "example.invalid",
  port: 22,
  user: "fixture",
  auth: "key",
  mode: "sftp",
  keyFile: "C:\\key",
  hostKey: "",
};
test("transfer retains file selection anchor and browse back/forward state", () => {
  const { store, w } = fixture();
  w.entries.local = ["a", "b", "c"].map((name) => ({
    name,
    dir: false,
    size: 0,
  }));
  w.selections.local.context(JSON.stringify(["local", null, w.localBrowse]), [
    "a",
    "b",
    "c",
  ]);
  w.selections.local.click(0);
  w.selections.local.click(2, { ctrl: true });
  w.navigation.local.commit("C:\\before");
  w.navigation.local.commit(w.localBrowse);
  w.navigation.local.commit("C:\\after");
  w.navigation.local.commit(w.localBrowse, 1);
  w.trees.local.record(w.localBrowse, w.entries.local);
  w.trees.local.node("C:\\").expanded = true;
  w.trees.local.node(w.localBrowse).expanded = true;
  const dto = snapshotWorkspaceTransfer(store, w.id);
  const target = new Store({ profiles: [profile] });
  const old = target.createWorkspace();
  const targetArray = target.workspaces;
  const restored = hydrateWorkspaceTransfer(target, dto, w.id);
  assert.equal(target.workspaces, targetArray);
  assert.equal(target.workspaces[0], old);
  assert.deepEqual(restored.selections.local.values(), ["a", "c"]);
  assert.equal(restored.selections.local.focus, "c");
  restored.selections.local.click(1, { shift: true });
  assert.deepEqual(restored.selections.local.values(), ["b", "c"]);
  assert.equal(restored.navigation.local.target(-1).path, "C:\\before");
  assert.equal(restored.navigation.local.target(1).path, "C:\\after");
  assert.equal(restored.trees.local.peek(w.localBrowse).expanded, true);
  assert.equal(w.selections.local.focus, "c");
});
function fixture(status = "running") {
  const store = new Store({ profiles: [profile] });
  const w = store.createWorkspace("p", "C:\\fixture");
  w.remoteBrowse = "/fixture";
  store.connectWorkspace(w.id, profile);
  store.attachJob(w.id, {
    id: "runtime-job",
    profile,
    local: w.localBrowse,
    remote: w.remoteBrowse,
    status,
    queue: new Queue(),
    sent: 2,
    speed: 3,
    latency: 4,
    logs: ["ordinary secret-looking user text"],
  });
  w.entries.local = [{ name: "file", dir: false, size: 2 }];
  return { store, w };
}
test("moves exact IDs with class instances and preserves source until explicit detach", () => {
  const { store, w } = fixture();
  const original = store.tabs[0];
  const before = store.serialize();
  const dto = snapshotWorkspaceTransfer(store, w.id);
  const target = new Store({ profiles: [profile] });
  target.connectWorkspace = () => {
    throw Error("no connection");
  };
  target.attachJob = () => {
    throw Error("no job start");
  };
  const restored = hydrateWorkspaceTransfer(target, dto, w.id);
  assert.equal(restored.id, w.id);
  assert.equal(restored.jobId, original.id);
  assert.equal(target.tabs[0].status, "running");
  assert(restored.trees.local instanceof FolderTree);
  assert(restored.navigation.local instanceof BrowseHistory);
  assert(restored.selections.local instanceof FileSelection);
  assert.equal(store.workspaces[0], w);
  assert.equal(store.tabs[0], original);
  assert.deepEqual(store.serialize(), before);
  const generation = w.generation.local;
  detachTransferredWorkspace(store, w.id);
  assert.equal(w.generation.local, generation + 1);
  assert.equal(store.tabs.length, 0);
  assert.equal(store.workspaces.length, 1);
  assert.notEqual(store.workspaces[0].id, w.id);
});
test("hydrated remote listing retains its connection signature on the first render", () => {
  const { store, w } = fixture();
  w.entries.remote = [
    { name: "server-only.txt", dir: false, size: 12 },
    { name: "nested", dir: true, size: 0 },
  ];
  const target = new Store({ profiles: [profile] });
  const restored = hydrateWorkspaceTransfer(
    target,
    snapshotWorkspaceTransfer(store, w.id),
    w.id,
  );
  assert.equal(restored.trees.remote.key, JSON.stringify(restored.connection));
  assert.deepEqual(restored.entries.remote, w.entries.remote);
  assert.equal(restored.trees.remote.peek(w.remoteBrowse).loaded, true);
  assert.equal(
    restored.trees.remote.peek(w.remoteBrowse).children[0].name,
    "nested",
  );
});
test("projection never reads secret fields and wire DTO rejects getters/unknown fields", () => {
  const { store, w } = fixture("stopped");
  let reads = 0;
  w.connection = { ...w.connection };
  for (const object of [w.connection, store.tabs[0].profile]) {
    if (!Object.isFrozen(object))
      Object.defineProperty(object, "passphrase", {
        get() {
          reads++;
          throw Error("secret");
        },
      });
  }
  Object.defineProperty(store.tabs[0], "privateKey", {
    get() {
      reads++;
      throw Error("secret");
    },
  });
  const dto = snapshotWorkspaceTransfer(store, w.id);
  assert.equal(reads, 0);
  assert.equal(dto.job.profile.name, profile.name);
  assert(!JSON.stringify(dto).includes("privateKey"));
  assert.throws(() => validateWorkspaceTransfer({ ...dto, passphrase: "bad" }));
  const hostile = structuredClone(dto);
  Object.defineProperty(hostile.workspace, "id", {
    get() {
      throw Error("getter executed");
    },
  });
  assert.throws(() => validateWorkspaceTransfer(hostile), /ordinary data/);
});
test("transient activity, duplicate IDs, and malformed payload reject without source mutation", () => {
  const { store, w } = fixture();
  const dto = snapshotWorkspaceTransfer(store, w.id);
  for (const field of ["connecting", "starting"]) {
    w[field] = true;
    assert.throws(() => snapshotWorkspaceTransfer(store, w.id));
    w[field] = false;
  }
  w.loading.local = true;
  assert.throws(() => snapshotWorkspaceTransfer(store, w.id));
  w.loading.local = false;
  assert.throws(() =>
    snapshotWorkspaceTransfer(store, w.id, { modalOpen: true }),
  );
  assert.throws(() =>
    snapshotWorkspaceTransfer(store, w.id, { fileOperationBusy: true }),
  );
  assert.throws(() => hydrateWorkspaceTransfer(store, dto, w.id));
  assert.equal(store.workspaces[0], w);
  assert.throws(() => hydrateWorkspaceTransfer(new Store(), dto, "foreign"));
  const huge = structuredClone(dto);
  huge.workspace.entries.local = Array(20001).fill({
    name: "x",
    dir: false,
    size: 0,
  });
  assert.throws(() => validateWorkspaceTransfer(huge));
});
test("window startup keeps global retained metadata but instantiates only native owned IDs", () => {
  const retained = ["a", "b"].map((id) => ({
    id,
    ownerTabId: id,
    ownerTabClosed: false,
    profile,
    local: "C:\\fixture",
    remote: "/fixture",
    exclusionRules: "",
    deleteRemoved: false,
    recursive: true,
    pendingState: "unknown",
  }));
  const s = createWindowStore(
    { profiles: [profile], retainedSyncs: retained },
    ["b"],
  );
  assert.deepEqual(
    s.workspaces.map((w) => w.id),
    ["b"],
  );
  assert.equal(s.retainedSyncs.length, 2);
  const child = createWindowStore(
    { profiles: [profile], retainedSyncs: retained },
    [],
  );
  assert.equal(child.workspaces.length, 0);
  assert.equal(child.retainedSyncs.length, 2);
});
test("failed hydration and retained ownership conflicts do not mutate destination", () => {
  const { store, w } = fixture("stopped");
  const dto = snapshotWorkspaceTransfer(store, w.id);
  dto.job.retainedId = "r";
  const target = new Store({
    profiles: [profile],
    retainedSyncs: [
      {
        id: "r",
        ownerTabId: "other",
        ownerTabClosed: false,
        profile,
        local: "C:\\fixture",
        remote: "/fixture",
        exclusionRules: "",
        deleteRemoved: false,
        recursive: true,
        pendingState: "unknown",
      },
    ],
  });
  const workspaces = target.workspaces;
  assert.throws(() => hydrateWorkspaceTransfer(target, dto, w.id));
  assert.equal(target.workspaces, workspaces);
  assert.equal(target.tabs.length, 0);
});
test("detach preserves retained metadata and order of every remaining workspace/job", () => {
  const { store, w } = fixture("failed");
  const retained = {
    id: "record",
    ownerTabId: w.id,
    ownerTabClosed: false,
    profile,
    local: "C:\\fixture",
    remote: "/fixture",
    exclusionRules: "",
    deleteRemoved: false,
    recursive: true,
    pendingState: "unknown",
  };
  store.retainedSyncs = [retained];
  store.tabs[0].retainedId = "record";
  const a = store.createWorkspace(),
    b = store.createWorkspace();
  store.reorderWorkspaces([b.id, w.id, a.id]);
  const metadata = store.retainedSyncs;
  const before = JSON.stringify(metadata);
  const old = w.generation.remote;
  detachTransferredWorkspace(store, w.id);
  assert.deepEqual(store.workspaces, [b, a]);
  assert.equal(store.retainedSyncs, metadata);
  assert.equal(JSON.stringify(metadata), before);
  assert.equal(w.generation.remote, old + 1);
});
test("logs are capped and size limits reject the snapshot without modifying source", () => {
  const { store, w } = fixture();
  const logs = Array.from({ length: 110 }, (_, i) => "line " + i);
  store.tabs[0].logs = logs;
  const dto = snapshotWorkspaceTransfer(store, w.id);
  assert.equal(dto.job.logs.length, 100);
  assert.equal(dto.job.logs[0], "line 10");
  assert.equal(store.tabs[0].logs, logs);
  w.entries.local = Array.from({ length: 2000 }, (_, i) => ({
    name: String(i) + "x".repeat(1100),
    dir: false,
    size: 0,
  }));
  assert.throws(() => snapshotWorkspaceTransfer(store, w.id), /2 MiB/);
  assert.equal(store.workspaces[0], w);
});
test("stopped development mock can hydrate while live mock cannot silently lose queue", () => {
  const { store, w } = fixture("stopped");
  w.connection = Object.freeze({ ...profile, mode: "mock" });
  store.tabs[0].profile = { ...profile, mode: "mock" };
  const target = new Store({ profiles: [{ ...profile, mode: "mock" }] });
  assert.equal(
    hydrateWorkspaceTransfer(
      target,
      snapshotWorkspaceTransfer(store, w.id),
      w.id,
    ).jobId,
    "runtime-job",
  );
  store.tabs[0].status = "running";
  store.tabs[0].queue.push("keep");
  assert.throws(() => snapshotWorkspaceTransfer(store, w.id), /mock/);
  assert.equal(store.tabs[0].queue.size, 1);
});
test("tree tokens and unknown numeric array properties cannot survive transfer", () => {
  const { store, w } = fixture();
  const token = w.trees.local.begin(w.localBrowse);
  const dto = snapshotWorkspaceTransfer(store, w.id);
  const hostile = structuredClone(dto);
  Object.defineProperty(hostile.job.logs, "9999999999", {
    get() {
      throw Error("must not evaluate");
    },
  });
  assert.throws(
    () => validateWorkspaceTransfer(hostile),
    /Invalid workspace transfer/,
  );
  detachTransferredWorkspace(store, w.id);
  assert.equal(w.trees.local.current(w.localBrowse, token), false);
});

test("nested view state rejects secrets, invalid selection/history, and oversized collections atomically", () => {
  const { store, w } = fixture();
  const dto = snapshotWorkspaceTransfer(store, w.id);
  const target = new Store({ profiles: [profile] });
  const existing = target.createWorkspace();
  const cases = [
    (d) => {
      d.viewState.selection.local.passphrase = "never";
    },
    (d) => {
      d.viewState.navigation.remote.paths = ["/one"];
      d.viewState.navigation.remote.cursor = -1;
    },
    (d) => {
      d.viewState.navigation.local.paths = Array(65).fill(w.localBrowse);
      d.viewState.navigation.local.cursor = 64;
    },
    (d) => {
      d.viewState.navigation.local.paths = ["C:\\different"];
      d.viewState.navigation.local.cursor = 0;
    },
    (d) => {
      d.viewState.selection.local.selected = ["not-in-listing"];
    },
    (d) => {
      d.viewState.selection.local.focus = "not-in-listing";
    },
    (d) => {
      d.viewState.selection.local.anchor = "not-in-listing";
    },
    (d) => {
      d.viewState.trees.remote.expanded = Array.from(
        { length: 257 },
        (_, i) => "/" + i,
      );
    },
    (d) => {
      d.viewState.trees.local.expanded = ["invalid-relative"];
    },
    (d) => {
      d.viewState.trees.remote.request = 13;
    },
    (d) => {
      d.workspace.entries.local = Array(10001).fill({
        name: "x",
        size: 0,
        dir: false,
      });
      d.workspace.entries.remote = Array(10000).fill({
        name: "y",
        size: 0,
        dir: false,
      });
    },
  ];
  for (const change of cases) {
    const invalid = structuredClone(dto);
    change(invalid);
    assert.throws(() => hydrateWorkspaceTransfer(target, invalid, w.id));
    assert.deepEqual(target.workspaces, [existing]);
    assert.equal(target.tabs.length, 0);
    assert.equal(store.workspaces[0], w);
  }
  let reads = 0;
  const invalid = structuredClone(dto);
  Object.defineProperty(invalid.viewState.trees.remote, "expanded", {
    enumerable: true,
    get() {
      reads++;
      throw Error("secret getter");
    },
  });
  assert.throws(() => validateWorkspaceTransfer(invalid), /ordinary data/);
  assert.equal(reads, 0);
});

test("wire profile property order does not change connection identity", () => {
  const { store, w } = fixture();
  const dto = snapshotWorkspaceTransfer(store, w.id);
  dto.job.profile = Object.fromEntries(
    Object.entries(dto.job.profile).reverse(),
  );
  const restored = hydrateWorkspaceTransfer(
    new Store({ profiles: [profile] }),
    dto,
    w.id,
  );
  assert.equal(restored.connection.host, profile.host);
});

test("legacy viewless DTO remains supported and creates current navigation state", () => {
  const { store, w } = fixture();
  const dto = snapshotWorkspaceTransfer(store, w.id);
  delete dto.viewState;
  const restored = hydrateWorkspaceTransfer(
    new Store({ profiles: [profile] }),
    dto,
    w.id,
  );
  assert.equal(restored.navigation.local.current, w.localBrowse);
  assert.equal(restored.navigation.remote.current, w.remoteBrowse);
});
