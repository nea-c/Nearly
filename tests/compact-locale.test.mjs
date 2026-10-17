import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../.test-build/core.js";

test("new appearance preferences default without changing explicit theme or revision", () => {
  const store = new Store({
    theme: "midnight",
    settingsRevision: 12,
    history: { sentinel: "設定" },
    localPaneRatio: 0.62,
  });
  assert.equal(store.language, "ja");
  assert.equal(store.compactExplorer, false);
  assert.equal(store.resolveInitialTheme(false), false);
  assert.equal(store.settingsRevision, 12);
  assert.equal(store.serialize().language, "ja");
  assert.equal(store.serialize().compactExplorer, false);
  assert.deepEqual(store.serialize().history, { sentinel: "設定" });
});
test("all explicit appearance choices roundtrip while preserving unrelated settings", () => {
  for (const language of ["ja", "en"])
    for (const compactExplorer of [false, true])
      for (const theme of ["light", "dark", "midnight"]) {
        const input = {
          language,
          compactExplorer,
          theme,
          settingsRevision: 9,
          history: { sentinel: "設定" },
          localPaneRatio: 0.63,
        };
        const copy = new Store(new Store(input).serialize());
        assert.equal(copy.language, language);
        assert.equal(copy.compactExplorer, compactExplorer);
        assert.equal(copy.theme, theme);
        assert.equal(copy.settingsRevision, 9);
        assert.equal(copy.localPaneRatio, 0.63);
        assert.deepEqual(copy.history, input.history);
      }
});
test("explicit invalid languages and density values are rejected, not reset", () => {
  for (const language of [null, "", "EN", "system", 1, false])
    assert.throws(() => new Store({ language }));
  for (const compactExplorer of [null, "false", 0, 1, {}, []])
    assert.throws(() => new Store({ compactExplorer }));
});
