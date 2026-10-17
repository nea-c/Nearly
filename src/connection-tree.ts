import { t } from "./i18n.js";
import type { Profile } from "./core.js";
import { text } from "./explorer-preferences.js";
export type ConnectionTreeNode =
  | {
      id: string;
      kind: "group";
      name: string;
      parentId: string | null;
      expanded: boolean;
    }
  | { id: string; kind: "profile"; profileId: string; parentId: string | null };
export interface ConnectionTree {
  version: 1;
  nodes: ConnectionTreeNode[];
}
export const TREE_WARNING =
  "接続先の分類情報を読み込めないため、接続先を一覧で表示しています。元の情報は保持されています。分類を編集して保存すると再作成します。";
export function flatConnectionTree(
  profiles: readonly Profile[],
): ConnectionTree {
  return {
    version: 1,
    nodes: profiles.map((p) => ({
      id: p.id,
      kind: "profile",
      profileId: p.id,
      parentId: null,
    })),
  };
}
export function validateConnectionTree(
  value: unknown,
  profiles: readonly Profile[],
  allowMissing = false,
): ConnectionTree {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid connection tree");
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    Object.keys(v).some((k) => !["version", "nodes"].includes(k)) ||
    !Array.isArray(v.nodes) ||
    v.nodes.length > 400 ||
    profiles.length > 200
  )
    throw Error("Connection tree limits or version invalid");
  const profileIds = new Set(profiles.map((p) => text(p.id, 128)));
  if (profileIds.size !== profiles.length)
    throw Error("Duplicate connection profiles");
  const nodes: ConnectionTreeNode[] = [],
    ids = new Map<string, ConnectionTreeNode>(),
    refs = new Set<string>();
  let groups = 0;
  for (const raw of v.nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Error("Invalid connection tree node");
    const n = raw as Record<string, unknown>;
    const id = text(n.id, 128);
    if (ids.has(id) || !(n.parentId === null || typeof n.parentId === "string"))
      throw Error("Invalid or duplicate connection node");
    if (n.parentId !== null) text(n.parentId, 128);
    let clean: ConnectionTreeNode;
    if (n.kind === "group") {
      if (
        Object.keys(n).some(
          (k) => !["id", "kind", "name", "parentId", "expanded"].includes(k),
        ) ||
        typeof n.expanded !== "boolean" ||
        profileIds.has(id) ||
        ++groups > 200
      )
        throw Error("Invalid connection group");
      clean = {
        id,
        kind: "group",
        name: text(n.name, 100).trim(),
        parentId: n.parentId,
        expanded: n.expanded,
      };
    } else if (n.kind === "profile") {
      if (
        Object.keys(n).some(
          (k) => !["id", "kind", "profileId", "parentId"].includes(k),
        ) ||
        typeof n.profileId !== "string" ||
        n.profileId !== id ||
        !profileIds.has(n.profileId) ||
        refs.has(n.profileId)
      )
        throw Error("Invalid connection profile reference");
      refs.add(n.profileId);
      clean = {
        id,
        kind: "profile",
        profileId: n.profileId,
        parentId: n.parentId,
      };
    } else throw Error("Unknown connection node kind");
    ids.set(id, clean);
    nodes.push(clean);
  }
  for (const n of nodes) {
    let at: ConnectionTreeNode | undefined = n,
      depth = 0;
    const seen = new Set<string>();
    while (at) {
      if (seen.has(at.id) || ++depth > 8)
        throw Error("Connection tree cycle or depth exceeds 8");
      seen.add(at.id);
      if (at.parentId === null) break;
      const parent = ids.get(at.parentId);
      if (!parent || parent.kind !== "group")
        throw Error("Connection parent is not a group");
      at = parent;
    }
  }
  if (refs.size !== profileIds.size) {
    if (!allowMissing)
      throw Error("A connection profile is missing from the tree");
    for (const p of profiles)
      if (!refs.has(p.id))
        nodes.push({
          id: p.id,
          kind: "profile",
          profileId: p.id,
          parentId: null,
        });
  }
  if (nodes.length > 400) throw Error("Connection tree exceeds 400 nodes");
  return { version: 1, nodes };
}
export class ConnectionTreeEditor {
  tree: ConnectionTree;
  profiles: Profile[];
  constructor(tree: ConnectionTree, profiles: Profile[]) {
    this.profiles = profiles.map((p) => ({ ...p }));
    this.tree = validateConnectionTree(tree, this.profiles);
  }
  private node(id: string) {
    const n = this.tree.nodes.find((n) => n.id === id);
    if (!n) throw Error("Connection node not found");
    return n;
  }
  private fresh(used: Set<string>) {
    for (let i = 0; i < 16; i++) {
      const id = globalThis.crypto.randomUUID();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw Error("Cannot allocate a unique connection ID");
  }
  create(name: string, parentId: string | null = null) {
    const used = new Set(this.tree.nodes.map((n) => n.id));
    const id = this.fresh(used);
    this.tree.nodes.push({
      id,
      kind: "group",
      name: text(name, 100).trim(),
      parentId,
      expanded: true,
    });
    return id;
  }
  rename(id: string, name: string) {
    const n = this.node(id);
    const value = text(name, 100).trim();
    if (n.kind === "group") n.name = value;
    else {
      const p = this.profiles.find((p) => p.id === n.profileId)!;
      p.name = value;
    }
  }
  expanded(id: string, expanded: boolean) {
    const n = this.node(id);
    if (n.kind !== "group" || typeof expanded !== "boolean")
      throw Error("Select a connection group");
    n.expanded = expanded;
  }
  move(id: string, parentId: string | null, beforeId: string | null = null) {
    const n = this.node(id);
    if (parentId === id || beforeId === id)
      throw Error("A connection node cannot move into itself");
    if (parentId !== null && this.node(parentId).kind !== "group")
      throw Error("Select a destination group");
    if (beforeId !== null && this.node(beforeId).parentId !== parentId)
      throw Error("Reorder target must share destination parent");
    this.tree.nodes = this.tree.nodes.filter((x) => x.id !== id);
    n.parentId = parentId;
    const i =
      beforeId === null
        ? this.tree.nodes.length
        : this.tree.nodes.findIndex((x) => x.id === beforeId);
    this.tree.nodes.splice(i, 0, n);
  }
  duplicate(id: string) {
    const root = this.node(id),
      original = [...this.tree.nodes];
    const used = new Set(original.map((n) => n.id));
    const subtree = new Set([id]);
    for (let pass = 0; pass < 8; pass++)
      for (const n of original)
        if (n.parentId !== null && subtree.has(n.parentId)) subtree.add(n.id);
    const added = original.filter((n) => subtree.has(n.id));
    if (
      this.profiles.length + added.filter((n) => n.kind === "profile").length >
        200 ||
      original.length + added.length > 400 ||
      original.filter((n) => n.kind === "group").length +
        added.filter((n) => n.kind === "group").length >
        200
    )
      throw Error("Connection tree clone exceeds capacity");
    const copiedName = (name: string) => {
      let base = "";
      for (const point of name) {
        if (base.length + point.length > 93) break;
        base += point;
      }
      return text(base + t(" のコピー"), 100);
    };
    const copied: ConnectionTreeNode[] = [];
    const copy = (
      n: ConnectionTreeNode,
      parentId: string | null,
      rootCopy: boolean,
    ): string => {
      const fresh = this.fresh(used);
      if (n.kind === "group") {
        copied.push({
          ...n,
          id: fresh,
          parentId,
          name: rootCopy ? copiedName(n.name) : n.name,
        });
        for (const child of original.filter((c) => c.parentId === n.id))
          copy(child, fresh, false);
      } else {
        const p = this.profiles.find((p) => p.id === n.profileId)!;
        const profile: Profile = {
          id: fresh,
          name: copiedName(p.name),
          host: p.host,
          port: p.port,
          user: p.user,
          auth: "key",
          mode: p.mode,
          keyFile: p.keyFile,
          hostKey: p.hostKey,
        };
        this.profiles.push(profile);
        copied.push({ id: fresh, kind: "profile", profileId: fresh, parentId });
      }
      return fresh;
    };
    const newId = copy(root, root.parentId, true);
    this.tree.nodes.splice(
      this.tree.nodes.findIndex((n) => n.id === id) + 1,
      0,
      ...copied,
    );
    return newId;
  }
  dissolve(id: string) {
    const group = this.node(id);
    if (group.kind !== "group") throw Error("Select a connection group");
    const children = this.tree.nodes
      .filter((n) => n.parentId === id)
      .map((n) => ({ ...n, parentId: group.parentId }));
    const index = this.tree.nodes
      .slice(
        0,
        this.tree.nodes.findIndex((n) => n.id === id),
      )
      .filter((n) => n.parentId !== id).length;
    this.tree.nodes = this.tree.nodes.filter(
      (n) => n.id !== id && n.parentId !== id,
    );
    this.tree.nodes.splice(index, 0, ...children);
  }
  remove(id: string) {
    const node = this.node(id);
    if (node.kind === "group") this.dissolve(id);
    else {
      this.profiles = this.profiles.filter((p) => p.id !== node.profileId);
      this.tree.nodes = this.tree.nodes.filter((n) => n.id !== id);
    }
  }
  finish() {
    this.tree = validateConnectionTree(this.tree, this.profiles);
    return this;
  }
}
