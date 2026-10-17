import type { FolderBookmark } from "./explorer-preferences.js";
import { text, validateConnectionKey } from "./explorer-preferences.js";
export type BookmarkTreeNode =
  | {
      id: string;
      kind: "group";
      connectionKey: string;
      name: string;
      parentId: string | null;
    }
  | {
      id: string;
      kind: "bookmark";
      bookmarkId: string;
      connectionKey: string;
      parentId: string | null;
    };
export interface BookmarkTree {
  version: 1;
  nodes: BookmarkTreeNode[];
}
/** Delete saved navigation metadata only; organizer folders promote their children. */
export function deleteBookmarkMetadata(
  store: {
    bookmarkTree: BookmarkTree;
    removeFolderBookmark(id: string): void;
    ungroupBookmarkFolder(key: string, id: string): void;
  },
  key: string,
  id: string,
) {
  key = validateConnectionKey(key);
  const node = store.bookmarkTree.nodes.find((n) => n.id === id);
  if (!node || node.connectionKey !== key)
    throw Error("Bookmark belongs to another connection or no longer exists");
  if (node.kind === "group") store.ungroupBookmarkFolder(key, id);
  else store.removeFolderBookmark(node.bookmarkId);
}
export const BOOKMARK_TREE_WARNING =
  "ブックマークの分類情報を読み込めないため、フォルダー分けせず表示しています。元の分類情報は保持されています。分類を編集して保存すると再作成します。";
export function flatBookmarkTree(
  bookmarks: readonly FolderBookmark[],
): BookmarkTree {
  return {
    version: 1,
    nodes: bookmarks.map((b) => ({
      id: b.id,
      kind: "bookmark",
      bookmarkId: b.id,
      connectionKey: b.connectionKey,
      parentId: null,
    })),
  };
}
export function validateBookmarkTree(
  value: unknown,
  bookmarks: readonly FolderBookmark[],
  allowMissing = false,
): BookmarkTree {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid bookmark tree");
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    Object.keys(v).some((k) => !["version", "nodes"].includes(k)) ||
    !Array.isArray(v.nodes) ||
    v.nodes.length > 700 ||
    bookmarks.length > 500
  )
    throw Error("Bookmark tree count or version invalid");
  const saved = new Map(bookmarks.map((b) => [b.id, b]));
  if (saved.size !== bookmarks.length) throw Error("Duplicate bookmarks");
  const ids = new Map<string, BookmarkTreeNode>(),
    refs = new Set<string>(),
    nodes: BookmarkTreeNode[] = [];
  let groups = 0;
  for (const raw of v.nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Error("Invalid bookmark node");
    const n = raw as Record<string, unknown>;
    const id = text(n.id, 128),
      key = validateConnectionKey(n.connectionKey);
    if (ids.has(id) || !(n.parentId === null || typeof n.parentId === "string"))
      throw Error("Duplicate or invalid bookmark node");
    if (n.parentId !== null) text(n.parentId, 128);
    let clean: BookmarkTreeNode;
    if (n.kind === "group") {
      if (
        ++groups > 200 ||
        saved.has(id) ||
        Object.keys(n).some(
          (k) =>
            !["id", "kind", "connectionKey", "name", "parentId"].includes(k),
        )
      )
        throw Error("Invalid bookmark group");
      clean = {
        id,
        kind: "group",
        connectionKey: key,
        name: text(n.name, 100).trim(),
        parentId: n.parentId,
      };
    } else if (n.kind === "bookmark") {
      if (
        n.bookmarkId !== id ||
        saved.get(id)?.connectionKey !== key ||
        refs.has(id) ||
        Object.keys(n).some(
          (k) =>
            !["id", "kind", "connectionKey", "bookmarkId", "parentId"].includes(
              k,
            ),
        )
      )
        throw Error("Invalid bookmark reference or connection scope");
      refs.add(id);
      clean = {
        id,
        kind: "bookmark",
        connectionKey: key,
        bookmarkId: id,
        parentId: n.parentId,
      };
    } else throw Error("Unknown bookmark node kind");
    ids.set(id, clean);
    nodes.push(clean);
  }
  for (const n of nodes) {
    let at = n,
      depth = 0;
    const seen = new Set<string>();
    while (true) {
      if (++depth > 8 || seen.has(at.id))
        throw Error("Bookmark cycle or depth exceeds 8");
      seen.add(at.id);
      if (at.parentId === null) break;
      const parent = ids.get(at.parentId);
      if (
        !parent ||
        parent.kind !== "group" ||
        parent.connectionKey !== at.connectionKey
      )
        throw Error("Bookmark parent must be a group on the same connection");
      at = parent;
    }
  }
  if (refs.size !== bookmarks.length) {
    if (!allowMissing) throw Error("Bookmark is missing from the tree");
    for (const b of bookmarks)
      if (!refs.has(b.id))
        nodes.push({
          id: b.id,
          kind: "bookmark",
          bookmarkId: b.id,
          connectionKey: b.connectionKey,
          parentId: null,
        });
  }
  if (nodes.length > 700) throw Error("Bookmark tree exceeds 700 nodes");
  return { version: 1, nodes };
}
export class BookmarkTreeEditor {
  tree: BookmarkTree;
  bookmarks: FolderBookmark[];
  constructor(tree: BookmarkTree, bookmarks: FolderBookmark[]) {
    this.bookmarks = bookmarks.map((b) => ({ ...b }));
    this.tree = validateBookmarkTree(tree, this.bookmarks);
  }
  private node(key: string, id: string) {
    const canonical = validateConnectionKey(key),
      node = this.tree.nodes.find((n) => n.id === id);
    if (!node || node.connectionKey !== canonical)
      throw Error(
        "Bookmark node belongs to another connection or no longer exists",
      );
    return node;
  }
  create(key: string, name: string, parentId: string | null = null) {
    key = validateConnectionKey(key);
    if (parentId !== null && this.node(key, parentId).kind !== "group")
      throw Error("Select a bookmark folder");
    let id = "";
    for (let i = 0; i < 16; i++) {
      const candidate = globalThis.crypto.randomUUID();
      if (!this.tree.nodes.some((n) => n.id === candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw Error("Cannot allocate bookmark group ID");
    this.tree.nodes.push({
      id,
      kind: "group",
      connectionKey: key,
      name: text(name, 100).trim(),
      parentId,
    });
    return id;
  }
  rename(key: string, id: string, name: string) {
    const n = this.node(key, id),
      label = text(name, 100).trim();
    if (n.kind === "group") n.name = label;
    else this.bookmarks.find((b) => b.id === n.bookmarkId)!.name = label;
  }
  move(
    key: string,
    id: string,
    parentId: string | null,
    beforeId: string | null = null,
  ) {
    const n = this.node(key, id);
    if (parentId === id || beforeId === id)
      throw Error("Cannot move a bookmark folder into itself");
    if (parentId !== null && this.node(key, parentId).kind !== "group")
      throw Error("Select a bookmark folder");
    if (beforeId !== null && this.node(key, beforeId).parentId !== parentId)
      throw Error("Bookmark reorder target has another parent");
    this.tree.nodes = this.tree.nodes.filter((n) => n.id !== id);
    n.parentId = parentId;
    this.tree.nodes.splice(
      beforeId === null
        ? this.tree.nodes.length
        : this.tree.nodes.findIndex((n) => n.id === beforeId),
      0,
      n,
    );
  }
  ungroup(key: string, id: string) {
    const g = this.node(key, id);
    if (g.kind !== "group") throw Error("Select a bookmark folder");
    const index = this.tree.nodes
      .slice(
        0,
        this.tree.nodes.findIndex((n) => n.id === id),
      )
      .filter((n) => n.parentId !== id).length;
    const children = this.tree.nodes
      .filter((n) => n.parentId === id)
      .map((n) => ({ ...n, parentId: g.parentId }));
    this.tree.nodes = this.tree.nodes.filter(
      (n) => n.id !== id && n.parentId !== id,
    );
    this.tree.nodes.splice(index, 0, ...children);
  }
  finish() {
    this.tree = validateBookmarkTree(this.tree, this.bookmarks);
    return this;
  }
}
