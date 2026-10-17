import { t } from "./i18n.js";
export function normalizeLocalBrowse(path: string): string {
  const value = path.trim().replaceAll("/", "\\");
  if (!/^[A-Za-z]:\\/.test(value) || /[\x00-\x1f]/.test(value))
    throw Error(
      t(
        "ドライブの絶対パスを指定してください（例: C:\\）。C: は使用できません。",
      ),
    );
  const trimmed = value.replace(/\\+$/, "");
  return /^[A-Za-z]:$/.test(trimmed) ? trimmed + "\\" : trimmed;
}

export interface NavigationSnapshot {
  paths: string[];
  cursor: number;
}
export class BrowseHistory {
  private paths: string[] = [];
  private cursor = -1;
  constructor(private limit = 64) {}
  snapshot(): NavigationSnapshot {
    return { paths: [...this.paths], cursor: this.cursor };
  }
  restore(state: NavigationSnapshot) {
    if (
      state.paths.length > this.limit ||
      !Number.isInteger(state.cursor) ||
      state.cursor < -1 ||
      state.cursor >= state.paths.length ||
      (state.paths.length > 0 && state.cursor < 0)
    )
      throw Error("Invalid navigation history");
    this.paths = [...state.paths];
    this.cursor = state.cursor;
  }
  get current() {
    return this.paths[this.cursor];
  }
  get length() {
    return this.paths.length;
  }
  target(direction: -1 | 1) {
    const index = this.cursor + direction;
    return index >= 0 && index < this.paths.length
      ? { path: this.paths[index], index }
      : undefined;
  }
  commit(path: string, index?: number) {
    if (index !== undefined) {
      if (this.paths[index] !== path) throw Error("Navigation history changed");
      this.cursor = index;
    } else if (this.current !== path) {
      this.paths.splice(this.cursor + 1);
      this.paths.push(path);
      if (this.paths.length > this.limit) this.paths.shift();
      this.cursor = this.paths.length - 1;
    }
  }
}
export function parentFolder(
  side: "local" | "remote",
  path: string,
): string | undefined {
  if (side === "remote") {
    if (path === "/") return;
    return path.replace(/\/[^/]+\/?$/, "") || "/";
  }
  const clean = path.replaceAll("/", "\\").replace(/\\$/, "");
  if (/^[A-Za-z]:$/.test(clean)) return;
  const parent = clean.replace(/\\[^\\]+$/, "");
  if (parent === clean || !parent) return;
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}
export function navigationIcon(action: "back" | "forward" | "up" | "refresh") {
  const paths = {
    back: "m9 3-5 5 5 5M4 8h9",
    forward: "m7 3 5 5-5 5M3 8h9",
    up: "m3 9 5-5 5 5M8 4v9",
    refresh: "M13 6a5.3 5.3 0 1 0 .1 4M13 2v4H9",
  };
  return (
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
    paths[action] +
    '"/></svg>'
  );
}
