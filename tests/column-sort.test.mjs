import test from "node:test";
import assert from "node:assert/strict";
import * as columns from "../.test-build/file-columns.js";
import { FileSelection } from "../.test-build/selection.js";
import {
  defaultPaneColumns,
  validatePaneColumns,
} from "../.test-build/explorer-preferences.js";

test("column sorting is independent per pane and toggles only the selected column", () => {
  assert.equal(typeof columns.ColumnSortState, "function");
  const state = new columns.ColumnSortState();
  assert.deepEqual(state.get("local"), {
    column: "name",
    direction: "ascending",
  });
  assert.deepEqual(state.toggle("local", "size"), {
    column: "size",
    direction: "ascending",
  });
  assert.deepEqual(state.toggle("local", "size"), {
    column: "size",
    direction: "descending",
  });
  assert.deepEqual(state.get("remote"), {
    column: "name",
    direction: "ascending",
  });
  assert.deepEqual(state.toggle("remote", "name"), {
    column: "name",
    direction: "descending",
  });
  assert.deepEqual(state.toggle("local", "modified"), {
    column: "modified",
    direction: "ascending",
  });
  assert.equal(state.get("remote").column, "name");
});

test("default name order groups folders first and preserves explicit restored sorting", () => {
  const entries = [
    { name: "a.txt", dir: false, size: 9 },
    { name: "dir10", dir: true, size: 0 },
    { name: "dir2", dir: true, size: 0 },
    { name: "z.txt", dir: false, size: 1 },
  ];
  const state = new columns.ColumnSortState({
    remote: { column: "size", direction: "descending" },
  });
  assert.deepEqual(
    columns.sortEntries(entries, state.get("local")).map((e) => e.name),
    ["dir2", "dir10", "a.txt", "z.txt"],
  );
  assert.deepEqual(state.get("remote"), {
    column: "size",
    direction: "descending",
  });
  assert.deepEqual(
    columns.sortEntries(entries, state.get("remote")).map((e) => e.name),
    ["a.txt", "z.txt", "dir10", "dir2"],
  );
  state.set("remote", { column: "name", direction: "ascending" });
  assert.equal(state.get("remote").column, "name");
});

test("legacy remote metadata without saved widths produces a finite complete table width", () => {
  const old = {
    order: ["name", "size", "type", "modified"],
    hidden: [],
    widths: {},
  };
  const pane = validatePaneColumns({ local: old, remote: old }).remote;
  pane.hidden = [];
  assert.equal(columns.columnWidth(pane, "permissions"), 120);
  assert.equal(columns.columnWidth(pane, "owner"), 120);
  assert.equal(columns.columnsWidth(pane), 890);
  pane.widths.owner = NaN;
  assert.equal(columns.columnsWidth(pane), 890);
});

test("name can move into the middle while first size column can be hidden and reloaded", () => {
  const panes = defaultPaneColumns();
  panes.local.order = columns.reorderedColumns(
    panes.local.order,
    "name",
    "type",
  );
  assert.equal(panes.local.order[0], "size");
  assert.equal(panes.local.order[1], "name");
  panes.local.hidden.push("size");
  const restored = validatePaneColumns(JSON.parse(JSON.stringify(panes)));
  assert.equal(columns.visibleColumns(restored.local)[0], "name");
  assert.ok(!columns.visibleColumns(restored.local).includes("size"));
  assert.deepEqual(restored.remote, panes.remote);
  assert.throws(() =>
    validatePaneColumns({
      ...panes,
      local: { ...panes.local, hidden: ["name"] },
    }),
  );
});

test("legacy four-column settings preserve widths and order while new metadata defaults hidden", () => {
  const old = {
    order: ["size", "name", "modified", "type"],
    hidden: ["size"],
    widths: { name: 333 },
  };
  const panes = validatePaneColumns({ local: old, remote: old });
  assert.deepEqual(panes.local.order, ["size", "name", "modified", "type"]);
  assert.deepEqual(panes.remote.order, [
    "size",
    "name",
    "modified",
    "type",
    "permissions",
    "owner",
  ]);
  assert.deepEqual(panes.local.hidden, ["size"]);
  assert.deepEqual(panes.remote.hidden, ["size", "permissions", "owner"]);
  assert.equal(panes.local.widths.name, 333);
});

test("permission and owner display and sorting handle absent metadata without invented values", () => {
  assert.equal(columns.permissionsText(0o1004755), "rwsr-xr-x");
  assert.equal(columns.permissionsText(0o2010), "-----s---");
  assert.equal(columns.permissionsText(0o1000), "--------T");
  assert.equal(columns.permissionsText(), "—");
  const entries = [
    { name: "a", dir: false, size: 0, owner: "user10", permissions: 0o755 },
    { name: "b", dir: false, size: 0, owner: "user2", permissions: 0o644 },
    { name: "c", dir: false, size: 0 },
  ];
  assert.deepEqual(
    columns
      .sortEntries(entries, { column: "owner", direction: "ascending" })
      .map((e) => e.name),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    columns
      .sortEntries(entries, { column: "permissions", direction: "descending" })
      .map((e) => e.name),
    ["a", "b", "c"],
  );
  assert.match(columns.columnCell("permissions", entries[0], "", ""), /0755/);
  assert.match(columns.columnCell("owner", entries[2], "", ""), /—/);
});

test("natural and numeric sorting preserves object identity, stable ties, and selected names", () => {
  assert.equal(typeof columns.sortedEntries, "function");
  const entries = [
    { name: "file10.txt", dir: false, size: 10, modifiedAt: 20 },
    { name: "file2.txt", dir: false, size: 2, modifiedAt: 3 },
    { name: "FILE2.txt", dir: false, size: 2 },
  ];
  const natural = columns.sortedEntries(entries, {
    column: "name",
    direction: "ascending",
  });
  assert.deepEqual(
    natural.map((e) => e.name),
    ["file2.txt", "FILE2.txt", "file10.txt"],
  );
  assert.equal(natural[0], entries[1]);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["file10.txt", "file2.txt", "FILE2.txt"],
  );
  assert.deepEqual(
    columns
      .sortedEntries(entries, { column: "size", direction: "descending" })
      .map((e) => e.size),
    [10, 2, 2],
  );
  assert.deepEqual(
    columns
      .sortedEntries(entries, { column: "modified", direction: "descending" })
      .map((e) => e.name),
    ["file10.txt", "file2.txt", "FILE2.txt"],
  );
  assert.deepEqual(
    columns
      .sortedEntries(entries, { column: "modified", direction: "ascending" })
      .map((e) => e.name),
    ["file2.txt", "file10.txt", "FILE2.txt"],
  );
  const selection = new FileSelection();
  selection.context(
    "same",
    entries.map((e) => e.name),
  );
  selection.clickName("file2.txt");
  selection.context(
    "same",
    natural.map((e) => e.name),
  );
  assert.deepEqual(selection.values(), ["file2.txt"]);
});

test("headers expose sort direction and column type comparison uses displayed types", () => {
  assert.equal(typeof columns.sortedEntries, "function");
  const entries = [
    { name: "b.txt", dir: false, size: 1 },
    { name: "a.json", dir: false, size: 1 },
  ];
  const sorted = columns.sortedEntries(entries, {
    column: "type",
    direction: "ascending",
  });
  assert.ok(
    columns
      .fileType(sorted[0])
      .localeCompare(columns.fileType(sorted[1]), "ja", {
        numeric: true,
        sensitivity: "base",
      }) <= 0,
  );
  const settings = {
    order: ["name", "size", "type", "modified"],
    hidden: [],
    widths: {},
  };
  const head = columns.columnsHead("local", settings, {
    column: "size",
    direction: "descending",
  });
  assert.match(head, /data-column="size"[^>]*aria-sort="descending"/);
  assert.match(head, /data-sort-indicator/);
});
