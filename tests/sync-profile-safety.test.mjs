import test from "node:test";
import assert from "node:assert/strict";
import { Store, DEFAULT_SYNC_PRESET_ID } from "../.test-build/core.js";
const preset = (id, name, extra = {}) => ({
  id,
  name,
  exclusionRules: "",
  ...extra,
});
test("missing profile flags are safe and loading same-name records preserves every ID", () => {
  const s = new Store({
    syncPresets: [
      preset("a", "Web", { recursive: false }),
      preset("b", "Web", { deleteRemoved: true }),
    ],
  });
  assert.deepEqual(
    s.syncPresets.map((p) => [p.id, p.deleteRemoved, p.recursive]),
    [
      ["a", false, false],
      ["b", true, true],
    ],
  );
  assert.deepEqual(s.defaultSyncPreset(), {
    id: DEFAULT_SYNC_PRESET_ID,
    name: "Default",
    exclusionRules: "",
    deleteRemoved: false,
    recursive: true,
  });
  assert.throws(
    () =>
      new Store({ syncPresets: [preset("a", "Web", { deleteRemoved: null })] }),
  );
});
test("same-name saves update, ambiguous duplicates require explicit selection, copies can use unique names", () => {
  const s = new Store();
  const a = s.saveSyncPreset({
    name: "Web",
    exclusionRules: "",
    deleteRemoved: true,
    recursive: false,
  });
  const b = s.saveSyncPreset({
    name: " Web ",
    exclusionRules: "*.log",
    deleteRemoved: false,
    recursive: true,
  });
  assert.equal(a.id, b.id);
  assert.equal(s.syncPresets.length, 1);
  assert.equal(b.deleteRemoved, false);
  const d = new Store({
    syncPresets: [preset("a", "Web"), preset("b", "Web")],
  });
  assert.throws(
    () =>
      d.saveSyncPreset({
        name: "Web",
        exclusionRules: "",
        deleteRemoved: true,
        recursive: true,
      }),
    /同名/,
  );
  d.saveSyncPreset({
    id: "b",
    name: "Web",
    exclusionRules: "x/",
    deleteRemoved: true,
    recursive: false,
  });
  assert.equal(d.syncPresets[0].deleteRemoved, false);
  assert.equal(d.syncPresets[1].deleteRemoved, true);
  assert.equal(d.syncPresets.length, 2);
});
test("editable default and deletion roundtrip safely without touching unrelated settings", () => {
  const s = new Store({
    theme: "midnight",
    language: "en",
    history: { sentinel: "keep" },
  });
  s.saveDefaultSyncPreset({
    exclusionRules: "default/",
    deleteRemoved: false,
    recursive: false,
  });
  const p = s.saveSyncPreset({
    name: "Custom",
    exclusionRules: "custom/",
    deleteRemoved: true,
    recursive: true,
  });
  s.syncOptions["affected"] = {
    presetId: p.id,
    deleteRemoved: true,
    recursive: true,
  };
  s.exclusions.affected = "custom/";
  s.syncOptions.other = { deleteRemoved: true, recursive: true };
  s.exclusions.other = "keep/";
  assert.throws(() => s.deleteSyncPreset(DEFAULT_SYNC_PRESET_ID));
  s.deleteSyncPreset(p.id);
  assert.deepEqual(s.syncOptions.affected, {
    deleteRemoved: false,
    recursive: false,
  });
  assert.equal(s.exclusions.affected, "default/");
  assert.deepEqual(s.syncOptions.other, {
    deleteRemoved: true,
    recursive: true,
  });
  assert.equal(s.history.sentinel, "keep");
  const restored = new Store(s.serialize());
  assert.equal(restored.defaultSyncPreset().recursive, false);
  assert.equal(restored.theme, "midnight");
  assert.equal(restored.language, "en");
  restored.saveDefaultSyncPreset({
    exclusionRules: "",
    deleteRemoved: true,
    recursive: true,
  });
  assert.equal(
    new Store(restored.serialize()).defaultSyncPreset().deleteRemoved,
    true,
  );
});

test("custom limit, duplicate IDs, invalid flags and repeated same-name updates stay strict", () => {
  const initial = Array.from({ length: 100 }, (_, n) =>
    preset("p" + n, "P" + n),
  );
  const s = new Store({ syncPresets: initial });
  s.saveDefaultSyncPreset({
    exclusionRules: "",
    deleteRemoved: false,
    recursive: true,
  });
  assert.equal(s.syncPresets.length, 101);
  assert.throws(() => s.saveSyncPreset({ name: "Extra" }));
  for (let n = 0; n < 20; n++)
    s.saveSyncPreset({
      name: "P0",
      deleteRemoved: n % 2 === 0,
      recursive: false,
    });
  assert.equal(s.syncPresets.length, 101);
  assert.equal(s.syncPresets.find((p) => p.id === "p0").deleteRemoved, false);
  assert.throws(
    () => new Store({ syncPresets: [preset("a", "A"), preset("a", "B")] }),
  );
  for (const invalid of [null, 1, "true"]) {
    assert.throws(
      () =>
        new Store({ syncPresets: [preset("a", "A", { recursive: invalid })] }),
    );
  }
});
