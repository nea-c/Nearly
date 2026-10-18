import test from "node:test";
import assert from "node:assert/strict";
import { applyTreeRatio } from "../.test-build/pane-layout.js";
import * as layout from "../.test-build/pane-layout.js";
import { Store } from "../.test-build/core.js";
import { applyPersistentSettings } from "../.test-build/shared-settings.js";

test('both desired pixel widths survive center narrowing and recover while legacy ratios initialize once', () => {
  const previous = globalThis.document;
  const bodies = Object.fromEntries(['local', 'remote'].map(side => [side, { clientWidth: 600, style: {} }]));
  globalThis.document = { querySelector(selector) { return selector.includes('pane-body') ? bodies[selector.includes('local') ? 'local' : 'remote'] : null; } };
  try {
    const store = new Store({ localTreeRatio: .4, remoteTreeRatio: .3 });
    layout.applyTreeRatios(store);
    assert.equal(store.localTreeWidth, 594 * .4);
    assert.equal(store.remoteTreeWidth, 594 * .3);
    const original = [store.localTreeWidth, store.remoteTreeWidth];
    bodies.local.clientWidth = 270; bodies.remote.clientWidth = 900;
    layout.applyTreeRatios(store);
    assert.equal(parseFloat(bodies.local.style.gridTemplateColumns), 124);
    assert.equal(parseFloat(bodies.remote.style.gridTemplateColumns), original[1]);
    assert.deepEqual([store.localTreeWidth, store.remoteTreeWidth], original);
    bodies.local.clientWidth = 600; bodies.remote.clientWidth = 600;
    layout.applyTreeRatios(store);
    assert.equal(parseFloat(bodies.local.style.gridTemplateColumns), original[0]);
    assert.equal(parseFloat(bodies.remote.style.gridTemplateColumns), original[1]);
  } finally { globalThis.document = previous; }
});

test('pixel preferences survive serialization and shared refresh; invalid values cannot enter persistence', () => {
  const store = new Store({ localTreeWidth: 330, remoteTreeWidth: 240 });
  assert.equal(store.serialize().localTreeWidth, 330);
  assert.equal(new Store(store.serialize()).remoteTreeWidth, 240);
  applyPersistentSettings(store, { ...store.serialize(), localTreeWidth: 420 });
  assert.equal(store.localTreeWidth, 420);
  for (const value of [NaN, Infinity, -1, 0, 99, 4097, '240']) {
    assert.equal(new Store({localTreeWidth: value}).localTreeWidth, undefined);
  }
  store.localTreeWidth = Infinity;
  assert.equal(store.serialize().localTreeWidth, undefined);
});
test("hidden and invalid pane geometry cannot create nonfinite layout or overwrite preferred ratio", () => {
  const previous = globalThis.document;
  const body = { clientWidth: 0, style: { gridTemplateColumns: "unchanged" } };
  globalThis.document = {
    querySelector(selector) {
      return selector.includes("pane-body") ? body : null;
    },
  };
  try {
    assert.equal(applyTreeRatio("local", 0.4), 0.4);
    assert.equal(body.style.gridTemplateColumns, "unchanged");
    assert.equal(applyTreeRatio("remote", NaN), 0.28);
    body.clientWidth = Infinity;
    assert.equal(applyTreeRatio("local", 0.4), 0.4);
    assert.equal(body.style.gridTemplateColumns, "unchanged");
    body.clientWidth = 900;
    const actual = applyTreeRatio("remote", Infinity);
    assert.ok(Number.isFinite(actual));
    assert.ok(!/NaN|Infinity/.test(body.style.gridTemplateColumns));
  } finally {
    globalThis.document = previous;
  }
});
