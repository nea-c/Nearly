import test from "node:test";
import assert from "node:assert/strict";
import { sortedEntries, ColumnSortState } from "../.test-build/file-columns.js";
import { FolderTree, supportedName } from "../.test-build/tree.js";

const ascending = { column: "name", direction: "ascending" };
const descending = { column: "name", direction: "descending" };
const entry = (name, dir = true, extra = {}) => ({
  name,
  dir,
  size: 0,
  ...extra,
});
const names = (entries) => entries.map((e) => e.name);
const fixture = ["a", "_test", "10", ".git", "2"].map((n) => entry(n));
const expected = [".git", "_test", "2", "10", "a"];

// Catches missing prefix priority, descending reversal, or pane-dependent order.
test("both panes prioritize dot and underscore names and reverse name order consistently", () => {
  const state = new ColumnSortState();
  for (const side of ["local", "remote"]) {
    assert.deepEqual(names(sortedEntries(fixture, state.get(side))), expected);
    assert.deepEqual(
      names(sortedEntries(fixture, state.toggle(side, "name"))),
      [...expected].reverse(),
    );
  }
  assert.deepEqual(names(fixture), ["a", "_test", "10", ".git", "2"]);
});

// Catches replacing natural collation, losing stable ties, or moving folder grouping.
test("prefix groups retain natural numbers, case and Japanese ties, identities and folder priority", () => {
  const input = [
    "file10",
    "FILE2",
    "file2",
    "\u304210",
    "\u30422",
    "\u30a22",
    "_dir10",
    "_dir2",
    ".dir10",
    ".dir2",
  ].map((n) => entry(n));
  assert.deepEqual(names(sortedEntries(input, ascending)), [
    ".dir2",
    ".dir10",
    "_dir2",
    "_dir10",
    "FILE2",
    "file2",
    "file10",
    "\u30422",
    "\u30a22",
    "\u304210",
  ]);
  assert.equal(sortedEntries(input, ascending)[4], input[1]);
  const mixed = [
    entry(".file", false),
    entry("_dir"),
    entry("a"),
    entry("z", false),
  ];
  assert.deepEqual(names(sortedEntries(mixed, ascending)), [
    "_dir",
    "a",
    ".file",
    "z",
  ]);
  assert.deepEqual(names(sortedEntries(mixed, descending)), [
    "z",
    "a",
    "_dir",
    ".file",
  ]);
});

// Catches accidental reuse of prefix priority for metadata columns or no-sort input.
test("other columns and unsorted input retain their existing rules", () => {
  const input = [
    entry(".x", false, { size: 2, owner: ".owner", modifiedAt: 2 }),
    entry("_x", true, { size: 1, owner: "_owner", modifiedAt: 1 }),
  ];
  for (const column of ["size", "modified", "owner"]) {
    assert.deepEqual(
      names(sortedEntries(input, { column, direction: "ascending" })),
      ["_x", ".x"],
    );
  }
  assert.deepEqual(sortedEntries(input), input);
  assert.notEqual(sortedEntries(input), input);
  assert.equal(supportedName(".."), false);
  assert.equal(supportedName("."), false);
});

// Catches a pair-only exception that cycles through hyphen or other punctuation.
test("name comparison is antisymmetric and transitive across symbols and collation ties", async () => {
  const { compareNames } = await import("../.test-build/name-order.js");
  const sample = [
    ".x",
    "_x",
    "-x",
    "!x",
    " x",
    "@x",
    "a",
    "A",
    "2",
    "02",
    "10",
    ".2",
    ".10",
    "_2",
    "_10",
    "\u30422",
    "\u30a22",
    "\u304210",
    "a.b",
    "a_b",
  ];
  assert.deepEqual([...sample.slice(0, 8)].sort(compareNames), [
    ".x",
    "_x",
    " x",
    "-x",
    "!x",
    "@x",
    "a",
    "A",
  ]);
  for (const a of sample) {
    assert.equal(compareNames(a, a), 0);
    for (const b of sample) {
      assert.equal(
        Math.sign(compareNames(a, b)) + Math.sign(compareNames(b, a)),
        0,
        `${a}, ${b}`,
      );
      for (const c of sample) {
        if (compareNames(a, b) <= 0 && compareNames(b, c) <= 0) {
          assert.ok(compareNames(a, c) <= 0, `${a} <= ${b} <= ${c}`);
        }
      }
    }
  }
});

// Catches tree dependence on backend order, user column sorting, or refresh path.
test("local and remote trees keep ascending names across normal loads and sorted refreshes", () => {
  for (const [side, root] of [
    ["local", "C:\\fixture"],
    ["remote", "/fixture"],
  ]) {
    const tree = new FolderTree(side, root);
    const input = [...fixture, entry(".."), entry("."), entry(".file", false)];
    tree.node(root).expanded = true;
    for (const entries of [
      input,
      sortedEntries(input, ascending),
      sortedEntries(input, descending),
      [...input].reverse(),
    ]) {
      tree.record(root, entries);
      assert.deepEqual(names(tree.peek(root).children), expected);
      assert.equal(tree.peek(root).expanded, true);
    }
  }
});

// Catches truncating before sorting and changing limit/limited/hidden metadata.
test("tree sorts before the 500-folder limit and preserves hidden metadata", () => {
  for (const [side, root] of [
    ["local", "C:\\fixture"],
    ["remote", "/fixture"],
  ]) {
    const tree = new FolderTree(side, root);
    const input = Array.from({ length: 500 }, (_, i) => entry(`dir${500 - i}`));
    tree.record(root, [
      ...input,
      entry("_last"),
      entry(".last", true, { hidden: true }),
    ]);
    const node = tree.peek(root);
    assert.equal(node.children.length, 500);
    assert.equal(node.limited, true);
    assert.deepEqual(names(node.children).slice(0, 4), [
      ".last",
      "_last",
      "dir1",
      "dir2",
    ]);
    assert.equal(node.children[0].hidden, true);
    assert.equal(node.children.at(-1).name, "dir498");
    tree.record(root, input);
    assert.equal(node.limited, false);
    assert.equal(node.children.at(-1).name, "dir500");
  }
});

// Catches newly discovered ancestry bypassing recordChildren's sorted order.
test("navigation and restored ancestry keep sibling names sorted without reordering drive roots", () => {
  for (const [side, root, sep] of [
    ["remote", "/", "/"],
    ["local", "@pc", "\\"],
  ]) {
    const tree = new FolderTree(side, root);
    const parent = side === "local" ? "C:\\" : "/";
    for (const name of ["a", "_test", ".git", "10", "2"])
      tree.record(parent + name + sep + "child", []);
    assert.deepEqual(names(tree.peek(parent).children), expected);
    const restored = new FolderTree(side, root);
    tree.node(parent + ".git").expanded = true;
    restored.restore(tree.snapshot());
    assert.equal(restored.peek(parent + ".git").expanded, true);
    if (side === "local") {
      tree.setDrives([
        { name: "D:", path: "D:\\" },
        { name: "C:", path: "C:\\" },
      ]);
      assert.deepEqual(names(tree.peek("@pc").children), ["D:", "C:"]);
    }
  }
});
