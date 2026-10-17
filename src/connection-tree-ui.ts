import { t, text, html, tError } from "./i18n.js";
import type { Store, Profile } from "./core.js";
import { ConnectionTreeEditor } from "./connection-tree.js";
import { bindPointerReorder, cancelPointerReorder } from "./pointer-reorder.js";

type State = { nodeId?: string; profileId: string };
let currentPopup: { view: HTMLElement; close: () => void } | undefined;
const contextMenus = new WeakMap<
  HTMLElement,
  (id: string | null, x: number, y: number) => void
>();
let activeDrag: { root: HTMLElement; cancel: () => void } | undefined;
export function connectionTreeDragging() {
  return !!activeDrag;
}
export function cancelConnectionTreeDrag() {
  activeDrag?.cancel();
}
export function closeConnectionTreePopup() {
  currentPopup?.close();
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelConnectionTreeDrag();
  if (!currentPopup) return;
  if (!currentPopup.view.isConnected) {
    closeConnectionTreePopup();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeConnectionTreePopup();
  }
});
window.addEventListener("blur", cancelConnectionTreeDrag);
type Callbacks = {
  select: (id: string) => void;
  edit: (profile: Partial<Profile>, parentId?: string | null) => void;
  mutate: <T>(change: (candidate: Store) => T) => Promise<T>;
  refresh: (selectedId?: string) => void;
  busy: () => boolean;
  deleteReason: (id: string) => string | undefined;
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const chevron = (expanded: boolean) =>
  `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"}"/></svg>`;

export function connectionTreeMarkup(store: Store, state: State) {
  const selected = state.nodeId ?? state.profileId;
  const children = (parentId: string | null, depth: number): string =>
    store.connectionTree.nodes
      .filter((n) => n.parentId === parentId)
      .map((node) => {
        const group = node.kind === "group";
        const profile = group
          ? undefined
          : store.profiles.find((p) => p.id === node.profileId);
        const name = group ? node.name : (profile?.name ?? "");
        return `<div class="connection-node ${selected === node.id ? "selected" : ""}" data-connection-node="${esc(node.id)}" data-depth="${depth}" role="treeitem" aria-level="${depth + 1}" aria-selected="${selected === node.id}" ${group ? `aria-expanded="${node.expanded}" ${node.expanded ? `aria-owns="connection-children-${encodeURIComponent(node.id)}"` : ""}` : ""} draggable="false"><div class="connection-node-row" data-drop-before="${esc(t("前に移動"))}" data-drop-after="${esc(t("後に移動"))}" data-drop-inside="${esc(t("グループ内へ"))}">${group ? html`<button type="button" class="connection-toggle" data-connection-toggle="${esc(node.id)}" aria-label="${esc(node.expanded ? text`${name}を折りたたむ` : text`${name}を展開`)}">${chevron(node.expanded)}</button>` : '<span class="connection-toggle-placeholder"></span>'}<button type="button" data-connection-select="${esc(node.id)}" title="${esc(group ? name : `${name} — ${profile?.user}@${profile?.host}:${profile?.port}`)}"><span class="connection-node-icon" aria-hidden="true">${group ? "▱" : "◇"}</span><span>${esc(name)}</span></button></div></div>${group && node.expanded ? `<div id="connection-children-${encodeURIComponent(node.id)}" role="group">${children(node.id, depth + 1)}</div>` : ""}`;
      })
      .join("");
  return html`<section class="connection-library" aria-label="保存した接続先">${store.connectionTreeWarning ? `<p class="warning connection-tree-warning">${esc(t(store.connectionTreeWarning))}</p>` : ""}<div id="connection-tree" role="tree" aria-label="接続先とグループ" tabindex="0">${children(null, 0) || html`<p class="connection-tree-empty">右クリックで接続先やグループを追加</p>`}</div><p class="connection-tree-error form-error" role="alert"></p></section>`;
}

export function bindConnectionTree(
  root: HTMLElement,
  store: Store,
  state: State,
  callbacks: Callbacks,
) {
  if (currentPopup && !currentPopup.view.isConnected)
    closeConnectionTreePopup();
  if (activeDrag && (activeDrag.root === root || !activeDrag.root.isConnected))
    cancelConnectionTreeDrag();
  const clearTargets = () =>
    root.querySelectorAll<HTMLElement>("[data-drop]").forEach((e) => {
      delete e.dataset.drop;
      delete e.dataset.dropLabel;
    });
  const clearDrag = () => {
    clearTargets();
    if (activeDrag?.root === root) activeDrag = undefined;
  };
  let popup: HTMLElement | undefined;
  const nodeFor = (id: string | null) =>
    store.connectionTree.nodes.find((n) => n.id === id);
  const nameFor = (id: string) => {
    const node = store.connectionTree.nodes.find((n) => n.id === id);
    return node?.kind === "group"
      ? node.name
      : (store.profiles.find((p) => p.id === id)?.name ?? "");
  };
  const report = (error: unknown) => {
    const target = root.querySelector<HTMLElement>(".connection-tree-error");
    if (target)
      target.textContent = tError(error);
  };
  const close = () => {
    if (currentPopup?.view === popup) currentPopup = undefined;
    popup?.remove();
    popup = undefined;
  };
  const change = async <T>(
    mutate: (candidate: Store) => T,
    select?: (result: T) => string | undefined,
  ) => {
    if (callbacks.busy()) return;
    try {
      const result = await callbacks.mutate(mutate);
      if (root.isConnected) callbacks.refresh(select?.(result));
    } catch (error) {
      report(error);
    }
  };
  const destination = (
    source: string,
    targetId: string | null,
    position: string,
  ) => {
    if (source === targetId)
      throw Error("A connection node cannot move into itself");
    const target = store.connectionTree.nodes.find((n) => n.id === targetId);
    if (targetId !== null && !target)
      throw Error("Connection target is no longer available");
    const parentId = target
      ? position === "inside"
        ? target.id
        : target.parentId
      : null;
    const siblings = store.connectionTree.nodes.filter(
      (n) => n.parentId === target?.parentId && n.id !== source,
    );
    const beforeId =
      !target || position === "inside"
        ? null
        : position === "before"
          ? target.id
          : (siblings[siblings.findIndex((n) => n.id === target.id) + 1]?.id ??
            null);
    // Validate a detached candidate before advertising a target. The persisted mutation
    // still repeats validation, including cycles and the maximum nesting depth.
    const candidate = new ConnectionTreeEditor(
      store.connectionTree,
      store.profiles,
    );
    candidate.move(source, parentId, beforeId);
    candidate.finish();
    return { parentId, beforeId };
  };
  const dropPosition = (row: HTMLElement, clientY: number) => {
    const bounds = row.getBoundingClientRect();
    const ratio = (clientY - bounds.top) / Math.max(1, bounds.height);
    const group =
      store.connectionTree.nodes.find(
        (n) => n.id === row.dataset.connectionNode,
      )?.kind === "group";
    return ratio < 0.3
      ? "before"
      : ratio > 0.7
        ? "after"
        : group
          ? "inside"
          : ratio < 0.5
            ? "before"
            : "after";
  };
  const parentForAdd = (id: string | null) => {
    const node = nodeFor(id);
    return node?.kind === "group" ? node.id : (node?.parentId ?? null);
  };
  const editor = (
    mode: "group" | "rename" | "delete",
    targetId: string | null,
  ) => {
    close();
    const id = targetId ?? "",
      node = nodeFor(targetId);
    if (mode !== "group" && !node) return;
    const parent = parentForAdd(targetId);
    const view = document.createElement("div");
    view.className = "connection-tree-overlay";
    view.id = "connection-tree-dialog";
    const reason = mode === "delete" ? callbacks.deleteReason(id) : undefined;
    const profile =
      node?.kind === "profile"
        ? store.profiles.find((p) => p.id === node.profileId)
        : undefined;
    view.innerHTML = html`<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="connection-node-title"><h2 id="connection-node-title">${mode === "group" ? t("グループを追加") : mode === "rename" ? t("名前を変更") : t("削除を確認")}</h2><form id="connection-node-form">${mode === "delete" ? html`<p>${esc(text`「${nameFor(id)}」を削除します。`)}</p>${profile ? `<p class="target">${esc(profile.user)}@${esc(profile.host)}:${profile.port}</p>` : ""}<p>${node?.kind === "group" ? t("中の接続先とグループは削除せず、ひとつ上へ移します。") : t("保存した接続設定だけを削除します。履歴やブックマークは残ります。")} サーバーやファイルは変更しません。</p>` : html`<label>名前<input id="connection-node-name" required maxlength="100" value="${esc(mode === "rename" ? nameFor(id) : "")}"></label>`}<div class="actions"><button type="button" id="connection-node-cancel">キャンセル</button><button id="connection-node-submit" class="primary" ${reason ? "disabled" : ""}>${mode === "delete" ? t("削除") : t("保存")}</button></div><p class="form-error" role="alert">${esc(tError(reason))}</p></form></section>`;
    root.append(view);
    popup = view;
    currentPopup = { view, close };
    const form = view.querySelector<HTMLFormElement>("form")!;
    view.querySelector<HTMLButtonElement>("#connection-node-cancel")!.onclick =
      close;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (form.dataset.busy || callbacks.busy()) return;
      const name =
        view.querySelector<HTMLInputElement>("#connection-node-name")?.value ??
        "";
      form.dataset.busy = "true";
      form
        .querySelectorAll<HTMLInputElement>("input,button")
        .forEach((e) => (e.disabled = true));
      try {
        const result = await callbacks.mutate((candidate) => {
          if (mode === "group")
            return candidate.createConnectionGroup(name, parent);
          if (mode === "rename") {
            candidate.renameConnectionNode(id, name);
            return id;
          }
          candidate.deleteConnectionNode(id, store);
          return node?.parentId ?? candidate.connectionTree.nodes[0]?.id ?? "";
        });
        if (popup === view) close();
        if (root.isConnected) callbacks.refresh(result);
      } catch (error) {
        view.querySelector<HTMLElement>(".form-error")!.textContent = tError(error);
      } finally {
        delete form.dataset.busy;
        form
          .querySelectorAll<HTMLInputElement>("input,button")
          .forEach((e) => (e.disabled = false));
        const blocked =
          mode === "delete" ? callbacks.deleteReason(id) : undefined;
        if (blocked)
          view.querySelector<HTMLButtonElement>(
            "#connection-node-submit",
          )!.disabled = true;
      }
    };
    view.querySelector<HTMLElement>("input,button")?.focus();
  };
  const action = (value: string, targetId: string | null) => {
    if (callbacks.busy()) return;
    const node = nodeFor(targetId);
    if (value === "add-profile")
      callbacks.edit(
        { name: "", host: "", port: 22, user: "" },
        parentForAdd(targetId),
      );
    else if (value === "add-group") editor("group", targetId);
    else if (value === "rename" || value === "delete") editor(value, targetId);
    else if (value === "duplicate" && node)
      void change(
        (s) => s.duplicateConnectionNode(node.id),
        (id) => id,
      );
  };
  const menu = (targetId: string | null, x: number, y: number) => {
    if (callbacks.busy() || !root.isConnected) return;
    close();
    const view = document.createElement("section");
    view.id = "connection-context-menu";
    view.className = "connection-context-menu";
    view.setAttribute("role", "menu");
    const node = nodeFor(targetId);
    view.innerHTML =
      html`<button type="button" data-menu-action="add-profile" role="menuitem">接続先を追加</button><button type="button" data-menu-action="add-group" role="menuitem">グループを追加</button>` +
      (node
        ? html`<button type="button" data-menu-action="rename" role="menuitem">名前を変更</button><button type="button" data-menu-action="duplicate" role="menuitem">複製</button><button type="button" data-menu-action="delete" role="menuitem">削除</button>`
        : "");
    root.append(view);
    popup = view;
    currentPopup = { view, close };
    view.style.left = Math.max(8, Math.min(x, innerWidth - 210)) + "px";
    view.style.top = Math.max(8, Math.min(y, innerHeight - 250)) + "px";
    view.querySelectorAll<HTMLButtonElement>("[data-menu-action]").forEach(
      (button) =>
        (button.onclick = () => {
          close();
          action(button.dataset.menuAction!, targetId);
        }),
    );
    view.querySelector<HTMLButtonElement>("button")?.focus();
  };
  contextMenus.set(root, menu);
  root.querySelector<HTMLElement>(".connection-library")!.oncontextmenu = (
    event,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (callbacks.busy()) return;
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-connection-node]")
        : null;
    const id = row?.dataset.connectionNode ?? null;
    // Selecting a row synchronously replaces this subtree and binds a new owner.
    // Open through that current owner so dismissal and pending writes remain scoped.
    if (id) callbacks.select(id);
    contextMenus.get(root)?.(id, event.clientX, event.clientY);
  };
  root
    .querySelectorAll<HTMLElement>("[data-connection-node]")
    .forEach((row) => {
      const id = row.dataset.connectionNode!;
      row.querySelector<HTMLElement>(
        ".connection-node-row",
      )!.style.paddingLeft = 4 + Number(row.dataset.depth) * 18 + "px";
      row.onclick = (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-connection-toggle]")
        )
          return;
        if (callbacks.busy()) return;
        callbacks.select(id);
      };
      row
        .querySelector<HTMLButtonElement>("[data-connection-toggle]")
        ?.addEventListener("click", (event) => {
          event.stopPropagation();
          const node = store.connectionTree.nodes.find((n) => n.id === id);
          if (node?.kind === "group")
            void change((s) =>
              s.setConnectionGroupExpanded(id, !node.expanded),
            );
        });
    });
  const library = root.querySelector<HTMLElement>(".connection-library")!;
  const tree = root.querySelector<HTMLElement>("#connection-tree")!;
  type DropTarget =
    | { sourceId: string; parentId: string | null; beforeId: string | null }
    | { error: string };
  bindPointerReorder<DropTarget>({
    // This section is replaced by renderConnection; listeners never accumulate
    // on its cached outer root when another connection is selected.
    root: library,
    selector: "[data-connection-node]",
    exclude: ".connection-toggle",
    busy: callbacks.busy,
    start: () => {
      close();
      activeDrag = { root, cancel: cancelPointerReorder };
    },
    move: (source, point) => {
      clearTargets();
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !library.contains(hit)) return;
      const sourceId = source.dataset.connectionNode!;
      const row = hit.closest<HTMLElement>("[data-connection-node]");
      try {
        if (row && library.contains(row)) {
          const position = dropPosition(row, point.y);
          const target = destination(
            sourceId,
            row.dataset.connectionNode!,
            position,
          );
          row.dataset.drop = position;
          row.dataset.dropLabel =
            position === "before"
              ? t("前に移動")
              : position === "after"
                ? t("後ろに移動")
                : t("グループ内に移動");
          return { sourceId, ...target };
        }
        if (
          hit === library ||
          hit.id === "connection-tree" ||
          hit.closest(".connection-tree-empty")
        ) {
          const target = destination(sourceId, null, "inside");
          tree.dataset.drop = "inside";
          tree.dataset.dropLabel = t("ルートの末尾に移動");
          return { sourceId, ...target };
        }
      } catch (error) {
        return {
          error: tError(error),
        };
      }
    },
    drop: (_source, target) => {
      if ("error" in target) {
        report(target.error);
        return;
      }
      // The helper clears drag state before this callback; use this frozen target.
      void change(
        (s) =>
          s.moveConnectionNode(
            target.sourceId,
            target.parentId,
            target.beforeId,
          ),
        () => target.sourceId,
      );
    },
    cancel: clearDrag,
    scrollContainers: () => [
      library,
      root.querySelector<HTMLElement>("#connection-tree")!,
    ],
  });
  root.onpointerdown = (event) => {
    if (
      popup?.id === "connection-context-menu" &&
      event.target instanceof Node &&
      !popup.contains(event.target)
    )
      close();
  };
  root.onkeydown = (event) => {
    if (event.key === "Escape" && popup) {
      event.preventDefault();
      close();
      return;
    }
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("#connection-tree") ||
      callbacks.busy()
    )
      return;
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      event.stopPropagation();
      const row = event.target.closest<HTMLElement>("[data-connection-node]");
      const id = row?.dataset.connectionNode ?? null;
      const bounds = (row ?? event.target).getBoundingClientRect();
      if (id) callbacks.select(id);
      contextMenus.get(root)?.(id, bounds.left + 12, bounds.bottom);
      return;
    }
    const rows = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-connection-select]"),
    ];
    const index = rows.findIndex((button) => button === event.target);
    if (index < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[
        Math.max(
          0,
          Math.min(
            rows.length - 1,
            index + (event.key === "ArrowDown" ? 1 : -1),
          ),
        )
      ]?.focus();
    }
  };
}
