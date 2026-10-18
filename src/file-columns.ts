import { t, text, html, getLanguage } from "./i18n.js";
import type { Entry, Side, Store } from "./core.js";
import {
  defaultPaneColumns,
  type ColumnId,
  type PaneColumnSettings,
} from "./explorer-preferences.js";

const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const columnLabels: Record<ColumnId, string> = {
  permissions: "権限",
  owner: "所有者",
  name: "名前",
  size: "サイズ",
  type: "種類",
  modified: "更新日時",
};
// Remote is the superset: local intentionally has no Unix metadata columns.
const defaults = defaultPaneColumns().remote.widths;
export function visibleColumns(settings: PaneColumnSettings) {
  return settings.order.filter(
    (id) => id === "name" || !settings.hidden.includes(id),
  );
}
export function columnWidth(settings: PaneColumnSettings, id: ColumnId) {
  const width = settings.widths[id];
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width >= 40 &&
    width <= 1200
    ? width
    : defaults[id]!;
}
export function fileType(entry: Pick<Entry, "name" | "dir">): string {
  if (entry.dir) return t("フォルダー");
  const extension = /\.([^.]+)$/.exec(entry.name)?.[1].toLowerCase();
  if (!extension || entry.name.toLowerCase() === "." + extension)
    return t("ファイル");
  const types: Record<string, string> = {
    txt: "テキスト ドキュメント",
    md: "Markdown ドキュメント",
    html: "HTML ドキュメント",
    htm: "HTML ドキュメント",
    css: "CSS ファイル",
    js: "JavaScript ファイル",
    mjs: "JavaScript ファイル",
    ts: "TypeScript ファイル",
    tsx: "TypeScript JSX ファイル",
    jsx: "JavaScript JSX ファイル",
    json: "JSON ファイル",
    xml: "XML ファイル",
    yaml: "YAML ファイル",
    yml: "YAML ファイル",
    csv: "CSV ファイル",
    pdf: "PDF ドキュメント",
    png: "PNG 画像",
    jpg: "JPEG 画像",
    jpeg: "JPEG 画像",
    gif: "GIF 画像",
    webp: "WebP 画像",
    svg: "SVG 画像",
    zip: "ZIP 圧縮ファイル",
    gz: "GZIP 圧縮ファイル",
    tar: "TAR アーカイブ",
    exe: "アプリケーション",
    dll: "アプリケーション拡張",
    mp3: "MP3 オーディオ",
    mp4: "MP4 ビデオ",
    docx: "Word ドキュメント",
    xlsx: "Excel ワークシート",
  };
  return types[extension]
    ? t(types[extension])
    : text`${extension.toUpperCase()} ファイル`;
}
export function modifiedText(entry: Entry): string {
  if (entry.modifiedAt === undefined || !Number.isFinite(entry.modifiedAt))
    return "";
  const date = new Date(entry.modifiedAt * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(getLanguage() === "en" ? "en-US" : "ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
export interface SortSpec {
  column: ColumnId;
  direction: "ascending" | "descending";
}
export class ColumnSortState {
  private panes: Partial<Record<Side, SortSpec>> = {};
  constructor(initial: Partial<Record<Side, SortSpec>> = {}) {
    for (const side of ["local", "remote"] as const) {
      if (initial[side]) this.set(side, initial[side]!);
    }
  }
  set(side: Side, spec: SortSpec) {
    this.panes[side] = { ...spec };
  }
  get(side: Side) {
    return (
      this.panes[side] ??
      ({ column: "name", direction: "ascending" } as SortSpec)
    );
  }
  toggle(side: Side, column: ColumnId): SortSpec {
    const previous = this.get(side);
    return (this.panes[side] = {
      column,
      direction:
        previous?.column === column && previous.direction === "ascending"
          ? "descending"
          : "ascending",
    });
  }
}
const collator = new Intl.Collator("ja", {
  numeric: true,
  sensitivity: "base",
});
export function sortedEntries(
  entries: readonly Entry[],
  sort?: SortSpec,
): Entry[] {
  if (!sort) return [...entries];
  const direction = sort.direction === "ascending" ? 1 : -1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = a.entry,
        right = b.entry;
      if (
        sort.column === "name" &&
        sort.direction === "ascending" &&
        left.dir !== right.dir
      )
        return left.dir ? -1 : 1;
      let compared = 0;
      if (
        sort.column === "size" ||
        sort.column === "modified" ||
        sort.column === "permissions"
      ) {
        const x =
          sort.column === "size"
            ? left.size
            : sort.column === "permissions"
              ? left.permissions
              : left.modifiedAt;
        const y =
          sort.column === "size"
            ? right.size
            : sort.column === "permissions"
              ? right.permissions
              : right.modifiedAt;
        const missingX = x === undefined || !Number.isFinite(x);
        const missingY = y === undefined || !Number.isFinite(y);
        if (missingX !== missingY) return missingX ? 1 : -1;
        if (!missingX && !missingY) compared = x! - y!;
      } else {
        if (sort.column === "owner" && (!left.owner || !right.owner)) {
          if (!!left.owner !== !!right.owner) return left.owner ? -1 : 1;
        }
        compared = collator.compare(
          sort.column === "name"
            ? left.name
            : sort.column === "owner"
              ? (left.owner ?? "")
              : fileType(left),
          sort.column === "name"
            ? right.name
            : sort.column === "owner"
              ? (right.owner ?? "")
              : fileType(right),
        );
      }
      return compared * direction || a.index - b.index;
    })
    .map(({ entry }) => entry);
}
export const sortEntries = sortedEntries;
export function reorderedColumns(
  order: readonly ColumnId[],
  source: ColumnId,
  target: ColumnId,
  after = false,
): ColumnId[] {
  if (source === target || !order.includes(source) || !order.includes(target))
    return [...order];
  const result = order.filter((id) => id !== source);
  result.splice(result.indexOf(target) + (after ? 1 : 0), 0, source);
  return result;
}
export function permissionsText(mode?: number): string {
  if (mode === undefined || !Number.isInteger(mode) || mode < 0) return "—";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const chars = bits.map((bit, i) => (mode & bit ? "rwx"[i % 3] : "-"));
  if (mode & 0o4000) chars[2] = mode & 0o100 ? "s" : "S";
  if (mode & 0o2000) chars[5] = mode & 0o010 ? "s" : "S";
  if (mode & 0o1000) chars[8] = mode & 0o001 ? "t" : "T";
  return chars.join("");
}
export function columnsHead(
  side: Side,
  settings: PaneColumnSettings,
  sort?: SortSpec,
) {
  const ids = visibleColumns(settings);
  return `<colgroup>${ids.map((id) => `<col data-col="${id}">`).join("")}</colgroup><thead><tr>${ids.map((id) => html`<th data-column="${id}" scope="col" aria-sort="${sort?.column === id ? sort.direction : "none"}"><button class="column-heading" data-column-menu="${side}" data-column-sort="${id}" draggable="false" title="${esc(text`${t(columnLabels[id])}: クリックで並べ替え、ドラッグで列を移動、右クリックで表示設定`)}" aria-label="${esc(text`${side === "local" ? t("ローカル") : t("リモート")}の${t(columnLabels[id])}で並べ替え`)}">${t(columnLabels[id])}${sort?.column === id ? `<span data-sort-indicator aria-hidden="true"> ${sort.direction === "ascending" ? "▲" : "▼"}</span>` : ""}</button><span class="column-resize" data-column-resize="${side}:${id}" role="separator" aria-orientation="vertical" aria-label="${esc(text`${t(columnLabels[id])}の幅`)}" aria-valuemin="40" aria-valuemax="1200" aria-valuenow="${columnWidth(settings, id)}" tabindex="0"></span></th>`).join("")}</tr></thead>`;
}
export function columnsWidth(settings: PaneColumnSettings) {
  return visibleColumns(settings).reduce(
    (sum, id) => sum + columnWidth(settings, id),
    0,
  );
}
export function columnCell(
  id: ColumnId,
  entry: Entry,
  nameHtml: string,
  size: string,
) {
  const value =
    id === "name"
      ? entry.name
      : id === "size"
        ? entry.dir
          ? "—"
          : size
        : id === "type"
          ? fileType(entry)
          : id === "permissions"
            ? permissionsText(entry.permissions)
            : id === "owner"
              ? entry.owner || "—"
              : modifiedText(entry);
  const title =
    id === "permissions" && entry.permissions !== undefined
      ? `${value} (${(entry.permissions & 0o7777).toString(8).padStart(4, "0")})`
      : value;
  return `<td role="gridcell" data-cell="${id}" title="${esc(title)}">${id === "name" ? nameHtml : esc(value)}</td>`;
}

let menu: HTMLElement | undefined;
let suppressClickUntil = 0;
export function closeColumnMenu() {
  menu?.remove();
  menu = undefined;
}
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (event) => {
    if (
      menu &&
      event.target instanceof Element &&
      !event.target.closest("#column-menu,[data-column-menu]")
    )
      closeColumnMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (menu && event.key === "Escape") {
      event.preventDefault();
      closeColumnMenu();
    }
  });
}

export function bindColumns(
  store: Store,
  persist: () => Promise<void>,
  render: () => void,
  report: (error: unknown) => void,
  setDragging: (value: boolean, cancel?: () => void) => void,
  sorting?: {
    get(side: Side): SortSpec | undefined;
    toggle(side: Side, column: ColumnId): void;
  },
) {
  const save = () => void persist().catch(report);
  // Release CSP rejects style attributes parsed from markup. Apply all saved
  // widths through CSSOM whenever render replaces the table DOM.
  for (const side of ["local", "remote"] as const) {
    const table = document.querySelector<HTMLTableElement>(
      `[data-list="${side}"] table`,
    );
    if (!table) continue;
    const settings = store.paneColumns[side];
    table.style.width = columnsWidth(settings) + "px";
    for (const id of visibleColumns(settings)) {
      const column = table.querySelector<HTMLTableColElement>(
        `col[data-col="${id}"]`,
      );
      if (column) column.style.width = columnWidth(settings, id) + "px";
    }
  }
  const open = (side: Side, x: number, y: number) => {
    closeColumnMenu();
    const settings = store.paneColumns[side];
    menu = document.createElement("section");
    menu.id = "column-menu";
    menu.className = "column-menu";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", t("列の表示と順序"));
    document.body.append(menu);
    const paint = () => {
      menu!.innerHTML = html`<header>
          <strong>列の表示</strong
          ><button data-column-close aria-label="閉じる">×</button>
        </header>
        ${settings.order.map((id) => `<div class="column-option"><label><input type="checkbox" data-column-visible="${id}" ${id === "name" || !settings.hidden.includes(id) ? "checked" : ""} ${id === "name" ? "disabled" : ""}>${t(columnLabels[id])}${id === "name" ? t("（必須）") : ""}</label></div>`).join("")}`;
      menu!.style.left = Math.max(8, Math.min(x, innerWidth - 286)) + "px";
      menu!.style.top = Math.max(8, Math.min(y, innerHeight - 240)) + "px";
      menu!.querySelector<HTMLElement>("[data-column-close]")!.onclick =
        closeColumnMenu;
      menu!.querySelectorAll<HTMLInputElement>("[data-column-visible]").forEach(
        (input) =>
          (input.onchange = () => {
            const id = input.dataset.columnVisible as ColumnId;
            if (id === "name") return;
            settings.hidden = input.checked
              ? settings.hidden.filter((k) => k !== id)
              : [...new Set([...settings.hidden, id])];
            save();
            render();
          }),
      );
    };
    paint();
    menu.querySelector<HTMLElement>("[data-column-close]")!.focus();
  };
  let dragging = false;
  document
    .querySelectorAll<HTMLElement>("[data-column-sort]")
    .forEach((button) => {
      const side = button.dataset.columnMenu as Side,
        id = button.dataset.columnSort as ColumnId;
      const header = button.closest("th")!;
      button.onclick = (event) => {
        event.stopPropagation();
        if (dragging || performance.now() < suppressClickUntil) return;
        closeColumnMenu();
        sorting?.toggle(side, id);
      };
      header.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        open(side, event.clientX, event.clientY);
      };
      button.onpointerdown = (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const origin = { x: event.clientX, y: event.clientY };
        let active = true;
        const finish = (commit: boolean, e?: PointerEvent) => {
          if (!active) return;
          active = false;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("keydown", key);
          if (!dragging) return;
          dragging = false;
          suppressClickUntil = performance.now() + 400;
          setDragging(false);
          if (commit && e) {
            const target = document
              .elementFromPoint(e.clientX, e.clientY)
              ?.closest<HTMLElement>("th[data-column]");
            if (target?.closest('[data-list="' + side + '"]')) {
              const bounds = target.getBoundingClientRect();
              store.paneColumns[side].order = reorderedColumns(
                store.paneColumns[side].order,
                id,
                target.dataset.column as ColumnId,
                e.clientX > bounds.left + bounds.width / 2,
              );
              save();
              render();
            }
          }
        };
        const move = (e: PointerEvent) => {
          if (e.pointerId !== event.pointerId) return;
          if (
            !dragging &&
            Math.hypot(e.clientX - origin.x, e.clientY - origin.y) >= 5
          ) {
            dragging = true;
            closeColumnMenu();
            setDragging(true, () => finish(false));
          }
          if (dragging) e.preventDefault();
        };
        const up = (e: PointerEvent) => {
          if (e.pointerId === event.pointerId) finish(true, e);
        };
        const cancel = () => finish(false),
          key = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault();
              finish(false);
            }
          };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", key);
      };
    });
  document
    .querySelectorAll<HTMLElement>("[data-column-resize]")
    .forEach((handle) => {
      const [side, id] = handle.dataset.columnResize!.split(":") as [
          Side,
          ColumnId,
        ],
        settings = store.paneColumns[side];
      const apply = (width: number) => {
        const table = handle.closest("table")!;
        table.querySelector<HTMLElement>(`col[data-col="${id}"]`)!.style.width =
          width + "px";
        table.style.width =
          columnsWidth(settings) - columnWidth(settings, id) + width + "px";
        handle.setAttribute("aria-valuenow", String(Math.round(width)));
      };
      handle.onpointerdown = (event) => {
        if (event.button !== 0 || !Number.isFinite(event.clientX)) return;
        event.preventDefault();
        event.stopPropagation();
        closeColumnMenu();
        const original = columnWidth(settings, id),
          start = event.clientX;
        let current = original,
          active = true;
        const finish = (commit: boolean) => {
          if (!active) return;
          active = false;
          handle.onpointermove =
            handle.onpointerup =
            handle.onpointercancel =
            handle.onlostpointercapture =
              null;
          if (handle.hasPointerCapture(event.pointerId))
            handle.releasePointerCapture(event.pointerId);
          apply(commit ? current : original);
          if (commit) settings.widths[id] = current;
          setDragging(false);
          if (commit) save();
        };
        setDragging(true, () => finish(false));
        handle.setPointerCapture(event.pointerId);
        handle.focus({ preventScroll: true });
        handle.onpointermove = (e) => {
          if (!Number.isFinite(e.clientX)) return;
          current = Math.max(
            40,
            Math.min(1200, Math.round(original + e.clientX - start)),
          );
          apply(current);
        };
        handle.onpointerup = () => finish(true);
        handle.onpointercancel = handle.onlostpointercapture = () =>
          finish(false);
      };
      handle.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const width =
          event.key === "Home"
            ? defaults[id]!
            : Math.max(
                40,
                Math.min(
                  1200,
                  columnWidth(settings, id) +
                    (event.key === "ArrowLeft" ? -10 : 10),
                ),
              );
        apply(width);
        settings.widths[id] = width;
        save();
      };
    });
}
