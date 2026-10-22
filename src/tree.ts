import { t } from "./i18n.js";
import type { Entry, Side } from "./core.js";
import { normalizeLocalBrowse } from "./navigation.js";
import { compareNames } from "./name-order.js";
export const PC_ROOT = "@pc";
export interface TreeSnapshot {
  root: string;
  key: string;
  expanded: string[];
}
export interface TreeChild {
  path: string;
  name: string;
  hidden?: boolean;
}
const compareChildren = (left: TreeChild, right: TreeChild) =>
  compareNames(left.name, right.name);
export interface TreeNode {
  path: string;
  children: TreeChild[];
  loaded: boolean;
  expanded: boolean;
  loading: boolean;
  error: string;
  limited: boolean;
  request: number;
}
export function supportedName(name: string) {
  return (
    !!name && name !== "." && name !== ".." && !/[\\/\x00-\x1f]/.test(name)
  );
}
export function childPath(side: Side, parent: string, name: string): string {
  if (!supportedName(name)) throw Error(t("無効なフォルダ名です"));
  return parent.replace(/[\\/]$/, "") + (side === "local" ? "\\" : "/") + name;
}
export class FolderTree {
  private nodes = new Map<string, TreeNode>();
  private epoch = 0;
  snapshot(): TreeSnapshot {
    return {
      root: this.root,
      key: this.key,
      expanded: [...this.nodes.values()]
        .filter((n) => n.expanded)
        .map((n) => n.path),
    };
  }
  restore(state: TreeSnapshot) {
    this.reset(state.root, state.key);
    for (const path of state.expanded) {
      // Rebuild visible ancestry without retaining asynchronous request state.
      if (path !== PC_ROOT) this.record(path, []);
      this.node(path).expanded = true;
    }
    for (const node of this.nodes.values()) {
      node.loaded = false;
      node.loading = false;
      node.request = 0;
    }
  }
  constructor(
    public side: Side,
    public root: string,
    public key = "",
  ) {
    this.node(root);
  }
  private id(path: string) {
    return this.side === "local"
      ? path === PC_ROOT
        ? PC_ROOT
        : normalizeLocalBrowse(path).toLowerCase()
      : path.replace(/\/$/, "") || "/";
  }
  peek(path: string) {
    return this.nodes.get(this.id(path));
  }
  invalidateSubtree(path: string, clearChildren = false) {
    const root = this.id(path),
      sep = this.side === "local" ? "\\" : "/";
    const expanded: string[] = [];
    for (const [id, node] of this.nodes) {
      if (id !== root && !id.startsWith(root.replace(/[\\/]$/, "") + sep))
        continue;
      node.loaded = false;
      node.loading = false;
      node.request++;
      if (clearChildren) { node.children = []; node.error = ""; node.limited = false; }
      if (node.expanded) expanded.push(node.path);
    }
    return expanded;
  }
  node(path: string): TreeNode {
    const id = this.id(path);
    let node = this.nodes.get(id);
    if (!node) {
      if (this.nodes.size >= 256)
        throw Error(t("ツリーの表示上限です。フォルダを開き直してください"));
      node = {
        path,
        children: [],
        loaded: false,
        expanded: false,
        loading: false,
        error: "",
        limited: false,
        request: 0,
      };
      this.nodes.set(id, node);
    }
    return node;
  }
  reset(root: string, key = this.key) {
    this.epoch++;
    this.nodes.clear();
    this.root = root;
    this.key = key;
    this.node(root);
  }
  begin(path: string) {
    const n = this.node(path);
    n.loading = true;
    n.error = "";
    return { epoch: this.epoch, request: ++n.request };
  }
  current(path: string, token: { epoch: number; request: number }) {
    return (
      token.epoch === this.epoch && this.peek(path)?.request === token.request
    );
  }
  record(path: string, entries: Entry[]) {
    if (this.side === "local" && this.root === PC_ROOT) {
      const match = /^([A-Za-z]:)[\\/]/.exec(path);
      if (!match)
        throw Error(t("PC ツリーではドライブの絶対パスを指定してください"));
      const drive = match[1].toUpperCase() + "\\";
      const pc = this.node(PC_ROOT);
      if (!pc.children.some((c) => this.id(c.path) === this.id(drive)))
        pc.children.push({ path: drive, name: drive.slice(0, 2) });
      let parent = drive;
      for (const name of path.slice(3).split(/[\\/]/).filter(Boolean)) {
        const next = childPath("local", parent, name),
          node = this.node(parent);
        if (!node.children.some((c) => this.id(c.path) === this.id(next))) {
          node.children.push({ path: next, name });
          node.children.sort(compareChildren);
        }
        parent = next;
      }
      this.recordChildren(path, entries);
      return;
    }
    const rootId = this.id(this.root),
      id = this.id(path),
      sep = this.side === "local" ? "\\" : "/";
    if (id !== rootId && !id.startsWith(rootId.replace(/[\\/]$/, "") + sep))
      this.reset(path);
    const rest = path
      .slice(this.root.replace(/[\\/]$/, "").length)
      .replace(/^[\\/]/, "");
    let parent = this.root;
    if (this.id(path) !== this.id(this.root))
      for (const name of rest.split(/[\\/]/).filter(Boolean)) {
        const next = childPath(this.side, parent, name),
          node = this.node(parent);
        if (!node.children.some((c) => this.id(c.path) === this.id(next))) {
          node.children.push({ path: next, name });
          node.children.sort(compareChildren);
        }
        parent = next;
      }
    this.recordChildren(path, entries);
  }
  setDrives(drives: TreeChild[]) {
    const node = this.node(PC_ROOT);
    node.children = drives
      .filter((d) => /^[A-Za-z]:[\\/]$/.test(d.path))
      .map((d) => ({ ...d }));
    node.loaded = true;
    node.loading = false;
    node.error = "";
  }
  private recordChildren(path: string, entries: Entry[]) {
    const node = this.node(path);
    // A completed listing supersedes older lazy reads of the same folder.
    node.request++;
    const children: TreeChild[] = [];
    for (const entry of entries)
      if (entry.dir) {
        try {
          const next = childPath(this.side, path, entry.name);
          if (!children.some((c) => this.id(c.path) === this.id(next)))
            children.push({
              path: next,
              name: entry.name,
              hidden: !!entry.hidden,
            });
        } catch {
          /* Never turn a server entry into traversal. */
        }
      }
    node.children = children.sort(compareChildren).slice(0, 500);
    node.limited = children.length > 500;
    node.loaded = true;
    node.loading = false;
    node.error = "";
  }
}
