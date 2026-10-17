import { t, html, tError } from "./i18n.js";
import {
  connectionKey,
  type Store,
  type Workspace,
  type Settings,
} from "./core.js";
import type { FolderBookmark } from "./explorer-preferences.js";
import { deleteBookmarkMetadata } from "./bookmark-tree.js";
import {
  bookmarkTreeButtons,
  bindBookmarkTree,
  closeBookmarkTree,
} from "./bookmark-tree-ui.js";
type Pair = { local: string; remote: string };
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const pairText = (pair: Pair) => `${pair.local} ↔ ${pair.remote}`;
let overlay: HTMLElement | undefined;
let owner = "";
let mutationPending = false;
let stripScroll = 0;
export function closeBookmarks() {
  closeBookmarkTree();
  overlay?.remove();
  overlay = undefined;
  owner = "";
}
export function captureBookmarks() {
  const strip = document.querySelector<HTMLElement>(".bookmark-items");
  if (strip) stripScroll = strip.scrollLeft;
}
document.addEventListener("keydown", (event) => {
  if (overlay && event.key === "Escape") {
    event.preventDefault();
    closeBookmarks();
  }
});
export function bookmarkBar(store: Store, w: Workspace) {
  if (!w.connection) return "";
  const items = bookmarkTreeButtons(
    store.bookmarkTree.nodes,
    store.folderBookmarks,
    connectionKey(w.connection!),
  );
  return html`<nav class="bookmark-bar" aria-label="この接続先のフォルダ組み合わせ"><div class="bookmark-items">${items || html`<span class="bookmark-empty">フォルダの組み合わせを登録</span>`}</div>${store.bookmarkTreeWarning ? html`<span class="bookmark-tree-warning" title="${esc(t(store.bookmarkTreeWarning))}" role="status">分類を確認</span>` : ""}<button type="button" id="bookmark-more" aria-expanded="false" aria-label="ブックマークメニュー" aria-haspopup="menu" title="ブックマークメニュー"><svg class="bookmark-more-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg></button></nav>`;
}
export function bindBookmarks(
  store: Store,
  w: Workspace,
  persist: (overrides?: Pick<Settings, "folderBookmarks">) => Promise<void>,
  render: () => void,
  openPair: (pair: Pair) => Promise<boolean>,
  report: (error: unknown) => void,
  mutate: <T>(change: (candidate: Store) => T) => Promise<T>,
) {
  if (!w.connection) {
    closeBookmarks();
    return;
  }
  const profile = w.connection,
    key = connectionKey(profile);
  const ownerKey = JSON.stringify([w.id, key]);
  if (owner && owner !== ownerKey) closeBookmarks();
  const strip = document.querySelector<HTMLElement>(".bookmark-items");
  if (strip) {
    strip.scrollLeft = stripScroll;
    strip.onscroll = () => (stripScroll = strip.scrollLeft);
  }
  const show = (
    mode: "history" | "save",
    initial: Pair = { local: w.localBrowse, remote: w.remoteBrowse },
    bookmark?: FolderBookmark,
    parentId?: string | null,
  ) => {
    closeBookmarkTree();
    closeBookmarks();
    owner = ownerKey;
    overlay = document.createElement("div");
    overlay.id = "bookmark-overlay";
    overlay.className = "overlay";
    overlay.innerHTML =
      '<section class="dialog bookmark-dialog" role="dialog" aria-modal="true" aria-labelledby="bookmark-title"></section>';
    document.body.append(overlay);
    const view = overlay;
    const closeOwned = () => {
      if (overlay === view) closeBookmarks();
    };
    const root = overlay.firstElementChild as HTMLElement;
    const frame = (title: string, content: string) => {
      root.innerHTML = html`<header class="bookmark-dialog-heading"><h2 id="bookmark-title">${title}</h2><button id="bookmark-close" aria-label="閉じる">×</button></header>${content}<p class="form-error" role="alert"></p>`;
      root.querySelector<HTMLElement>("#bookmark-close")!.onclick =
        closeBookmarks;
    };
    const error = (e: unknown) => {
      root.querySelector<HTMLElement>(".form-error")!.textContent = tError(e);
    };
    const saveForm = (pair: Pair, existing?: FolderBookmark) => {
      frame(
        existing ? t("ブックマークを編集") : t("フォルダの組み合わせを登録"),
        html`<form id="bookmark-form"><label>名前<input id="bookmark-name" name="name" maxlength="100" required value="${esc(existing?.name ?? "")}" placeholder="例：Webサイト"></label><div class="bookmark-paths"><span>ローカル</span><code title="${esc(pair.local)}">${esc(pair.local)}</code><span>リモート</span><code title="${esc(pair.remote)}">${esc(pair.remote)}</code></div><p class="subtle">この接続先の閲覧位置として保存します。同期先は変更しません。</p><div class="actions">${existing ? html`<button type="button" id="bookmark-delete">削除</button>` : ""}<button type="button" id="bookmark-cancel">戻る</button><button id="bookmark-save" class="primary">保存</button></div></form>`,
      );
      root.querySelector<HTMLElement>("#bookmark-cancel")!.onclick = history;
      const form = root.querySelector<HTMLFormElement>("form")!;
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (form.dataset.busy) return;
        if (mutationPending) {
          error(t("前の保存が完了するまでお待ちください"));
          return;
        }
        mutationPending = true;
        form.dataset.busy = "true";
        const name =
          root.querySelector<HTMLInputElement>("#bookmark-name")!.value;
        form
          .querySelectorAll<HTMLInputElement>("input,button")
          .forEach((e) => (e.disabled = true));
        try {
          await mutate((candidate) => {
            const saved = candidate.saveFolderBookmark(profile, {
              local: pair.local,
              remote: pair.remote,
              name,
              ...(existing ? { id: existing.id } : {}),
            });
            if (!existing && parentId !== undefined)
              candidate.moveBookmarkNode(key, saved.id, parentId, null);
          });
          // Repaint only after persistence has settled and mutations are available again.
          mutationPending = false;
          closeOwned();
          render();
        } catch (e) {
          error(e);
        } finally {
          mutationPending = false;
          delete form.dataset.busy;
          form
            .querySelectorAll<HTMLInputElement>("input,button")
            .forEach((e) => (e.disabled = false));
        }
      };
      root
        .querySelector<HTMLElement>("#bookmark-delete")
        ?.addEventListener("click", async () => {
          if (form.dataset.busy) return;
          if (mutationPending) {
            error(t("前の保存が完了するまでお待ちください"));
            return;
          }
          mutationPending = true;
          form.dataset.busy = "true";
          form
            .querySelectorAll<HTMLInputElement>("input,button")
            .forEach((e) => (e.disabled = true));
          try {
            await mutate((candidate) =>
              deleteBookmarkMetadata(candidate, key, existing!.id),
            );
            mutationPending = false;
            closeOwned();
            render();
          } catch (e) {
            error(e);
          } finally {
            mutationPending = false;
            delete form.dataset.busy;
            form
              .querySelectorAll<HTMLInputElement>("input,button")
              .forEach((e) => (e.disabled = false));
          }
        });
      root.querySelector<HTMLInputElement>("#bookmark-name")!.focus();
    };
    const open = async (pair: Pair) => {
      if (root.dataset.busy) return;
      root.dataset.busy = "true";
      root
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((e) => (e.disabled = true));
      try {
        const success = await openPair(pair);
        if (success) closeOwned();
        else error(t("フォルダを開けませんでした。閲覧位置は変更していません。"));
      } catch (e) {
        error(e);
      } finally {
        delete root.dataset.busy;
        root
          .querySelectorAll<HTMLButtonElement>("button")
          .forEach((e) => (e.disabled = false));
      }
    };
    const legacyConfirm = (pair: Pair, save: boolean) => {
      frame(
        t("旧履歴の接続先を確認"),
        html`<p>この履歴には接続先の識別情報がありません。現在の接続先で利用する組み合わせか確認してください。</p><strong>${esc(profile.user)}@${esc(profile.host)}:${profile.port}</strong><div class="bookmark-paths"><span>ローカル</span><code>${esc(pair.local)}</code><span>リモート</span><code>${esc(pair.remote)}</code></div><div class="actions"><button id="legacy-cancel">戻る</button><button id="legacy-confirm" class="primary">${save ? t("接続先を確認して登録") : t("接続先を確認して開く")}</button></div>`,
      );
      root.querySelector<HTMLElement>("#legacy-cancel")!.onclick = history;
      root.querySelector<HTMLElement>("#legacy-confirm")!.onclick = () =>
        save ? saveForm(pair) : void open(pair);
    };
    const history = () => {
      const bookmarks = store.folderBookmarks.filter(
          (b) => b.connectionKey === key,
        ),
        pairs = store.folderPairHistory.filter((p) => p.connectionKey === key),
        legacy = store.legacyFolderPairs(profile);
      const row = (pair: Pair, buttons: string, name?: string) =>
        `<div class="pair-row">${name ? `<strong>${esc(name)}</strong>` : ""}<div class="pair-paths"><code title="${esc(pair.local)}">${esc(pair.local)}</code><code title="${esc(pair.remote)}">${esc(pair.remote)}</code></div><div class="pair-actions">${buttons}</div></div>`;
      frame(
        t("履歴とブックマーク"),
        html`<p class="subtle">${esc(profile.user)}@${esc(profile.host)}:${profile.port} · 開く操作は両ペインの閲覧位置だけを変更します。</p><div class="pair-history-list"><h3>ブックマーク</h3>${bookmarks.map((b, i) => row(b, html`<button data-saved-open="${i}">開く</button><button data-bookmark-edit="${i}">編集</button>`, b.name)).join("") || html`<p class="subtle">登録はありません</p>`}<h3>最近使った組み合わせ</h3>${pairs.map((p, i) => row(p, html`<button data-history-open="${i}">開く</button><button data-history-register="${i}">登録</button>`)).join("") || html`<p class="subtle">履歴はありません</p>`}${legacy.length ? html`<h3>旧履歴・接続先未確認</h3>${legacy.map((p, i) => row(p, html`<button data-legacy-open="${i}">確認して開く</button><button data-legacy-register="${i}">確認して登録</button>`)).join("")}` : ""}</div>`,
      );
      const bind = (attr: string, fn: (i: number) => void) =>
        root
          .querySelectorAll<HTMLElement>(`[${attr}]`)
          .forEach(
            (button) =>
              (button.onclick = () => fn(Number(button.getAttribute(attr)))),
          );
      bind("data-saved-open", (i) => void open(bookmarks[i]));
      bind("data-bookmark-edit", (i) => saveForm(bookmarks[i], bookmarks[i]));
      bind("data-history-open", (i) => void open(pairs[i]));
      bind("data-history-register", (i) => saveForm(pairs[i]));
      bind("data-legacy-open", (i) => legacyConfirm(legacy[i], false));
      bind("data-legacy-register", (i) => legacyConfirm(legacy[i], true));
      root.querySelector<HTMLElement>("#bookmark-close")!.focus();
    };
    mode === "save" ? saveForm(initial, bookmark) : history();
  };
  const bar = document.querySelector<HTMLElement>(".bookmark-bar");
  if (bar)
    bindBookmarkTree(bar, {
      nodes: store.bookmarkTree.nodes,
      bookmarks: store.folderBookmarks,
      key,
      owner: w.id,
      busy: () => mutationPending || w.loading.local || w.loading.remote,
      open: (bookmark) => void openPair(bookmark).catch(report),
      register: (parentId) => show("save", undefined, undefined, parentId),
      history: () => show("history"),
      report,
      change: async (change) => {
        if (mutationPending)
          throw Error(t("前の保存が完了するまでお待ちください"));
        mutationPending = true;
        try {
          await mutate((candidate) => {
            if (change.action === "create")
              candidate.createBookmarkGroup(key, change.name, change.parentId);
            else if (change.action === "rename")
              candidate.renameBookmarkNode(key, change.id, change.name);
            else if (change.action === "move")
              candidate.moveBookmarkNode(
                key,
                change.id,
                change.parentId,
                change.beforeId,
              );
            else if (change.action === "delete")
              deleteBookmarkMetadata(candidate, key, change.id);
            else candidate.ungroupBookmarkFolder(key, change.id);
          });
        } finally {
          mutationPending = false;
        }
        render();
      },
    });
}
