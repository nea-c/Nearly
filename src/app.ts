import {retainedSyncsInWorkspaceOrder} from "./workspace-order.js";
import {sessionResumeContext,syncActionLabel,resumeActionLabel,currentSyncHelp,resumeSyncHelp} from './sync-actions.js';
import { initializeStartupUpdate } from "./startup-update.js";
import { initializeUpdateRestart } from "./update-recovery.js";
import { syncPathSummary } from "./sync-path-summary.js";
import { getDisplayVersion } from "./version.js";
import { freezeUpdateRoots, settleUpdateWrites } from "./startup-update-settle.js";
import { createWindowStore, snapshotWorkspaceTransfer, hydrateWorkspaceTransfer, detachTransferredWorkspace } from "./workspace-transfer.js";
import { transferText } from "./window-transfer-ui.js";
import { initializeNativeTabDrag, publishTabStrip, reorderTabNodes, detachedPreviewReady } from "./native-tab-drag.js";
import { applyPersistentSettings } from "./shared-settings.js";
import { registerWorkspace, type WindowRegistration, type WindowTransferRecord, type TabDragStatus } from "./api.js";
const rawError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
import {
  t as tr,
  text as trText,
  html,
  tError,
  setLanguage,
  getLanguage,
} from "./i18n.js";
import { connectionError } from "./connection-errors.js";
import { applyExplorerDensity } from "./explorer-density.js";
import {
  bookmarkBar,
  bindBookmarks,
  captureBookmarks,
} from "./folder-bookmarks.js";
import {
  bookmarkTreeDragging,
  cancelBookmarkTreeDrag,
  closeBookmarkTree,
} from "./bookmark-tree-ui.js";
import {
  closeColumnMenu,
  bindColumns,
  columnsHead,
  columnCell,
  visibleColumns,
  ColumnSortState,
  sortEntries,
} from "./file-columns.js";
import "./context-menu.js";
import { showBlockedCloseNotice, refreshBlockedCloseNotice } from "./window-close-notice.js";
import { sameRetainedConnection, retainedEntryState } from "./retained-sync-state.js";
import type { RetainedSync } from "./retained-sync.js";
import { RefreshQueue, remoteDirtyPaths, type RemoteChanges } from "./auto-refresh.js";
import { DirectoryCache } from "./directory-cache.js";
import { bindMarqueeSelection } from "./marquee-selection.js";
import { pointerReordering, cancelPointerReorder } from "./pointer-reorder.js";
import {
  parentFolder,
  navigationIcon,
  normalizeLocalBrowse,
} from "./navigation.js";
import {
  Store,
  Queue,
  remotePath,
  conflict,
  exclusionKey,
  validateRules,
  type Profile,
  type Entry,
  type SyncTab,
  type Workspace,
  type ThemePreference,
  type Settings,
} from "./core.js";
import {
  native,
  invoke,
  windowControl,
  windowMaximized,
  windowIcon,
} from "./api.js";
import { FolderTree, childPath, supportedName, PC_ROOT } from "./tree.js";
import { syncSettingsMarkup, bindSyncSettings } from "./sync-settings.js";
import { bindFileActions, refreshFileActionLocale } from "./file-actions.js";
import { applyTreeRatios, bindTreeSplitters } from "./pane-layout.js";
import {
  captureTabStrip,
  bindTabStrip,
  revealSelectedTab,
} from "./tab-strip.js";
import { titlebar } from "./titlebar.js";
import {
  connectionTreeMarkup,
  bindConnectionTree,
  closeConnectionTreePopup,
  connectionTreeDragging,
  cancelConnectionTreeDrag,
} from "./connection-tree-ui.js";
import {
  cancelHostKeyApproval,
  showHostKeyApproval,
} from "./host-key-approval.js";
import {
  mockEnabled,
  canUseConnection,
  connectionModeOptions,
  parseConnectionMode,
  disabledMockMessage,
} from "./connection-mode.js";
import { sameSettingsAfterHostPin } from "./settings-revision.js";
type Side = "local" | "remote";
const retrying = new Set<string>();
const closingWorkspaces = new Set<string>();
const treeScrolls = new WeakMap<FolderTree, { top: number; left: number }>();
const connectionViews = new Map<string, HTMLElement>();
const connectionStates = new Map<string, ConnectionDialog>();
const columnSorts = new WeakMap<Workspace, ColumnSortState>();
const parentSelections = new WeakMap<Workspace, Set<Side>>();
const directoryCaches = new WeakMap<
  Workspace,
  Record<Side, DirectoryCache<Entry>>
>();
function directoryCache(w: Workspace, side: Side) {
  let caches = directoryCaches.get(w);
  if (!caches) {
    caches = {
      local: new DirectoryCache<Entry>(0),
      remote: new DirectoryCache<Entry>(),
    };
    directoryCaches.set(w, caches);
  }
  return caches[side];
}
function parentSelection(w: Workspace) {
  let selected = parentSelections.get(w);
  if (!selected) {
    selected = new Set();
    parentSelections.set(w, selected);
  }
  return selected;
}
function columnSort(w: Workspace) {
  let state = columnSorts.get(w);
  if (!state) {
    state = new ColumnSortState({
      local: store.paneColumns.local.sort,
      remote: store.paneColumns.remote.sort,
    });
    columnSorts.set(w, state);
  }
  return state;
}
let connectionMutationPending = false;
let bookmarkMutationPending = false;
const paneScrolls = new WeakMap<
  Workspace,
  Map<string, { top: number; left: number }>
>();
function paneScrollKey(w: Workspace, side: Side, path: string) {
  return JSON.stringify([
    side,
    side === "remote" ? workspaceProfile(w) : null,
    path,
  ]);
}
let selectionDrag = false;
// Listing state belongs to a pane and its committed path, not the shared notice
// or the tree's independently loaded children. Sorting may replace entry arrays.
const listingStates = new WeakMap<
  Workspace,
  Partial<Record<Side, { path?: string; errorPath?: string }>>
>();
function listingState(w: Workspace, side: Side) {
  let states = listingStates.get(w);
  if (!states) listingStates.set(w, (states = {}));
  return (states[side] ??= {});
}
function listingSucceeded(w: Workspace, side: Side, path: string) {
  const state = listingState(w, side);
  state.path = path;
  state.errorPath = undefined;
}
let splitterDragging = false;
let deferredPathRender = false;
let cancelSplitter: (() => void) | undefined;
let finishSelectionDrag: (() => void) | undefined;
let pointerBusy = false;
let interactionRenderTimer: ReturnType<typeof setTimeout> | undefined;
let wheelQuietUntil = 0;
let wheelRenderPending = false;
let wheelRenderTimer: ReturnType<typeof setTimeout> | undefined;
document.addEventListener(
  "wheel",
  (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(
        ".table-scroll,.folder-tree,#connection-tree,.bookmark-tree-menu",
      )
    )
      return;
    wheelQuietUntil = performance.now() + 180;
    clearTimeout(wheelRenderTimer);
    wheelRenderTimer = setTimeout(() => {
      if (wheelRenderPending) {
        wheelRenderPending = false;
        render();
      }
    }, 190);
  },
  { passive: true },
);
document.addEventListener(
  "pointerdown",
  (e) => {
    if (
      e.target instanceof Element &&
      e.target.closest(".table-scroll,.folder-tree,.retained-syncs")
    ) {
      pointerBusy = true;
    }
  },
  true,
);
document.addEventListener(
  "pointerup",
  () => {
    pointerBusy = false;
  },
  true,
);
document.addEventListener(
  "pointercancel",
  () => {
    pointerBusy = false;
  },
  true,
);
window.addEventListener("blur", () => {
  pointerBusy = false;
  cancelConnectionTreeDrag();
  finishSelectionDrag?.();
  cancelSplitter?.();
});
type ConnectionDialog = {
  type: "connect";
  workspaceId: string;
  profileId: string;
  nodeId?: string;
  info?: string;
  keyError?: { profile: string; message: string };
};
type Dialog =
  | {
      type: "profile";
      p: Partial<Profile>;
      returnTo?: ConnectionDialog;
      parentId?: string | null;
    }
  | { type: "start"; workspaceId:string; p: Profile; local: string; remote: string; retained?: RetainedSync };
let store = new Store(),
  selected = "",
  active = "",
  localBrowse = "C:\\Projects",
  remoteBrowse = "/",
  entries: Record<Side, Entry[]> = { local: [], remote: [] },
  notice = "",
  dialog: Dialog | null = null,
  loading = false,
  settingsAvailable = false,
  initialized = false;
let themeSaving = false;
let windowRegistration: WindowRegistration | undefined;
let windowClosing = false;
let startupFailed = false;
function newWorkspaceLocal(profileId: string) {
  const p=store.profiles.find(p=>p.id===profileId);
  return (p ? store.lastBrowse(p).local : undefined) ?? defaultLocalBrowse;
}
async function closeEmptyWindow() {
  if(windowClosing) return;
  windowClosing=true; active="";
  document.documentElement.dataset.windowClosing="true";
  cancelPointerReorder(); reconcileLocalWatch();
  const app=document.querySelector<HTMLElement>("#app");
  if(app) { app.inert=true; app.querySelector(".tabs")?.replaceChildren(); app.querySelector("main")?.replaceChildren(); }
  try {
    if(windowRegistration) await invoke("close_empty_window");
    else if(native) await windowControl("close");
    else window.close();
  } catch(error) {
    windowClosing=false;
    document.documentElement.dataset.windowClosing="false";
    renderEmptyWindow();
    showBlockedCloseNotice(rawError(error));
  }
}
function renderEmptyWindow() {
  const app=document.querySelector<HTMLElement>("#app");
  if(!app) return;
  app.inert=false;
  app.innerHTML=titlebar(store,"",settingsOpen)+html`<main>${startupFailed && notice ? html`<div class="notice" role="alert">${esc(localizedNotice(notice))}</div>` : ""}</main>`;
  document.documentElement.dataset.emptyWindowReason=startupFailed?"startup-error":"closed";
  const on=(selector:string, action:()=>void)=>{const button=app.querySelector<HTMLButtonElement>(selector);if(button)button.onclick=action;};
  on("#window-close",()=>{void closeEmptyWindow();});
  on("#window-minimize",()=>{void windowControl("minimize").catch(message);});
  on("#window-maximize",()=>{void windowControl("toggleMaximize").catch(message);});
  on("#add-tab",addWorkspace);
  const add=app.querySelector<HTMLButtonElement>("#add-tab");if(add)add.disabled=!settingsAvailable||!initialized;
  on("#settings-toggle",()=>{settingsOpen=!settingsOpen;renderSettings();});
  renderSettings();
  void publishTabStrip();
}
const movingWorkspaces = new Set<string>();
const outboundTransfers = new Map<string, WindowTransferRecord>();
let transferEventsReady = false;
const bufferedTransferEvents = new Map<string, WindowTransferRecord>();
let incomingTransfer: WindowTransferRecord | undefined;
let incomingPreviousActive: string | undefined;
let incomingOrderChanged = false;
let previewBootstrap = false;
const incomingReady = new Map<string, Promise<void>>();
let nativeDrag: {workspaceId:string; dragId?:string; cancelRequested?:boolean; cancelSent?:boolean} | undefined;
function workspaceMoving(id: string) { return movingWorkspaces.has(id); }
function transferBusy(id: string) {
  const w = store.workspaces.find(w => w.id === id);
  return !w || workspaceMoving(id) || closingWorkspaces.has(id) || !!dialog || !!w.connecting || !!w.starting ||
    w.loading.local || w.loading.remote || selectionDrag || splitterDragging || pointerReordering() ||
    retainedWriteCount > 0 || !!document.querySelector(".operation-overlay,[role=dialog]");
}
function applyTransferLock() {
  const locked = workspaceMoving(active);
  const previewLocked = previewBootstrap || (incomingTransfer?.targetKind === "new" && ["dragging","pending"].includes(incomingTransfer.phase));
  document.querySelectorAll<HTMLElement>("#app,#modal-root,#settings-root").forEach(root => {
    if(previewLocked){root.inert=true;root.dataset.previewTransferInert="true";}
    else if(root.dataset.previewTransferInert==="true"){root.inert=!!updateSettleToken;delete root.dataset.previewTransferInert;}
  });
  document.querySelectorAll<HTMLElement>("main").forEach(main => {
    main.inert = locked;
    main.dataset.transferPending = String(locked);
  });
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach(tab => {
    const pending = workspaceMoving(tab.dataset.tab!);
    tab.dataset.transferPending = String(pending);
    const shell = tab.closest<HTMLElement>(".tab");
    if (shell) {
      shell.dataset.transferPending = String(pending);
      shell.dataset.transferIncoming = String(!!incomingTransfer && ["dragging","pending"].includes(incomingTransfer.phase) && incomingTransfer.workspaceId === tab.dataset.tab);
      shell.classList.toggle("tab-detached-source",detachedPreviewReady(tab.dataset.tab!));
      shell.querySelector<HTMLButtonElement>("[data-close]")!.disabled = pending;
    }
  });
}
function acceptTransferRecord(record: WindowTransferRecord) {
  if (!windowRegistration || !record || !["pending", "committed", "aborted"].includes(record.phase)) return;
  if (!transferEventsReady) { bufferedTransferEvents.set(record.token, record); return; }
  if (record.sourceLabel === windowRegistration.label && movingWorkspaces.has(record.workspaceId) && !outboundTransfers.has(record.token)) {
    outboundTransfers.set(record.token, record);
    void monitorOutboundTransfer(record, true);
  }
  if (record.targetLabel === windowRegistration.label && record.targetKind === "existing" && record.phase === "pending" && incomingTransfer?.token !== record.token) {
    if (incomingTransfer?.phase === "pending") { void invoke("abort_workspace_transfer", {token:record.token}).catch(message); return; }
    incomingTransfer = record;
    incomingPreviousActive = active;
    void stageIncomingTransfer(record);
    return;
  }
  if (record.sourceLabel === windowRegistration.label && outboundTransfers.has(record.token)) {
    if (record.phase === "pending") return;
    outboundTransfers.delete(record.token);
    nativeDrag = undefined;
    movingWorkspaces.delete(record.workspaceId);
    if (record.phase === "committed") {
      const old = store.workspaces.find(w => w.id === record.workspaceId);
      if (old) {
        if (active !== old.id) captureWorkspace();
        automaticRefresh.forget(refreshKey(old,"local"));
        automaticRefresh.forget(refreshKey(old,"remote"));
        automaticRefresh.forget(old.id+":remote-tree");
        dirtyRemoteTrees.delete(old);
        const wasLast = store.workspaces.length === 1;
        detachTransferredWorkspace(store, old.id);

        connectionViews.delete(old.id); connectionStates.delete(old.id);
        if (wasLast) { void closeEmptyWindow(); return; }
        if (active === old.id) { active = store.workspaces[0].id; restoreWorkspace(); revealSelectedTab(); }
        for (const w of store.workspaces) void registerWorkspace(w.id).catch(message);
      }
    } else message(transferText("ウィンドウへの移動を完了できませんでした。元のタブを引き続き使用できます。", "The move did not complete. You can continue using the original tab."));
    document.documentElement.dataset.transferPhase = record.phase;
    render();
  }
  if (record.targetLabel === windowRegistration.label && incomingTransfer?.token === record.token) {
    if(incomingTransfer.phase === "committed" && record.phase !== "committed") return;
    const wasPreview = incomingTransfer.phase === "dragging";
    incomingTransfer = record;
    if(wasPreview && record.phase === "pending") void finishIncomingTransfer(record).catch(message);
    if (record.phase === "committed") {
      previewBootstrap = false;
      movingWorkspaces.delete(record.workspaceId);
      document.documentElement.dataset.transferPhase = "committed";
      initialized = true; applyTransferLock(); render();
      if (record.targetKind === "existing" && incomingOrderChanged) {
        incomingOrderChanged=false;
        void persist(undefined,undefined,true).catch(message);
      }
    } else if (record.phase === "aborted") {
      previewBootstrap = false;
      // Remove only the unclaimed incoming UI. Existing target owners keep their sessions.
      movingWorkspaces.delete(record.workspaceId);
      const staged = store.workspaces.find(w => w.id === record.workspaceId);
      if (staged) {
        store.workspaces = store.workspaces.filter(w => w !== staged);
        store.tabs = store.tabs.filter(j => j.id !== staged.jobId);
      }
      if (active === record.workspaceId) active = store.workspaces.find(w=>w.id===incomingPreviousActive)?.id ?? store.workspaces[0]?.id ?? "";
      incomingTransfer = undefined; incomingPreviousActive = undefined; incomingOrderChanged=false;
      applyTransferLock();
      if (active) restoreWorkspace();
      document.documentElement.dataset.transferPhase = "aborted";
      render();
    }
  }
}
function finishIncomingTransfer(record:WindowTransferRecord):Promise<void> {
  if(incomingTransfer?.token !== record.token || incomingTransfer.phase === "committed") return Promise.resolve();
  const previous=incomingReady.get(record.token);if(previous)return previous;
  if(record.phase !== "pending")return Promise.reject(Error("Native mouse-up has not authorized this transfer"));
  const pending=(async()=>{
    try {
      acceptTransferRecord(await invoke("workspace_transfer_ready",{token:record.token}));
      if(incomingTransfer?.token===record.token && incomingTransfer.phase==="pending")acceptTransferRecord(await invoke("workspace_transfer_status",{token:record.token}));
      if(incomingTransfer?.token!==record.token || incomingTransfer.phase!=="committed")throw Error("Workspace transfer did not commit");
      const current=store.workspaces.find(w=>w.id===record.workspaceId);if(current && !current.connection)openConnection(current);
    } catch(error) {
      try{acceptTransferRecord(await invoke("abort_workspace_transfer",{token:record.token}));}catch{/* Preserve the native ownership outcome. */}
      throw error;
    }
  })().finally(()=>incomingReady.delete(record.token));
  incomingReady.set(record.token,pending);return pending;
}
function positionIncoming(record: WindowTransferRecord) {
  const previous=JSON.stringify(store.serialize().retainedSyncs?.map(r=>r.id));
  const ids = store.workspaces.map(w=>w.id).filter(id=>id!==record.workspaceId);
  const before = record.beforeId ? ids.indexOf(record.beforeId) : -1;
  const index = before >= 0 ? before : Math.max(0,Math.min(ids.length,record.targetIndex ?? ids.length));
  ids.splice(index,0,record.workspaceId); store.reorderWorkspaces(ids);
  incomingOrderChanged=previous!==JSON.stringify(store.serialize().retainedSyncs?.map(r=>r.id));
}
async function stageIncomingTransfer(record: WindowTransferRecord) {
  try {
    if(!initialized || !settingsAvailable || dialog || settingsOpen || themeSaving || connectionMutationPending || bookmarkMutationPending)
      throw Error("Destination window is busy");
    captureWorkspace();
    // Serialize with this window's writes before refreshing shared retained metadata.
    let data: Settings;
    for (;;) {
      const queuedSettings=settingsWrites, queuedRetained=retainedWrites;
      await queuedSettings.catch(()=>{}); await queuedRetained.catch(()=>{});
      const before=JSON.stringify(store.serialize());
      data=await invoke("load_settings");
      if (queuedSettings===settingsWrites && queuedRetained===retainedWrites && before===JSON.stringify(store.serialize())) break;
      if (incomingTransfer?.token !== record.token || incomingTransfer.phase !== "pending") return;
    }
    if (incomingTransfer?.token !== record.token || incomingTransfer.phase !== "pending") return;
    applyPersistentSettings(store,data);
    const restored = hydrateWorkspaceTransfer(store,record.payload,record.workspaceId);
    movingWorkspaces.add(restored.id); positionIncoming(record);
    for(const side of ["local","remote"] as const) listingSucceeded(restored,side,browsePath(restored,side));
    captureWorkspace();
    incomingPreviousActive=active;
    active=restored.id; restoreWorkspace(); revealSelectedTab(); render();
    const outcome = await invoke("workspace_transfer_ready",{token:record.token});
    acceptTransferRecord(outcome);
  } catch(error) {
    try { acceptTransferRecord(await invoke("abort_workspace_transfer",{token:record.token})); }
    catch { /* Coordinator outcome remains authoritative; preserve staged state until status resolves. */ }
    message(error);
  }
}
async function monitorOutboundTransfer(record: WindowTransferRecord, immediate = false) {
  const started = Date.now();
  while (outboundTransfers.has(record.token)) {
    if (!immediate) await new Promise(resolve => setTimeout(resolve, 500));
    immediate = false;
    if (!outboundTransfers.has(record.token)) break;
    try {
      let current = await invoke("workspace_transfer_status", { token: record.token });
      if (current.phase === "pending" && Date.now() - started > 35000) {
        try { current = await invoke("abort_workspace_transfer", { token: record.token }); }
        catch { current = await invoke("workspace_transfer_status", { token: record.token }); }
      }
      acceptTransferRecord(current);
    } catch { /* Keep ownership frozen until the coordinator confirms its outcome. */ }
  }
}
function acceptNativeDrag(status: TabDragStatus) {
  if (!windowRegistration || status.sourceLabel !== windowRegistration.label ||
      nativeDrag?.workspaceId !== status.workspaceId) return;
  if (nativeDrag.dragId && nativeDrag.dragId !== status.dragId) return;
  nativeDrag.dragId = status.dragId;
  document.documentElement.dataset.tabDragPhase = status.phase;
  if (status.phase === "dragging") {
    if(nativeDrag.cancelRequested) requestNativeDragCancel();
    return;
  }
  if (status.phase === "pending" || status.phase === "committed") {
    if (status.token) void invoke("workspace_transfer_status",{token:status.token}).then(acceptTransferRecord).catch(()=>{});
    return;
  }
  nativeDrag = undefined;
  movingWorkspaces.delete(status.workspaceId);
  if (status.phase === "reordered") {
    const ids=store.workspaces.map(w=>w.id).filter(id=>id!==status.workspaceId);
    const before=status.beforeId ? ids.indexOf(status.beforeId) : -1;
    ids.splice(before>=0?before:Math.max(0,Math.min(ids.length,status.targetIndex??ids.length)),0,status.workspaceId);
    reorderTabNodes(ids); commitTabOrder(ids);
  }
  applyTransferLock(); reconcileLocalWatch();
  publishTabStrip(); updatePrimaryState();
}
function requestNativeDragCancel() {
  const gesture=nativeDrag;
  if(!gesture || gesture.cancelSent) return;
  gesture.cancelSent=true;
  void invoke("cancel_tab_drag",{dragId:gesture.dragId ?? null}).then(status=>{
    if(nativeDrag===gesture) acceptNativeDrag(status);
  }).catch(()=>{if(nativeDrag===gesture) gesture.cancelSent=false;});
}
document.addEventListener("keydown", event => {
  if(event.key!=="Escape" || !nativeDrag) return;
  event.preventDefault(); event.stopImmediatePropagation();
  nativeDrag.cancelRequested=true;
  requestNativeDragCancel();
},true);
async function beginNativeTabDrag(id:string, grab:{x:number;y:number}, title:string) {
  if (!windowRegistration || nativeDrag || transferBusy(id)) return;
  captureWorkspace();
  try {
    const payload=snapshotWorkspaceTransfer(store,id,{modalOpen:!!dialog,fileOperationBusy:!!document.querySelector(".operation-overlay")});
    nativeDrag={workspaceId:id}; movingWorkspaces.add(id); applyTransferLock(); reconcileLocalWatch(); updatePrimaryState();
    await registerWorkspace(id);
    await publishTabStrip(true);
    if(nativeDrag?.cancelRequested) {
      nativeDrag=undefined; movingWorkspaces.delete(id); applyTransferLock(); reconcileLocalWatch(); updatePrimaryState(); return;
    }
    const status=await invoke("begin_tab_drag",{workspaceId:id,payload,grab,title});
    acceptNativeDrag(status);
    while(nativeDrag?.workspaceId===id) {
      await new Promise(resolve=>setTimeout(resolve,500));
      if(nativeDrag?.workspaceId!==id) break;
      if(nativeDrag.dragId) {
        try { acceptNativeDrag(await invoke("tab_drag_status",{dragId:nativeDrag.dragId})); }
        catch { /* Preserve ownership until a confirmed coordinator outcome. */ }
      }
    }
  } catch(error) {
    if(nativeDrag?.workspaceId===id && !nativeDrag.dragId && !Array.from(outboundTransfers.values()).some(r=>r.workspaceId===id)) {
      nativeDrag=undefined; movingWorkspaces.delete(id); applyTransferLock(); reconcileLocalWatch(); updatePrimaryState();
    }
    message(error);
  }
}
let settingsOpen = false;
// Sample OS appearance once. Saved explicit choices never follow later changes.
const initialSystemDark = window.matchMedia(
  "(prefers-color-scheme: dark)",
).matches;
function applyTheme() {
  const resolved =
    store.theme === "system"
      ? initialSystemDark
        ? "dark"
        : "light"
      : store.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = store.theme;
  document.documentElement.style.colorScheme =
    resolved === "light" || resolved === "mint" ? "light" : "dark";
}
applyTheme();
const $ = (s: string) => document.querySelector<HTMLInputElement>(s),
  esc = (s: unknown) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
const demoFiles = (p: string): Entry[] =>
  [
    { name: "assets", dir: true, size: 0 },
    { name: "images", dir: true, size: 0 },
    { name: "index.html", dir: false, size: 4280 },
    { name: "style.css", dir: false, size: 2710 },
  ].filter((x) => !/[\\/]assets$/.test(p) || !x.dir);
let defaultLocalBrowse = localBrowse;
const workspace = () => store.workspaces.find((w) => w.id === active)!;
const tab = () => store.tabs.find((t) => t.id === workspace()?.jobId)!;
const profile = () => {
  return workspaceProfile(workspace());
};
function workspaceProfile(w: Workspace): Profile | undefined {
  return w?.connection;
}
function openConnection(w = workspace()) {
  if (w && workspaceMoving(w.id)) return;
  if (w.connection || w.connecting) return;
  connectionViews.delete(w.id);
  render();
}
function folderTree(
  w: Workspace,
  side: Side,
  p: Partial<Profile> = workspaceProfile(w) ?? {},
) {
  if (side === "remote") {
    const key = JSON.stringify(p ?? {});
    if (w.trees.remote.key !== key) {
      directoryCache(w, "remote").invalidate();
      const changed = !!w.trees.remote.key;
      w.trees.remote = new FolderTree("remote", "/", key);
      w.entries.remote = [];
      listingState(w, "remote").path = undefined;
      w.selections.remote.context(key, []);
      w.generation.remote++;
      w.loading.remote = false;
      if (changed)
        w.notice = tr(
          "接続先の設定が変わりました。リモートパスで Enter を押して再読込してください",
        );
      if (active === w.id) {
        entries = w.entries;
        notice = w.notice;
        loading = w.loading.local || w.loading.remote;
      }
    }
  }
  return w.trees[side];
}
async function loadTree(
  w: Workspace,
  side: Side,
  path: string,
  secret?: string,
) {
  const p = { ...workspaceProfile(w) },
    tree = folderTree(w, side, p),
    node = tree.node(path);
  if (node.loading) return;
  node.expanded = true;
  if (side === "remote" && !w.connection) {
    openConnection(w);
    return;
  }
  const token = tree.begin(path);
  const generation = w.generation[side];
  const stale = () =>
    !store.workspaces.includes(w) ||
    w.trees[side] !== tree ||
    (path !== PC_ROOT && w.generation[side] !== generation) ||
    !tree.current(path, token) ||
    (side === "remote" &&
      tree.key !== JSON.stringify(workspaceProfile(w) ?? {}));
  if (active === w.id) render();
  try {
    const drives =
      path === PC_ROOT
        ? native
          ? await invoke("list_drives")
          : [
              { path: "C:\\", name: "C:" },
              { path: "D:\\", name: "D:" },
            ]
        : undefined;
    const result = path === PC_ROOT ? [] : await readDirectory(w, side, path);
    if (!stale()) {
      const expanded = node.expanded;
      if (drives) tree.setDrives(drives);
      else tree.record(path, result);
      node.expanded = expanded;
    }
  } catch (error) {
    if (!stale()) node.error = rawError(error);
  } finally {
    if (tree.current(path, token)) node.loading = false;
    if (active === w.id && store.workspaces.includes(w)) render();
  }
}
function renderTree(side: Side) {
  if (side === "remote" && !workspace().connection)
    return html`<nav class="folder-tree" data-tree="remote">
      <div class="tree-caption">フォルダ</div>
      <p class="tree-note">未接続</p>
    </nav>`;
  const tree = folderTree(workspace(), side),
    current = side === "local" ? localBrowse : remoteBrowse;
  const nodeHtml = (
    path: string,
    name: string,
    depth: number,
    hidden = false,
  ): string => {
    const node = tree.peek(path),
      expanded = !!node?.expanded;
    const selected =
      side === "local"
        ? path.replace(/\\$/, "").toLowerCase() ===
          current.replace(/\\$/, "").toLowerCase()
        : path === current;
    const children =
      expanded && depth < 40
        ? (node?.children ?? [])
            .map((c) => nodeHtml(c.path, c.name, depth + 1, c.hidden))
            .join("")
        : "";
    const label = expanded ? tr("折り畳む") : tr("展開");
    const virtual = side === "local" && path === PC_ROOT;
    const chevron = html`<svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    >
      <path d="${expanded ? "m2 4 4 4 4-4" : "m4 2 4 4-4 4"}" />
    </svg>`;
    return html`<li
      role="treeitem"
      aria-expanded="${expanded}"
      aria-selected="${selected}"
    >
      <div
        class="tree-row ${selected ? "selected" : ""}"
        data-tree-row="${side}"
        data-tree-path="${esc(path)}"
        data-depth="${depth}"
      >
        <button
          class="tree-toggle"
          data-tree-toggle="${side}"
          data-tree-path="${esc(path)}"
          aria-label="${trText`${esc(name)} を${label}`}"
          ${node?.loading ? 'aria-busy="true"' : ""}
        >
          ${chevron}</button
        >${
          virtual
            ? '<span class="tree-label virtual-root">PC</span>'
            : html`<button
                class="tree-label"
                data-tree-select="${side}"
                data-tree-path="${esc(path)}"
                title="${esc(path)}"
              >
                <span class="entry-label ${hidden ? "hidden-item-label" : ""}"
                  ><span
                    class="folder-glyph"
                    data-entry-icon
                    aria-hidden="true"
                  ></span
                  ><span>${esc(name)}</span></span
                >
              </button>`
        }
      </div>
      ${
        expanded
          ? html`<ul role="group">
              ${node?.loading ? html`<li class="tree-note">読込中…</li>` : ""}${node?.error ? html`<li class="tree-error" role="alert">${esc(tError(node.error))}<button data-tree-retry="${side}" data-tree-path="${esc(path)}">再読込</button></li>` : ""}${children}${node?.loaded && !node.children.length ? html`<li class="tree-note">サブフォルダなし</li>` : ""}${node?.limited ? html`<li class="tree-note">先頭500フォルダを表示</li>` : ""}
            </ul>`
          : ""
      }
    </li>`;
  };
  return html`<nav
    class="folder-tree"
    data-tree="${side}"
    aria-label="${trText`${side === "local" ? tr("ローカル") : tr("リモート")}のフォルダツリー`}"
  >
    <div class="tree-caption">フォルダ</div>
    <ul role="tree">
      ${nodeHtml(tree.root, tree.root === PC_ROOT ? "PC" : tree.root, 0)}
    </ul>
  </nav>`;
}
function navigateFolder(side: Side, path: string) {
  if (!workspace().connection) {
    openConnection();
    return;
  }
  void refresh(side, { path }).catch(message);
}
function bindTrees(scope: ParentNode = document) {
  scope.querySelectorAll<HTMLElement>("[data-tree]").forEach((nav) => {
    const tree = folderTree(workspace(), nav.dataset.tree as Side);
    const saved = treeScrolls.get(tree);
    nav.scrollTop = saved?.top ?? 0;
    nav.scrollLeft = saved?.left ?? 0;
    nav.onscroll = () =>
      treeScrolls.set(tree, { top: nav.scrollTop, left: nav.scrollLeft });
  });
  scope
    .querySelectorAll<HTMLButtonElement>("[data-tree-toggle],[data-tree-retry]")
    .forEach((button) => {
      button.onclick = () => {
        try {
          const side = (button.dataset.treeToggle ??
              button.dataset.treeRetry) as Side,
            path = button.dataset.treePath!,
            w = workspace(),
            tree = folderTree(w, side),
            node = tree.node(path);
          if (node.expanded && !button.hasAttribute("data-tree-retry")) {
            node.expanded = false;
            render();
          } else {
            node.expanded = true;
            if (node.loaded && !node.error) render();
            else {
              if (button.hasAttribute("data-tree-retry"))
                directoryCache(w, side).invalidate();
              loadTree(w, side, path).catch(message);
            }
          }
        } catch (error) {
          message(error);
        }
      };
    });
  scope
    .querySelectorAll<HTMLButtonElement>("[data-tree-select]")
    .forEach((button) => {
      button.onclick = () =>
        navigateFolder(
          button.dataset.treeSelect as Side,
          button.dataset.treePath!,
        );
    });
  scope.querySelectorAll<HTMLElement>("[data-tree-row]").forEach((row) => {
    const toggle = row.querySelector<HTMLElement>(".tree-toggle");
    if (toggle) toggle.style.marginLeft = Number(row.dataset.depth) * 11 + "px";
    row.onclick = (event) => {
      if ((event.target as Element).closest("button")) return;
      row.querySelector<HTMLButtonElement>("[data-tree-select]")?.click();
    };
    row.oncontextmenu = (event) => {
      if ((event.target as Element).closest("[data-tree-select],.tree-toggle"))
        return;
      event.preventDefault();
      row.querySelector<HTMLButtonElement>("[data-tree-select]")?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    };
  });
}
function paintSelection(side: Side) {
  const selection = workspace().selections[side];
  if (selection.values().length) parentSelection(workspace()).delete(side);
  document
    .querySelectorAll<HTMLElement>(`[data-list="${side}"] [data-entry]`)
    .forEach((row) => {
      const selected = selection.has(row.dataset.name!);
      row.classList.toggle("selected", selected);
      row.setAttribute("aria-selected", String(selected));
      row.tabIndex = selection.focus === row.dataset.name ? 0 : -1;
    });
  const parent = document.querySelector<HTMLElement>(
    `[data-parent-row="${side}"]`,
  );
  if (parent) {
    const selected = parentSelection(workspace()).has(side);
    parent.classList.toggle("selected", selected);
    parent.setAttribute("aria-selected", String(selected));
  }
  const count = document.querySelector(`[data-selection-count="${side}"]`);
  if (count)
    count.textContent = selection.values().length
      ? " · " + selection.values().length + tr(" 件を選択")
      : "";
}
function bindSelections(onlySide?: Side) {
  for (const side of onlySide ? [onlySide] : ["local", "remote"] as Side[]) {
    const list = document.querySelector<HTMLElement>(`[data-list="${side}"]`)!;
    const selection = workspace().selections[side];
    const rows = () =>
      Array.from(
        list.querySelectorAll<HTMLElement>("[data-entry]:not([data-inert])"),
      );
    rows().forEach((row, index) => {
      row.onclick = (e) => {
        parentSelection(workspace()).delete(side);
        selection.clickName(row.dataset.name!, {
          ctrl: e.ctrlKey || e.metaKey,
          shift: e.shiftKey,
        });
        paintSelection(side);
        row.focus({ preventScroll: true });
      };
      row.onkeydown = (e) => {
        parentSelection(workspace()).delete(side);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          const next = Math.max(
            0,
            Math.min(
              rows().length - 1,
              index + (e.key === "ArrowDown" ? 1 : -1),
            ),
          );
          if (e.ctrlKey || e.metaKey)
            selection.focus = rows()[next].dataset.name!;
          else
            selection.clickName(rows()[next].dataset.name!, {
              shift: e.shiftKey,
            });
          paintSelection(side);
          rows()[next]?.focus();
        } else if (e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          selection.clickName(row.dataset.name!, {
            ctrl: e.ctrlKey || e.metaKey,
            shift: e.shiftKey,
          });
          paintSelection(side);
        } else if (e.key === "Enter") {
          e.preventDefault();
          row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        }
      };
    });
    list.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        parentSelection(workspace()).delete(side);
        selection.all();
        paintSelection(side);
        if ((e.target as Element).closest("[data-parent-row]"))
          rows()[0]?.focus();
      } else if (e.key === "Escape") {
        parentSelection(workspace()).delete(side);
        selection.clear();
        paintSelection(side);
      }
    };
    const w = workspace(),
      path = side === "local" ? w.localBrowse : w.remoteBrowse;
    bindMarqueeSelection({
      list,
      rows,
      selection,
      paint: () => {
        parentSelection(w).delete(side);
        paintSelection(side);
      },
      active: (value, cancel) => {
        selectionDrag = value;
        finishSelectionDrag = cancel;
      },
      current: () =>
        list.isConnected &&
        active === w.id &&
        (side === "local" ? w.localBrowse : w.remoteBrowse) === path,
      render,
    });
    const parent = list.querySelector<HTMLElement>("[data-parent-row]");
    if (parent) {
      const choose = () => {
        selection.clear();
        parentSelection(w).add(side);
        paintSelection(side);
        parent.focus({ preventScroll: true });
      };
      const open = () => {
        const target = parentFolder(side, path);
        if (target && !w.loading[side]) navigateFolder(side, target);
      };
      parent.onclick = (event) => {
        event.stopPropagation();
        choose();
      };
      parent.ondblclick = (event) => {
        event.stopPropagation();
        open();
      };
      parent.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        choose();
      };
      parent.onkeydown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
          return;
        const control = event.ctrlKey || event.metaKey;
        if (control && !["c", "x", "v"].includes(event.key.toLowerCase()))
          return;
        if (
          ![
            "Enter",
            "ArrowDown",
            "ArrowUp",
            "Escape",
            " ",
            "Delete",
            "F2",
            "ContextMenu",
          ].includes(event.key) &&
          !control
        )
          return;
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          if (parentSelection(w).has(side)) open();
        } else if (event.key === "ArrowDown" && rows()[0]) {
          event.preventDefault();
          rows()[0].click();
          rows()[0].focus();
        } else if (event.key === "Escape") {
          parentSelection(w).delete(side);
          paintSelection(side);
        } else {
          event.preventDefault();
          if (event.key === " ") choose();
        }
      };
    }
  }
}
function bindOperations() {
  const w = workspace(),
    p = profile(),
    profileSnapshot = p ? { ...p } : undefined;
  const signature = JSON.stringify(profileSnapshot),
    local = w.localBrowse,
    remote = w.remoteBrowse;
  bindFileActions({
    workspaceId: w.id,
    sessionId: w.connection?.mode === "sftp" ? w.id : undefined,
    profile: profileSnapshot,
    panes: {
      local: {
        path: local,
        entries: w.entries.local,
        selection: w.selections.local,
        loading: w.loading.local,
      },
      remote: {
        path: remote,
        entries: w.entries.remote,
        selection: w.selections.remote,
        loading: w.loading.remote || !w.connection,
      },
    },
    syncRoots: store.tabs
      .filter((t) => t.status !== "stopped")
      .map((t) => t.local),
    selected: paintSelection,
    valid: () =>
      !workspaceMoving(w.id) && store.workspaces.includes(w) &&
      JSON.stringify(workspaceProfile(w)) === signature &&
      w.localBrowse === local &&
      w.remoteBrowse === remote,
    changed: async (side, passphrase, change) => {
      if (change.action === "createfile" || change.action === "mkdir") {
        const parent = change.parent!;
        const samePath = (a: string, b: string) => side === "local"
          ? a.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase() === b.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase()
          : (a.replace(/\/$/, "") || "/") === (b.replace(/\/$/, "") || "/");
        // Creation never relocates another view or clears another pane's selection/tree.
        for (const target of store.workspaces) {
          if (side === "remote" && JSON.stringify(workspaceProfile(target)) !== signature) continue;
          directoryCache(target, side).invalidate();
          const node = target.trees[side].peek(parent);
          if (node) { node.loaded = false; node.loading = false; node.request++; }
        }
        if (!store.workspaces.includes(w) || JSON.stringify(workspaceProfile(w)) !== signature) return;
        const current = side === "local" ? w.localBrowse : w.remoteBrowse;
        if (samePath(current, parent)) {
          const expected = w.generation[side] + 1;
          const ok = await refresh(side, { restoring: true }, w);
          if (ok && change.created && active === w.id && w.generation[side] === expected && samePath(side === "local" ? w.localBrowse : w.remoteBrowse, parent)) {
            const name = change.paths[0]?.split(/[\\/]/).pop();
            if (name && w.entries[side].some(entry => entry.name === name)) {
              w.selections[side].clickName(name);
              paintSelection(side);
            }
          }
        } else {
          // A tree context may target a folder other than the committed list path.
          const tree = w.trees[side], node = tree.peek(parent);
          if (node) {
            const expanded = node.expanded, generation = w.generation[side], token = tree.begin(parent);
            try {
              const result = await readDirectory(w, side, parent);
              if (store.workspaces.includes(w) && w.trees[side] === tree && w.generation[side] === generation && tree.current(parent, token)) {
                tree.record(parent, result); tree.node(parent).expanded = expanded;
              }
            } finally {
              if (tree.current(parent, token)) node.loading = false;
              if (active === w.id && store.workspaces.includes(w)) render();
            }
          }
        }
        return;
      }
      for (const target of store.workspaces) {
        if (
          side === "remote" &&
          JSON.stringify(workspaceProfile(target)) !== signature
        )
          continue;
        const path =
          side === "local" ? target.localBrowse : target.remoteBrowse;
        const inside = (a: string, b: string) => {
          const clean = (s: string) =>
            side === "local"
              ? s.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase()
              : s.replace(/\/$/, "") || "/";
          a = clean(a);
          b = clean(b);
          return a === b || b.startsWith(a + (side === "local" ? "\\" : "/"));
        };
        const removed =
          change.action === "delete" || change.action === "move"
            ? change.paths.find((source) => inside(source, path))
            : undefined;
        if (removed) {
          const parent =
            side === "remote"
              ? remotePath(removed + "/..")
              : removed.replace(/[\\/][^\\/]+[\\/]?$/, "") +
                (/^[A-Za-z]:$/.test(removed.replace(/[\\/][^\\/]+[\\/]?$/, ""))
                  ? "\\"
                  : "");
          if (side === "local") target.localBrowse = parent;
          else target.remoteBrowse = parent;
        }
        directoryCache(target, side).invalidate();
        target.selections[side].clear();
        target.trees[side].reset(
          side === "local" ? PC_ROOT : "/",
          side === "remote" ? signature : undefined,
        );
        target.generation[side]++;
        target.loading[side] = false;
        target.entries[side] = [];
        listingState(target, side).path = undefined;
      }
      if (active === w.id) {
        restoreWorkspace();
        await refresh(side);
      }
    },
  });
}
function captureWorkspace() {
  const w = workspace();
  if (w) {
    const map =
      paneScrolls.get(w) ?? new Map<string, { top: number; left: number }>();
    document.querySelectorAll<HTMLElement>("[data-list]").forEach((list) => {
      if (list.dataset.workspace === w.id && list.dataset.scrollKey) {
        map.set(list.dataset.scrollKey, {
          top: list.scrollTop,
          left: list.scrollLeft,
        });
        if (map.size > 64) map.delete(map.keys().next().value!);
      }
    });
    paneScrolls.set(w, map);
    Object.assign(w, {
      profileId: selected,
      localBrowse,
      remoteBrowse,
      entries,
      notice,
    });
  }
}
function restoreWorkspace() {
  const w = workspace();
  selected = w.profileId;
  localBrowse = w.localBrowse;
  remoteBrowse = w.remoteBrowse;
  entries = w.entries;
  notice = w.notice;
  loading = w.loading.local || w.loading.remote;
}
function leavePathEditor() {
  // Explicit workspace changes discard an unsubmitted path draft. Background
  // listing replies still defer rendering while this editor is being used.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest("form[data-path]"))
    focused.blur();
}
function switchWorkspace(id: string) {
  cancelPointerReorder();
  cancelBookmarkTreeDrag();
  cancelConnectionTreeDrag();
  if (id !== active) cancelHostKeyApproval();
  if (
    dialog ||
    workspace().connecting ||
    !store.workspaces.some((w) => w.id === id)
  )
    return;
  if (id !== active) closeConnectionTreePopup();
  leavePathEditor();
  captureWorkspace();
  revealSelectedTab();
  active = id;
  restoreWorkspace();
  render();
}
function addWorkspace() {
  if(windowClosing) return;
  cancelPointerReorder();
  cancelBookmarkTreeDrag();
  cancelConnectionTreeDrag();
  cancelHostKeyApproval();
  if (dialog || workspace()?.connecting || selectionDrag || pointerBusy) return;
  closeConnectionTreePopup();
  try {
    captureWorkspace();
    const w = store.createWorkspace(selected, newWorkspaceLocal(selected));
    // An unconnected tab is still a native-owned workspace. Register as soon
    // as it exists; close awaits this same deduplicated claim before cleanup.
    void registerWorkspace(w.id).catch(message);
    leavePathEditor();
    revealSelectedTab();
    active = w.id;
    restoreWorkspace();
    render();
    openConnection(w);
  } catch (e) {
    message(e);
  }
}
function closeWorkspace(id: string) {
  if (workspaceMoving(id)) return;
  cancelPointerReorder();
  cancelBookmarkTreeDrag();
  cancelConnectionTreeDrag();
  if (id === active) cancelHostKeyApproval();
  const w = store.workspaces.find((w) => w.id === id);
  if (!w) return;
  if (w.connecting) {
    message(tr("接続を中止してからタブを閉じてください"));
    return;
  }
  const job = store.tabs.find((t) => t.id === w.jobId);
  if (w.starting || (job && job.status !== "stopped")) {
    showBlockedCloseNotice(
      tr(
        "同期中のタブは閉じられません。同期停止を押し、停止完了後に改めて閉じてください。",
      ),
    );
    return;
  }
  if (id === active) closeConnectionTreePopup();
  leavePathEditor();
  void removeWorkspace(id).catch(message);
}
async function removeWorkspace(id: string) {
  const closing = store.workspaces.find((w) => w.id === id);
  if (!closing || closingWorkspaces.has(id)) return;
  closingWorkspaces.add(id);
  updatePrimaryState();
  try {
    if (windowRegistration) await registerWorkspace(id);
    if (native) await invoke("disconnect_session", { id });
  } catch (error) {
    closingWorkspaces.delete(id);
    updatePrimaryState();
    throw error;
  }
  if (store.ownRetainedForWorkspace(id)) {
    try { await mutateRetained(candidate=>candidate.closeRetainedWorkspace(id)); }
    catch(error) { closing.connection=undefined; closingWorkspaces.delete(id); if(active===id)restoreWorkspace(); render(); throw error; }
  }
  if (windowRegistration) {
    try { await invoke("unregister_workspace", { id }); }
    catch (error) { closingWorkspaces.delete(id); updatePrimaryState(); throw error; }
  }
  captureWorkspace();
  const index = store.workspaces.findIndex((w) => w.id === id);
  automaticRefresh.forget(refreshKey(closing,"local"));
  automaticRefresh.forget(refreshKey(closing,"remote"));
  automaticRefresh.forget(closing.id+":remote-tree");
  dirtyRemoteTrees.delete(closing);
  store.closeWorkspace(id);
  connectionViews.delete(id);
  connectionStates.delete(id);
  closingWorkspaces.delete(id);
  if (!store.workspaces.length) { await closeEmptyWindow(); return; }
  if (active === id) {
    leavePathEditor();
    revealSelectedTab();
    active =
      store.workspaces[
        Math.max(0, Math.min(index, store.workspaces.length - 1))
      ].id;
    restoreWorkspace();
  }
  render();
}

function commitTabOrder(ids:string[]){
  const previous=store.workspaces.map(w=>w.id);
  const before=JSON.stringify(store.serialize().retainedSyncs?.map(r=>r.id));
  if(!store.reorderWorkspaces(ids)){if(ids.length!==previous.length||ids.some((id,i)=>id!==previous[i]))render();return;}
  // The drag controller already moved the same header nodes. Keep the selected
  // workspace and its editor/list/connection DOM intact rather than repainting.
  captureTabStrip();
  if(before!==JSON.stringify(store.serialize().retainedSyncs?.map(r=>r.id)))
    void persist(undefined,undefined,true).catch(error=>message(trText`タブ順を保存できませんでした。再起動して保存状態を確認してください。 ${tError(error)}`));
}

let settingsWrites: Promise<void> = Promise.resolve();
let sharedSettingsDirty = false;
let sharedSettingsGeneration = 0;
let sharedSettingsReading = false;
function sharedSettingsIdle() {
  return initialized && settingsAvailable && !dialog && !settingsOpen && !themeSaving &&
    !connectionMutationPending && !bookmarkMutationPending && !retainedWriteCount &&
    !movingWorkspaces.size && !automaticBusy() &&
    !store.workspaces.some(w => w.connecting || w.starting);
}
function refreshSharedSettings() {
  if (!native || !sharedSettingsDirty || sharedSettingsReading || !sharedSettingsIdle()) return;
  sharedSettingsReading = true;
  const retainedAtRequest = retainedWrites;
  const read = settingsWrites.catch(() => {}).then(async () => {
    await retainedAtRequest.catch(() => {});
    if (!sharedSettingsIdle()) return;
    const before = JSON.stringify(store.serialize());
    const generation = sharedSettingsGeneration;
    const data = await invoke("load_settings");
    if (!sharedSettingsIdle() || retainedWrites !== retainedAtRequest || settingsWrites !== read || before !== JSON.stringify(store.serialize())) return;
    applyPersistentSettings(store, data);
    sharedSettingsDirty = sharedSettingsGeneration !== generation;
    setLanguage(store.language); document.documentElement.lang = store.language;
    applyExplorerDensity(store.compactExplorer); applyTheme(); render();
  }).catch(message).finally(() => { sharedSettingsReading = false; });
  settingsWrites = read;
}
type SettingsOverrides = Partial<
  Pick<
    Settings,
    | "folderBookmarks"
    | "bookmarkTree"
    | "bookmarkTreeChanged"
    | "profiles"
    | "retainedSyncs"
    | "connectionTree"
    | "connectionTreeChanged"
  >
>;
async function persist(
  overrides?: SettingsOverrides,
  beforeWrite?: () => void,
  lockOnFailure = false,
) {
  if (!settingsAvailable)
    throw Error(
      tr(
        "設定の読込に失敗しているため保存できません。元の設定を復元して再起動してください。",
      ),
    );
  const requested = overrides ? structuredClone(overrides) : undefined;
  const write = settingsWrites
    .catch(() => {})
    .then(async () => {
      if (!settingsAvailable)
        throw Error(
          tr(
            "設定の読込に失敗しているため保存できません。元の設定を復元して再起動してください。",
          ),
        );
      beforeWrite?.();
      const currentTree = store.connectionTree;
      const currentBookmarkTree = store.bookmarkTree;
      const browseRevision = store.browsePreferencesRevision;
      const selectedProfileRevision = store.lastSelectedProfileRevision;
      const data = structuredClone({ ...store.serialize(), ...requested });
      if(requested?.retainedSyncs)data.retainedSyncs=retainedSyncsInWorkspaceOrder(data.retainedSyncs!,store.workspaces);
      if (native) {
        const revision = await invoke("save_settings", { data });
        if (typeof revision === "number") store.settingsRevision = revision;
      } else localStorage.setItem("syncfiles-v1", JSON.stringify(data));
      if (data.browseLocationsChanged)
        store.markBrowseLocationsSaved(browseRevision);
      if (data.lastSelectedProfileChanged)
        store.markLastSelectedProfileSaved(selectedProfileRevision);
      if (requested?.folderBookmarks)
        store.folderBookmarks = requested.folderBookmarks;
      if (requested?.bookmarkTree) {
        store.bookmarkTree = requested.bookmarkTree;
        if (requested.bookmarkTreeChanged) store.markBookmarkTreeSaved();
      } else if (
        data.bookmarkTreeChanged &&
        store.bookmarkTree === currentBookmarkTree
      )
        store.markBookmarkTreeSaved();
      if (requested?.retainedSyncs) store.retainedSyncs=structuredClone(data.retainedSyncs!);
      if (requested?.profiles) {
        const removed = new Set(
          store.profiles
            .filter(
              (p) => !requested.profiles!.some((next) => next.id === p.id),
            )
            .map((p) => p.id),
        );
        store.profiles = requested.profiles;
        for (const w of store.workspaces)
          if (!w.connection && !w.connecting && removed.has(w.profileId))
            w.profileId = "";
        for (const state of connectionStates.values()) {
          if (removed.has(state.profileId)) state.profileId = "";
          if (
            state.nodeId &&
            requested.connectionTree &&
            !requested.connectionTree.nodes.some((n) => n.id === state.nodeId)
          )
            state.nodeId = undefined;
        }
      }
      if (requested?.connectionTree) {
        store.connectionTree = requested.connectionTree;
        if (requested.connectionTreeChanged) store.markConnectionTreeSaved();
        for (const w of store.workspaces)
          if (!w.connection && !w.connecting) connectionViews.delete(w.id);
      } else if (
        data.connectionTreeChanged &&
        store.connectionTree === currentTree
      )
        store.markConnectionTreeSaved();
    })
    .catch((error) => {
      // Lock before settling the shared queue, so already-enqueued writes cannot
      // retry an appearance snapshot after an uncertain or rejected save.
      if (lockOnFailure) settingsAvailable = false;
      throw error;
    });
  settingsWrites = write;
  await write;
  const warnings = store.takePreferenceWarnings();
  if (warnings.length) message(warningNotice(warnings));
}
async function mutateBookmarks<T>(change: (candidate: Store) => T): Promise<T> {
  if (bookmarkMutationPending)
    throw Error(tr("前のブックマーク設定の保存が完了するまでお待ちください"));
  bookmarkMutationPending = true;
  try {
    const candidate = new Store(structuredClone(store.serialize()));
    const result = change(candidate);
    const data = candidate.serialize();
    await persist({
      folderBookmarks: data.folderBookmarks,
      bookmarkTree: data.bookmarkTree,
      bookmarkTreeChanged: data.bookmarkTreeChanged,
    });
    return result;
  } finally {
    bookmarkMutationPending = false;
  }
}
async function mutateConnections<T>(
  change: (candidate: Store) => T,
): Promise<T> {
  if (connectionMutationPending)
    throw Error(tr("前の接続設定の保存が完了するまでお待ちください"));
  connectionMutationPending = true;
  try {
    const candidate = new Store(structuredClone(store.serialize()));
    const result = change(candidate);
    const data = candidate.serialize();
    const removed = store.profiles
      .filter((p) => !data.profiles.some((next) => next.id === p.id))
      .map((p) => p.id);
    const guard = () => {
      for (const id of removed) store.assertConnectionProfileDeletable(id);
    };
    guard();
    await persist(
      {
        profiles: data.profiles,
        connectionTree: data.connectionTree,
        connectionTreeChanged: data.connectionTreeChanged,
      },
      guard,
    );
    return result;
  } finally {
    connectionMutationPending = false;
    // The initiating form finishes first; any newly active tab then sees the
    // committed tree, while unrelated modal drafts remain in their portal.
    setTimeout(() => render(), 0);
  }
}
async function approveNativeHostKey(
  requestId: string,
  token: string,
  profile: Profile,
  current: () => boolean,
): Promise<Profile> {
  if (connectionMutationPending)
    throw Error(tr("前の接続設定の保存が完了するまでお待ちください"));
  connectionMutationPending = true;
  const write = settingsWrites
    .catch(() => {})
    .then(async () => {
      if (!current())
        throw Error(tr("接続先が変更されたためホスト鍵の確認を中止しました"));
      const response = await invoke("approve_host_key", {
        requestId,
        token,
        profile,
        expectedRevision: store.settingsRevision,
      });
      const { settingsRevision, ...pinned } = response;
      if (
        !pinned.hostKey ||
        !sameConnectionProfile({ ...pinned, hostKey: profile.hostKey }, profile)
      )
        throw Error(
          tr(
            "保存された接続設定を確認できませんでした。設定を再読み込みしてください。",
          ),
        );
      // Native approval already persisted this exact profile and trust record.
      // Commit before the next queued settings snapshot, with no second save.
      if (typeof settingsRevision === "number")
        store.settingsRevision = settingsRevision;
      store.profiles = store.profiles.map((p) =>
        p.id === profile.id ? { ...pinned } : p,
      );
      for (const w of store.workspaces)
        if (!w.connection && !w.connecting) connectionViews.delete(w.id);
      return pinned;
    });
  settingsWrites = write.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await write;
  } finally {
    connectionMutationPending = false;
  }
}
function sameConnectionProfile(a: Profile | undefined, b: Profile): boolean {
  return (
    !!a &&
    (
      [
        "id",
        "name",
        "host",
        "port",
        "user",
        "auth",
        "mode",
        "keyFile",
        "hostKey",
      ] as const
    ).every((key) => (a[key] ?? "") === (b[key] ?? ""))
  );
}
async function reloadApprovedProfile(
  profile: Profile,
): Promise<Profile | undefined> {
  if (connectionMutationPending)
    throw Error(tr("接続設定の保存完了後に再試行してください"));
  await settingsWrites.catch(() => {});
  const saved = await invoke("load_settings");
  if (!sameSettingsAfterHostPin(store.serialize(), saved, profile.id))
    throw Error(
      tr(
        "他の設定も更新されています。アプリを再起動して保存状態を読み直してください。",
      ),
    );
  const pinned = saved.profiles.find((p) => p.id === profile.id);
  if (
    !pinned?.hostKey ||
    !sameConnectionProfile({ ...pinned, hostKey: profile.hostKey }, profile)
  )
    return;
  if (
    !sameConnectionProfile(
      store.profiles.find((p) => p.id === profile.id),
      profile,
    )
  )
    throw Error(tr("接続先が変更されています"));
  if (typeof saved.settingsRevision === "number")
    store.settingsRevision = saved.settingsRevision;
  store.profiles = store.profiles.map((p) =>
    p.id === profile.id ? { ...pinned } : p,
  );
  return pinned;
}
// Only this constructor registers multi-warning notices; arbitrary errors are never split.
const ownedWarningNotices = new Map<string, readonly string[]>();
function warningNotice(warnings: string[]) {
  const source = warnings.join("\n");
  if (source) {
    ownedWarningNotices.set(source, [...warnings]);
    if (ownedWarningNotices.size > 32) ownedWarningNotices.delete(ownedWarningNotices.keys().next().value!);
  }
  return source;
}
function localizedNotice(source: string) {
  const warnings = ownedWarningNotices.get(source);
  return warnings ? warnings.map(tError).join("\n") : tError(source);
}
function message(e: unknown) {
  notice = String(e instanceof Error ? e.message : e);
  if (workspace()) workspace().notice = notice;
  if (
    (dialog?.type === "start" && workspace().starting) ||
    workspace()?.connecting
  ) {
    // Preserve the in-flight form, disabled submit and its cancellation closure.
    let alert = document.querySelector<HTMLElement>("main > .notice");
    if (!alert) {
      alert = document.createElement("div");
      alert.className = "notice";
      alert.setAttribute("role", "alert");
      document.querySelector("main")?.append(alert);
    }
    alert.textContent = localizedNotice(notice);
    return;
  }
  render();
}
window.__TAURI__?.event
  ?.listen<string>("sync-close-blocked", (event) => showBlockedCloseNotice(event.payload))
  .catch(() => {});
function primaryState() {
  const w = workspace(),
    t = tab();
  if (workspaceMoving(w.id)) return { text: transferText("移動中…", "Moving…"), disabled: true, stop: false };
  if (closingWorkspaces.has(w.id))
    return { text: tr("閉じています…"), disabled: true, stop: false };
  if (w.starting) return { text: tr("開始中…"), disabled: true, stop: false };
  if (t?.status === "stopping")
    return { text: tr("停止中…"), disabled: true, stop: true };
  if (t && t.status !== "stopped")
    return { text: tr("同期停止"), disabled: false, stop: true };
  return { text: syncActionLabel(), disabled: !profile() || loading || w.loading.local || w.loading.remote, stop: false };
}
function updatePrimaryState() {
  const button = document.querySelector<HTMLButtonElement>("#prepare");
  if (button) {
    const state = primaryState();
    button.textContent = state.text;
    button.disabled = state.disabled;
    button.classList.toggle("destructive", state.stop);
    button.title=primarySyncHelp();
    const help=document.querySelector<HTMLElement>("#sync-primary-help");if(help)help.textContent=primarySyncHelp();
    const locations=document.querySelector<HTMLButtonElement>("#retained-open");if(locations)locations.disabled=resumeBusy(false);
  }
}
async function readDirectory(
  w: Workspace,
  side: Side,
  path: string,
): Promise<Entry[]> {
  if (workspaceMoving(w.id)) throw Error("Workspace transfer pending");
  if (!w.connection) throw Error(tr("接続先がありません"));
  const connection = w.connection;
  if (!canUseConnection(connection.mode)) throw Error(disabledMockMessage);
  const generation = w.generation[side];
  return directoryCache(w, side).read(
    path,
    async () => {
      if (side === "local")
        return native ? await invoke("list_local", { path }) : demoFiles(path);
      if (connection.mode === "mock") return demoFiles(path);
      if (!native) throw Error(tr("実SFTPはデスクトップで利用できます"));
      return await invoke("list_remote", {
        profile: connection,
        path,
        passphrase: "",
        sessionId: w.id,
      });
    },
    () =>
      store.workspaces.includes(w) &&
      w.connection === connection &&
      w.generation[side] === generation,
  );
}
// Sixteen workspaces can each own list/tree work plus the visible local pane.
const automaticRefresh = new RefreshQueue(250, 1000, 64);
const remoteCursors = new WeakMap<SyncTab, number>();
let localWatchToken = 0;
let watchChain: Promise<unknown> = Promise.resolve();
let refreshDisposed = false;
type VisibleWatch = { w: Workspace; connection: Profile; path: string; token: number; revision: number; ready: boolean; failed: boolean; recoveries: number };
let visibleWatch: VisibleWatch | undefined;
const refreshKey = (w: Workspace, side: Side) => w.id + ":" + side;
function sameBrowsePath(side: Side, a: string, b: string) {
  return side === "local" ? a.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase() === b.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase() : (a.replace(/\/$/, "") || "/") === (b.replace(/\/$/, "") || "/");
}
function browsePath(w: Workspace, side: Side) { return side === "local" ? w.localBrowse : w.remoteBrowse; }
function automaticBusy() {
  return selectionDrag || pointerBusy || splitterDragging || pointerReordering() || bookmarkTreeDragging() || connectionTreeDragging() || performance.now() < wheelQuietUntil || !!document.querySelector("#modal-root > *,[role=menu],[role=dialog],.file-menu,.operation-overlay") || !!document.activeElement?.closest("form[data-path]")?.matches("[data-dirty],[data-composing]");
}
function reconcileLocalWatch(force = false) {
  const w = workspace();
  const eligible = native && !refreshDisposed && w?.connection && !workspaceMoving(w.id) && !w.loading.local && listingState(w, "local").path === w.localBrowse;
  if (!force && eligible && visibleWatch?.w === w && visibleWatch.connection === w.connection && sameBrowsePath("local", visibleWatch.path, w.localBrowse)) return;
  const old = visibleWatch; visibleWatch = undefined;
  if (old) watchChain = watchChain.catch(() => {}).then(() => invoke("unwatch_local_directory", { id: old.w.id, token: old.token })).catch(() => {});
  if (!eligible || !w.connection) return;
  const next: VisibleWatch = { w, connection: w.connection, path: w.localBrowse, token: ++localWatchToken, revision: 0, ready: false, failed: false, recoveries: force ? (old?.recoveries??0)+1 : 0 };
  visibleWatch = next;
  watchChain = watchChain.catch(() => {}).then(async () => {
    if (visibleWatch !== next || refreshDisposed) return;
    try {
      const value = await invoke("watch_local_directory", { id: next.w.id, path: next.path, token: next.token });
      if (visibleWatch !== next) return;
      if (!value || value.token !== next.token) { next.failed = true; return; }
      next.ready = true; next.revision = value.revision;
      if (value.error) throw Error(value.error);
      requestAutomaticRefresh(next.w,"local",next.path,next.connection);
    } catch (error) { if (visibleWatch === next) { next.failed = true; message(error); } }
  });
}
async function pollLocalWatch() {
  reconcileLocalWatch();
  const target = visibleWatch;
  if (!target?.ready || target.failed) return;
  try {
    const value = await invoke("local_watch_status", { id: target.w.id });
    if (visibleWatch !== target || !value || value.token !== target.token) return;
    if (value.error) { target.failed = true; message(Error(value.error)); return; }
    if (value.revision !== target.revision) {
      target.revision = value.revision;
      requestAutomaticRefresh(target.w, "local", target.path, target.connection);
    }
  } catch (error) { if (visibleWatch === target) {
    if(rawError(error)==="Local directory watch not found" && target.recoveries<1)reconcileLocalWatch(true);
    else {target.failed = true; message(error);}
  } }
}
function requestAutomaticRefresh(w: Workspace, side: Side, path: string, connection = w.connection) {
  if (!connection || refreshDisposed || workspaceMoving(w.id)) return;
  const generation = w.generation[side], tree = w.trees[side];
  const current = () => !refreshDisposed && !workspaceMoving(w.id) && store.workspaces.includes(w) && w.connection === connection && w.generation[side] === generation && w.trees[side] === tree && sameBrowsePath(side, browsePath(w,side),path);
  automaticRefresh.request(refreshKey(w, side), async () => {
    if (!current()) return true;
    if (w.loading[side] || (active === w.id && automaticBusy())) return false;
    directoryCache(w, side).invalidate();
    try {
      const result = await readDirectory(w, side, path);
      if (!current()) return true;
      if (active === w.id && automaticBusy()) return false;
      // No renderer replacement when a notification does not change visible entries.
      const sorted = sortEntries(result, columnSort(w).get(side));
      const changed = JSON.stringify(w.entries[side]) !== JSON.stringify(sorted) || !!listingState(w,side).errorPath || !!tree.peek(path)?.error;
      if (active === w.id) captureWorkspace();
      tree.record(path, sorted); listingSucceeded(w, side, path);
      w.entries[side] = sorted;
      w.selections[side].context(JSON.stringify([side,side === "remote" ? connection : null,path]),sorted.filter(e=>supportedName(e.name)).map(e=>e.name));
      if (active === w.id) { restoreWorkspace(); if (changed) patchAutomaticPane(side); }
    } catch (error) {
      if (current()) { listingState(w,side).errorPath=path; w.notice=rawError(error); if(active===w.id)message(error); }
    }
    return true;
  });
}
function patchAutomaticPane(side: Side) {
  const pane=document.querySelector<HTMLElement>('[data-pane="'+side+'"]');
  if(!pane)return;
  const focused=document.activeElement as HTMLElement|null;
  const hadFocus=!!focused && pane.contains(focused);
  const name=focused?.dataset.name, treePath=focused?.dataset.treePath;
  const parentRow=focused?.dataset.parentRow;
  const treeControl=focused?.hasAttribute("data-tree-toggle")?"toggle":focused?.hasAttribute("data-tree-retry")?"retry":"select";
  const list=pane.querySelector<HTMLElement>('[data-list]')!;
  const tree=pane.querySelector<HTMLElement>('[data-tree]')!;
  const scroll={top:list.scrollTop,left:list.scrollLeft,treeTop:tree.scrollTop,treeLeft:tree.scrollLeft};
  const template=document.createElement('template');template.innerHTML=filePane(side);
  pane.querySelector('tbody')!.replaceChildren(...template.content.querySelector('tbody')!.childNodes);
  tree.replaceChildren(...template.content.querySelector('[data-tree]')!.childNodes);
  pane.querySelector('footer')!.replaceChildren(...template.content.querySelector('footer')!.childNodes);
  bindEntryOpen(pane);bindTrees(pane);bindSelections(side);bindOperations();
  list.scrollTop=scroll.top;list.scrollLeft=scroll.left;tree.scrollTop=scroll.treeTop;tree.scrollLeft=scroll.treeLeft;
  if(hadFocus && !focused?.isConnected) {
    const target=name?pane.querySelector<HTMLElement>('[data-name="'+CSS.escape(name)+'"]'):parentRow?pane.querySelector<HTMLElement>('[data-parent-row="'+side+'"]'):treePath?pane.querySelector<HTMLElement>('[data-tree-'+treeControl+'][data-tree-path="'+CSS.escape(treePath)+'"]'):null;
    (target??list).focus({preventScroll:true});
  }
}
const dirtyRemoteTrees=new WeakMap<Workspace,{connection:Profile;tree:FolderTree;generation:number;paths:Set<string>}>();
function requestAutomaticRemoteTrees(w:Workspace, paths:string[]) {
  const connection=w.connection, tree=w.trees.remote, generation=w.generation.remote;
  if(!connection)return;
  let state=dirtyRemoteTrees.get(w);
  if(!state || state.connection!==connection || state.tree!==tree || state.generation!==generation){state={connection,tree,generation,paths:new Set()};dirtyRemoteTrees.set(w,state);}
  const pending=state.paths;
  for(const path of paths)if(pending.size<256)pending.add(path);
  const current=()=>store.workspaces.includes(w)&&w.connection===connection&&w.trees.remote===tree&&w.generation.remote===generation;
  automaticRefresh.request(w.id+":remote-tree",async()=>{
    if(!current()){pending!.clear();return true;}
    if(w.loading.remote || (active===w.id&&automaticBusy()))return false;
    // A single bounded sequential tree batch. Revisions during reads remain
    // dirty for one following batch instead of starting competing requests.
    const batch=[...pending!].slice(0,8);for(const path of batch)pending!.delete(path);
    let changed=false;
    for(const path of batch){
      if(!current())return true;
      const node=tree.peek(path);if(!node?.expanded || sameBrowsePath("remote",path,w.remoteBrowse))continue;
      try{
        const entries=await readDirectory(w,"remote",path);
        if(!current())return true;
        tree.record(path,entries);changed=true;
      }catch(error){if(current()){node.error=rawError(error);node.loaded=false;changed=true;}}
    }
    if(current()&&active===w.id&&changed){
      if(automaticBusy()){for(const path of batch)pending!.add(path);return false;}
      restoreWorkspace();patchAutomaticPane("remote");
    }
    return !pending!.size;
  });
}
function consumeRemoteChanges(t: SyncTab, changes: RemoteChanges | undefined) {
  const previous=remoteCursors.get(t)??0;
  const cursor=changes && changes.revision<previous?0:previous;
  const paths=remoteDirtyPaths(changes,cursor,t.remote);
  const removedDirectories=changes?.records.filter(record=>record.revision>cursor&&record.removedDirectory).map(record=>record.removedDirectory!)??[];
  if(changes)remoteCursors.set(t,Math.max(cursor,changes.revision));
  if(!paths.length)return;
  const contains=(parent:string,child:string)=>parent==="/" || child===parent || child.startsWith(parent.replace(/\/$/,"")+"/");
  const signature=JSON.stringify(t.profile);
  for(const w of store.workspaces){
    if(!w.connection||JSON.stringify(w.connection)!==signature)continue;
    directoryCache(w,"remote").invalidate();
    const gap=!!changes && (!changes.records.length || changes.records[0].revision>cursor+1);
    const trees=new Set<string>();let refreshList=gap&&contains(t.remote,w.remoteBrowse);
    for(const path of removedDirectories){
      for(const expanded of w.trees.remote.invalidateSubtree(path))trees.add(expanded);
      if(contains(path,w.remoteBrowse))refreshList=true;
    }
    if(gap)for(const path of w.trees.remote.invalidateSubtree(t.remote))trees.add(path);
    for(const path of paths){
      if(sameBrowsePath("remote",path,w.remoteBrowse))refreshList=true;
      const node=w.trees.remote.peek(path);if(node){node.loaded=false;node.request++;node.loading=false;if(node.expanded)trees.add(path);}
      // An upload can implicitly create ancestors. Refresh an ancestor only
      // when its previously displayed next child is absent, not on every edit.
      let child=path,parent=parentFolder("remote",path);
      while(parent){
        const next=child.slice(child.lastIndexOf("/")+1), ancestor=w.trees.remote.peek(parent);
        if(sameBrowsePath("remote",parent,w.remoteBrowse)&&!w.entries.remote.some(e=>e.dir&&e.name===next))refreshList=true;
        if(ancestor&&!ancestor.children.some(c=>c.name===next)){ancestor.loaded=false;ancestor.request++;if(ancestor.expanded)trees.add(parent);}
        child=parent;parent=parentFolder("remote",parent);
      }
    }
    if(refreshList)requestAutomaticRefresh(w,"remote",w.remoteBrowse);
    if(trees.size)requestAutomaticRemoteTrees(w,[...trees]);
  }
}
function disposeAutomaticRefresh() {
  if(refreshDisposed)return;refreshDisposed=true;automaticRefresh.dispose();
  const old=visibleWatch;visibleWatch=undefined;
  if(old)watchChain=watchChain.catch(()=>{}).then(()=>invoke("unwatch_local_directory",{id:old.w.id,token:old.token})).catch(()=>{});
}
window.addEventListener("pagehide",disposeAutomaticRefresh);
function rememberViewedPair(w: Workspace) {
  if (!w.connection) return;
  try {
    if (w.navigation.local.current && w.navigation.remote.current)
      store.rememberFolderPair(w.connection, w.localBrowse, w.remoteBrowse);
    void persist().catch((error) => {
      if (active === w.id) message(error);
    });
  } catch (error) {
    w.notice = rawError(error);
  }
}
async function openFolderPair(
  w: Workspace,
  pair: { local: string; remote: string },
): Promise<boolean> {
  if (
    !w.connection ||
    w.loading.local ||
    w.loading.remote ||
    !store.workspaces.includes(w)
  )
    return false;
  if (active === w.id) {
    leavePathEditor();
    captureWorkspace();
  }
  const request = {
    local: ++w.generation.local,
    remote: ++w.generation.remote,
  };
  const browseTokens = {
    local: store.beginBrowse(w.connection, "local"),
    remote: store.beginBrowse(w.connection, "remote"),
  };
  const trees = {
    local: folderTree(w, "local"),
    remote: folderTree(w, "remote"),
  };
  automaticRefresh.cancel(refreshKey(w,"local"));automaticRefresh.cancel(refreshKey(w,"remote"));
  w.loading.local = w.loading.remote = true;
  reconcileLocalWatch();
  w.notice = "";
  if (active === w.id) {
    restoreWorkspace();
    render();
  }
  const stale = () =>
    !store.workspaces.includes(w) ||
    (["local", "remote"] as const).some(
      (side) =>
        w.generation[side] !== request[side] || w.trees[side] !== trees[side],
    );
  try {
    const settled = await Promise.allSettled(
      (["local", "remote"] as const).map(async (side) => {
        try {
          return await readDirectory(w, side, pair[side]);
        } catch (error) {
          if (!stale() && listingState(w, side).path === pair[side])
            listingState(w, side).errorPath = pair[side];
          throw Error(
            (side === "local" ? tr("ローカル") : tr("リモート")) +
              ": " +
              rawError(error),
          );
        }
      }),
    );
    if (stale()) return false;
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const results = settled.map(
      (result) => (result as PromiseFulfilledResult<Entry[]>).value,
    );
    for (const [index, side] of (["local", "remote"] as const).entries())
      trees[side].record(pair[side], results[index]);
    for (const [index, side] of (["local", "remote"] as const).entries()) {
      parentSelection(w).delete(side);
      store.rememberSuccessfulBrowse(
        w.connection,
        side,
        pair[side],
        browseTokens[side],
      );
      w.entries[side] = results[index];
      listingSucceeded(w, side, pair[side]);
      w.navigation[side].commit(pair[side]);
      w.selections[side].context(
        JSON.stringify([
          side,
          side === "remote" ? w.connection : null,
          pair[side],
        ]),
        results[index].filter((e) => supportedName(e.name)).map((e) => e.name),
      );
    }
    w.localBrowse = pair.local;
    w.remoteBrowse = pair.remote;
    rememberViewedPair(w);
    return true;
  } catch (error) {
    if (!stale())
      w.notice =
        tr("組み合わせを開けませんでした。閲覧位置は変更していません。 ") +
        rawError(error);
    return false;
  } finally {
    for (const side of ["local", "remote"] as const)
      if (w.generation[side] === request[side]) w.loading[side] = false;
    if (active === w.id && store.workspaces.includes(w)) {
      restoreWorkspace();
      render();
    }
  }
}
async function refresh(
  side: Side,
  options: { path?: string; historyIndex?: number; restoring?: boolean; remember?: boolean } = {},
  w = workspace(),
) {
  if (workspaceMoving(w.id)) return false;
  if (!w.connection) {
    openConnection(w);
    return false;
  }
  if (active === w.id) captureWorkspace();
  const requestedPath =
    options.path === undefined
      ? side === "local"
        ? w.localBrowse
        : w.remoteBrowse
      : side === "remote"
        ? remotePath(options.path)
        : normalizeLocalBrowse(options.path);
  const requestedProfile = { ...w.connection };
  const requestedTree = folderTree(w, side, requestedProfile);
  const request = ++w.generation[side];
  const browseToken = store.beginBrowse(requestedProfile, side);
  if (options.path === undefined) directoryCache(w, side).invalidate();
  automaticRefresh.cancel(refreshKey(w,side));
  w.loading[side] = true;
  if(side==="local")reconcileLocalWatch();
  w.notice = "";
  if (active === w.id) {
    restoreWorkspace();
    render();
  }
  const stale = () =>
    !store.workspaces.includes(w) ||
    w.generation[side] !== request ||
    w.trees[side] !== requestedTree;
  try {
    const result = await readDirectory(w, side, requestedPath);
    if (!stale()) {
      requestedTree.record(requestedPath, result);
      w.navigation[side].commit(requestedPath, options.historyIndex);
      if (side === "local") w.localBrowse = requestedPath;
      else w.remoteBrowse = requestedPath;
      w.entries[side] = result;
      listingSucceeded(w, side, requestedPath);
      parentSelection(w).delete(side);
      w.selections[side].context(
        JSON.stringify([
          side,
          side === "remote" ? requestedProfile : null,
          requestedPath,
        ]),
        result
          .filter((entry) => supportedName(entry.name))
          .map((entry) => entry.name),
      );
      if(options.remember !== false) store.rememberSuccessfulBrowse(
        requestedProfile,
        side,
        requestedPath,
        browseToken,
      );
      if (!options.restoring) rememberViewedPair(w);
      return true;
    }
  } catch (e) {
    if (!stale()) {
      if (listingState(w, side).path === requestedPath)
        listingState(w, side).errorPath = requestedPath;
      w.notice = rawError(e);
    }
  } finally {
    if (!stale()) w.loading[side] = false;
    if (active === w.id && store.workspaces.includes(w)) {
      restoreWorkspace();
      render();
    }
  }
  return false;
}

async function restoreBrowses(
  w: Workspace,
  saved: { local?: string; remote?: string },
  home: { path: string; entries: Entry[] },
) {
  if (!w.connection) return;
  const connection = w.connection,
    localDefault = defaultLocalBrowse,
    homePath = remotePath(home.path);
  const warnings: string[] = [];
  const restoreSide = async (side: Side) => {
    const fallback = side === "local" ? localDefault : homePath;
    const desired = saved[side] ?? fallback;
    if (side === "remote" && desired === homePath) {
      const token = store.beginBrowse(connection, side);
      store.rememberSuccessfulBrowse(connection, side, homePath, token);
      return;
    }
    const expected = w.generation[side] + 1;
    const success = await refresh(side, { path: desired, restoring: true }, w);
    if (
      success ||
      !store.workspaces.includes(w) ||
      w.generation[side] !== expected
    )
      return;
    const reason = w.notice;
    if (saved[side])
      warnings.push(
        trText`${side === "local" ? tr("ローカル") : tr("リモート")}の前回フォルダを開けませんでした: ${desired}。 ${reason}`,
      );
    if (desired === fallback) return;
    if (side === "remote") {
      // connect_session already verified this home listing. A failed saved path
      // never replaces it or becomes a history/persistence entry.
      store.beginBrowse(connection, side);
      w.navigation.remote.commit(homePath);
      listingSucceeded(w, "remote", homePath);
    } else await refresh(side, { path: fallback, restoring: true, remember: false }, w);
  };
  await Promise.all([
    loadTree(w, "local", PC_ROOT),
    restoreSide("local"),
    restoreSide("remote"),
  ]);
  if (!store.workspaces.includes(w)) return;
  if (warnings.length) {
    w.notice = warnings.join("\n");
    // Automatic safe fallbacks are temporary views. Keep the last successful
    // user paths and pair history available for the next authenticated attempt.
    void persist().catch(error=>{if(active===w.id)message(error);});
  } else rememberViewedPair(w);
  if (active === w.id) {
    restoreWorkspace();
    render();
  }
}

function fmt(n: number) {
  return n > 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : n > 1024
      ? (n / 1024).toFixed(1) + " KB"
      : n + " B";
}
function filePane(side: Side) {
  const isLocal = side === "local",
    p = isLocal ? localBrowse : remoteBrowse,
    w = workspace(),
    selection = w.selections[side],
    columnSettings = store.paneColumns[side],
    columnIds = visibleColumns(columnSettings),
    listing = listingState(w, side),
    confirmedEmpty =
      !w.loading[side] && listing.path === p && listing.errorPath !== p;
  return html`<section
    class="pane ${w.loading[side] ? "is-loading" : ""}"
    data-pane="${side}"
    aria-busy="${w.loading[side]}"
  >
    <header>
      <h2>${isLocal ? tr("ローカル") : tr("リモート")}</h2>
      <span>${isLocal ? tr("この PC") : ""}</span
      >${isLocal ? "" : html`<span class="sync-controls"><span class="sync-location-slot">${retainedLocationsMarkup()}</span>${primarySyncMarkup()}<span class="sync-resume-slot">${retainedControlsMarkup()}</span></span>`}
    </header>
    <form data-path="${side}" class="path">
      ${(["back", "forward", "up", "refresh"] as const)
        .map((action) => {
          const label = {
            back: tr("戻る"),
            forward: tr("進む"),
            up: tr("親フォルダ"),
            refresh: tr("更新"),
          }[action];
          const disabled =
            w.loading[side] ||
            (action === "back"
              ? !w.navigation[side].target(-1)
              : action === "forward"
                ? !w.navigation[side].target(1)
                : action === "up"
                  ? !parentFolder(side, p)
                  : false);
          return html`<button
            type="button"
            class="path-navigation"
            data-${action}="${side}"
            title="${label}"
            aria-label="${trText`${isLocal ? tr("ローカル") : tr("リモート")}の${label}`}"
            ${disabled ? "disabled" : ""}
          >
            ${navigationIcon(action)}
          </button>`;
        })
        .join("")}<input
        id="${side}-path"
        aria-label="${trText`${isLocal ? tr("ローカル") : tr("リモート")}フォルダ`}"
        name="path"
        value="${esc(p)}"
      />
    </form>
    <div class="pane-body">
      ${renderTree(side)}
      <div
        id="${side}-tree-splitter"
        class="tree-splitter"
        role="separator"
        aria-label="${trText`${isLocal ? tr("ローカル") : tr("リモート")}のツリー幅`}"
        aria-orientation="vertical"
        aria-valuemin="15"
        aria-valuemax="65"
        tabindex="0"
      ></div>
      <div
        class="table-scroll"
        data-list="${side}"
        data-workspace="${esc(w.id)}"
        data-scroll-key="${esc(paneScrollKey(w, side, p))}"
        tabindex="0"
        aria-label="${trText`${isLocal ? tr("ローカル") : tr("リモート")}のファイル一覧`}"
      >
        <table role="grid" aria-multiselectable="true">
          ${columnsHead(side, columnSettings, columnSort(w).get(side))}
          <tbody>
            ${
              parentFolder(side, p)
                ? html`<tr
                    role="row"
                    tabindex="0"
                    data-parent-row="${side}"
                    data-no-marquee
                    aria-selected="${parentSelection(w).has(side)}"
                    class="parent-row ${parentSelection(w).has(side) ? "selected" : ""}"
                  >
                    ${columnIds
                      .map(
                        (id) =>
                          html`<td
                            data-column="${id}"
                            title="${id === "name" ? tr("親フォルダ") : ""}"
                          >
                            ${
                              id === "name"
                                ? html`<span class="entry-label"
                                    ><span
                                      class="parent-folder-icon"
                                      data-entry-icon
                                      aria-hidden="true"
                                      ><svg
                                        width="18"
                                        height="16"
                                        viewBox="0 0 18 16"
                                        fill="none"
                                      >
                                        <path
                                          d="M1 4V2h6l2 2h8v11H1Z"
                                          fill="#e7b650"
                                          stroke="#af822b"
                                        />
                                        <path
                                          d="M9 12V6m-3 3 3-3 3 3"
                                          stroke="#374c65"
                                          stroke-width="1.5"
                                        /></svg></span
                                    ><span>..（親フォルダ）</span></span
                                  >`
                                : ""
                            }
                          </td>`,
                      )
                      .join("")}
                  </tr>`
                : ""
            }${
              entries[side]
                .map((f, i) => {
                  const supported = supportedName(f.name),
                    display = f.name.replace(
                      /[\x00-\x1f]/g,
                      (c) =>
                        "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
                    );
                  return html`<tr
                    role="row"
                    tabindex="${supported && selection.focus === f.name ? 0 : -1}"
                    data-entry="${side}:${i}"
                    data-name="${esc(f.name)}"
                    aria-selected="${supported && selection.has(f.name)}"
                    ${supported ? "" : html`data-inert aria-disabled="true" title="この名前の操作は未対応です"`}
                    class="${selection.has(f.name) ? "selected" : ""} ${supported ? "" : "unsupported-entry"}"
                  >
                    ${columnIds.map((id) => columnCell(id, f, html`<span data-entry-label class="entry-label ${f.hidden ? "hidden-item-label" : ""}"><span class="${f.dir ? "folder-glyph" : "document-glyph"}" data-entry-icon aria-hidden="true"></span><span>${esc(display)}</span></span>`, fmt(f.size))).join("")}
                  </tr>`;
                })
                .join("") ||
              (confirmedEmpty
                ? html`<tr class="empty-row" data-no-marquee>
                    <td colspan="${columnIds.length}" class="empty">
                      <span class="empty-message">このフォルダーは空です</span>
                    </td>
                  </tr>`
                : "")
            }
          </tbody>
        </table>
      </div>
    </div>
    <footer>
      ${trText`${entries[side].length} 項目`}<span
        data-selection-count="${side}"
        >${selection.values().length ? " · " + selection.values().length + tr(" 件を選択") : ""}</span
      >${!isLocal ? tr(" · 閲覧先を変えても同期先は変わりません") : ""}
    </footer>
  </section>`;
}

function applyPaneRatio(ratio = store.localPaneRatio) {
  if (!Number.isFinite(ratio)) ratio = 0.5;
  const panes = document.querySelector<HTMLElement>(".panes");
  if (!panes) return ratio;
  const available = panes.clientWidth - 6;
  if (!Number.isFinite(available) || available <= 0) return ratio;
  const min = Math.max(0.2, Math.min(250 / available, 0.4));
  const actual = Math.max(min, Math.min(1 - min, ratio));
  panes.style.gridTemplateColumns = `minmax(0, ${actual}fr) 6px minmax(0, ${1 - actual}fr)`;
  document
    .querySelector("#pane-splitter")
    ?.setAttribute("aria-valuenow", String(Math.round(actual * 100)));
  return actual;
}
window.addEventListener("resize", () => {
  if (!splitterDragging) {
    applyPaneRatio();
    applyTreeRatios(store);
  }
});
function bindSplitter() {
  const handle = document.querySelector<HTMLElement>("#pane-splitter");
  if (!handle) return;
  applyPaneRatio();
  const save = () =>
    persist().catch((error) =>
      message(tr("ペイン幅を保存できませんでした。 ") + rawError(error)),
    );
  handle.onpointerdown = (event) => {
    if (
      event.button !== 0 ||
      selectionDrag ||
      !Number.isFinite(event.clientX) ||
      handle.parentElement!.clientWidth <= 6
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const original = Number.isFinite(store.localPaneRatio)
      ? store.localPaneRatio
      : 0.5;
    let current = original;
    splitterDragging = true;
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    const move = (e: PointerEvent) => {
      const bounds = handle.parentElement!.getBoundingClientRect();
      if (
        !Number.isFinite(e.clientX) ||
        !Number.isFinite(bounds.width) ||
        bounds.width <= 6
      )
        return;
      current = applyPaneRatio(
        (e.clientX - bounds.left - 3) / Math.max(1, bounds.width - 6),
      );
      applyTreeRatios(store);
    };
    const finish = (commit: boolean) => {
      if (!splitterDragging) return;
      splitterDragging = false;
      cancelSplitter = undefined;
      handle.onpointermove = null;
      handle.onpointerup = null;
      handle.onpointercancel = null;
      handle.onlostpointercapture = null;
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
      store.localPaneRatio = commit ? current : original;
      applyPaneRatio();
      applyTreeRatios(store);
      if (commit) void save();
    };
    handle.onpointermove = move;
    handle.onpointerup = () => finish(true);
    handle.onpointercancel = () => finish(false);
    handle.onlostpointercapture = () => finish(false);
    cancelSplitter = () => finish(false);
  };
  handle.onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    store.localPaneRatio = applyPaneRatio(
      event.key === "Home"
        ? 0.5
        : (Number.isFinite(store.localPaneRatio) ? store.localPaneRatio : 0.5) +
            (event.key === "ArrowLeft" ? -0.03 : 0.03),
    );
    void save();
    applyTreeRatios(store);
  };
}
function render() {
  if(windowClosing) return;
  if(initialized && !store.workspaces.length) { renderEmptyWindow(); return; }
  reconcileLocalWatch();
  if (
    selectionDrag ||
    pointerBusy ||
    splitterDragging ||
    pointerReordering() ||
    bookmarkTreeDragging() ||
    connectionTreeDragging()
  ) {
    // A completed read may request a render during a gesture. Flush it after
    // release/cancellation; status polling no longer rebuilds the app for us.
    if (!interactionRenderTimer)
      interactionRenderTimer = setTimeout(() => {
        interactionRenderTimer = undefined;
        render();
      }, 60);
    return;
  }
  if (performance.now() < wheelQuietUntil) {
    wheelRenderPending = true;
    return;
  }
  wheelRenderPending = false;
  const editingPath =
    document.activeElement?.closest<HTMLFormElement>("form[data-path]");
  if (
    editingPath &&
    (editingPath.dataset.dirty || editingPath.dataset.composing)
  ) {
    deferredPathRender = true;
    return;
  }
  deferredPathRender = false;
  if (!store.workspaces.length) {
    const w = store.createWorkspace(selected, defaultLocalBrowse);
    active = w.id;
  }
  captureWorkspace();
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused?.id;
  const dataFocus =
    ["tab", "close", "entry", "list"]
      .map((k) =>
        focused?.dataset[k] !== undefined
          ? `[data-${k}="${CSS.escape(focused.dataset[k]!)}"]`
          : null,
      )
      .find(Boolean) ||
    (focused?.dataset.parentRow
      ? `[data-parent-row="${focused.dataset.parentRow}"]`
      : null) ||
    (focused?.dataset.treePath
      ? `[data-tree-path="${CSS.escape(focused.dataset.treePath)}"][data-tree-${focused.hasAttribute("data-tree-toggle") ? "toggle" : "select"}="${focused.dataset.treeToggle ?? focused.dataset.treeSelect}"]`
      : null);
  const oldLogScroll =
    document.querySelector<HTMLElement>(".log-drawer .logs")?.scrollTop ?? 0;
  const w = workspace(),
    t = tab(),
    p = profile();
  if (p)
    for (const side of ["local", "remote"] as const) {
      w.entries[side] = sortEntries(w.entries[side], columnSort(w).get(side));
      entries[side] = w.entries[side];
      w.selections[side].context(
        JSON.stringify([
          side,
          side === "remote" ? w.connection : null,
          side === "local" ? w.localBrowse : w.remoteBrowse,
        ]),
        w.entries[side].filter((e) => supportedName(e.name)).map((e) => e.name),
      );
    }
  captureTabStrip();
  captureBookmarks();
  $("#app")!.innerHTML =
    titlebar(store, active, settingsOpen) +
    html`<main>
        ${!p ? retainedControlsMarkup() : ""}${p ? bookmarkBar(store, w) : ""}${
          p
            ? html`<section class="workspace">
                  <div class="panes">
                    ${filePane("local")}
                    <div
                      id="pane-splitter"
                      role="separator"
                      aria-label="左右ペインの幅"
                      aria-orientation="vertical"
                      aria-valuemin="20"
                      aria-valuemax="80"
                      tabindex="0"
                    ></div>
                    ${filePane("remote")}
                  </div>
                </section>
                ${w.logsOpen ? logDrawer(t) : ""}`
            : html`<div id="connection-slot"></div>`
        }${notice ? html`<div class="notice" role="alert">${esc(localizedNotice(notice))}<button id="dismiss" aria-label="通知を閉じる">×</button></div>` : ""}
      </main>
      ${p ? statusbar(t) : html`<footer class="statusbar connection-status">${w.connecting ? tr("接続中…") : tr("接続先を選択してください")}</footer>`}`;
  if (!p) {
    let view = connectionViews.get(w.id);
    if (!view) {
      view = document.createElement("section");
      view.className = "connection-view";
      view.dataset.workspace = w.id;
      connectionViews.set(w.id, view);
      const state: ConnectionDialog = connectionStates.get(w.id) ?? {
        type: "connect",
        workspaceId: w.id,
        profileId: w.profileId || store.initialProfileId(),
      };
      connectionStates.set(w.id, state);
      renderConnection(view, state);
    }
    $("#connection-slot")!.replaceWith(view);
  }
  bindTabStrip({reorder:commitTabOrder,externalStart:windowRegistration?(id,grab,title)=>{void beginNativeTabDrag(id,grab,title);}:undefined,busy:()=>!initialized||!settingsAvailable||movingWorkspaces.size>0||!!dialog||selectionDrag||splitterDragging||closingWorkspaces.size>0});
  publishTabStrip();
  bindRetainedSyncs();
  bindBookmarks(
    store,
    w,
    persist,
    render,
    (pair) => openFolderPair(w, pair),
    message,
    mutateBookmarks,
  );
  bind();
  if (p) {
    bindTrees();
    bindSelections();
    bindOperations();
    bindColumns(
      store,
      persist,
      render,
      message,
      (value, cancel) => {
        splitterDragging = value;
        cancelSplitter = cancel;
      },
      {
        get: (side) => columnSort(w).get(side),
        toggle: (side, id) => {
          columnSort(w).toggle(side, id);
          store.setPaneSort(side, columnSort(w).get(side));
          void persist().catch(message);
          render();
        },
      },
    );
  }
  bindSplitter();
  bindTreeSplitters(
    store,
    persist,
    () => !selectionDrag && !splitterDragging,
    (value, cancel) => {
      splitterDragging = value;
      cancelSplitter = cancel;
    },
    message,
  );
  updatePrimaryState();
  // The modal portal is outside #app, preserving draft values, focus and
  // pending request/cancellation closures when background listings render.
  if (dialog && !$("#modal-root")!.childElementCount) renderDialog();
  else if (!dialog) $("#modal-root")!.replaceChildren();
  document.querySelectorAll<HTMLElement>("[data-list]").forEach((e) => {
    const saved = paneScrolls.get(w)?.get(e.dataset.scrollKey!);
    e.scrollTop = saved?.top ?? 0;
    e.scrollLeft = saved?.left ?? 0;
  });
  const logs = document.querySelector<HTMLElement>(".log-drawer .logs");
  if (logs) logs.scrollTop = oldLogScroll;
  const selector = focusId ? "#" + CSS.escape(focusId) : dataFocus;
  if (focused?.isConnected) focused.focus({ preventScroll: true });
  else if (selector)
    document
      .querySelector<HTMLElement>(selector)
      ?.focus({ preventScroll: true });
}
const startingRetained = new Set<string>();
const retainedFailures = new Map<string,string>();
let retainedWrites:Promise<void>=Promise.resolve();
let retainedWriteCount=0;
function retainedJob(id:string){return store.tabs.find(t=>t.retainedId===id&&t.status!=="stopped");}
function ownedRetained(){return workspace()?store.ownRetainedForWorkspace(workspace().id):undefined;}
async function mutateRetained(change:(candidate:Store)=>void,guard:()=>void=()=>{}) {
  retainedWriteCount++;paintRetainedSyncs();
  const work=retainedWrites.catch(()=>{}).then(async()=>{
    guard();const candidate=new Store(structuredClone(store.serialize()));change(candidate);
    await persist({retainedSyncs:candidate.serialize().retainedSyncs},guard,true);
  });
  retainedWrites=work;
  try {await work;}finally{retainedWriteCount--;paintRetainedSyncs();}
}
function resumeContext(){return workspace()?sessionResumeContext(workspace().id,tab(),ownedRetained()):undefined;}
function resumeBusy(resume=true){
  const w=workspace(),t=tab();
  return !w?.connection || workspaceMoving(w.id) || retainedWriteCount>0 || w.connecting || w.starting || closingWorkspaces.has(w.id) || w.loading.local || w.loading.remote ||
    (resume ? !!t&&t.status!=="stopped" : t?.status==="stopping");
}
function primarySyncHelp(){
  const t=tab(),w=workspace();
  return t&&t.status!=="stopped"?trText`同期を停止します。同期元 ${t.local}、同期先 ${t.remote}。`:currentSyncHelp(w.localBrowse,w.remoteBrowse);
}
function retainedLocationsMarkup(){
  const entry=resumeContext();if(!entry)return "";
  const help=trText`同期したローカル ${entry.local} とリモート ${entry.remote} を開きます。同期は開始しません。`;
  return html`<span class="sync-action sync-location-action"><button type="button" id="retained-open" data-retained-open="${esc(entry.id)}" ${resumeBusy(false)?"disabled":""} title="${esc(help)}" aria-describedby="sync-locations-help">同期した場所へ戻る</button><span role="tooltip" class="sync-action-help" id="sync-locations-help">${esc(help)}</span></span>`;
}
function primarySyncMarkup(){
  const state=primaryState(),help=primarySyncHelp();
  return html`<span class="sync-action"><button class="primary ${state.stop?"destructive":""}" id="prepare" ${state.disabled?"disabled":""} title="${esc(help)}" aria-describedby="sync-primary-help">${state.text}</button><span role="tooltip" class="sync-action-help" id="sync-primary-help">${esc(help)}</span></span>`;
}
function retainedControlsMarkup(){
  const entry=resumeContext(),job=tab();
  if(!entry||!job||job.status!=="stopped"||workspace().starting||startingRetained.has(entry.id))return "";
  const help=resumeSyncHelp(entry.local,entry.remote);
  return html`<span class="tab-sync-actions sync-action"><button class="primary" id="retained-resume" data-retained-resume="${esc(entry.id)}" ${resumeBusy()?"disabled":""} title="${esc(help)}" aria-describedby="sync-resume-help">${resumeActionLabel()}</button><span role="tooltip" class="sync-action-help" id="sync-resume-help">${esc(help)}</span></span>`;
}

function bindRetainedSyncs() {
  for(const kind of ["open","resume"] as const){const button=document.querySelector<HTMLButtonElement>('#retained-'+kind);if(!button)continue;
    button.onclick=()=>{
      const entry=resumeContext();if(!entry||button.getAttribute('data-retained-'+kind)!==entry.id)return;
      if(retainedWriteCount||startingRetained.has(entry.id)||dialog)return;
      if(kind==="open")void openRetainedLocations(entry).catch(message);else resumeRetained(entry);
    };
  }
}
function paintRetainedSyncs() {
  if(pointerBusy||selectionDrag||splitterDragging||windowClosing)return;
  const resumeSlot=document.querySelector<HTMLElement>('.sync-resume-slot');
  const locationSlot=document.querySelector<HTMLElement>('.sync-location-slot');
  if(resumeSlot&&locationSlot){
    for(const [slot,markup] of [[resumeSlot,retainedControlsMarkup()],[locationSlot,retainedLocationsMarkup()]] as const){
      const template=document.createElement('template');template.innerHTML=markup;
      if(slot.innerHTML!==template.innerHTML)slot.replaceChildren(template.content);
    }
    bindRetainedSyncs();return;
  }
  const current=document.querySelector<HTMLElement>('.tab-sync-actions');
  const markup=retainedControlsMarkup();
  if(!current){
    if(markup){
      const primary=document.querySelector('#prepare')?.closest('.sync-action');
      if(primary){const template=document.createElement('template');template.innerHTML=markup;primary.after(template.content);bindRetainedSyncs();}
      else render();
    }
    return;
  }
  if(!markup){current.remove();return;}
  const template=document.createElement('template');template.innerHTML=markup;
  if(current.outerHTML!==template.innerHTML) current.replaceWith(template.content);
  bindRetainedSyncs();
}
function retainedWorkspace(entry:RetainedSync,forResume:boolean) {
  const owner=workspace();
  if(!owner||entry.ownerTabId!==owner.id||ownedRetained()?.id!==entry.id)throw Error(tr("このタブの同期設定ではありません。"));
  if(dialog||owner.connecting||owner.starting||closingWorkspaces.has(owner.id))throw Error(tr("接続・開始・タブ終了の処理が終わってから再試行してください。"));
  const current=store.profiles.find(p=>p.id===entry.profile.id);
  if(!current||!sameRetainedConnection(current,entry.profile))throw Error(tr("登録時の接続設定と異なります。接続先を確認して新しい同期を登録してください。"));
  if(owner.connection){
    if(!sameRetainedConnection(owner.connection,entry.profile))throw Error(tr("登録時の接続設定と異なります。接続先を確認して新しい同期を登録してください。"));
    if(forResume&&retainedJob(entry.id))throw Error(tr("この登録は開始中または同期中です。"));
    return owner;
  }
  owner.profileId=current.id;connectionViews.delete(owner.id);connectionStates.set(owner.id,{type:"connect",workspaceId:owner.id,profileId:current.id});
  render();message(tr("接続は自動で開始しません。接続後にもう一度「場所を開く」または「再開」を押してください。"));return undefined;
}
async function openRetainedLocations(entry:RetainedSync){
  const w=retainedWorkspace(entry,false);if(!w)return;
  if(w.loading.local||w.loading.remote)throw Error(tr("フォルダーの読込完了後に再試行してください。"));
  await openFolderPair(w,{local:entry.local,remote:entry.remote});
}
function resumeRetained(entry:RetainedSync){
  if(retainedJob(entry.id)||startingRetained.has(entry.id))return;
  try{const w=retainedWorkspace(entry,true);if(!w)return;
    if(w.loading.local||w.loading.remote)throw Error(tr("フォルダーの読込完了後に再試行してください。"));
    dialog={type:"start",workspaceId:w.id,p:{...w.connection!},local:entry.local,remote:entry.remote,retained:structuredClone(entry)};renderDialog();
  }catch(error){message(error);}
}

function syncRoots(t: SyncTab) {
  return html`<div class="roots sync-roots" data-sync-id="${t.id}">
    <div>
      <small>同期元</small><code title="${esc(t.local)}">${esc(t.local)}</code>
    </div>
    <span>→</span>
    <div>
      <small>同期先</small
      ><code title="${esc(t.remote)}">${esc(t.remote)}</code>
    </div>
  </div>`;
}
function resumeSettingsMarkup(entry:RetainedSync){
  return html`<section class="resume-settings"><p>${tr("前回の設定を使います。")}</p><div class="sync-option-flags"><label><input type="checkbox" id="delete-removed" name="deleteRemoved" disabled ${entry.deleteRemoved?"checked":""}>ファイルを削除する</label><label><input type="checkbox" id="recursive-sync" name="recursive" disabled ${entry.recursive?"checked":""}>サブディレクトリを更新する</label></div>${entry.deleteRemoved?html`<p class="warning">${tr("前回と同じ削除設定を使います。開始時の比較と変更監視で、同期対象内のローカルにないリモート項目を削除します。元に戻せない可能性があります。")}</p>`:""}<details class="resume-exclusions"><summary>除外ルール</summary><pre>${esc(entry.exclusionRules||tr("なし"))}</pre></details></section>`;
}
function statusbar(t?: SyncTab) {
  const state = t
    ? {
        running: tr("監視中"),
        failed: tr("失敗・再試行が必要"),
        stopped: tr("停止済み"),
        stopping: tr("停止中"),
      }[t.status]
    : workspace().connecting
      ? tr("接続中…")
      : workspace().connection
        ? tr("接続済み")
        : tr("未接続");
  const errors = t?.errorCount ?? (t?.status === "failed" ? 1 : 0);
  return html`<footer class="statusbar">
    <div class="status-summary">
      <span
        class="dot ${!t || t.status === "stopped" ? "off" : t.status === "failed" ? "error" : ""}"
      ></span
      ><span id="sync-state">${state}</span
      ><span id="pending-count">待機 ${t?.pending ?? t?.queue.size ?? 0}</span
      ><button
        id="error-count"
        class="${errors ? "has-errors" : ""}"
        aria-label="${trText`エラー ${errors} 件のログを表示`}"
      >
        エラー ${errors}
      </button>
    </div>
    <div class="status-metrics">
      <span>${t?.latency ?? 0} ms</span><span>${fmt(t?.speed ?? 0)}/s</span
      ><span id="sent-count">送信 ${t?.sent ?? 0}</span>
    </div>
    <button
      id="toggle-logs"
      aria-expanded="${workspace().logsOpen}"
      aria-controls="log-drawer"
    >
      ${workspace().logsOpen ? tr("ログを閉じる") : tr("ログ")}
    </button>
  </footer>`;
}
// Polling must not replace scroll containers or captured pointer targets.
// Only status text, tab indicators and the bounded log list change here.
function paintPolledStatus() {
  paintRetainedSyncs();
  const w = workspace();
  if (!w) return;
  const t = tab();
  updatePrimaryState();
  const template = document.createElement("template");
  template.innerHTML = statusbar(t);
  const copy = (selector: string) => {
    const from = template.content.querySelector<HTMLElement>(selector);
    const to = document.querySelector<HTMLElement>(selector);
    if (!from || !to) return;
    if (to.textContent !== from.textContent) to.textContent = from.textContent;
    if (to.className !== from.className) to.className = from.className;
    const label = from.getAttribute("aria-label");
    if (label !== null && to.getAttribute("aria-label") !== label)
      to.setAttribute("aria-label", label);
  };
  for (const selector of [
    "#sync-state",
    "#pending-count",
    "#error-count",
    "#sent-count",
    ".status-summary .dot",
  ])
    copy(selector);
  document
    .querySelectorAll<HTMLElement>(".status-metrics > span")
    .forEach((span, index) => {
      const text = template.content.querySelectorAll(".status-metrics > span")[
        index
      ]?.textContent;
      if (text !== undefined && span.textContent !== text)
        span.textContent = text;
    });
  for (const workspace of store.workspaces) {
    const job = store.tabs.find((job) => job.id === workspace.jobId);
    const dot = document.querySelector<HTMLElement>(
      `[data-tab="${CSS.escape(workspace.id)}"] .dot`,
    );
    const className = `dot ${!job || job.status === "stopped" ? "off" : job.status === "failed" ? "error" : ""}`;
    if (dot && dot.className !== className) dot.className = className;
  }
  const retry = document.querySelector<HTMLButtonElement>("#retry");
  if (retry) retry.disabled = t?.status !== "failed" || retrying.has(t.id);
  const logs = document.querySelector<HTMLElement>(".log-drawer .logs");
  if (logs) {
    const contents =
      (t?.logs ?? [])
        .slice(-100)
        .reverse()
        .map((line) => html`<li>${esc(line)}</li>`)
        .join("") || html`<li>まだログはありません</li>`;
    if (logs.innerHTML !== contents) {
      const top = logs.scrollTop;
      logs.innerHTML = contents;
      logs.scrollTop = top;
    }
  }
}
function logDrawer(t?: SyncTab) {
  return html`<section
    class="log-drawer"
    id="log-drawer"
    aria-label="このタブのログ"
  >
    <header>
      <strong
        >${trText`${esc(workspace().connection?.name ?? tr("未接続"))} のログ`}</strong
      ><span>最大100件</span
      ><button
        id="retry"
        ${t?.status === "failed" && !retrying.has(t.id) ? "" : "disabled"}
      >
        再接続して再試行</button
      ><button id="close-logs" aria-label="ログを閉じる">×</button>
    </header>
    ${t ? syncRoots(t) : ""}${t?.profile.mode === "mock" ? html`<div class="demo-controls"><span>モック動作確認</span><button id="burst">同じファイルを20回変更</button><button id="fail">次の転送を失敗させる</button></div>` : ""}
    <ul class="logs">
      ${
        (t?.logs ?? [])
          .slice(-100)
          .reverse()
          .map((l) => html`<li>${esc(l)}</li>`)
          .join("") || html`<li>まだログはありません</li>`
      }
    </ul>
  </section>`;
}

// Snapshots stay in this call only. Passwords never enter Store or persisted data.
function preserveFormDom(root: HTMLElement) {
  const fields = [
    ...root.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input,textarea,select"),
  ].map((field, index) => ({
    index,
    value: field.value,
    checked: field instanceof HTMLInputElement ? field.checked : undefined,
    start:
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.selectionStart
        : null,
    end:
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.selectionEnd
        : null,
    direction:
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.selectionDirection
        : null,
    focused: document.activeElement === field,
  }));
  const details = [...root.querySelectorAll("details")].map(
    (node) => node.open,
  );
  const forms = [...root.querySelectorAll("form")].map((node) => ({
    dirty: node.dataset.dirty,
    composing: node.dataset.composing,
  }));
  const errors = [...root.querySelectorAll<HTMLElement>(".form-error")].map(
    (node) => node.textContent ?? "",
  );
  const scroll = [
    ...root.querySelectorAll<HTMLElement>(
      ".folder-tree,.table-scroll,#connection-tree,.dialog",
    ),
  ].map((node) => ({ top: node.scrollTop, left: node.scrollLeft }));
  return () => {
    const current = root.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input,textarea,select");
    for (const saved of fields) {
      const field = current[saved.index];
      if (!field) continue;
      field.value = saved.value;
      if (field instanceof HTMLInputElement && saved.checked !== undefined)
        field.checked = saved.checked;
      if (
        (field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement) &&
        saved.start !== null
      ) {
        try {
          field.setSelectionRange(
            saved.start,
            saved.end,
            saved.direction ?? undefined,
          );
        } catch {
          /* number/select inputs have no text selection */
        }
      }
      if (saved.focused) field.focus({ preventScroll: true });
      saved.value = "";
    }
    root
      .querySelectorAll("details")
      .forEach((node, i) => (node.open = details[i] ?? node.open));
    root.querySelectorAll("form").forEach((node, i) => {
      if (forms[i]?.dirty) node.dataset.dirty = forms[i].dirty;
      if (forms[i]?.composing) node.dataset.composing = forms[i].composing;
    });
    root
      .querySelectorAll<HTMLElement>(".form-error")
      .forEach((node, i) => (node.textContent = tError(errors[i] ?? "")));
    root
      .querySelectorAll<HTMLElement>(
        ".folder-tree,.table-scroll,#connection-tree,.dialog",
      )
      .forEach((node, i) => {
        node.scrollTop = scroll[i]?.top ?? 0;
        node.scrollLeft = scroll[i]?.left ?? 0;
      });
  };
}
let localeComposing = false;
document.addEventListener("compositionstart", () => (localeComposing = true));
document.addEventListener("compositionend", () => (localeComposing = false));
function preferenceInteractionBusy() {
  return (
    performance.now() < wheelQuietUntil ||
    localeComposing ||
    selectionDrag ||
    pointerBusy ||
    splitterDragging ||
    pointerReordering() ||
    bookmarkTreeDragging() ||
    connectionTreeDragging() ||
    connectionMutationPending ||
    bookmarkMutationPending ||
    store.workspaces.some((w) => w.connecting || w.starting) ||
    !!document.querySelector(
      "[data-busy=true],[data-submitting=true],[data-settings-saving=true],[data-picking-folder=true]",
    )
  );
}
function localeDialogOpen() {
  return !!document.querySelector(
    "#start-form,#bookmark-tree-form,#connection-node-form,#bookmark-form,#legacy-confirm,.pair-history-list,.host-key-dialog,.operation-dialog",
  );
}
function repaintLanguage() {
  closeBookmarkTree();
  closeConnectionTreePopup();
  closeColumnMenu();
  refreshFileActionLocale();
  refreshBlockedCloseNotice();
  const restoreApp = preserveFormDom($("#app")!);
  const modal = $("#modal-root")!,
    restoreModal = preserveFormDom(modal);
  // Dirty path fields block background renders, but this controlled repaint restores them.
  const focused = document.activeElement as HTMLElement | null;
  focused?.blur();
  for (const [id, view] of connectionViews) {
    const state = connectionStates.get(id);
    if (!state) continue;
    const restore = preserveFormDom(view);
    renderConnection(view, state);
    restore();
  }
  render();
  restoreApp();
  if (dialog) {
    renderDialog();
    restoreModal();
  }
  applyExplorerDensity(store.compactExplorer);
}
async function saveAppearance(change: () => void, repaint: boolean) {
  if (
    !settingsAvailable ||
    themeSaving ||
    preferenceInteractionBusy() ||
    (repaint && localeDialogOpen())
  ) {
    renderSettings();
    return;
  }
  const preferenceFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.id
      : "";
  themeSaving = true;
  change();
  if (repaint) repaintLanguage();
  renderSettings();
  try {
    await persist(undefined, undefined, true);
  } catch (error) {
    // A rejected write can have an uncertain durable outcome. Do not silently retry
    // the same revision through a later unrelated preference or profile save.
    settingsAvailable = false;
    message(
      trText`表示設定を保存できませんでした。再起動して保存状態を確認してください。 ${tError(error)}`,
    );
  } finally {
    themeSaving = false;
    renderSettings();
    if (settingsOpen && document.activeElement === document.body)
      document.getElementById(preferenceFocus)?.focus({ preventScroll: true });
  }
}
function renderSettings() {
  const root = document.querySelector<HTMLElement>("#settings-root")!;
  $("#settings-toggle")?.setAttribute("aria-expanded", String(settingsOpen));
  if (!settingsOpen) {
    root.replaceChildren();
    return;
  }
  const disabled =
    !settingsAvailable || themeSaving || preferenceInteractionBusy();
  const languageLabel = "Language / 言語",
    japaneseLabel = "日本語",
    englishLabel = "English";
  root.innerHTML = html`<section
    id="settings-popup"
    class="settings-popup"
    role="dialog"
    aria-label="アプリ設定"
  >
    <header>
      <strong>設定</strong
      ><span class="settings-header-actions"><span id="settings-version" class="settings-version">${getDisplayVersion()}</span><button id="settings-close" aria-label="設定を閉じる">×</button></span>
    </header>
    <label class="language-picker" for="language-select"
      ><span>${languageLabel}</span
      ><select
        id="language-select"
        aria-label="${languageLabel}"
        ${disabled || localeDialogOpen() ? "disabled" : ""}
      >
        <option value="en" ${store.language === "en" ? "selected" : ""}>
          ${englishLabel}
        </option>
        <option value="ja" ${store.language === "ja" ? "selected" : ""}>
          ${japaneseLabel}
        </option>
      </select></label
    ><label class="theme-picker" for="theme-select"
      ><span>テーマ</span
      ><select
        id="theme-select"
        aria-label="テーマ"
        ${disabled ? "disabled" : ""}
      >
        ${(
          [
            ["light", tr("ライト")],
            ["dark", tr("ダーク")],
            ["midnight", tr("ミッドナイト")],
            ["forest", tr("ジェイド")],
            ["mint", tr("ミント")],
          ] as const
        )
          .map(
            ([value, label]) =>
              html`<option
                value="${value}"
                ${store.theme === value ? "selected" : ""}
              >
                ${label}
              </option>`,
          )
          .join("")}
      </select></label
    ><label class="compact-explorer-option"
      ><input
        id="compact-explorer"
        type="checkbox"
        ${store.compactExplorer ? "checked" : ""}
        ${disabled ? "disabled" : ""}
      /><span>コンパクト表示</span></label
    >
    <p class="compact-explorer-help">一覧とツリーの行間を狭くします</p>
  </section>`;
  $("#settings-close")!.onclick = () => {
    settingsOpen = false;
    renderSettings();
    $("#settings-toggle")?.focus();
  };
  $("#language-select")!.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== "ja" && value !== "en") return;
    void saveAppearance(() => {
      store.language = value;
      setLanguage(value);
      document.documentElement.lang = value;
    }, true);
  });
  $("#theme-select")!.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (!["light", "dark", "midnight", "forest", "mint"].includes(value)) return;
    void saveAppearance(() => {
      store.theme = value as ThemePreference;
      applyTheme();
    }, false);
  });
  $("#compact-explorer")!.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    void saveAppearance(() => {
      store.compactExplorer = checked;
      applyExplorerDensity(checked);
    }, false);
  });
}

document.addEventListener("pointerdown", (event) => {
  if (
    settingsOpen &&
    event.target instanceof Element &&
    !event.target.closest("#settings-root,#settings-toggle")
  ) {
    settingsOpen = false;
    renderSettings();
  }
});
document.addEventListener("keydown", (event) => {
  if (settingsOpen && event.key === "Escape") {
    event.preventDefault();
    settingsOpen = false;
    renderSettings();
    $("#settings-toggle")?.focus();
  }
});

function bindEntryOpen(scope: ParentNode = document) {
  scope.querySelectorAll<HTMLElement>("[data-entry]").forEach((el) => {
    const open = () => {
      const [side, i] = el.dataset.entry!.split(":") as [Side, string];
      const f = entries[side][+i];
      if (!f?.dir || !supportedName(f.name)) return;
      navigateFolder(
        side,
        childPath(side, side === "local" ? localBrowse : remoteBrowse, f.name),
      );
    };
    el.ondblclick = open;
    el.onkeydown = (e) => {
      if (e.key === "Enter") open();
    };
  });
}
function bind() {
  applyTransferLock();
  const on = (s: string, fn: () => void) => {
    const el = $(s);
    if (el) el.onclick = fn;
  };
  on("#settings-toggle", () => {
    settingsOpen = !settingsOpen;
    renderSettings();
  });
  on("#toggle-logs", () => {
    workspace().logsOpen = !workspace().logsOpen;
    render();
  });
  on("#close-logs", () => {
    workspace().logsOpen = false;
    render();
  });
  on("#error-count", () => {
    workspace().logsOpen = true;
    render();
  });
  on("#dismiss", () => {
    notice = "";
    render();
  });
  on("#add-tab", addWorkspace);
  on("#window-minimize", () => windowControl("minimize").catch(message));
  on("#window-maximize", () => windowControl("toggleMaximize").catch(message));
  on("#window-close", () => {
    if (movingWorkspaces.size) { showBlockedCloseNotice(transferText("タブの移動が完了するまでお待ちください。", "Wait for the tab move to finish.")); return; }
    if (store.workspaces.some((w) => w.connecting)) {
      showBlockedCloseNotice(tr("接続を中止し、完了してからウィンドウを閉じてください。"));
      return;
    }
    if (
      store.workspaces.some((w) => w.starting) ||
      store.tabs.some((t) => t.status !== "stopped")
    ) {
      showBlockedCloseNotice(
        tr(
          "同期中はウィンドウを閉じられません。各タブの同期停止を押し、停止完了後に改めて閉じてください。",
        ),
      );
      return;
    }
    windowControl("close").catch(message);
  });
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach(
    (el) =>
      (el.onclick = () => {
        switchWorkspace(el.dataset.tab!);
      }),
  );
  document.querySelectorAll<HTMLElement>("[data-close]").forEach(
    (el) =>
      (el.onclick = () => {
        closeWorkspace(el.dataset.close!);
      }),
  );
  document.querySelectorAll<HTMLFormElement>("[data-path]").forEach((form) => {
    let composing = false;
    form.addEventListener("input", () => {
      form.dataset.dirty = "true";
    });
    form.addEventListener("compositionstart", () => {
      composing = true;
      form.dataset.composing = "true";
    });
    form.addEventListener("compositionend", () => {
      composing = false;
      delete form.dataset.composing;
    });
    form.addEventListener("keydown", (e) => {
      if (
        e.key === "Enter" &&
        (composing || e.isComposing || e.keyCode === 229)
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      if (composing) return;
      if (!workspace().connection) {
        openConnection();
        return;
      }
      try {
        const v = String(new FormData(form).get("path") ?? "");
        delete form.dataset.dirty;
        navigateFolder(form.dataset.path as Side, v);
      } catch (e) {
        message(e);
      }
    };
  });
  for (const action of ["back", "forward", "up", "refresh"] as const) {
    document
      .querySelectorAll<HTMLButtonElement>("[data-" + action + "]")
      .forEach((button) => {
        button.onclick = () => {
          const side = button.dataset[action] as Side,
            w = workspace();
          if (w.loading[side]) return;
          const form = button.closest("form")!;
          delete form.dataset.dirty;
          const path = side === "local" ? w.localBrowse : w.remoteBrowse;
          if (action === "back" || action === "forward") {
            const target = w.navigation[side].target(
              action === "back" ? -1 : 1,
            );
            if (target)
              void refresh(side, {
                path: target.path,
                historyIndex: target.index,
              });
          } else if (action === "up") {
            const parent = parentFolder(side, path);
            if (parent) navigateFolder(side, parent);
          } else void refresh(side);
        };
      });
  }
  bindEntryOpen();
  on("#prepare", () => {
    if (workspaceMoving(active)) return;
    if (
      closingWorkspaces.has(workspace().id) ||
      workspace().starting ||
      tab()?.status === "stopping"
    )
      return;
    const current = tab();
    if (current && current.status !== "stopped") {
      stop(current).catch(message);
      return;
    }
    const connected = profile();
    if (!connected) {
      openConnection();
      return;
    }
    const owner=workspace();
    if(owner.loading.local||owner.loading.remote){message(tr("フォルダーの読み込みが完了してから同期してください。"));return;}
    dialog = {
      type: "start",
      workspaceId:owner.id,
      remote: owner.remoteBrowse,
      local: owner.localBrowse,
      p: { ...connected },
    };
    renderDialog();
  });
  on("#retry", async () => {
    const t = tab();
    const w = workspace();
    if (!t || t.status !== "failed" || retrying.has(t.id)) return;
    retrying.add(t.id);
    $("#retry")!.disabled = true;
    try {
      if (t.profile.mode === "sftp") await invoke("retry_sync", { id: t.id });
      if (!store.tabs.includes(t) || ["stopping", "stopped"].includes(t.status))
        return;
      t.status = "running";
    } catch (e) {
      if (
        store.tabs.includes(t) &&
        !["stopping", "stopped"].includes(t.status)
      ) {
        w.notice = rawError(e);
        if (active === w.id) notice = w.notice;
      }
    } finally {
      retrying.delete(t.id);
      if (active === w.id) render();
    }
  });
  on("#burst", () => {
    const t = tab();
    try {
      for (let i = 0; i < 20; i++) t.queue.push("index.html");
      log(t, tr("index.html の変更20件を集約"));
      render();
    } catch (e) {
      t.status = "failed";
      message(e);
    }
  });
  on("#fail", () => {
    const t = tab();
    t.failNext = true;
    t.queue.push("style.css");
    log(t, tr("次の転送で通信失敗を模擬"));
    render();
  });
}
function log(t: SyncTab, s: string) {
  t.logs.push(new Date().toLocaleTimeString() + "  " + s);
  if (t.logs.length > 100) t.logs.shift();
}
function renderDialog() {
  const root = document.querySelector<HTMLElement>("#modal-root");
  if (!root || !dialog) return;
  const $ = (selector: string) =>
    root.querySelector<HTMLInputElement>(selector);
  const d = dialog;
  root.innerHTML = html`<div class="overlay">
    <section
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <h2 id="dialog-title">
        ${d.type === "profile" ? tr("接続プロファイル") : d.type === "start" ? tr("同期する組み合わせを確認") : tr("タブを閉じる")}
      </h2>
      ${
        d.type === "profile"
          ? html`<form id="profile-form">
              <label
                >名前<input name="name" required value="${esc(d.p.name)}"
              /></label>
              <div class="form-row">
                <label
                  >ホスト<input
                    name="host"
                    required
                    value="${esc(d.p.host)}"
                    placeholder="sftp.example.com" /></label
                ><label
                  >ポート<input
                    name="port"
                    type="number"
                    min="1"
                    max="65535"
                    value="${esc(d.p.port)}"
                    required
                /></label>
              </div>
              <label
                >ユーザー名<input
                  name="user"
                  required
                  value="${esc(d.p.user)}" /></label
              ><label
                >接続方式<select name="mode" aria-label="接続方式" required>
                  ${connectionModeOptions(d.p.mode)}
                </select></label
              >${d.p.mode === "mock" && !mockEnabled ? html`<p class="warning">${tr(disabledMockMessage)}</p>` : ""}<input
                type="hidden"
                name="auth"
                value="key"
              />
              <p class="subtle">認証：PPK 秘密鍵</p>
              <label
                >秘密鍵ファイル<input
                  name="keyFile"
                  value="${esc(d.p.keyFile ?? "")}"
                  placeholder="秘密鍵の .ppk ファイル" /></label
              ><button type="button" id="pick-key">秘密鍵ファイルを選択</button
              ><label
                >確認済みホスト鍵（SHA-256）<input
                  name="hostKey"
                  readonly
                  value="${esc(d.p.hostKey ?? "")}"
                  placeholder="初回接続時に確認"
              /></label>
              <p class="subtle">
                ${tr("PPK v2/v3 を内蔵エンジンで読み込みます。保存するのは鍵のパスだけです。ホスト鍵は初回接続時に取得して確認・保存します。保存済みの鍵と異なる場合は接続を拒否します。")}
              </p>
              <div class="actions">
                <button type="button" id="cancel">キャンセル</button
                ><button class="primary">保存</button>
              </div>
            </form>`
          : d.type === "start"
            ? html`<form id="start-form">
                ${syncPathSummary('destination',tr("リモート同期先 /")+" "+d.p.name,d.remote)}
                ${syncPathSummary('source',d.retained?tr("同期元（前回のローカルフォルダー）"):tr("同期元（現在のローカルフォルダー）"),d.local)}
                <input type="hidden" name="local" value="${esc(d.local)}">
                ${d.retained?resumeSettingsMarkup(d.retained):syncSettingsMarkup()}

                <p class="subtle">
                  サイズと更新日時（1秒単位）が同じファイルは送信を省略します。内容の一致を保証する比較ではありません。同名で異なるファイルは、リモート側が新しくてもローカルで上書きします。その後は変更を監視します。
                </p>
                ${d.p.mode === "sftp" ? html`<p class="warning">実 SFTP：開始すると接続・アップロードを実行します。</p>` : html`<p class="mock-note">モック：ファイル監視と転送をシミュレーションします。</p>`}
                <div class="actions">
                  <button type="button" id="cancel">キャンセル</button
                  ><button class="primary">${d.retained?tr("確認して再開"):tr("確認して同期開始")}</button>
                </div>
              </form>`
            : html`<p>同期停止を押し、停止完了後に改めて閉じてください。</p>
                <button id="cancel">閉じる</button>`
      }
      <p class="form-error" role="alert"></p>
    </section>
  </div>`;
  $("#cancel")!.onclick = () => {
    if (dialog === d) {
      dialog = null;
      root.replaceChildren();
      render();
    }
  };
  root.querySelector<HTMLElement>("input,button")?.focus();
  $("#profile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (d.type !== "profile" || connectionMutationPending) return;
    const form = e.target as HTMLFormElement;
    if (form.dataset.busy) return;
    const values = new FormData(form);
    form.dataset.busy = "true";
    form
      .querySelectorAll<HTMLInputElement>("input,select,button")
      .forEach((input) => (input.disabled = true));
    try {
      const p = await mutateConnections((candidate) => {
        const saved = candidate.saveProfile({
          ...d.p,
          auth: "key",
          ...Object.fromEntries(values),
          port: Number(values.get("port")),
          mode: parseConnectionMode(values.get("mode")),
          hostKey: d.p.hostKey ?? "",
        });
        if (!d.p.id && d.parentId)
          candidate.moveConnectionNode(saved.id, d.parentId);
        return saved;
      });
      if (d.returnTo) {
        d.returnTo.profileId = p.id;
        d.returnTo.nodeId = p.id;
        const owner = store.workspaces.find(
          (w) => w.id === d.returnTo!.workspaceId,
        );
        if (owner && !owner.connection) owner.profileId = p.id;
        if (active === owner?.id) selected = p.id;
        if (store.selectSavedProfile(p.id)) await persist();
      }
      if (dialog === d) {
        dialog = null;
        root.replaceChildren();
      }
      render();
    } catch (e) {
      form
        .closest(".dialog")!
        .querySelector<HTMLElement>(".form-error")!.textContent = tError(e);
    } finally {
      delete form.dataset.busy;
      form
        .querySelectorAll<HTMLInputElement>("input,select,button")
        .forEach((input) => (input.disabled = false));
    }
  });
  $("#pick-key")?.addEventListener("click", async () => {
    if (!native) {
      $(".form-error")!.textContent =
        tr("デスクトップ版で鍵を選択してください");
      return;
    }
    try {
      const key = await invoke("pick_key_file", { language: getLanguage() });
      if (key && dialog === d) $("#profile-form [name=keyFile]")!.value = key;
    } catch (e) {
      if (dialog === d) $(".form-error")!.textContent = tError(e);
    }
  });

  if (d.type === "start"&&!d.retained) {
    const own=ownedRetained();
    const initial=own&&sameRetainedConnection(own.profile,d.p)&&own.remote===d.remote&&sameBrowsePath("local",own.local,d.local) ? {exclusionRules:own.exclusionRules,deleteRemoved:own.deleteRemoved,recursive:own.recursive,...(own.presetId?{presetId:own.presetId}:{})} : undefined;
    bindSyncSettings(root, store, d.p.id, d.remote, persist, initial);
  }
  $("#start-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (d.type !== "start") return;
    if(workspace()?.id!==d.workspaceId){root.querySelector<HTMLElement>(".form-error")!.textContent=tr("同期を開始したタブに戻って確認してください。");return;}
    if (!canUseConnection(d.p.mode)) {
      root.querySelector<HTMLElement>(".form-error")!.textContent =
        tr(disabledMockMessage);
      return;
    }
    const startForm = e.target as HTMLFormElement;
    if (
      startForm.dataset.submitting ||
      startForm.dataset.settingsSaving ||
      startForm.dataset.pickingFolder ||
      closingWorkspaces.has(workspace().id)
    )
      return;
    const formData = new FormData(startForm);
    startForm.dataset.submitting = "true";
    startForm
      .querySelectorAll<HTMLInputElement>("input,select,textarea,button")
      .forEach((control) => (control.disabled = true));
    const submit = (
      e.target as HTMLFormElement
    ).querySelector<HTMLButtonElement>(".primary")!;
    submit.disabled = true;
    $("#cancel")!.disabled = true;
    const startingWorkspace = workspace();
    let retainedId=d.retained?.id;
    let cancelled=false;
    startingWorkspace.starting = true;
    updatePrimaryState();
    try {
      const local = d.local;
      if (!local) throw Error(tr("ローカルフォルダを指定してください"));
      if (conflict(store.tabs, d.p, d.remote))
        throw Error(
          tr("同じ接続先で重なる同期が実行中です。先に停止してください"),
        );
      const id = crypto.randomUUID();
      const exclusionRules = d.retained?.exclusionRules ?? String(formData.get("exclusionRules") ?? "");
      validateRules(exclusionRules);
      const rulesKey = exclusionKey(d.p.id, d.remote, local);
      const form = e.target as HTMLFormElement;
      const deleteRemoved = d.retained?.deleteRemoved ?? form.querySelector<HTMLInputElement>(
        "[name=deleteRemoved]",
      )!.checked;
      const recursive = d.retained?.recursive ??
        form.querySelector<HTMLInputElement>("[name=recursive]")!.checked;
      const presetId = d.retained ? d.retained.presetId :
        form.querySelector<HTMLSelectElement>("#sync-preset")!.value;
      store.syncOptions[rulesKey] = {
        deleteRemoved,
        recursive,
        ...(presetId ? { presetId } : {}),
      };
      store.exclusions[rulesKey] = exclusionRules;
      store.rememberSyncPair(d.p, local, d.remote);
      const existing=d.retained??store.ownRetainedForWorkspace(startingWorkspace.id);
      if(existing?.ownerTabId!==undefined&&existing.ownerTabId!==startingWorkspace.id)throw Error(tr("このタブの同期設定ではありません。"));
      retainedId=existing?.id??crypto.randomUUID();
      if(retainedJob(retainedId)||startingRetained.has(retainedId))throw Error(tr("この登録は開始中または同期中です。"));
      startingRetained.add(retainedId);retainedFailures.delete(retainedId);
      const registration:RetainedSync={id:retainedId,profile:{...d.p},local,remote:d.remote,exclusionRules,deleteRemoved,recursive,...(presetId?{presetId}:{}),pendingState:"unknown",ownerTabId:startingWorkspace.id,ownerTabClosed:false};
      await mutateRetained(candidate=>{candidate.upsertRetainedSync(registration);},()=>{if(!store.workspaces.includes(startingWorkspace)||!sameRetainedConnection(startingWorkspace.connection,d.p))throw Error(tr("接続先が変更されています"));});
      if (d.p.mode === "sftp") {
        if (!native) throw Error(tr("SFTP はデスクトップ版を起動してください"));
        await invoke("prepare_sync", { id, sessionId: startingWorkspace.id });
        const cancel = $("#cancel")!;
        cancel.disabled = false;
        cancel.textContent = tr("接続を中止");
        cancel.onclick = async () => {
          cancelled = true;
          cancel.disabled = true;
          try {
            await invoke("stop_sync", { id });
          } catch (error) {
            $(".form-error")!.textContent = tError(error);
          }
        };
        await invoke("start_sync", {
          id,
          profile: d.p,
          local,
          remote: d.remote,
          passphrase: "",
          sessionId: startingWorkspace.id,
          exclusionRules,
          deleteRemoved,
          recursive,
        });
        if (cancelled) {
          await invoke("stop_sync", { id }).catch(() => {});
          throw Error(tr("接続を中止しました"));
        }
      }
      const t: SyncTab = {
        id,
        retainedId,
        profile: { ...d.p },
        local,
        remote: d.remote,
        status: "running",
        queue: new Queue(),
        logs: [],
        errorCount: 0,
        exclusionRules,
        deleteRemoved,
        recursive,
        sent: 0,
        speed: 0,
        latency: 0,
      };
      store.attachJob(startingWorkspace.id, t);
      startingWorkspace.starting = false;
      if(retainedId)startingRetained.delete(retainedId);
      log(
        t,
        d.p.mode === "mock"
          ? tr("モック同期を開始。変更ボタンで送信を確認できます")
          : tr("同期を開始"),
      );
      dialog = null;
      render();
    } catch (e) {
      if(retainedId){startingRetained.delete(retainedId);if(!cancelled)retainedFailures.set(retainedId,rawError(e));}
      startingWorkspace.starting = false;
      paintRetainedSyncs();
      delete startForm.dataset.submitting;
      startForm
        .querySelectorAll<HTMLInputElement>("input,select,textarea,button")
        .forEach((control) => (control.disabled = false));
      $(".form-error")!.textContent = tError(e);
      updatePrimaryState();
      submit.disabled = false;
      $("#cancel")!.disabled = false;
      $("#cancel")!.textContent = tr("キャンセル");
      $("#cancel")!.onclick = () => {
        dialog = null;
        root.innerHTML = "";
      };
    }
  });
}
const stopPromises = new Map<string, Promise<void>>();
async function stop(t: SyncTab) {
  if (store.workspaces.some(w => w.jobId === t.id && workspaceMoving(w.id))) return;
  const previous = stopPromises.get(t.id);
  if (previous) return previous;
  const promise = stopInner(t);
  stopPromises.set(t.id, promise);
  try {
    await promise;
  } finally {
    stopPromises.delete(t.id);
  }
}

async function stopInner(t: SyncTab) {
  if (t.status === "stopped") return;
  for (const w of store.workspaces)
    if (w.jobId === t.id) {
      for (const side of ["local", "remote"] as const) {
        directoryCache(w, side).invalidate();
        w.generation[side]++;
        w.loading[side] = false;
      }
      if (active === w.id) restoreWorkspace();
    }
  let knownUnreflected=t.profile.mode==="mock"&&(t.queue.size>0||!!t.busy);
  if (t.profile.mode === "sftp") {
    t.status = "stopping";render();
    try { const summary=await invoke("stop_sync", { id: t.id });knownUnreflected=summary?.knownUnreflected===true; }
    catch(error){t.status="failed";render();throw error;}
  }
  t.status = "stopped";
  for (const w of store.workspaces)
    if (
      w.connection &&
      JSON.stringify(w.connection) === JSON.stringify(t.profile)
    ) {
      directoryCache(w, "remote").invalidate();
      w.generation.remote++;
      w.loading.remote = false;
      if (active === w.id) restoreWorkspace();
    }
  t.queue = new Queue();
  t.pending = 0;
  t.speed = 0;
  log(t, tr("同期を停止しました。再開はこのタブの「再開」から確認してください。"));
  if(t.retainedId){
    const state=knownUnreflected?"unreflected":"unknown";
    store.updateRetainedPending(t.retainedId,state);
    try {await mutateRetained(candidate=>{candidate.updateRetainedPending(t.retainedId!,state);});}
    catch(error){render();message(error);return;}
  }
  render();
}
let statusPollRunning = false;
setInterval(async () => {
  if (!initialized || statusPollRunning) return;
  refreshSharedSettings();
  statusPollRunning = true;
  try {
    await pollLocalWatch();
    for (const t of [...store.tabs]) {
      if (store.workspaces.some(w => w.jobId === t.id && workspaceMoving(w.id))) continue;
      if (t.profile.mode === "sftp") {
        if (t.status === "stopped" || stopPromises.has(t.id)) continue;
        try {
          const status = await invoke("sync_status", { id: t.id });
          if (
            !["stopped"].includes(t.status) && !stopPromises.has(t.id) &&
            store.tabs.includes(t)
          ) {
            if (status.sent !== t.sent) {
              for (const w of store.workspaces)
                if (
                  w.connection &&
                  JSON.stringify(w.connection) === JSON.stringify(t.profile)
                )
                  directoryCache(w, "remote").invalidate();
            }
            consumeRemoteChanges(t,status.remoteChanges);
            Object.assign(t, status);
          }
        } catch (e) {
          if (
            !["stopped"].includes(t.status) && !stopPromises.has(t.id) &&
            store.tabs.includes(t)
          )
            t.status = t.status === "stopping" && rawError(e) === "Job not found" ? "stopped" : "failed";
        }
        continue;
      }
      if (t.status !== "running" || t.busy) continue;
      const item = t.queue.take();
      if (!item) {
        t.speed = 0;
        continue;
      }
      t.busy = true;
      const started = Date.now();
      await new Promise((r) => setTimeout(r, 80));
      if (t.status !== "running") {
        t.busy = false;
        continue;
      }
      if (t.failNext) {
        t.failNext = false;
        t.queue.retry(item);
        t.status = "failed";
        t.errorCount = (t.errorCount ?? 0) + 1;
        t.speed = 0;
        log(t, tr("通信失敗（モック）。待ち行列を保持。再試行してください"));
      } else {
        t.sent++;
        t.latency = Date.now() - item.first;
        t.speed = Math.round((4096 * 1000) / Math.max(1, Date.now() - started));
        log(t, item.path + tr(" を送信完了（モック）"));
      }
      t.busy = false;
    }
    paintPolledStatus();
  } finally {
    statusPollRunning = false;
  }
}, 700);
window.addEventListener("beforeunload", (e) => {
  if (store.tabs.some((t) => t.status === "running")) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("keydown", (e) => {
  if (!initialized || !settingsAvailable || windowClosing) return;
  if (!e.ctrlKey || !["t", "w", "Tab"].includes(e.key)) return;
  e.preventDefault();
  if (dialog || selectionDrag || pointerBusy) return;
  if(!store.workspaces.length) {
    if(e.key==="t") addWorkspace();
    else if(e.key==="w") void closeEmptyWindow();
    return;
  }
  if (e.key === "t") addWorkspace();
  else if (e.key === "w") closeWorkspace(active);
  else {
    const i = store.workspaces.findIndex((w) => w.id === active),
      n = store.workspaces.length;
    switchWorkspace(store.workspaces[(i + (e.shiftKey ? -1 : 1) + n) % n].id);
  }
});
let updateSettleToken: string | undefined;
let restoreUpdateRoots: (() => void) | undefined;
let updateRootsObserver: MutationObserver | undefined;
let updateSettleDisposed = false;
const updateSettleListeners: (() => void)[] = [];
function updateSettleReady() {
  return initialized && settingsAvailable && !windowClosing && !startupFailed &&
    !settingsOpen && !dialog && !themeSaving && !connectionMutationPending &&
    !bookmarkMutationPending && !retainedWriteCount && !sharedSettingsReading &&
    !movingWorkspaces.size && !outboundTransfers.size && !nativeDrag &&
    !closingWorkspaces.size && !startingRetained.size && !retrying.size &&
    !automaticBusy() && !store.workspaces.some(w => w.connecting || w.starting || w.loading.local || w.loading.remote) &&
    !store.tabs.some(t => t.status !== "stopped");
}
function unsealStartupUpdate() {
  updateSettleToken = undefined;
  updateRootsObserver?.disconnect(); updateRootsObserver = undefined;
  restoreUpdateRoots?.(); restoreUpdateRoots = undefined;
}
function blockUpdateInteraction(event: Event) {
  if (!updateSettleToken) return;
  const target = event.target;
  // The updater dialog is a sibling of the app portals and stays usable.
  if (target instanceof Element && target.closest("#startup-update-dialog")) return;
  event.preventDefault(); event.stopImmediatePropagation();
}
const updateInteractionEvents = ["keydown", "keyup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup", "submit", "input", "change", "wheel"];
async function initializeUpdateSettlement() {
  const events = window.__TAURI__?.event;
  if (!events) return;
  for (const name of updateInteractionEvents) window.addEventListener(name, blockUpdateInteraction, { capture: true, passive: false });
  const retainListener = (stop: () => void) => { if (updateSettleDisposed) stop(); else updateSettleListeners.push(stop); };
  retainListener(await events.listen("startup-update-unseal", unsealStartupUpdate));
  retainListener(await events.listen<{token: string}>("startup-update-settle", event => {
    const token = event.payload?.token;
    if (updateSettleDisposed || typeof token !== "string" || !token || token === updateSettleToken) return;
    unsealStartupUpdate(); updateSettleToken = token;
    const roots = Array.from(document.querySelectorAll<HTMLElement>("#app,#modal-root,#settings-root"));
    restoreUpdateRoots = freezeUpdateRoots(roots);
    updateRootsObserver = new MutationObserver(() => { if (updateSettleToken) for (const root of roots) if (!root.inert) root.inert = true; });
    for (const root of roots) updateRootsObserver.observe(root, { attributes: true, attributeFilter: ["inert"] });
    void (async () => {
      let ready = false;
      try { ready = await settleUpdateWrites(() => [settingsWrites, retainedWrites], updateSettleReady); }
      catch (error) { message(error); }
      if (updateSettleDisposed || updateSettleToken !== token) return;
      await invoke("ack_startup_update", { token, ready });
    })().catch(message);
  }));
}
window.addEventListener("pagehide", () => {
  updateSettleDisposed = true; unsealStartupUpdate();
  for (const stop of updateSettleListeners.splice(0)) stop();
  for (const name of updateInteractionEvents) window.removeEventListener(name, blockUpdateInteraction, true);
});
await initializeUpdateSettlement();

try {
  if (native) {
    windowRegistration = await invoke("register_window");
    if (windowRegistration?.label && Array.isArray(windowRegistration.ownedWorkspaceIds)) {
      document.documentElement.dataset.windowLabel = windowRegistration.label;
      await window.__TAURI__?.event?.listen<WindowTransferRecord>("workspace-transfer", event => acceptTransferRecord(event.payload));
      await initializeNativeTabDrag(windowRegistration.label,acceptNativeDrag);
      await window.__TAURI__?.event?.listen<{ settingsRevision: number }>("settings-changed", () => { sharedSettingsGeneration++; sharedSettingsDirty = true; refreshSharedSettings(); });
    } else windowRegistration = undefined; // Legacy browser fixtures have no coordinator.
  }
  const data = native
    ? await invoke("load_settings")
    : JSON.parse(localStorage.getItem("syncfiles-v1") || "{}");
  const freshMain = windowRegistration?.label === "main" && windowRegistration.freshProcess === true;
  store = windowRegistration && !freshMain ? createWindowStore(data, windowRegistration.ownedWorkspaceIds) : new Store(data);
  previewBootstrap = !!windowRegistration?.pendingTransfer && windowRegistration.pendingTransfer.targetKind !== "existing" && ["dragging","pending"].includes(windowRegistration.pendingTransfer.phase);
  setLanguage(store.language);
  document.documentElement.lang = store.language;
  applyExplorerDensity(store.compactExplorer);
  notice = warningNotice(store.takePreferenceWarnings());
  const themeNeedsSave = store.resolveInitialTheme(initialSystemDark);
  applyTheme();
  settingsAvailable = true;
  // Resolve legacy/absent preference only after the complete validated load.
  // Await the ordinary CAS write before exposing a workspace or editable UI.
  // A rejected/uncertain write falls through to the locked startup error state.
  if (themeNeedsSave && !previewBootstrap) await persist();
  if (
    mockEnabled &&
    !store.profiles.length &&
    !native &&
    !Array.isArray(data.profiles)
  ) {
    store.saveProfile({
      name: tr("デモ接続"),
      host: "demo.invalid",
      port: 22,
      user: "demo",
      mode: "mock",
    });
    await persist();
  }
  selected = store.initialProfileId();
  if (native) localBrowse = await invoke("default_folder");
  defaultLocalBrowse=localBrowse;
  if (windowRegistration) {
    for (const descriptor of windowRegistration.workspaces ?? []) {
      const saved = store.workspaces.find(w => w.id === descriptor.id);
      const runtime = windowRegistration.jobs?.find(j => j.workspaceId === descriptor.id && j.job)?.job as Record<string, unknown> | undefined;
      const connection = descriptor.connection ?? (runtime?.profile as Profile | undefined);
      if (!connection && !runtime) {
        if (!saved) { const blank = store.createWorkspace(selected, defaultLocalBrowse); blank.id = descriptor.id; }
        continue;
      }
      const retained = store.retainedSyncs.find(r => r.ownerTabId === descriptor.id && !r.ownerTabClosed &&
        (!runtime || (sameRetainedConnection(r.profile, runtime.profile as Profile) && r.local === runtime.local && r.remote === runtime.remote)));
      const job = runtime ? Object.fromEntries(["id","profile","local","remote","status","sent","speed","latency","logs","pending","errorCount","exclusionRules","deleteRemoved","recursive"].filter(key => Object.hasOwn(runtime,key)).map(key => [key,runtime[key]])) : undefined;
      // A native stop can finish during reload; poll its existing ID to reconcile.
      const wasStopping = job?.status === "stopping";
      if (wasStopping && job) job.status = "running";
      if (job && retained) job.retainedId = retained.id;
      const temporary = createWindowStore(data, []);
      const recovered = hydrateWorkspaceTransfer(temporary, {
        version: 1,
        workspace: { id: descriptor.id, profileId: saved?.profileId ?? (store.profiles.some(p => p.id === connection?.id) ? connection!.id : ""),
          localBrowse: saved?.localBrowse ?? retained?.local ?? runtime?.local ?? defaultLocalBrowse,
          remoteBrowse: saved?.remoteBrowse ?? retained?.remote ?? runtime?.remote ?? "/", logsOpen: false,
          entries: {local:[],remote:[]}, ...(connection ? {connection} : {}) },
        ...(job ? {job} : {}),
      }, descriptor.id);
      if (wasStopping && temporary.tabs[0]) temporary.tabs[0].status = "stopping";
      if (saved) store.workspaces.splice(store.workspaces.indexOf(saved), 1, recovered);
      else store.workspaces.push(recovered);
      store.tabs.push(...temporary.tabs);
    }
  }
  incomingTransfer = windowRegistration?.pendingTransfer;
  for (const outgoing of windowRegistration?.outgoingTransfers ?? []) {
    if (outgoing.sourceLabel !== windowRegistration?.label) continue;
    outboundTransfers.set(outgoing.token, outgoing);
    movingWorkspaces.add(outgoing.workspaceId);
    document.documentElement.dataset.transferPhase = "pending";
  }
  if (incomingTransfer) {
    movingWorkspaces.add(incomingTransfer.workspaceId);
    const restored = hydrateWorkspaceTransfer(store, incomingTransfer.payload, incomingTransfer.workspaceId);
    positionIncoming(incomingTransfer);
    active = restored.id;
    for (const side of ["local", "remote"] as const) listingSucceeded(restored, side, browsePath(restored, side));
    document.documentElement.dataset.transferPhase = "pending";
  }
  const restored=store.workspaces[0];
  const first = restored ?? store.createWorkspace(selected, newWorkspaceLocal(selected));
  first.notice = notice;
  active = incomingTransfer?.workspaceId ?? first.id;
  restoreWorkspace();
  render();
  transferEventsReady = true;
  for (const record of bufferedTransferEvents.values()) acceptTransferRecord(record);
  bufferedTransferEvents.clear();
  for (const record of outboundTransfers.values()) void monitorOutboundTransfer(record, true);
  if (incomingTransfer) {
    if(incomingTransfer.phase === "dragging") {
      // Real workspace DOM is hydrated but inert; this only makes the native
      // provisional window visible. Ownership still belongs to its source.
      const outcome=await invoke("workspace_drag_preview_ready",{token:incomingTransfer.token});
      if(outcome.phase !== "dragging")acceptTransferRecord(outcome);
    }
    if(incomingTransfer?.phase === "pending")await finishIncomingTransfer(incomingTransfer);
    else if(incomingTransfer?.phase !== "dragging" && incomingTransfer?.phase !== "committed")throw Error("Workspace transfer did not commit");
  } else {
    await Promise.all(store.workspaces.map(w => registerWorkspace(w.id)));
    initialized = true;
    openConnection(workspace());
    for (const w of store.workspaces) if (w.connection) {
      void Promise.all([refresh("local", {}, w), refresh("remote", {}, w)]).catch(message);
    }
  }
} catch (e) {
  const failedTransfer=incomingTransfer ?? windowRegistration?.pendingTransfer;
  if(failedTransfer && ["dragging","pending"].includes(failedTransfer.phase)){
    void invoke("abort_workspace_transfer",{token:failedTransfer.token}).catch(()=>{});
  }
  initialized = true;
  settingsAvailable = false;
  startupFailed = true;
  message(
    tr(
      "設定を読み込めませんでした。上書きを避けるためアプリを再起動してください。 ",
    ) + e,
  );
}

void initializeUpdateRestart(windowRegistration?.label,()=>initialized&&settingsAvailable&&!startupFailed&&!previewBootstrap&&!incomingTransfer);
void initializeStartupUpdate();

function takeSecret(form: HTMLFormElement): string {
  const field = form.querySelector<HTMLInputElement>("[name=passphrase]");
  if (!field) return "";
  const secret = field.value;
  field.value = "";
  return secret;
}

function renderConnection(root: HTMLElement, d: ConnectionDialog) {
  const w = store.workspaces.find((w) => w.id === d.workspaceId);
  if (!settingsAvailable || !w || w.connection) {
    root.innerHTML = "";
    return;
  }
  const chosenId = d.nodeId ?? d.profileId;
  const chosen = store.connectionTree.nodes.find((n) => n.id === chosenId);
  const p =
    chosen?.kind === "group"
      ? undefined
      : store.profiles.find((p) => p.id === chosenId);
  const group = chosen?.kind === "group" ? chosen : undefined;
  const profileSignature = p ? JSON.stringify(p) : "";
  if (d.keyError?.profile !== profileSignature) delete d.keyError;
  root.innerHTML = html`<section
    class="dialog connection-card"
    aria-labelledby="connection-title"
  >
    <h1 id="connection-title">接続先</h1>
    <div class="connection-browser">
      ${connectionTreeMarkup(store, d)}
      <form id="connect-form" class="connection-details">
        <h2>${esc(group?.name ?? p?.name ?? tr("接続先を選択"))}</h2>
        ${
          p
            ? html`<p class="connection-endpoint">
                  ${esc(p.user)}@${esc(p.host)}:${p.port}
                </p>
                <button type="button" id="edit-profile">接続設定</button>`
            : html`<p class="subtle">
                ${group ? tr("グループ内の接続先を選択してください。グループの操作では接続しません。") : tr("接続先を追加するか、左のツリーから選択してください。")}
              </p>`
        }${
          p?.mode === "sftp"
            ? html`<label
                  >秘密鍵のパスフレーズ（必要な場合のみ）<input
                    name="passphrase"
                    type="password"
                    autocomplete="off"
                    aria-describedby="passphrase-error"
                    aria-invalid="${d.keyError ? "true" : "false"}"
                /><span id="passphrase-error" class="passphrase-error" role="alert" aria-atomic="true">${esc(tError(d.keyError?.message ?? ""))}</span></label>
                <p class="subtle">
                  認証情報はこのタブを閉じるまでメモリ内に保持し、設定やログには保存しません。
                </p>`
            : p
              ? mockEnabled
                ? html`<p class="mock-note">
                    モック接続：実際の接続や送信は行いません。
                  </p>`
                : html`<p class="warning">${tr(disabledMockMessage)}</p>`
              : ""
        }
        <p class="subtle">
          接続後、このタブの接続先は固定されます。別の接続先は新しいタブで開いてください。
        </p>
        <div class="actions">
          <button
            class="primary"
            ${p && canUseConnection(p.mode) ? "" : "disabled"}
          >
            接続
          </button>
        </div>
        <p class="connection-info subtle" role="status">
          ${esc(tError(d.info ?? ""))}
        </p>
        <p class="form-error" role="alert"></p>
      </form>
    </div>
  </section>`;
  const form = root.querySelector<HTMLFormElement>("#connect-form")!;
  const passphraseInput = form.querySelector<HTMLInputElement>("[name=passphrase]");
  const keyErrorNode = form.querySelector<HTMLElement>("#passphrase-error");
  const clearKeyError = () => {
    delete d.keyError;
    if (keyErrorNode) keyErrorNode.textContent = "";
    passphraseInput?.setAttribute("aria-invalid", "false");
  };
  passphraseInput?.addEventListener("input", clearKeyError);
  const edit = (profile: Partial<Profile>, parentId?: string | null) => {
    cancelHostKeyApproval();
    if (connectionMutationPending || w.connecting) return;
    clearKeyError();
    dialog = { type: "profile", p: profile, returnTo: d, parentId };
    renderDialog();
  };
  bindConnectionTree(root, store, d, {
    select: (id) => {
      cancelHostKeyApproval();
      if (w.connecting || connectionMutationPending) return;
      clearKeyError();
      d.nodeId = id;
      const node = store.connectionTree.nodes.find((n) => n.id === id);
      d.profileId = node?.kind === "profile" ? node.profileId : "";
      w.profileId = d.profileId;
      if (active === w.id) selected = d.profileId;
      if (store.selectSavedProfile(d.profileId)) void persist().catch(message);
      renderConnection(root, d);
      root
        .querySelector<HTMLButtonElement>(
          `[data-connection-select="${CSS.escape(id)}"]`,
        )
        ?.focus();
    },
    edit,
    deleteReason: (id) => {
      const node = store.connectionTree.nodes.find((n) => n.id === id);
      if (!node) return tr("接続先またはグループが見つかりません");
      if (node.kind === "group") return;
      try {
        store.assertConnectionProfileDeletable(node.profileId);
      } catch (error) {
        return String(error instanceof Error ? error.message : error);
      }
    },
    mutate: mutateConnections,
    refresh: (id) => {
      if (id !== undefined) {
        d.nodeId = id;
        const node = store.connectionTree.nodes.find((n) => n.id === id);
        d.profileId = node?.kind === "profile" ? node.profileId : "";
        w.profileId = d.profileId;
      }
      if (!w.connection && !w.connecting && store.workspaces.includes(w))
        renderConnection(root, d);
    },
    busy: () =>
      w.connecting ||
      connectionMutationPending ||
      !store.workspaces.includes(w),
  });

  root
    .querySelector<HTMLButtonElement>("#edit-profile")
    ?.addEventListener("click", () => {
      if (p) edit({ ...p });
    });

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!p || w.connecting || connectionMutationPending) return;
    clearKeyError();
    form.querySelector<HTMLElement>(".form-error")!.textContent = "";
    if (!canUseConnection(p.mode)) {
      takeSecret(form);
      form.querySelector<HTMLElement>(".form-error")!.textContent =
        tr(disabledMockMessage);
      return;
    }
    const snapshot = { ...p };
    if (snapshot.mode === "sftp" && !snapshot.hostKey?.trim()) {
      takeSecret(form);
      const current = (expected = snapshot) =>
        active === w.id &&
        store.workspaces.includes(w) &&
        !w.connection &&
        (d.nodeId ?? d.profileId) === snapshot.id &&
        sameConnectionProfile(
          store.profiles.find((p) => p.id === snapshot.id),
          expected,
        );
      if (!native) {
        form.querySelector<HTMLElement>(".form-error")!.textContent = tr(
          "SFTP はデスクトップ版で接続してください",
        );
        return;
      }
      void showHostKeyApproval({
        profile: snapshot,
        current,
        busy: (value) => {
          w.connecting = value;
          root
            .querySelectorAll<HTMLInputElement>("input,select,button")
            .forEach((input) => (input.disabled = value));
        },
        approve: (requestId, token, frozen) =>
          approveNativeHostKey(requestId, token, frozen, () => current(frozen)),
        reload: () => reloadApprovedProfile(snapshot),
        saved: (pinned) => {
          d.profileId = pinned.id;
          d.nodeId = pinned.id;
          d.info = tr(
            "ホスト鍵を保存しました。必要な場合はパスフレーズを入力し、接続してください。",
          );
          connectionViews.delete(w.id);
          render();
        },
      });
      return;
    }
    w.connecting = true;
    let cancelled = false;
    let passphrase = takeSecret(form);
    root
      .querySelectorAll<HTMLInputElement>("input,select,button")
      .forEach((e) => (e.disabled = true));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.id = "connect-cancel";
    cancel.textContent = tr("接続を中止");
    cancel.disabled = true;
    form.querySelector(".actions")!.prepend(cancel);
    const errorNode = form.querySelector<HTMLElement>(".form-error")!;
    const submit = form.querySelector<HTMLButtonElement>(".primary")!;
    submit.textContent = tr("接続中…");
    try {
      let connected: { path: string; entries: Entry[] };
      if (snapshot.mode === "sftp") {
        if (!native) throw Error(tr("SFTP はデスクトップ版で接続してください"));
        await invoke("prepare_session", { id: w.id });
        cancel.disabled = false;
        cancel.onclick = async () => {
          cancelled = true;
          cancel.disabled = true;
          try {
            await invoke("disconnect_session", { id: w.id });
          } catch (error) {
            errorNode.textContent = tError(error);
          }
        };
        const request = invoke("connect_session", {
          id: w.id,
          profile: snapshot,
          passphrase,
        });
        passphrase = "";
        connected = await request;
      } else {
        passphrase = "";
        connected = { path: "/", entries: demoFiles("/") };
      }
      if (cancelled || !store.workspaces.includes(w)) {
        if (native && snapshot.mode === "sftp")
          await invoke("disconnect_session", { id: w.id });
        throw Error(tr("接続を中止しました"));
      }
      const owned=store.ownRetainedForWorkspace(w.id);
      const savedBrowse = owned&&sameRetainedConnection(owned.profile,snapshot) ? {local:owned.local,remote:owned.remote} : store.lastBrowse(snapshot);
      store.connectWorkspace(w.id, snapshot);
      // Establish the initial tree view once. Subsequent navigation and listing
      // updates preserve every chevron's state.
      const initialLocal = savedBrowse.local ?? w.localBrowse;
      const drive = /^[A-Za-z]:[\\/]/.exec(initialLocal)?.[0];
      if (drive) {
        let ancestor = drive.replaceAll("/", "\\");
        w.trees.local.node(ancestor).expanded = true;
        for (const part of initialLocal
          .slice(3)
          .split(/[\\/]/)
          .filter(Boolean)
          .slice(0, 40)) {
          ancestor = childPath("local", ancestor, part);
          w.trees.local.node(ancestor).expanded = true;
        }
      }
      w.remoteBrowse = remotePath(connected.path);
      if (!savedBrowse.remote || savedBrowse.remote === w.remoteBrowse)
        w.navigation.remote.commit(w.remoteBrowse);
      const tree = folderTree(w, "remote", snapshot);
      w.entries.remote = connected.entries;
      listingSucceeded(w, "remote", w.remoteBrowse);
      w.selections.remote.context(
        JSON.stringify(["remote", snapshot, w.remoteBrowse]),
        connected.entries
          .filter((e) => supportedName(e.name))
          .map((e) => e.name),
      );
      tree.record(w.remoteBrowse, connected.entries);
      tree.node("/").expanded = true;
      let initialAncestor = "";
      for (const part of w.remoteBrowse.split("/").filter(Boolean)) {
        initialAncestor += "/" + part;
        tree.node(initialAncestor).expanded = true;
      }
      tree.node(w.remoteBrowse).expanded = true;
      directoryCache(w, "remote").seed(w.remoteBrowse, connected.entries);
      w.connecting = false;
      connectionViews.delete(w.id);
      restoreWorkspace();
      render();
      await restoreBrowses(w, savedBrowse, connected);
    } catch (error) {
      w.connecting = false;
      // Cached background views may show their own failure, but an obsolete form
      // must never update a replacement form or steal the active tab's focus.
      const ownsForm = store.workspaces.includes(w) && !w.connection &&
        root.querySelector("#connect-form") === form &&
        (d.nodeId ?? d.profileId) === snapshot.id &&
        sameConnectionProfile(store.profiles.find((p) => p.id === snapshot.id), snapshot);
      if (!ownsForm) return;
      const failure = connectionError(error);
      const inline = !cancelled && failure.kind === "keyUnlockFailed" && !!keyErrorNode;
      if (inline) {
        d.keyError = { profile: profileSignature, message: failure.message };
        keyErrorNode!.textContent = tError(failure.message);
        passphraseInput?.setAttribute("aria-invalid", "true");
      } else {
        errorNode.textContent = cancelled ? tr("接続を中止しました") : tError(failure.message);
      }
      root
        .querySelectorAll<HTMLInputElement>("input,select,button")
        .forEach((e) => (e.disabled = false));
      submit.textContent = tr("接続");
      cancel.remove();
      if (inline && active === w.id && form.isConnected && document.hasFocus())
        passphraseInput?.focus({ preventScroll: true });
    } finally {
      passphrase = "";
      w.connecting = false;
    }
  };
  root
    .querySelector<HTMLElement>(
      `[data-connection-select="${CSS.escape(chosenId)}"]`,
    )
    ?.focus();
}

