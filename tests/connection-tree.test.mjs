import test from "node:test";
import assert from "node:assert/strict";
import { Store, connectionKey } from "../.test-build/core.js";
import { validateConnectionTree } from "../.test-build/connection-tree.js";
const p = (id) => ({
  id,
  name: id,
  host: "example.invalid",
  port: 22,
  user: "me",
  auth: "key",
  mode: "mock",
  keyFile: "fixture.ppk",
  hostKey: "",
});

test("connection deletion is metadata-only, promotes group children and protects live runtime references", () => {
  const s = new Store({ profiles: [p("a"), p("b")] });
  const group = s.createConnectionGroup("Group"),
    nested = s.createConnectionGroup("Nested", group);
  s.moveConnectionNode("a", nested);
  s.rememberSyncPair(s.profiles[0], "C:\\site", "/www");
  s.saveFolderBookmark(s.profiles[0], {
    name: "Keep",
    local: "C:\\site",
    remote: "/www",
  });
  const w = s.createWorkspace("a");
  s.connectWorkspace(w.id, s.profiles[0]);
  const snapshot = JSON.stringify(s.serialize());
  assert.throws(() => s.deleteConnectionNode("a"), /接続|同期|使用/);
  const candidate = new Store(s.serialize());
  assert.throws(() => candidate.deleteConnectionNode("a", s));
  assert.equal(JSON.stringify(s.serialize()), snapshot);
  s.deleteConnectionNode(group);
  assert.equal(
    s.connectionTree.nodes.find((n) => n.id === nested).parentId,
    null,
  );
  assert.equal(w.connection.id, "a");
  w.connection = undefined;
  w.connecting = true;
  assert.throws(() => s.deleteConnectionNode("a"));
  w.connecting = false;
  w.starting = true;
  assert.throws(() => s.deleteConnectionNode("a"));
  w.starting = false;
  s.tabs.push({ id: "job", profile: p("a"), status: "failed" });
  assert.throws(() => s.deleteConnectionNode("a"));
  s.tabs[0].status = "stopped";
  s.deleteConnectionNode("a");
  const loaded = new Store(s.serialize());
  assert.deepEqual(
    loaded.profiles.map((p) => p.id),
    ["b"],
  );
  assert.ok(loaded.connectionTree.nodes.some((n) => n.id === nested));
  assert.equal(loaded.folderBookmarks.length, 1);
  assert.equal(loaded.localFor(p("a"), "/www"), "C:\\site");
  assert.throws(() => s.deleteConnectionNode("missing"));
});
test("flat migration, upsert and moves retain stable identities and immutable sessions", () => {
  const s = new Store({ profiles: [p("a"), p("b")] });
  assert.deepEqual(
    s.connectionTree.nodes.map((n) => n.id),
    ["a", "b"],
  );
  const w = s.createWorkspace("a");
  s.connectWorkspace(w.id, s.profiles[0]);
  const snapshot = w.connection;
  const before = connectionKey(snapshot);
  s.rememberSyncPair(snapshot, "C:\\site", "/www");
  s.saveFolderBookmark(snapshot, {
    name: "Site",
    local: "C:\\site",
    remote: "/www",
  });
  const group = s.createConnectionGroup("Group");
  s.moveConnectionNode("a", group);
  s.renameConnectionNode("a", "Renamed");
  assert.equal(connectionKey(s.profiles[0]), before);
  assert.equal(s.localFor(snapshot, "/www"), "C:\\site");
  assert.equal(s.folderBookmarks[0].connectionKey, before);
  assert.equal(w.connection, snapshot);
  assert.equal(snapshot.name, "a");
  s.saveProfile(p("c"));
  assert.equal(s.connectionTree.nodes.filter((n) => n.id === "c").length, 1);
  s.saveProfile({ ...p("c"), name: "again" });
  assert.equal(s.connectionTree.nodes.filter((n) => n.id === "c").length, 1);
  const r = new Store(s.serialize());
  assert.deepEqual(r.connectionTree, s.connectionTree);
  assert.equal(r.connectionTreeChanged, false);
});

test("deleting last unused profile persists an empty library and clears idle selections only", () => {
  const s = new Store({ profiles: [p("only")] }),
    idle = s.createWorkspace("only");
  s.deleteConnectionNode("only");
  assert.equal(idle.profileId, "");
  assert.deepEqual(new Store(s.serialize()).profiles, []);
  assert.deepEqual(new Store(s.serialize()).connectionTree.nodes, []);
});
test("cycles, self descendants, duplicate refs and unknown metadata recover without losing profiles", () => {
  const s = new Store({
    profiles: [p("a"), p("b")],
    connectionTree: {
      version: 1,
      nodes: [
        { id: "g", kind: "group", name: "G", parentId: "g", expanded: true },
      ],
    },
  });
  assert.ok(s.connectionTreeWarning);
  assert.deepEqual(
    s.connectionTree.nodes.map((n) => n.id),
    ["a", "b"],
  );
  assert.equal(s.connectionTreeChanged, false);
  const warning = s.connectionTreeWarning;
  s.saveProfile({ ...p("a"), host: "edited.invalid" });
  assert.equal(s.connectionTreeChanged, false);
  assert.equal(s.connectionTreeWarning, warning);
  const g = s.createConnectionGroup("G"),
    h = s.createConnectionGroup("H", g);
  const old = JSON.stringify(s.serialize());
  assert.throws(() => s.moveConnectionNode(g, h));
  assert.equal(JSON.stringify(s.serialize()), old);
  assert.throws(() => s.moveConnectionNode(g, g));
  for (const nodes of [
    [
      { id: "a", kind: "profile", profileId: "a", parentId: null },
      { id: "b", kind: "profile", profileId: "a", parentId: null },
    ],
    [{ id: "x", kind: "profile", profileId: "missing", parentId: null }],
  ])
    assert.throws(() =>
      validateConnectionTree({ version: 1, nodes }, s.profiles),
    );
  const added = new Store({
    profiles: [p("a"), p("b")],
    connectionTree: {
      version: 1,
      nodes: [
        { id: "g", kind: "group", name: "G", parentId: null, expanded: false },
        { id: "a", kind: "profile", profileId: "a", parentId: "g" },
      ],
    },
  });
  assert.equal(
    added.connectionTree.nodes.find((n) => n.id === "a").parentId,
    "g",
  );
  assert.equal(
    added.connectionTree.nodes.find((n) => n.id === "b").parentId,
    null,
  );
});
test("group clone creates fresh IDs recursively, preserves sibling order and dissolve keeps profiles", () => {
  const s = new Store({ profiles: [p("a"), p("b")] });
  const g = s.createConnectionGroup("G"),
    h = s.createConnectionGroup("H", g);
  s.moveConnectionNode("a", g);
  s.moveConnectionNode("b", h);
  s.setConnectionGroupExpanded(h, false);
  const clone = s.duplicateConnectionNode(g);
  assert.equal(s.profiles.length, 4);
  assert.notEqual(clone, g);
  assert.equal(
    new Set(s.connectionTree.nodes.map((n) => n.id)).size,
    s.connectionTree.nodes.length,
  );
  assert.deepEqual(s.profiles.slice(0, 2), [p("a"), p("b")]);
  const copiedGroup = s.connectionTree.nodes.find(
    (n) => n.parentId === clone && n.kind === "group",
  );
  assert.equal(copiedGroup.expanded, false);
  assert.equal(
    s.connectionTree.nodes.filter((n) => n.kind === "profile").length,
    4,
  );
  s.dissolveConnectionGroup(g);
  assert.equal(s.profiles.length, 4);
  assert.equal(s.connectionTree.nodes.find((n) => n.id === h).parentId, null);
  assert.equal(s.connectionTree.nodes.find((n) => n.id === "a").parentId, null);
  assert.throws(() => s.dissolveConnectionGroup("a"));
});
test("capacity and depth failures are atomic and Unicode bounds match native", () => {
  const s = new Store({
    profiles: Array.from({ length: 200 }, (_, i) => p("p" + i)),
  });
  let parent = null;
  for (let i = 0; i < 7; i++) parent = s.createConnectionGroup("G" + i, parent);
  s.moveConnectionNode("p0", parent);
  const deepest = s.createConnectionGroup("Depth8", parent);
  const before = JSON.stringify(s.serialize());
  assert.throws(() => s.duplicateConnectionNode(parent));
  assert.equal(JSON.stringify(s.serialize()), before);
  assert.throws(() => s.createConnectionGroup("Too deep", deepest));
  assert.equal(JSON.stringify(s.serialize()), before);
  assert.throws(() => s.createConnectionGroup("😀".repeat(51)));
  assert.throws(() => s.createConnectionGroup("x\u0085"));
  assert.ok(s.createConnectionGroup("😀".repeat(50)));
});
test("sibling reorder and group dissolution preserve position with earlier descendants", () => {
  const s = new Store({ profiles: [p("a"), p("b"), p("c")] });
  const inner = s.createConnectionGroup("Inner"),
    outer = s.createConnectionGroup("Outer");
  s.moveConnectionNode(inner, outer);
  s.moveConnectionNode("a", inner);
  s.moveConnectionNode("b", null, "c");
  assert.deepEqual(
    s.connectionTree.nodes.filter((n) => n.parentId === null).map((n) => n.id),
    ["b", "c", outer],
  );
  s.moveConnectionNode("a", outer, inner);
  s.moveConnectionNode(outer, null, "c");
  const earlier = s.connectionTree.nodes.filter((n) => n.parentId === outer);
  s.connectionTree.nodes = [
    ...earlier,
    ...s.connectionTree.nodes.filter((n) => n.parentId !== outer),
  ];
  s.dissolveConnectionGroup(outer);
  assert.deepEqual(
    s.connectionTree.nodes.filter((n) => n.parentId === null).map((n) => n.id),
    ["b", "a", inner, "c"],
  );
  s.renameConnectionNode(inner, "😀".repeat(50));
  const copied = s.duplicateConnectionNode(inner);
  assert.ok(
    s.connectionTree.nodes.find((n) => n.id === copied).name.length <= 100,
  );
  s.markConnectionTreeSaved();
  assert.equal(s.connectionTreeChanged, false);
  s.saveProfile({ ...s.profiles[0], name: "Explicit profile edit" });
  assert.equal(s.connectionTreeChanged, false);
});
