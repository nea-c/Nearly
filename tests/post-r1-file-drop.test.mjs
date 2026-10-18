import test from "node:test";
import assert from "node:assert/strict";
globalThis.window = { __TAURI__: { core: { invoke: async () => {} } } };
const drop = await import("../.test-build/file-drop.js");
const { localizeNativeError } = await import("../.test-build/native-errors.js");
const { uploadErrorLiterals, uploadPartialSuffix } =
  await import("../.test-build/translations-native-errors.js");
test("physical coordinates reject invalid scales and convert current DPR", () => {
  assert.deepEqual(drop.physicalToCss({ x: 300, y: 150 }, 1.5), {
    x: 200,
    y: 100,
  });
  for (const scale of [0, -1, NaN, Infinity])
    assert.equal(drop.physicalToCss({ x: 2, y: 3 }, scale), undefined);
  assert.equal(drop.physicalToCss({ x: NaN, y: 3 }, 2), undefined);
});
test("attempted subtree roots are conservative for unknown native types and roots", () => {
  assert.deepEqual(drop.uploadTargets(["C:\\a.txt", "C:\\folder"], "/dest"), [
    "/dest/a.txt",
    "/dest/folder",
  ]);
  assert.deepEqual(drop.uploadTargets(["/", "C:\\"], "/dest"), []);
});
test("upload source sync guard uses Windows containment boundaries in both directions", () => {
  assert.equal(drop.sourcesOverlapSync(["C:\\root\\one"], ["c:/root"]), true);
  assert.equal(drop.sourcesOverlapSync(["C:\\root"], ["C:\\root\\sub"]), true);
  assert.equal(
    drop.sourcesOverlapSync(["C:\\root-other"], ["C:\\root"]),
    false,
  );
});
test("every upload owned diagnostic localizes and nested partial wrapper localizes only complete owned inner messages", () => {
  for (const [ja, en] of uploadErrorLiterals) {
    assert.equal(localizeNativeError(en, "ja"), ja);
    assert.equal(localizeNativeError(ja, "en"), en);
  }
  const [ja, en] = uploadErrorLiterals[0];
  assert.equal(
    localizeNativeError(en + uploadPartialSuffix.en, "ja"),
    ja + uploadPartialSuffix.ja,
  );
  assert.equal(
    localizeNativeError(
      "C:\\Source changed during upload" + uploadPartialSuffix.en,
      "ja",
    ),
    "C:\\Source changed during upload" + uploadPartialSuffix.ja,
  );
});
test("destination requires current model entry, actual workspace list and directory type", () => {
  const host = {
    valid: () => true,
    uploadAllowed: () => true,
    sessionId: "w",
    profile: { mode: "sftp" },
    workspaceId: "w",
    panes: {
      remote: {
        loading: false,
        path: "/root",
        entries: [
          { name: "folder", dir: true },
          { name: "file", dir: false },
        ],
      },
    },
    remoteDirectory: (path) => path === "/real",
  };
  const list = { dataset: { workspace: "w" } };
  const element = (name) => ({
    closest: (selector) =>
      selector.startsWith("thead")
        ? null
        : selector === '[data-list="remote"]'
          ? list
          : selector === "[data-entry]"
            ? { dataset: { name }, hasAttribute: () => false }
            : null,
  });
  assert.equal(drop.remoteDropTarget(host, element("folder")), "/root/folder");
  assert.equal(drop.remoteDropTarget(host, element("file")), undefined);
  assert.equal(drop.remoteDropTarget(host, element("forged")), undefined);
  list.dataset.workspace = "other";
  assert.equal(drop.remoteDropTarget(host, element("folder")), undefined);
});
