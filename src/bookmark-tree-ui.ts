import { bookmarkItemIcon } from './bookmark-item.js';
import { popupBarrier } from './popup-barrier.js';
import { t, text, html, tError } from "./i18n.js";
import type { FolderBookmark } from "./explorer-preferences.js";
import { bindPointerReorder, cancelPointerReorder } from "./pointer-reorder.js";
import {bindBookmarkOverflow,menuKeys,focusBookmarkMenu} from './bookmark-overflow.js';
import {bindBookmarkTooltip,closeBookmarkTooltip} from './bookmark-tooltip.js';

export type BookmarkNode = {
  id: string;
  kind: "group" | "bookmark";
  connectionKey: string;
  parentId: string | null;
  name?: string;
  bookmarkId?: string;
};
export type BookmarkChange =
  | { action: "create"; name: string; parentId: string | null }
  | { action: "rename"; id: string; name: string }
  | {
      action: "move";
      id: string;
      parentId: string | null;
      beforeId: string | null;
    }
  | { action: "ungroup"; id: string }
  | { action: "delete"; id: string };
type Options = {
  nodes: BookmarkNode[];
  bookmarks: FolderBookmark[];
  key: string;
  owner: string;
  busy: () => boolean;
  change: (change: BookmarkChange) => Promise<void>;
  open: (bookmark: FolderBookmark) => void;
  register: (parentId: string | null) => void;
  history: () => void;
  side?: 'local' | 'remote';
  edit?: (bookmark: FolderBookmark, opener: HTMLElement) => void;
  remove?: (bookmark: FolderBookmark, opener: HTMLElement) => void;
  report: (error: unknown) => void;
};
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let popup: HTMLElement | undefined;
let releaseBarrier: (() => void) | undefined;
let contextUnderlay: HTMLElement | undefined;
export function bookmarkContextOpen() { return !!releaseBarrier; }
let popupOwner = "";
let restoreOverflow:(()=>void)|undefined;
let popupAnchor:HTMLElement|undefined;
let popupAnchorOwner="";
let popupReturnRoot: HTMLElement | undefined;
function closeBookmarkTreeAndFocus(){
  const anchor=popupAnchor,owned=!!popupOwner&&popupAnchorOwner===popupOwner;
  closeBookmarkTree();
  if(owned&&anchor?.isConnected&&!anchor.closest('[hidden]')&&!anchor.matches(':disabled'))anchor.focus();
  else if(owned&&popupReturnRoot?.isConnected)popupReturnRoot.focus({preventScroll:true});
}
let menuTimer: ReturnType<typeof setTimeout> | undefined;
const cancelMenuTimer = () => {
  clearTimeout(menuTimer);
  menuTimer = undefined;
};
let dragging: { id: string; key: string; owner: string } | undefined;
const clearIndicators = () =>
  document
    .querySelectorAll("[data-bookmark-drop]")
    .forEach((e) => e.removeAttribute("data-bookmark-drop"));
export function bookmarkTreeDragging() {
  return !!dragging;
}
export function cancelBookmarkTreeDrag() {
  cancelPointerReorder();
  dragging = undefined;
  clearIndicators();
}
export function closeBookmarkTree() {
  releaseBarrier?.(); releaseBarrier = undefined;
  contextUnderlay?.remove(); contextUnderlay = undefined;
  closeBookmarkTooltip();restoreOverflow?.();restoreOverflow=undefined;
  cancelMenuTimer();
  popup?.remove();
  popup = undefined;
  popupOwner = "";
  document.querySelectorAll(".bookmark-bar,.side-bookmark-bar").forEach(bar=>bar.setAttribute("aria-expanded","false"));
  document
    .querySelectorAll("[data-bookmark-group][aria-expanded=true]")
    .forEach((e) => e.setAttribute("aria-expanded", "false"));
  document
    .querySelector("#bookmark-more")
    ?.setAttribute("aria-expanded", "false");

}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelBookmarkTreeDrag();
  if (event.key === "Escape" && popup && !popup.dataset.busy) {
    event.preventDefault();
    closeBookmarkTreeAndFocus();
  }
});
window.addEventListener("blur", cancelBookmarkTreeDrag);
document.addEventListener("pointerdown", (event) => {
  if (
    popup &&
    !releaseBarrier &&
    !popup.matches(".bookmark-tree-overlay") &&
    event.target instanceof Element &&
    !event.target.closest(
      ".bookmark-menu-stack,#bookmark-tree-context,#side-bookmark-context,[data-bookmark-tree-node],[data-bookmark-overflow]",
    )
  )
    closeBookmarkTree();
});

export function bookmarkTreeButtons(
  nodes: BookmarkNode[],
  bookmarks: FolderBookmark[],
  key: string,
  parentId: string | null = null,
  side?: 'local' | 'remote',
) {
  return nodes
    .filter((n) => n.connectionKey === key && n.parentId === parentId)
    .map((n) => {
      const b = bookmarks.find(
        (b) => b.id === n.bookmarkId && b.connectionKey === key,
      );
      if (n.kind === "bookmark" && !b) return "";
      const description=n.kind==='group'?[n.name]:side?[b!.name,t(side==='local'?'ローカル':'リモート'),side==='local'?b!.local:b!.remote]:[b!.name,t('ローカル'),b!.local,t('リモート'),b!.remote];
      return `<button type="button" class="bookmark-tree-item" ${side ? `id="${side}-bookmark-${esc(n.id)}" ${n.kind==='bookmark'?`data-side-open="${esc(n.id)}"`:''}` : ''} draggable="false" data-bookmark-tree-node="${esc(n.id)}" ${n.kind === "group" ? `data-bookmark-group="${esc(n.id)}" aria-haspopup="menu" aria-expanded="false"` : `data-bookmark-open="${esc(b!.id)}"`} data-bookmark-description="${esc(JSON.stringify(description))}">${n.kind === "group" ? '<span class="folder-glyph" aria-hidden="true"></span>' : bookmarkItemIcon}<span class="bookmark-label">${esc(n.kind === "group" ? n.name : b!.name)}</span>${n.kind === "group" ? '<span class="bookmark-arrow" aria-hidden="true">▾</span>' : ""}</button>`;
    })
    .join("");
}

export function bindBookmarkTree(root: HTMLElement, options: Options) {
  options = { ...options, owner: JSON.stringify([options.owner, options.key]) };
  if (popupOwner && popupOwner !== options.owner) closeBookmarkTree();
  if (dragging && dragging.owner !== options.owner) cancelBookmarkTreeDrag();
  const nodes = options.nodes.filter((n) => n.connectionKey === options.key);
  const node = (id: string) => nodes.find((n) => n.id === id);
  const bookmark = (id: string) =>
    options.bookmarks.find(
      (b) => b.id === node(id)?.bookmarkId && b.connectionKey === options.key,
    );
  const name = (id: string) =>
    node(id)?.kind === "group"
      ? (node(id)?.name ?? "")
      : (bookmark(id)?.name ?? "");
  const owned = (view: HTMLElement) =>
    popup === view && popupOwner === options.owner;
  const apply = async (change: BookmarkChange, view?: HTMLElement) => {
    if (options.busy() || view?.dataset.busy) return;
    const startedPopup = popup;
    if (view) {
      view.dataset.busy = "true";
      view
        .querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >("button,input,select")
        .forEach((e) => (e.disabled = true));
    }
    try {
      await options.change(change);
      if (
        view
          ? owned(view)
          : popup === startedPopup && popupOwner === options.owner
      )
        closeBookmarkTree();
    } catch (error) {
      const message = view?.querySelector<HTMLElement>(".form-error");
      if (message)
        message.textContent = tError(error);
      else options.report(error);
    } finally {
      if (view) {
        delete view.dataset.busy;
        view
          .querySelectorAll<
            HTMLButtonElement | HTMLInputElement | HTMLSelectElement
          >("button,input,select")
          .forEach((e) => (e.disabled = false));
      }
    }
  };
  const place = (view: HTMLElement, x: number, y: number) => {
    view.style.left =
      Math.max(
        8,
        Math.min(x, innerWidth - view.getBoundingClientRect().width - 8),
      ) + "px";
    view.style.top =
      Math.max(
        46,
        Math.min(y, innerHeight - Math.min(view.scrollHeight, 400) - 8),
      ) + "px";
  };
  const dialog = (mode: "create" | "rename" | "delete", id?: string) => {
    closeBookmarkTree();
    if (mode !== "create" && (!id || !node(id))) return;
    const view = document.createElement("div");
    view.className = "bookmark-tree-overlay";
    view.id = "bookmark-tree-dialog";
    popup = view;
    popupOwner = options.owner;
    const parent = id
      ? node(id)!.kind === "group" && mode === "create"
        ? id
        : node(id)!.parentId
      : null;
    const deletingGroup = mode === "delete" && node(id!)?.kind === "group";
    const title =
      mode === "create"
        ? t("フォルダを追加")
        : mode === "rename"
          ? t("名前を変更")
          : deletingGroup
            ? t("整理フォルダーを削除")
            : t("ブックマークを削除");
    view.innerHTML = html`<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="bookmark-tree-title"><h2 id="bookmark-tree-title">${title}</h2><p class="subtle">ブックマークの整理です。ディスクやサーバーのファイル・フォルダーは変更しません。</p><form id="bookmark-tree-form">${mode === "delete" ? html`<p>${esc(text`「${name(id!)}」を削除します。`)}${deletingGroup ? t("中のブックマークと整理フォルダーは削除せず、ひとつ上へ移します。") : t("保存したブックマーク情報だけを削除します。")}</p>` : html`<label>名前<input id="bookmark-folder-name" maxlength="100" required value="${esc(mode === "rename" ? name(id!) : "")}"></label>`}<div class="actions"><button type="button" id="bookmark-tree-cancel">キャンセル</button><button class="primary" ${mode === "delete" ? 'data-bookmark-action="delete"' : ""}>${mode === "delete" ? t("削除") : t("保存")}</button></div><p class="form-error" role="alert"></p></form></section>`;
    document.body.append(view);
    view.querySelector<HTMLButtonElement>("#bookmark-tree-cancel")!.onclick =
      closeBookmarkTree;
    view.querySelector<HTMLFormElement>("form")!.onsubmit = (event) => {
      event.preventDefault();
      const value =
        view.querySelector<HTMLInputElement>("#bookmark-folder-name")?.value ??
        "";
      void apply(
        mode === "create"
          ? { action: "create", name: value, parentId: parent }
          : mode === "rename"
            ? { action: "rename", id: id!, name: value }
            : { action: "delete", id: id! },
        view,
      );
    };
    view.querySelector<HTMLElement>("input,button")?.focus();
  };
  const context = (id: string | undefined, x: number, y: number, opener?:HTMLElement) => {
    const previous=opener&&popupOwner===options.owner&&popup?.contains(opener)?popupAnchor:opener;
    const returnTo=previous?.matches('button')?previous:root;
    // Keep the actual overflow/cascade target visible while its context is open.
    if (opener && popup?.contains(opener) && !releaseBarrier) {
      contextUnderlay = popup; popup = undefined; cancelMenuTimer(); closeBookmarkTooltip();
    } else closeBookmarkTree();
    popupAnchor=returnTo;popupAnchorOwner=options.owner;
    popupReturnRoot=root;
    if(returnTo===root)root.setAttribute("aria-expanded","true");
    const view = document.createElement("section");
    view.id = options.side ? "side-bookmark-context" : "bookmark-tree-context";
    view.className = "bookmark-tree-menu";
    view.style.zIndex = '1002';
    view.setAttribute("role", "menu");
    popup = view;
    popupOwner = options.owner;
    const n = id ? node(id) : undefined;
    const register =
      html`<button data-bookmark-action="register" role="menuitem">${t("ブックマークを追加")}</button>`;
    const create =
      html`<button data-bookmark-action="create" role="menuitem">${t("フォルダを追加")}</button>`;
    const history =
      html`<button data-bookmark-action="history" role="menuitem">履歴</button>`;
    view.innerHTML =
      register +
      create +
      history +
      (n?.kind==='bookmark'&&options.edit ? html`<button data-bookmark-action="edit" role="menuitem">編集</button>`:'')+
      (n
        ? html`<button data-bookmark-action="rename" role="menuitem">名前を変更</button><button data-bookmark-action="delete" role="menuitem">削除</button>`
        : "");
    document.body.append(view);
    releaseBarrier = popupBarrier(view, closeBookmarkTreeAndFocus, 1001, id ? opener : undefined);
    place(view, x, y);
    menuKeys(view,closeBookmarkTreeAndFocus);
    view
      .querySelectorAll<HTMLButtonElement>("[data-bookmark-action]")
      .forEach((button) => {
        if(options.side)button.dataset.sideAction=button.dataset.bookmarkAction==='register'?'add':button.dataset.bookmarkAction;
        button.disabled =
          button.dataset.bookmarkAction !== "history" && options.busy();
        button.onclick = () => {
          const action = button.dataset.bookmarkAction!;
          if (action !== "history" && options.busy()) return;
          closeBookmarkTree();
          if (action === "register")
            options.register(
              n?.kind === "group" ? n.id : (n?.parentId ?? null),
            );
          else if (action === "history") options.history();
          else if(action==='edit'&&id){const b=bookmark(id);if(b)options.edit?.(b,returnTo);}
          else if(action==='delete'&&id&&n?.kind==='bookmark'&&options.remove){const b=bookmark(id);if(b)options.remove(b,returnTo);}
          else dialog(action as "create" | "rename" | "delete", id);
        };
      });
    view.querySelector<HTMLButtonElement>("button")?.focus();
  };
  const menus: { view: HTMLElement; anchor: HTMLButtonElement; id: string }[] =
    [];
  const trimMenus = (depth: number) => {
    for (const item of menus.splice(depth)) {
      item.view.remove();
      item.anchor.setAttribute("aria-expanded", "false");
    }
  };
  const scheduleMenu = (action: () => void, delay: number) => {
    cancelMenuTimer();
    const startedPopup = popup;
    menuTimer = setTimeout(() => {
      menuTimer = undefined;
      if (
        popup === startedPopup &&
        popupOwner === options.owner &&
        !dragging &&
        !options.busy()
      )
        action();
    }, delay);
  };
  const canDrop = (parentId: string | null) => {
    if (
      !dragging ||
      dragging.key !== options.key ||
      dragging.owner !== options.owner ||
      options.busy()
    )
      return false;
    let current = parentId;
    const visited = new Set<string>();
    while (current) {
      if (current === dragging.id || visited.has(current)) return false;
      visited.add(current);
      current = node(current)?.parentId ?? null;
    }
    return !!node(dragging.id);
  };
  const bindBlank = (container: HTMLElement, parentId: string | null) => {
    container.oncontextmenu = (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-bookmark-tree-node]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      context(parentId ?? undefined, event.clientX, event.clientY,container);
    };
  };
  const bind = (container: HTMLElement, vertical = false, depth = 0) => {
    container
      .querySelectorAll<HTMLButtonElement>("[data-bookmark-tree-node]")
      .forEach((button) => {
        const id = button.dataset.bookmarkTreeNode!;
        if(!button.dataset.tooltipBound){bindBookmarkTooltip(button);button.dataset.tooltipBound='true';}
        button.disabled = options.busy();
        button.onpointerenter=null;
        if(!vertical)button.removeAttribute('role');
        if (vertical) {
          button.setAttribute("role", "menuitem");
          const arrow = button.querySelector(".bookmark-arrow");
          if (arrow) arrow.textContent = "›";
        }
        button.onclick = () => {
          if (options.busy()) return;
          cancelMenuTimer();
          if (node(id)?.kind === "group") {
            // Only a deliberate bar click toggles. Hover and keyboard opening
            // stay idempotent, so a delayed enter cannot reopen a closed menu.
            if (
              !vertical &&
              popupOwner === options.owner &&
              menus[0]?.id === id &&
              menus[0].view.isConnected
            )
              closeBookmarkTree();
            else showFolder(button, depth, true);
          } else {
            const b = bookmark(id);
            if (b) {
              closeBookmarkTree();
              options.open(b);
            }
          }
        };
        if (vertical)
          button.onpointerenter = (event) => {
            if (
              event.pointerType === "touch" ||
              event.buttons ||
              dragging ||
              options.busy()
            )
              return;
            scheduleMenu(() => {
              if (!button.isConnected || !button.matches(":hover")) return;
              if (node(id)?.kind === "group") showFolder(button, depth, false);
              else trimMenus(depth);
            }, 140);
          };
        button.onkeydown = (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();event.stopPropagation();const box=button.getBoundingClientRect();context(id,box.left,box.bottom,button);return;
          }
          if (
            ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
              event.key,
            )
          )
            cancelMenuTimer();
          if (
            (event.key === "ArrowRight" ||
              (!vertical && event.key === "ArrowDown")) &&
            node(id)?.kind === "group"
          ) {
            event.preventDefault();
            showFolder(button, depth, true);
          } else if (vertical && event.key === "ArrowLeft") {
            event.preventDefault();
            const anchor = menus[depth - 1]?.anchor;
            trimMenus(depth - 1);
            anchor?.focus();
          } else if (
            vertical &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            const buttons = [
              ...container.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            buttons[
              (buttons.indexOf(button) +
                (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                buttons.length
            ]?.focus();
          }
        };
        button.oncontextmenu = (event) => {
          event.preventDefault();
          event.stopPropagation();
          context(id, event.clientX, event.clientY,button);
        };
      });
    type Drop = {
      id: string;
      parentId: string | null;
      beforeId: string | null;
    };
    bindPointerReorder<Drop>({
      root: container,
      selector: "[data-bookmark-tree-node]",
      busy: options.busy,
      start: (source) => {
        cancelMenuTimer();
        const id = source.dataset.bookmarkTreeNode!;
        if (!node(id)) return false;
        dragging = { id, key: options.key, owner: options.owner };
      },
      move: (source, point) => {
        clearIndicators();
        const id = source.dataset.bookmarkTreeNode!;
        if (!node(id)) return;
        const hit = document.elementFromPoint(point.x, point.y);
        const targetButton = hit?.closest<HTMLElement>(
          "[data-bookmark-tree-node]",
        );
        if (
          targetButton &&
          (root.contains(targetButton) ||
            (popupOwner === options.owner && popup?.contains(targetButton)))
        ) {
          const targetId = targetButton.dataset.bookmarkTreeNode!;
          const target = node(targetId);
          if (!target || targetId === id) return;
          const bounds = targetButton.getBoundingClientRect();
          const inMenu = !!targetButton.closest("[data-bookmark-folder-menu],#bookmark-overflow-menu");
          const ratio = inMenu
            ? (point.y - bounds.top) / bounds.height
            : (point.x - bounds.left) / bounds.width;
          const position =
            ratio < 0.25
              ? "before"
              : ratio > 0.75
                ? "after"
                : target.kind === "group"
                  ? "inside"
                  : ratio < 0.5
                    ? "before"
                    : "after";
          const parentId = position === "inside" ? targetId : target.parentId;
          if (!canDrop(parentId)) return;
          targetButton.dataset.bookmarkDrop = position;
          const siblings = nodes.filter(
            (n) => n.parentId === target.parentId && n.id !== id,
          );
          return {
            id,
            parentId,
            beforeId:
              position === "before"
                ? targetId
                : position === "after"
                  ? (siblings[siblings.findIndex((n) => n.id === targetId) + 1]
                      ?.id ?? null)
                  : null,
          };
        }
        const folderMenu = hit?.closest<HTMLElement>("[data-bookmark-folder-menu]");
        const overflowMenu = hit?.closest<HTMLElement>("#bookmark-overflow-menu");
        const menu = folderMenu ?? overflowMenu;
        const blank =
          menu && popupOwner === options.owner && popup?.contains(menu)
            ? menu
            : hit && root.contains(hit) && !hit.closest("button")
              ? (root.querySelector<HTMLElement>(".bookmark-items") ?? root)
              : undefined;
        if (!blank) return;
        const parentId = folderMenu?.dataset.bookmarkFolderMenu ?? null;
        if (!canDrop(parentId)) return;
        blank.dataset.bookmarkDrop = "inside";
        return { id, parentId, beforeId: null };
      },
      drop: (_source, target) => {
        // Helper cleanup has already cleared dragging. Use its captured target.
        void apply({ action: "move", ...target });
      },
      cancel: () => {
        dragging = undefined;
        clearIndicators();
      },
      scrollContainers: () =>
        [
          root.querySelector<HTMLElement>(".bookmark-items"),
          ...Array.from(
            popup?.querySelectorAll<HTMLElement>(
              "[data-bookmark-folder-menu],#bookmark-overflow-menu",
            ) ?? [],
          ),
        ].filter((el): el is HTMLElement => !!el),
    });
  };
  const showFolder = (
    anchor: HTMLButtonElement,
    depth: number,
    focus: boolean,
  ) => {
    closeBookmarkTooltip();
    const id = anchor.dataset.bookmarkTreeNode!;
    if (options.busy() || node(id)?.kind !== "group") return;
    if (
      depth === 0 &&
      (!popup?.classList.contains("bookmark-menu-stack") ||
        popupOwner !== options.owner ||
        !menus.length)
    ) {
      closeBookmarkTree();
      menus.length = 0;
      popup = document.createElement("div");
      popup.className = "bookmark-menu-stack";
      popupOwner = options.owner;
      document.body.append(popup);
    }
    if (
      !popup?.classList.contains("bookmark-menu-stack") ||
      popupOwner !== options.owner
    )
      return;
    if(depth===0){popupAnchor=anchor;popupAnchorOwner=options.owner;}
    if (menus[depth]?.id === id && menus[depth].view.isConnected) {
      if (focus)
        menus[depth].view.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    trimMenus(depth);
    const view = document.createElement("section");
    if (!depth) view.id = "bookmark-folder-menu";
    view.className = "bookmark-tree-menu" + (depth ? " bookmark-submenu" : "");
    view.dataset.bookmarkFolderMenu = id;
    view.setAttribute("role", "menu");
    view.setAttribute("aria-label", name(id));
    view.innerHTML =
      bookmarkTreeButtons(nodes, options.bookmarks, options.key, id, options.side) ||
      html`<p class="subtle bookmark-menu-empty">空の整理フォルダ</p>`;
    popup.append(view);
    view.onpointerenter = cancelMenuTimer;
    view.onpointerleave = (event) => {
      if (event.pointerType === "touch" || dragging) return;
      // Keep the parent available while crossing into a child or across the
      // small gap; entering any open menu cancels this pending branch close.
      scheduleMenu(() => trimMenus(Math.max(1, depth)), 240);
    };
    menus.push({ view, anchor, id });
    anchor.setAttribute("aria-expanded", "true");
    bind(view, true, depth + 1);
    bindBlank(view, id);
    const bounds = anchor.getBoundingClientRect(),
      parentBounds = depth
        ? menus[depth - 1].view.getBoundingClientRect()
        : bounds;
    const width = view.getBoundingClientRect().width;
    const x = depth
      ? parentBounds.right + width < innerWidth - 8
        ? parentBounds.right - 1
        : parentBounds.left - width + 1
      : bounds.left;
    place(view, x, depth ? bounds.top - 5 : bounds.bottom + 3);
    if (focus) view.querySelector<HTMLButtonElement>("button")?.focus();
  };
  bind(root);
  const strip = root.querySelector<HTMLElement>(".bookmark-items") ?? root;
  bindBlank(root, null);
  bindBlank(strip, null);
  root.onkeydown = event => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("[data-bookmark-tree-node]"))) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();event.stopPropagation();const box=root.getBoundingClientRect();context(undefined,box.left,box.bottom,root);
    }
  };
  bindBookmarkOverflow(root,(items,keyboard)=>{
    closeBookmarkTree();const overflow=root.querySelector<HTMLButtonElement>('[data-bookmark-overflow]')!;
    popup=document.createElement('div');popup.className='bookmark-menu-stack';popupOwner=options.owner;popupAnchor=overflow;popupAnchorOwner=options.owner;
    const view=document.createElement('section');view.className='bookmark-tree-menu'+(options.side?' side-bookmark-menu':'');view.id='bookmark-overflow-menu';view.setAttribute('role','menu');
    items.forEach(item=>{item.hidden=false;view.append(item);});popup.append(view);document.body.append(popup);
    restoreOverflow=()=>{items.forEach(item=>{item.hidden=true;item.removeAttribute('role');strip.append(item);});overflow.setAttribute('aria-expanded','false');bind(root);};
    menus.length=0;menus.push({view,anchor:overflow,id:'@overflow'});bind(view,true,1);bindBlank(view,null);
    const box=overflow.getBoundingClientRect();place(view,box.right-240,box.bottom+3);overflow.setAttribute('aria-expanded','true');
    menuKeys(view,closeBookmarkTreeAndFocus);focusBookmarkMenu(view,keyboard);
  },closeBookmarkTree);
  strip.onwheel = (event) => {
    if (strip.scrollWidth <= strip.clientWidth || event.ctrlKey) return;
    event.preventDefault();
    strip.scrollLeft +=
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
  };
}
