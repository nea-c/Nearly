import test from "node:test";
import assert from "node:assert/strict";
import { Store, connectionKey } from "../.test-build/core.js";
import {
  validateBookmarkTree,
  deleteBookmarkMetadata,
} from "../.test-build/bookmark-tree.js";
const profile = (id, host) => ({
  id,
  name: id,
  host,
  port: 22,
  user: "me",
  auth: "key",
  mode: "mock",
  keyFile: "",
  hostKey: "",
});

test("item and organizer rename persist only display names, preserving targets and sync preferences", () => {
  const p = profile("p", "a.invalid"),
    q = profile("q", "b.invalid"),
    s = new Store({ profiles: [p, q], theme: "dark" }),
    key = connectionKey(p);
  const item = s.saveFolderBookmark(p, {
    name: "Original",
    local: "C:\\site",
    remote: "/site",
  });
  s.saveFolderBookmark(q, {
    name: "Other connection",
    local: "D:\\other",
    remote: "/other",
  });
  const group = s.createBookmarkGroup(key, "Group");
  s.moveBookmarkNode(key, item.id, group);
  s.rememberSyncPair(p, "C:\\sync", "/sync");
  const before = structuredClone(s.serialize());
  s.renameBookmarkNode(key, item.id, "Renamed item");
  s.renameBookmarkNode(key, group, "Renamed folder");
  const after = new Store(s.serialize()).serialize();
  assert.deepEqual(
    after.folderBookmarks,
    before.folderBookmarks.map((b) =>
      b.id === item.id ? { ...b, name: "Renamed item" } : b,
    ),
  );
  assert.deepEqual(
    after.bookmarkTree.nodes,
    before.bookmarkTree.nodes.map((n) =>
      n.id === group ? { ...n, name: "Renamed folder" } : n,
    ),
  );
  for (const field of [
    "profiles",
    "history",
    "folderPairHistory",
    "lastBrowses",
    "exclusions",
    "syncOptions",
    "syncPresets",
    "paneColumns",
    "connectionTree",
    "theme",
  ])
    assert.deepEqual(after[field], before[field], field);
  assert.equal(new Store(after).localFor(p, "/sync"), "C:\\sync");
});

test("context deletion removes only scoped metadata and folder deletion promotes stable children", () => {
  const p = profile("p", "a.invalid"),
    q = profile("q", "b.invalid"),
    s = new Store(),
    key = connectionKey(p);
  const a = s.saveFolderBookmark(p, {
      name: "A",
      local: "C:\\a",
      remote: "/a",
    }),
    b = s.saveFolderBookmark(q, { name: "B", local: "C:\\b", remote: "/b" });
  const g = s.createBookmarkGroup(key, "Group"),
    h = s.createBookmarkGroup(key, "Nested", g);
  s.moveBookmarkNode(key, a.id, h);
  s.rememberSyncPair(p, "C:\\fixed", "/fixed");
  const original = JSON.stringify(s.serialize());
  assert.throws(() => deleteBookmarkMetadata(s, connectionKey(q), a.id));
  assert.equal(JSON.stringify(s.serialize()), original);
  deleteBookmarkMetadata(s, key, g);
  assert.equal(s.bookmarkTree.nodes.find((n) => n.id === h).parentId, null);
  assert.equal(s.bookmarkTree.nodes.find((n) => n.id === a.id).parentId, h);
  assert.equal(s.folderBookmarks.length, 2);
  deleteBookmarkMetadata(s, key, a.id);
  const restored = new Store(s.serialize());
  assert.deepEqual(
    restored.folderBookmarks.map((x) => x.id),
    [b.id],
  );
  assert.ok(restored.bookmarkTree.nodes.some((n) => n.id === h));
  assert.equal(restored.localFor(p, "/fixed"), "C:\\fixed");
  assert.throws(() => deleteBookmarkMetadata(s, key, g));
});
test("bookmark migration and hierarchy retain stable IDs, scope and unrelated settings", () => {
  const p = profile("p", "a.invalid"),
    s = new Store({ profiles: [p], theme: "dark", localPaneRatio: 0.61 });
  const a = s.saveFolderBookmark(p, {
      name: "A",
      local: "C:\\a",
      remote: "/a",
    }),
    b = s.saveFolderBookmark(p, { name: "B", local: "C:\\b", remote: "/b" });
  const key = connectionKey(p);
  assert.deepEqual(
    s.bookmarkTree.nodes.map((n) => n.id),
    [a.id, b.id],
  );
  const g = s.createBookmarkGroup(key, "Favorites"),
    h = s.createBookmarkGroup(key, "Nested", g);
  s.moveBookmarkNode(key, a.id, h);
  s.moveBookmarkNode(key, b.id, g, h);
  s.renameBookmarkNode(key, a.id, "Updated");
  assert.equal(s.folderBookmarks.find((x) => x.id === a.id).name, "Updated");
  assert.equal(s.bookmarkTree.nodes.find((n) => n.id === a.id).parentId, h);
  const r = new Store(s.serialize());
  assert.deepEqual(r.bookmarkTree, s.bookmarkTree);
  assert.equal(r.bookmarkTreeChanged, false);
  assert.equal(r.theme, "dark");
  assert.equal(r.localPaneRatio, 0.61);
  assert.equal(r.tabs.length, 0);
  s.removeFolderBookmark(a.id);
  assert.ok(!s.bookmarkTree.nodes.some((n) => n.id === a.id));
  assert.ok(s.bookmarkTree.nodes.some((n) => n.id === h));
});
test("cross-connection moves cycles and deep nesting fail atomically without altering history", () => {
  const a = profile("a", "a.invalid"),
    b = profile("b", "b.invalid"),
    s = new Store();
  const ka = connectionKey(a),
    kb = connectionKey(b);
  const bookmark = s.saveFolderBookmark(a, {
    name: "A",
    local: "C:\\a",
    remote: "/a",
  });
  const ga = s.createBookmarkGroup(ka, "A"),
    gb = s.createBookmarkGroup(kb, "B"),
    child = s.createBookmarkGroup(ka, "Child", ga);
  s.rememberSyncPair(a, "C:\\fixed", "/sync");
  const before = JSON.stringify(s.serialize());
  for (const action of [
    () => s.moveBookmarkNode(ka, ga, child),
    () => s.moveBookmarkNode(ka, ga, ga),
    () => s.moveBookmarkNode(ka, bookmark.id, gb),
    () => s.renameBookmarkNode(kb, bookmark.id, "wrong"),
  ]) {
    assert.throws(action);
    assert.equal(JSON.stringify(s.serialize()), before);
  }
  assert.equal(s.localFor(a, "/sync"), "C:\\fixed");
  let parent = child;
  for (let i = 0; i < 6; i++)
    parent = s.createBookmarkGroup(ka, "Depth", parent);
  const full = JSON.stringify(s.serialize());
  assert.throws(() => s.moveBookmarkNode(ka, bookmark.id, parent));
  assert.equal(JSON.stringify(s.serialize()), full);
});
test("invalid grouping falls back without discarding bookmarks and missing refs append safely", () => {
  const p = profile("p", "a.invalid"),
    s = new Store();
  const a = s.saveFolderBookmark(p, {
      name: "A",
      local: "C:\\a",
      remote: "/a",
    }),
    key = connectionKey(p);
  const data = s.serialize();
  data.bookmarkTree = {
    version: 1,
    nodes: [
      { id: "g", kind: "group", name: "G", connectionKey: key, parentId: "g" },
    ],
  };
  const restored = new Store(data);
  assert.equal(restored.folderBookmarks.length, 1);
  assert.ok(restored.bookmarkTreeWarning);
  assert.equal(restored.bookmarkTree.nodes[0].id, a.id);
  assert.equal(restored.bookmarkTreeChanged, false);
  restored.saveFolderBookmark(p, {
    id: a.id,
    name: "Renamed only",
    local: "C:\\a",
    remote: "/a",
  });
  assert.equal(restored.bookmarkTreeChanged, false);
  assert.ok(restored.bookmarkTreeWarning);
  const tree = {
    version: 1,
    nodes: [
      { id: "g", kind: "group", name: "G", connectionKey: key, parentId: null },
    ],
  };
  assert.throws(() => validateBookmarkTree(tree, s.folderBookmarks));
  assert.equal(
    validateBookmarkTree(tree, s.folderBookmarks, true).nodes[1].id,
    a.id,
  );
});
test("ungroup preserves children positions and group/name counts stay bounded", () => {
  const p = profile("p", "a.invalid"),
    s = new Store(),
    key = connectionKey(p);
  const a = s.saveFolderBookmark(p, {
      name: "A",
      local: "C:\\a",
      remote: "/a",
    }),
    b = s.saveFolderBookmark(p, { name: "B", local: "C:\\b", remote: "/b" }),
    g = s.createBookmarkGroup(key, "G"),
    h = s.createBookmarkGroup(key, "H", g);
  s.moveBookmarkNode(key, a.id, g, h);
  s.moveBookmarkNode(key, g, null, b.id);
  s.ungroupBookmarkFolder(key, g);
  assert.deepEqual(
    s.bookmarkTree.nodes.filter((n) => n.parentId === null).map((n) => n.id),
    [a.id, h, b.id],
  );
  assert.equal(s.folderBookmarks.length, 2);
  assert.throws(() => s.createBookmarkGroup(key, "😀".repeat(51)));
  assert.ok(s.createBookmarkGroup(key, "😀".repeat(50)));
  for (
    let i = s.bookmarkTree.nodes.filter((n) => n.kind === "group").length;
    i < 200;
    i++
  )
    s.createBookmarkGroup(key, "G" + i);
  const old = JSON.stringify(s.serialize());
  assert.throws(() => s.createBookmarkGroup(key, "overflow"));
  assert.equal(JSON.stringify(s.serialize()), old);
});
