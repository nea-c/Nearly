import test from "node:test";
import assert from "node:assert/strict";
import { Store, connectionKey } from "../.test-build/core.js";
const p = {
  id: "p",
  name: "Fixture",
  mode: "sftp",
  host: "example.invalid",
  port: 22,
  user: "me",
  auth: "key",
  keyFile: "fixture.ppk",
  hostKey: "SHA256:fixture",
};
test("serialization prevents null numeric preferences and retains last valid layout and widths", () => {
  const s = new Store({
    profiles: [p],
    history: { legacy: "C:\\fixture" },
    localPaneRatio: 0.41,
  });
  s.paneColumns.remote.widths.owner = 180;
  s.serialize();
  s.localPaneRatio = NaN;
  s.localTreeRatio = Infinity;
  s.remoteTreeRatio = null;
  s.paneColumns.remote.widths.owner = NaN;
  s.paneColumns.remote.widths.permissions = Infinity;
  const saved = JSON.parse(JSON.stringify(s.serialize()));
  assert.equal(saved.localPaneRatio, 0.41);
  assert.equal(saved.localTreeRatio, 0.28);
  assert.equal(saved.remoteTreeRatio, 0.28);
  assert.equal(saved.paneColumns.remote.widths.owner, 180);
  assert.equal(saved.paneColumns.remote.widths.permissions, 120);
  assert.deepEqual(saved.profiles, [p]);
  assert.deepEqual(saved.history, { legacy: "C:\\fixture" });
  assert.ok(s.takePreferenceWarnings().length);
  assert.equal(s.takePreferenceWarnings().length, 0);
});
test("legacy null recovery is narrow and preserves valid choices", () => {
  const a = new Store();
  const data = a.serialize();
  data.localPaneRatio = null;
  data.paneColumns.remote.widths.owner = null;
  data.paneColumns.remote.widths.name = 310;
  const s = new Store(data);
  assert.equal(s.localPaneRatio, 0.5);
  assert.equal(s.serialize().paneColumns.remote.widths.name, 310);
  assert.ok(s.takePreferenceWarnings().length);
  for (const value of ["120", {}, false]) {
    data.paneColumns.remote.widths.owner = value;
    assert.throws(() => new Store(data));
  }
  data.paneColumns.remote.widths.owner = 120;
  data.paneColumns.remote.widths.unknown = null;
  assert.throws(() => new Store(data));
});
test("only newest successful browse per frozen endpoint and side is remembered", () => {
  const s = new Store();
  const old = s.beginBrowse(p, "remote"),
    latest = s.beginBrowse(p, "remote");
  assert.equal(s.rememberSuccessfulBrowse(p, "remote", "/stale", old), false);
  assert.deepEqual(s.lastBrowse(p), {});
  assert.equal(
    s.rememberSuccessfulBrowse(p, "remote", "/actual", latest),
    true,
  );
  const local = s.beginBrowse(p, "local");
  s.rememberSuccessfulBrowse(p, "local", "D:\\actual", local);
  const changed = { ...p, host: "different.invalid" };
  assert.deepEqual(s.lastBrowse(changed), {});
  const failed = s.beginBrowse(p, "remote");
  assert.ok(failed);
  assert.equal(s.lastBrowse(p).remote, "/actual");
  const restored = new Store(JSON.parse(JSON.stringify(s.serialize())));
  assert.deepEqual(restored.lastBrowse(p), {
    local: "D:\\actual",
    remote: "/actual",
  });
  assert.equal(restored.localFor(p, "/actual"), "");
  assert.ok(restored.browseLocations[connectionKey(p)]);
});
test("sort defaults and explicit choices persist without stale save clearing newer browsing", () => {
  const s = new Store();
  assert.deepEqual(s.paneColumns.local.sort, {
    column: "name",
    direction: "ascending",
  });
  assert.deepEqual(s.paneColumns.remote.sort, s.paneColumns.local.sort);
  s.setPaneSort("remote", { column: "owner", direction: "descending" });
  const revision = s.browsePreferencesRevision;
  s.rememberSuccessfulBrowse(p, "remote", "/new", s.beginBrowse(p, "remote"));
  assert.equal(s.markBrowseLocationsSaved(revision), false);
  assert.equal(s.browseLocationsChanged, true);
  assert.equal(s.markBrowseLocationsSaved(s.browsePreferencesRevision), true);
  const restored = new Store(s.serialize());
  assert.deepEqual(restored.paneColumns.remote.sort, {
    column: "owner",
    direction: "descending",
  });
  assert.equal(restored.browseLocationsChanged, false);
  assert.throws(() =>
    s.setPaneSort("local", { column: "owner", direction: "ascending" }),
  );
});
