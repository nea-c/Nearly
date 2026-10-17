import type { Profile } from "./core.js";
export type ColumnId =
  "name" | "size" | "type" | "modified" | "permissions" | "owner";
export interface PaneSort {
  column: ColumnId;
  direction: "ascending" | "descending";
}
export interface PaneColumnSettings {
  order: ColumnId[];
  hidden: ColumnId[];
  widths: Partial<Record<ColumnId, number>>;
  sort?: PaneSort;
}
export interface PaneColumns {
  local: PaneColumnSettings;
  remote: PaneColumnSettings;
}
export interface FolderBookmark {
  id: string;
  name: string;
  connectionKey: string;
  local: string;
  remote: string;
}
export interface FolderPairHistoryEntry {
  connectionKey: string;
  local: string;
  remote: string;
  openedAt: number;
}
export const COLUMN_IDS: readonly ColumnId[] = [
  "name",
  "size",
  "type",
  "modified",
  "permissions",
  "owner",
];
export function defaultPaneColumns(): PaneColumns {
  const pane = (): PaneColumnSettings => ({
    order: [...COLUMN_IDS],
    hidden: ["permissions", "owner"],
    widths: {
      name: 280,
      size: 100,
      type: 100,
      modified: 170,
      permissions: 120,
      owner: 120,
    },
    sort: { column: "name", direction: "ascending" },
  });
  const local = pane();
  local.order = local.order.filter(
    (id) => id !== "permissions" && id !== "owner",
  );
  local.hidden = [];
  delete local.widths.permissions;
  delete local.widths.owner;
  return { local, remote: pane() };
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid explorer preferences");
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw Error("Unknown explorer preference field");
}
export function text(v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\u0000-\u001f\u007f-\u009f]/.test(v) ||
    /[\ud800-\udfff]/u.test(v)
  )
    throw Error("Invalid explorer preference text");
  return v;
}
export function connectionKey(p: Profile): string {
  return JSON.stringify([
    p.id,
    p.mode,
    p.host.trim().toLowerCase(),
    p.port,
    p.user,
    p.hostKey.trim(),
  ]);
}
export function validateConnectionKey(v: unknown): string {
  const key = text(v, 8192);
  if (new TextEncoder().encode(key).length > 8192)
    throw Error("Bookmark connection identity exceeds 8192 bytes");
  let a: unknown;
  try {
    a = JSON.parse(key);
  } catch {
    throw Error("Invalid bookmark connection identity");
  }
  if (
    !Array.isArray(a) ||
    a.length !== 6 ||
    typeof a[0] !== "string" ||
    !a[0].trim() ||
    !["mock", "sftp"].includes(a[1]) ||
    typeof a[2] !== "string" ||
    !a[2] ||
    a[2] !== a[2].trim().toLowerCase() ||
    !Number.isInteger(a[3]) ||
    a[3] < 1 ||
    a[3] > 65535 ||
    typeof a[4] !== "string" ||
    !a[4].trim() ||
    typeof a[5] !== "string" ||
    a[5] !== a[5].trim() ||
    a.some(
      (x) =>
        typeof x === "string" &&
        (/[\u0000-\u001f\u007f-\u009f]/.test(x) || /[\ud800-\udfff]/u.test(x)),
    )
  )
    throw Error("Invalid bookmark connection identity");
  return JSON.stringify(a);
}
export function localFolder(v: unknown): string {
  const path = text(v, 4096).replaceAll("/", "\\");
  if (
    !/^[a-zA-Z]:\\/.test(path) ||
    path.split("\\").some((part) => part === ".." || part === ".") ||
    /[<>"|?*]/.test(path) ||
    path.slice(2).includes(":")
  )
    throw Error("Use an absolute local drive folder");
  const normalized = path.replace(/\\+/g, "\\").replace(/\\+$/, "");
  return normalized.length === 2 ? normalized + "\\" : normalized;
}
export function remoteFolder(v: unknown): string {
  const path = text(v, 4096);
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === ".")
  )
    throw Error("Use an absolute remote folder without traversal");
  return "/" + path.split("/").filter(Boolean).join("/");
}
export function pairKey(p: {
  connectionKey: string;
  local: string;
  remote: string;
}): string {
  return JSON.stringify([
    p.connectionKey,
    localFolder(p.local).toLowerCase(),
    remoteFolder(p.remote),
  ]);
}
export function validateBookmark(value: unknown): FolderBookmark {
  const v = object(value);
  keys(v, ["id", "name", "connectionKey", "local", "remote"]);
  return {
    id: text(v.id, 128),
    name: text(v.name, 100).trim(),
    connectionKey: validateConnectionKey(v.connectionKey),
    local: localFolder(v.local),
    remote: remoteFolder(v.remote),
  };
}
export function validatePair(value: unknown): FolderPairHistoryEntry {
  const v = object(value);
  keys(v, ["connectionKey", "local", "remote", "openedAt"]);
  if (
    typeof v.openedAt !== "number" ||
    !Number.isSafeInteger(v.openedAt) ||
    v.openedAt < 0
  )
    throw Error("Invalid folder history timestamp");
  return {
    connectionKey: validateConnectionKey(v.connectionKey),
    local: localFolder(v.local),
    remote: remoteFolder(v.remote),
    openedAt: v.openedAt,
  };
}
export function validatePaneColumns(
  value: unknown,
  recoverNullWidths = false,
): PaneColumns {
  const both = object(value);
  keys(both, ["local", "remote"]);
  function pane(value: unknown): PaneColumnSettings {
    const v = object(value);
    keys(v, ["order", "hidden", "widths", "sort"]);
    if (
      !Array.isArray(v.order) ||
      ![4, 6].includes(v.order.length) ||
      new Set(v.order).size !== v.order.length ||
      (v.order.length === 4 &&
        v.order.some((k) => k === "permissions" || k === "owner")) ||
      v.order.some((k) => !COLUMN_IDS.includes(k)) ||
      !Array.isArray(v.hidden) ||
      new Set(v.hidden).size !== v.hidden.length ||
      v.hidden.some((k) => k === "name" || !COLUMN_IDS.includes(k))
    )
      throw Error("Invalid column order or required name visibility");
    const widths = { ...object(v.widths) };
    keys(widths, [...COLUMN_IDS]);
    if (recoverNullWidths)
      for (const id of Object.keys(widths))
        if (widths[id] === null) delete widths[id];
    if (
      Object.values(widths).some(
        (n) =>
          typeof n !== "number" || !Number.isFinite(n) || n < 40 || n > 1200,
      )
    )
      throw Error("Column widths must be between 40 and 1200 pixels");
    const sort =
      v.sort === undefined
        ? { column: "name", direction: "ascending" }
        : object(v.sort);
    keys(sort, ["column", "direction"]);
    if (
      !COLUMN_IDS.includes(sort.column as ColumnId) ||
      !["ascending", "descending"].includes(sort.direction as string)
    )
      throw Error("Invalid column sorting preference");
    return {
      order:
        v.order.length === 4
          ? [...v.order, "permissions", "owner"]
          : [...v.order],
      hidden:
        v.order.length === 4
          ? [...new Set([...v.hidden, "permissions", "owner"])]
          : [...v.hidden],
      widths: { ...widths },
      sort: { column: sort.column, direction: sort.direction },
    } as PaneColumnSettings;
  }
  const local = pane(both.local);
  local.order = local.order.filter(
    (id) => id !== "permissions" && id !== "owner",
  );
  local.hidden = local.hidden.filter(
    (id) => id !== "permissions" && id !== "owner",
  );
  delete local.widths.permissions;
  delete local.widths.owner;
  if (local.sort?.column === "permissions" || local.sort?.column === "owner")
    throw Error("Local sorting column is unsupported");
  return { local, remote: pane(both.remote) };
}
export function validateCollection<T>(
  v: unknown,
  validate: (v: unknown) => T,
  limit = 200,
): T[] {
  if (!Array.isArray(v) || v.length > limit)
    throw Error(`Explorer collection is limited to ${limit} entries`);
  return v.map(validate);
}
