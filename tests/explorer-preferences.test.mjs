import test from "node:test";
import assert from "node:assert/strict";
import { Store, connectionKey } from "../.test-build/core.js";
import {
  localFolder,
  text,
  validateConnectionKey,
} from "../.test-build/explorer-preferences.js";
const profile = {
  id: "p",
  name: "Fixture",
  host: "example.invalid",
  port: 22,
  user: "me",
  auth: "key",
  mode: "sftp",
  keyFile: "fixture.ppk",
  hostKey: "SHA256:fixture",
};
test("UTF16 limits, lone surrogates and control characters match native validation", () => {
  const s = new Store();
  assert.equal(
    s.saveFolderBookmark(profile, {
      name: "😀".repeat(50),
      local: "C:\\site",
      remote: "/www",
    }).name.length,
    100,
  );
  for (const name of [
    "😀".repeat(51),
    "😀".repeat(100),
    "\ud800",
    "\udfff",
    "name\u007f",
    "name\u0085",
    "name\u009f",
    "\ufeff",
  ]) {
    assert.throws(() =>
      s.saveFolderBookmark(profile, {
        name,
        local: "C:\\other",
        remote: "/other",
      }),
    );
  }
  assert.equal(text("日".repeat(100), 100).length, 100);
  assert.equal(text("prefix\ufeffsuffix", 100), "prefix\ufeffsuffix");
  assert.throws(() =>
    validateConnectionKey(
      connectionKey({ ...profile, hostKey: "😀".repeat(2100) }),
    ),
  );
  assert.throws(() =>
    validateConnectionKey(connectionKey({ ...profile, user: "\u0085" })),
  );
});
test("bookmarks and pair history bind to immutable endpoint identity, not mutable profile ID", () => {
  const s = new Store({ profiles: [profile] });
  const snapshot = { ...profile };
  s.rememberSyncPair(snapshot, "C:\\Site", "/www");
  const b = s.saveFolderBookmark(snapshot, {
    name: "Site",
    local: "C:\\Site",
    remote: "/www",
  });
  s.saveProfile({ ...profile, host: "different.invalid" });
  assert.notEqual(connectionKey(snapshot), connectionKey(s.profiles[0]));
  assert.equal(s.local(profile.id, "/www"), "");
  assert.equal(s.folderBookmarks[0].connectionKey, connectionKey(snapshot));
  assert.equal(s.folderPairHistory[0].connectionKey, connectionKey(snapshot));
  assert.equal(new Store(s.serialize()).local(profile.id, "/www"), "");
  assert.equal(s.localFor(snapshot, "/www"), "C:\\Site");
  s.rememberSyncPair(snapshot, "C:\\StillOldSession", "/other");
  assert.equal(s.localFor(s.profiles[0], "/other"), "");
  for (const change of [
    { port: 2222 },
    { user: "other" },
    { mode: "mock" },
    { hostKey: "SHA256:other" },
  ])
    assert.notEqual(
      connectionKey(snapshot),
      connectionKey({ ...snapshot, ...change }),
    );
  assert.equal(
    s.saveFolderBookmark(snapshot, {
      name: "Renamed",
      local: "c:/site/",
      remote: "/www/",
    }).id,
    b.id,
  );
  assert.equal(s.folderBookmarks.length, 1);
  s.removeFolderBookmark(b.id);
  assert.equal(s.folderBookmarks.length, 0);
});
test("legacy history remains unverified until explicit registration and name changes preserve identity", () => {
  const s = new Store({
    profiles: [profile],
    history: { [JSON.stringify(["p", "/www"])]: "C:\\Site" },
  });
  assert.equal(s.folderPairHistory.length, 0);
  assert.equal(s.local("p", "/www"), "");
  assert.deepEqual(s.legacyFolderPairs(profile), [
    { local: "C:\\Site", remote: "/www" },
  ]);
  s.rememberSyncPair(profile, "C:\\Site", "/www");
  s.saveProfile({ ...profile, name: "Renamed" });
  assert.equal(s.local("p", "/www"), "C:\\Site");
  s.rememberFolderPair(profile, "c:/site/", "/www/");
  assert.equal(s.folderPairHistory.length, 1);
  const x = s.serialize();
  assert.ok(!JSON.stringify(x.folderBookmarks).includes("fixture.ppk"));
  assert.equal(new Store(x).folderPairHistory.length, 1);
  s.rememberFolderPair(profile, "C:\\BrowseOnly", "/www");
  assert.equal(s.localFor(profile, "/www"), "C:\\Site");
});
test("columns validate independently, require name and preserve other appearance settings", () => {
  const s = new Store({
    theme: "dark",
    localPaneRatio: 0.6,
    localTreeRatio: 0.3,
    remoteTreeRatio: 0.4,
  });
  s.paneColumns.local = {
    order: ["name", "modified", "size", "type"],
    hidden: ["type"],
    widths: { name: 420, size: 80 },
  };
  const r = new Store(s.serialize());
  assert.equal(r.paneColumns.local.widths.name, 420);
  assert.deepEqual(r.paneColumns.remote.order, [
    "name",
    "size",
    "type",
    "modified",
    "permissions",
    "owner",
  ]);
  assert.equal(r.theme, "dark");
  assert.equal(r.localPaneRatio, 0.6);
  assert.equal(r.localTreeRatio, 0.3);
  assert.equal(r.remoteTreeRatio, 0.4);
  for (const bad of [
    { order: ["name", "name", "type", "modified"], hidden: [], widths: {} },
    {
      order: ["name", "size", "type", "modified"],
      hidden: ["name"],
      widths: {},
    },
    {
      order: ["name", "size", "type", "modified"],
      hidden: [],
      widths: { size: Infinity },
    },
    {
      order: ["name", "size", "type", "modified"],
      hidden: [],
      widths: { password: 200 },
    },
  ]) {
    assert.throws(
      () =>
        new Store({
          paneColumns: { local: bad, remote: r.paneColumns.remote },
        }),
    );
  }
});
test("bookmark bounds and pair deduplication are explicit", () => {
  const s = new Store();
  assert.throws(() =>
    s.saveFolderBookmark(profile, { name: "", local: "C:\\a", remote: "/a" }),
  );
  assert.throws(() =>
    s.saveFolderBookmark(profile, {
      name: "bad",
      local: "C:\\a\\..\\b",
      remote: "/a",
    }),
  );
  for (let i = 0; i < 500; i++)
    s.saveFolderBookmark(profile, {
      name: `b${i}`,
      local: `C:\\p${i}`,
      remote: `/p${i}`,
    });
  assert.throws(() =>
    s.saveFolderBookmark(profile, {
      name: "overflow",
      local: "C:\\overflow",
      remote: "/overflow",
    }),
  );
  for (let i = 0; i < 205; i++)
    s.rememberFolderPair(profile, `C:\\h${i}`, `/h${i}`);
  assert.equal(s.folderPairHistory.length, 200);
  const b = s.saveFolderBookmark(profile, {
    id: s.folderBookmarks[0].id,
    name: "Root",
    local: "C:////",
    remote: "/",
  });
  assert.equal(b.local, "C:\\");
  for (const root of ["D:\\", "D:\\\\", "D:\\\\\\", "D:////", "D:/\\/\\"]) {
    assert.equal(localFolder(root), "D:\\");
    assert.equal(localFolder(localFolder(root)), "D:\\");
  }
  assert.throws(() => localFolder("D:"));
});
