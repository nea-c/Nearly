import { bookmarkTreeButtons, bindBookmarkTree, closeBookmarkTree } from './bookmark-tree-ui.js';
import { sideBookmarkAdapter, sideTreeAdapter, LOCAL_BOOKMARK_SCOPE } from './side-bookmarks.js';
import { bindBookmarkTooltip } from './bookmark-tooltip.js';
import { connectionKey, type Store, type Workspace } from "./core.js";
import { t, tError, html } from "./i18n.js";
import { type BookmarkSide, type LocalBookmark } from "./side-bookmarks.js";
import {
  bindBookmarkOverflow,
  focusBookmarkMenu,
  menuKeys,
  overflowIcon,
} from "./bookmark-overflow.js";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
let overlay: HTMLElement | undefined, returnFocus: HTMLElement | undefined;
let overlayOwned: (() => boolean) | undefined;
let menu: HTMLElement | undefined, restoreMenu: (() => void) | undefined;
function closeMenu(focus = false) {
  const old = menu;
  menu = undefined;
  restoreMenu?.();
  restoreMenu = undefined;
  old?.remove();
  if (returnFocus?.hasAttribute("aria-expanded")) returnFocus.setAttribute("aria-expanded", "false");
  if (focus) returnFocus?.isConnected && returnFocus.focus();
}
export function closeSideBookmarks() {
  closeMenu();
  closeBookmarkTree();
  overlay?.remove();
  overlay = undefined;
  overlayOwned = undefined;
  returnFocus?.setAttribute("aria-expanded", "false");
}
export function closeStaleSideBookmarks() {
  if (overlay && !overlayOwned?.()) closeSideBookmarks();
}
document.addEventListener("pointerdown", (event) => {
  if (
    menu &&
    event.target instanceof Node &&
    !menu.contains(event.target) &&
    !returnFocus?.contains(event.target)
  )
    closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && overlay) {
    event.preventDefault();
    closeSideBookmarks();
    if (returnFocus?.isConnected) returnFocus.focus();
  }
});
export function sideBookmarkBar(
  store: Store,
  w: Workspace,
  side: BookmarkSide,
) {
  const label = side === "local" ? t("ローカル") : t("リモート");
  const records =
    side === "local"
      ? store.localBookmarks
      : store.remoteBookmarks.filter(
          (b) =>
            w.connection && b.connectionKey === connectionKey(w.connection),
        );
  const tree=sideTreeAdapter(side==='local'?store.localBookmarkTree:store.remoteBookmarkTree);
  const key=side==='local'?LOCAL_BOOKMARK_SCOPE:(w.connection?connectionKey(w.connection):'');
  const items=bookmarkTreeButtons(tree.nodes,sideBookmarkAdapter(records,side),key,null,side);
  return `<nav id="${side}-bookmarks" class="side-bookmark-bar" tabindex="0" aria-haspopup="menu" aria-expanded="false" data-side-bookmarks="${side}" aria-label="${esc(label+' '+t('ブックマーク'))}"><div class="bookmark-items">${items}</div><button type="button" id="${side}-bookmark-more" data-bookmark-overflow hidden aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('他のブックマーク'))}">${overflowIcon}</button></nav>`;
}
export function bindSideBookmarks(
  store: Store,
  w: Workspace,
  side: BookmarkSide,
  owned: () => boolean,
  navigate: (path: string) => Promise<boolean>,
  mutate: <T>(change: (candidate: Store) => T) => Promise<T>,
  render: () => void,
  report: (e: unknown) => void,
) {
  const bar = document.querySelector<HTMLElement>(
    `[data-side-bookmarks=${side}]`,
  );
  if (!bar) return;
  bar.querySelectorAll<HTMLElement>("[data-side-open]").forEach(bindBookmarkTooltip);
  const profile = w.connection ? { ...w.connection } : undefined,
    key = profile ? connectionKey(profile) : undefined;
  const records = () =>
    side === "local"
      ? store.localBookmarks
      : store.remoteBookmarks.filter((b) => b.connectionKey === key);
  const close = (focus = true) => {
    closeSideBookmarks();
    if (focus && owned() && returnFocus?.isConnected) returnFocus.focus();
  };
  const show = (record?: LocalBookmark, deleting = false, opener: HTMLElement = bar, parentId: string | null = null, initialPath?:string) => {
    if (!owned()) return;
    closeSideBookmarks();
    returnFocus = opener;
    const view = document.createElement("div");
    view.id = "side-bookmark-dialog";
    view.className = "overlay";
    overlay = view;
    overlayOwned = owned;
    const frame = (content: string) => {
      view.innerHTML = `<section class="dialog bookmark-dialog" role="dialog" aria-modal="true" aria-labelledby="side-bookmark-title"><h2 id="side-bookmark-title">${esc(t(record ? "ブックマークを編集" : "ブックマークを追加"))}</h2>${content}<p class="form-error" role="alert"></p></section>`;
    };
    const error = (e: unknown) => {
      if (overlay === view)
        view.querySelector(".form-error")!.textContent = tError(e);
    };
    const edit = (record?: LocalBookmark) => {
      frame(
        html`<form>
          <label
            >${t("名前")}<input
              id="side-bookmark-name"
              maxlength="100"
              required
              value="${esc(record?.name ?? "")}" /></label
          ><label
            >${t("フォルダー")}<input
              id="side-bookmark-path"
              maxlength="4096"
              required
              value="${esc(record?.path ?? initialPath ?? (side === "local" ? w.localBrowse : w.remoteBrowse))}"
          /></label>
          <div class="actions">
            ${record ? `<button type="button" id="side-bookmark-remove">${esc(t("削除"))}</button>` : ""}<button
              type="button"
              id="side-bookmark-cancel"
            >
              ${t("キャンセル")}</button
            ><button id="side-bookmark-save" class="primary">
              ${t("保存")}
            </button>
          </div>
        </form>`,
      );
      const form = view.querySelector("form")!;
      const commit = async (remove = false) => {
        if (!owned() || overlay !== view || form.dataset.busy) return;
        form.dataset.busy = "true";
        const name = remove
            ? record!.name
            : view.querySelector<HTMLInputElement>("#side-bookmark-name")!
                .value,
          path = remove
            ? record!.path
            : view.querySelector<HTMLInputElement>("#side-bookmark-path")!
                .value;
        view
          .querySelectorAll<HTMLInputElement>("input,button")
          .forEach((e) => (e.disabled = true));
        try {
          await mutate((candidate) => {
            if (!owned()) throw Error(t("ブックマークの表示が変更されました"));
            if (remove) candidate.removeSideBookmark(side, record!.id, key);
            else
              { const saved = candidate.saveSideBookmark(
                side,
                { id: record?.id, name, path },
                profile,
              ); if(!record&&parentId)candidate.moveSideBookmarkNode(side,saved.id,parentId,null,profile); }
          });
          if (overlay === view && owned()) {
            if (remove) returnFocus = bar;
            close();
            render();
          }
        } catch (e) {
          error(e);
        } finally {
          delete form.dataset.busy;
          view
            .querySelectorAll<HTMLInputElement>("input,button")
            .forEach((e) => (e.disabled = false));
        }
      };
      form.onsubmit = (event) => {
        event.preventDefault();
        void commit();
      };
      view.querySelector<HTMLElement>("#side-bookmark-cancel")!.onclick = () =>
        close();
      const remove = view.querySelector<HTMLElement>("#side-bookmark-remove");
      const confirmDelete = () => {
          frame(
            `<p>${esc(t("ブックマークを削除しますか？"))} ${esc(record!.name)}</p><div class="actions"><button id="side-delete-cancel">${esc(t("キャンセル"))}</button><button id="side-delete-confirm">${esc(t("削除"))}</button></div>`,
          );
          view.querySelector<HTMLElement>("#side-delete-cancel")!.onclick =
            () => deleting ? close() : edit(record);
          view.querySelector<HTMLElement>("#side-delete-confirm")!.onclick =
            () => void commit(true);
          view.querySelector<HTMLElement>("#side-delete-cancel")!.focus();
        };
      if (remove) remove.onclick = confirmDelete;
      if (deleting && record) confirmDelete();
      else view.querySelector<HTMLElement>("input")?.focus();
    };
    document.body.append(view);
    edit(record);
  };
  const showHistory=()=>{
    if(!owned())return;
    closeSideBookmarks();returnFocus=bar;
    const view=document.createElement('div');view.className='overlay';view.id='side-history-dialog';overlay=view;overlayOwned=owned;
    const history=(side==='local'?store.localFolderHistory:store.remoteFolderHistory.filter(p=>p.connectionKey===key));
    view.innerHTML=`<section class="dialog bookmark-dialog" role="dialog" aria-modal="true" aria-labelledby="side-history-title"><header class="bookmark-dialog-heading"><h2 id="side-history-title">${esc(t('履歴'))}</h2><button type="button" data-history-close aria-label="${esc(t('閉じる'))}">×</button></header><div class="side-history-list">${history.map((p,i)=>`<article class="pair-row"><code>${esc(p.path)}</code><div class="actions"><button data-side-history-open="${i}">${esc(t('開く'))}</button><button data-side-history-add="${i}">${esc(t('ブックマークを追加'))}</button></div></article>`).join('')||`<p class="subtle">${esc(t('履歴はありません'))}</p>`}</div><p class="form-error" role="alert"></p></section>`;
    view.querySelector<HTMLElement>('[data-history-close]')!.onclick=()=>close();
    view.querySelectorAll<HTMLElement>('[data-side-history-open]').forEach(button=>button.onclick=()=>{if(!owned())return;const entry=history[Number(button.dataset.sideHistoryOpen)];close();void navigate(entry.path).catch(report);});
    view.querySelectorAll<HTMLElement>('[data-side-history-add]').forEach(button=>button.onclick=()=>{if(owned())show(undefined,false,bar,null,history[Number(button.dataset.sideHistoryAdd)].path);});
    document.body.append(view);view.querySelector<HTMLElement>('button')?.focus();
  };
  const tree=sideTreeAdapter(side==='local'?store.localBookmarkTree:store.remoteBookmarkTree);
  const adapted=sideBookmarkAdapter(records(),side);
  bindBookmarkTree(bar,{
    nodes:tree.nodes,bookmarks:adapted,key:side==='local'?LOCAL_BOOKMARK_SCOPE:key??'',owner:JSON.stringify([w.id,side]),side,
    busy:()=>!owned(),
    change:async change=>{await mutate(candidate=>{
      if(!owned())throw Error(t('ブックマークの表示が変更されました'));
      if(change.action==='create')candidate.createSideBookmarkGroup(side,change.name,change.parentId,profile);
      else if(change.action==='rename')candidate.renameSideBookmarkNode(side,change.id,change.name,profile);
      else if(change.action==='move')candidate.moveSideBookmarkNode(side,change.id,change.parentId,change.beforeId,profile);
      else if(change.action==='ungroup')candidate.ungroupSideBookmarkFolder(side,change.id,profile);
      else candidate.removeSideBookmark(side,change.id,key);
    });if(owned())render();},
    open:bookmark=>{if(owned())void navigate(side==='local'?bookmark.local:bookmark.remote).catch(report);},
    register:parentId=>show(undefined,false,bar,parentId),
    edit:(bookmark,opener)=>show(records().find(b=>b.id===bookmark.id),false,opener),
    remove:(bookmark,opener)=>show(records().find(b=>b.id===bookmark.id),true,opener),
    history:showHistory,report,
  });
}
