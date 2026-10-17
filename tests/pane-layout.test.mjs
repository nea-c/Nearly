import test from "node:test";
import assert from "node:assert/strict";
import { applyTreeRatio } from "../.test-build/pane-layout.js";
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
