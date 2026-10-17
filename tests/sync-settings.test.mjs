import test from "node:test";
import assert from "node:assert/strict";
import { Store, exclusionKey, validateRules } from "../.test-build/core.js";
import { FolderTree, PC_ROOT } from "../.test-build/tree.js";
test("splitter invalid values fall back safely and serialize with theme", () => {
  for (const localPaneRatio of [null, "0.5", 0, 0.19, 0.81, Infinity, NaN])
    assert.equal(new Store({ localPaneRatio }).localPaneRatio, 0.5);
  const s = new Store({ localPaneRatio: 0.63, theme: "dark" });
  assert.equal(new Store(s.serialize()).localPaneRatio, 0.63);
  assert.equal(s.serialize().theme, "dark");
});

test("tree ratios persist independently and each invalid saved value falls back", () => {
  for (const invalid of [null, "0.28", 0.14, 0.66, Infinity, NaN]) {
    const store = new Store({
      localTreeRatio: invalid,
      remoteTreeRatio: 0.4,
      localPaneRatio: 0.6,
      theme: "dark",
    });
    assert.equal(store.localTreeRatio, 0.28);
    assert.equal(store.remoteTreeRatio, 0.4);
    assert.equal(store.serialize().localPaneRatio, 0.6);
    assert.equal(store.serialize().theme, "dark");
  }
  const stored = new Store({
    localTreeRatio: 0.15,
    remoteTreeRatio: 0.65,
  }).serialize();
  assert.equal(new Store(stored).localTreeRatio, 0.15);
  assert.equal(new Store(stored).remoteTreeRatio, 0.65);
});
test("combo keys normalize case and separators while retaining connection and remote isolation", () => {
  assert.equal(
    exclusionKey("p", "/a/", "C:\\Site\\"),
    exclusionKey("p", "/a", "c:/site"),
  );
  assert.notEqual(
    exclusionKey("p", "/a", "c:/site"),
    exclusionKey("q", "/a", "c:/site"),
  );
  assert.notEqual(
    exclusionKey("p", "/a", "c:/site"),
    exclusionKey("p", "/b", "c:/site"),
  );
});
test("presets have only sync fields; updates do not mutate saved combo values", () => {
  const s = new Store();
  const p = s.saveSyncPreset({
    name: "Web",
    exclusionRules: "*.log",
    deleteRemoved: false,
    recursive: true,
    host: "ignored",
    passphrase: "ignored",
  });
  const key = exclusionKey("p", "/", "c:/one");
  s.exclusions[key] = "custom/";
  s.syncOptions[key] = {
    presetId: p.id,
    deleteRemoved: false,
    recursive: true,
  };
  s.saveSyncPreset({
    ...p,
    name: "Renamed",
    exclusionRules: "*.tmp",
    deleteRemoved: true,
  });
  assert.equal(s.exclusions[key], "custom/");
  assert.equal(s.syncOptions[key].deleteRemoved, false);
  const clone = s.saveSyncPreset({ ...p, id: undefined, name: "Clone" });
  assert.notEqual(clone.id, p.id);
  assert.deepEqual(Object.keys(clone).sort(), [
    "deleteRemoved",
    "exclusionRules",
    "id",
    "name",
    "recursive",
  ]);
  const restored = new Store(s.serialize());
  assert.equal(restored.syncPresets.length, 2);
  assert.equal(restored.exclusions[key], "custom/");
  assert.throws(() => validateRules("a".repeat(4097)));
});
test("PC is virtual; drive enumeration stays lazy and direct paths cache ancestors without expanding them", () => {
  const t = new FolderTree("local", PC_ROOT);
  t.setDrives([
    { path: "C:\\", name: "C:" },
    { path: "D:\\", name: "D:" },
  ]);
  assert.equal(t.peek("C:\\"), undefined);
  t.record("D:\\work\\site", [{ name: "child", dir: true, size: 0 }]);
  assert.equal(t.root, PC_ROOT);
  assert.equal(t.peek(PC_ROOT).children.length, 2);
  assert.equal(t.peek("D:\\").loaded, false);
  assert.equal(t.peek("D:\\").expanded, false);
  assert.equal(t.peek("D:\\work").children[0].path, "D:\\work\\site");
});
