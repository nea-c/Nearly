import { t, text, html } from "./i18n.js";
import type { Store } from "./core.js";
import { native, windowIcon, windowMaximized } from "./api.js";
import {syncIndicatorClass} from './sync-presentation.js';
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function titlebar(store: Store, active: string, settingsOpen: boolean) {
  const gear =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9.5 3-.6 2.4-2 .9-2.2-.7-2.5 4.3L4 11.5v2l-1.8 1.6 2.5 4.3 2.2-.7 2 .9.6 2.4h5l.6-2.4 2-.9 2.2.7 2.5-4.3-1.8-1.6v-2l1.8-1.6-2.5-4.3-2.2.7-2-.9L14.5 3z"/><circle cx="12" cy="12.5" r="3.5"/></svg>';
  return html`<header class="titlebar"><div class="tabs" role="tablist" aria-label="作業タブ">${store.workspaces
    .map((w) => {
      const job = store.tabs.find((t) => t.id === w.jobId),
        p = w.connection ?? store.ownRetainedForWorkspace?.(w.id)?.profile;
      const name =
        (p?.name || t("新しいタブ")) +
        (job ? " / " + (job.remote.split("/").pop() || "/") : "");
      const endpoint = p ? `${p.user}@${p.host}:${p.port}` : t("未接続");
      return html`<div class="tab ${active === w.id ? "active" : ""}"><button role="tab" aria-selected="${active === w.id}" data-tab="${esc(w.id)}" title="${esc(name + " — " + endpoint)}"><span class="dot ${syncIndicatorClass(job)}"></span><span>${esc(name)}</span></button><button data-close="${esc(w.id)}" aria-label="${esc(text`${p?.name || t("作業")} のタブを閉じる`)}" ${w.starting ? "disabled" : ""}>×</button></div>`;
    })
    .join(
      "",
    )}</div><button id="add-tab" class="add-tab" aria-label="新しいタブ" title="新しいタブ (Ctrl+T)" ${store.workspaces.length >= 16 ? "disabled" : ""}>＋</button><div class="title-drag" data-tauri-drag-region aria-label="ウィンドウを移動"></div><button id="settings-toggle" class="settings-toggle" aria-label="設定" aria-expanded="${settingsOpen}" aria-controls="settings-popup">${gear}</button><span class="caption-divider" aria-hidden="true"></span><div class="window-controls"><button id="window-minimize" aria-label="最小化" ${native ? "" : "disabled"}>${windowIcon("minimize")}</button><button id="window-maximize" aria-label="${windowMaximized ? t("元のサイズに戻す") : t("最大化")}" ${native ? "" : "disabled"}>${windowIcon(windowMaximized ? "restore" : "maximize")}</button><button id="window-close" aria-label="ウィンドウを閉じる" ${native ? "" : "disabled"}>${windowIcon("close")}</button></div></header>`;
}
