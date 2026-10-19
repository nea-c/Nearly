import type { Language } from "./i18n.js";
import { t } from "./i18n.js";
import type { Entry, Profile, Settings, Status } from "./core.js";
export interface HostKeyCandidate {
  requestId: string;
  token: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  expiresInSeconds: number;
}
export interface ArchiveRequest {
  sources?: string[];
  id: string;
  action: "compress" | "extract";
  source: string;
  destination: string;
  side: "local" | "remote";
}
export interface ArchiveOutcome {
  finalPath: string;
  action: "compress" | "extract";
  entries: number;
  bytes: number;
}
export interface ArchiveError {
  code: string;
  stagePath?: string | null;
  committed: boolean;
}
export interface WindowTransferRecord {
  token: string;
  workspaceId: string;
  sourceLabel: string;
  targetLabel: string;
  phase: "dragging" | "pending" | "committed" | "aborted";
  payload: unknown;
  targetKind?: "new" | "existing";
  beforeId?: string | null;
  targetIndex?: number | null;
}
export interface TabDragStatus {
  dragId: string;
  sourceLabel: string;
  workspaceId: string;
  phase: "dragging" | "cancelled" | "pending" | "reordered" | "committed" | "moved";
  targetLabel: string | null;
  beforeId: string | null;
  targetIndex: number | null;
  token: string | null;
  reason: string | null;
}
export type TabStripRect = { x: number; y: number; width: number; height: number };
export interface TabStripGeometry {
  rect: TabStripRect;
  appendRect?: TabStripRect;
  items: {workspaceId: string; rect: TabStripRect}[];
  viewport: {width: number; height: number};
}
export interface WindowRegistration {
  label: string;
  freshProcess?: boolean;
  ownedWorkspaceIds: string[];
  pendingTransfer?: WindowTransferRecord;
  outgoingTransfers?: WindowTransferRecord[];
  jobs: { id: string; workspaceId: string; job?: unknown }[];
  workspaces?: { id: string; connection?: Profile }[];
}
export interface StartupUpdateReport {state:string;latestVersion:string|null;canInstall:boolean;errorCode?:string|null}
export interface UpdateRestartReport {phase:string;reason?:string;revision:number;installerQa?:boolean}
export interface UploadRequest { id: string; sessionId: string; sources: string[]; remote: string; recursive: boolean; interactive?: boolean }
export interface TransferPrompt {token:string;source:string;destination:string;sourceDirectory:boolean;targetDirectory:boolean;canOverwrite:boolean}
export interface UploadOutcome { status: "completed" | "partial" | "cancelled"; completed: number; bytes: number; transferredBytes?: number; skipped?: number; message: string }
export type NativeFileDrop = {type: "enter" | "over" | "drop" | "leave"; ownOutbound?: boolean; paths?: string[]; position?: {x:number;y:number}};
export interface RemoteDragOutcome extends UploadOutcome { internalPosition?: {x:number;y:number} | null }
interface Commands {
  file_transfer_prompt: {args:{id:string};result:TransferPrompt|null};
  choose_file_transfer: {args:{id:string;decision:{token:string;action:'overwrite'|'skip'|'keepboth'|'cancel';applyAll:boolean}};result:void};
  run_upload: {args: {request: UploadRequest}; result: UploadOutcome};
  run_download: {args:{request:{id:string;sessionId:string;sources:string[];local:string}};result:UploadOutcome};
  run_remote_drag: {args:{request:{id:string;sessionId:string;sources:string[]}};result:RemoteDragOutcome};
  update_restart_status: { args: undefined; result: UpdateRestartReport };
  ack_update_restart_ready: { args: {bootstrap?:boolean}|undefined; result: void };
  check_startup_update: { args: undefined; result: StartupUpdateReport };
  startup_update_status: { args: undefined; result: StartupUpdateReport };
  prepare_startup_update: { args: undefined; result: StartupUpdateReport };
  cancel_startup_update: { args: undefined; result: StartupUpdateReport };
  dismiss_startup_update: { args: undefined; result: StartupUpdateReport };
  install_startup_update: { args: undefined; result: StartupUpdateReport };
  ack_startup_update: { args: {token:string;ready:boolean}; result: void };
  close_empty_window: { args: undefined; result: void };
  register_tab_strip: { args: {geometry: TabStripGeometry | null}; result: void };
  begin_tab_drag: { args: {workspaceId: string; payload: unknown; grab: {x: number; y: number}; title: string}; result: TabDragStatus };
  cancel_tab_drag: { args: {dragId: string | null}; result: TabDragStatus };
  tab_drag_status: { args: {dragId: string}; result: TabDragStatus };
  register_window: { args: undefined; result: WindowRegistration };
  register_workspace: { args: { id: string }; result: void };
  unregister_workspace: { args: { id: string }; result: void };
  begin_workspace_transfer: { args: { workspaceId: string; payload: unknown }; result: WindowTransferRecord };
  workspace_transfer_ready: { args: { token: string }; result: WindowTransferRecord };
  workspace_drag_preview_ready: { args: { token: string }; result: WindowTransferRecord };
  workspace_transfer_status: { args: { token: string }; result: WindowTransferRecord };
  abort_workspace_transfer: { args: { token: string }; result: WindowTransferRecord };
  watch_local_directory: { args: { id: string; path: string; token: number }; result: {token:number;revision:number;error?:string} };
  local_watch_status: { args: { id: string }; result: {token:number;revision:number;error?:string} };
  unwatch_local_directory: { args: { id: string; token: number }; result: boolean };
  run_local_archive: {
    args: { request: ArchiveRequest };
    result: ArchiveOutcome;
  };
  probe_host_key: {
    args: { requestId: string; profile: Profile };
    result: HostKeyCandidate;
  };
  cancel_host_key: { args: { requestId: string }; result: void };
  approve_host_key: {
    args: {
      requestId: string;
      token: string;
      profile: Profile;
      expectedRevision: number;
    };
    result: Profile & { settingsRevision?: number };
  };
  prepare_session: { args: { id: string }; result: void };
  connect_session: {
    args: { id: string; profile: Profile; passphrase: string };
    result: { path: string; entries: Entry[] };
  };
  disconnect_session: { args: { id: string }; result: void };
  prepare_file_operation: { args: { id: string }; result: void };
  run_file_operation: {
    args: { request: FileOperationRequest };
    result: { completed: number; message: string };
  };
  cancel_file_operation: { args: { id: string; abandon?: boolean }; result: void };
  load_settings: { args: undefined; result: Settings };
  save_settings: { args: { data: Settings }; result: number };
  list_local: { args: { path: string }; result: Entry[] };
  list_drives: {
    args: undefined;
    result: { path: string; name: string; kind?: string }[];
  };
  list_remote: {
    args: {
      profile: Profile;
      path: string;
      passphrase: string;
      sessionId?: string;
    };
    result: Entry[];
  };
  pick_folder: {
    args: { language?: Language } | undefined;
    result: string | null;
  };
  pick_key_file: {
    args: { language?: Language } | undefined;
    result: string | null;
  };
  default_folder: { args: undefined; result: string };
  start_sync: {
    args: {
      id: string;
      profile: Profile;
      local: string;
      remote: string;
      passphrase: string;
      sessionId?: string;
      exclusionRules?: string;
      deleteRemoved?: boolean;
      recursive?: boolean;
    };
    result: void;
  };
  stop_sync: { args: { id: string }; result: {knownUnreflected:boolean} };
  prepare_sync: { args: { id: string; sessionId?: string }; result: void };
  retry_sync: { args: { id: string }; result: void };
  sync_status: { args: { id: string }; result: Status };
}
export interface FileOperationRequest {
  id: string;
  side: "local" | "remote";
  action: "copy" | "move" | "delete" | "createfile" | "mkdir";
  source: string;
  destination?: string;
  profile?: Profile;
  sessionId?: string;
  passphrase: string;
  confirmDelete: boolean;
}
declare global {
  interface Window {
    __TAURI__?: {
      webview?: { getCurrentWebview(): { onDragDropEvent(handler: (event: {payload: NativeFileDrop}) => void): Promise<() => void> } };
      core: { invoke<T>(cmd: string, args?: unknown): Promise<T> };
      event?: {
        listen<T>(
          event: string,
          handler: (event: { payload: T }) => void,
        ): Promise<() => void>;
      };
      window?: {
        getCurrentWindow(): {
          minimize(): Promise<void>;
          toggleMaximize(): Promise<void>;
          close(): Promise<void>;
          isMaximized(): Promise<boolean>;
          onResized?(handler: () => void): Promise<() => void>;
        };
      };
    };
  }
}
export const native = !!window.__TAURI__;
let coordinated = false;
const registrations = new Map<string, Promise<void>>();
export function registerWorkspace(id: string): Promise<void> {
  if (!coordinated) return Promise.resolve();
  let pending = registrations.get(id);
  if (!pending) {
    pending = window.__TAURI__!.core.invoke<void>("register_workspace", { id });
    registrations.set(id, pending);
    void pending.catch(() => registrations.delete(id));
  }
  return pending;
}
export let windowMaximized = false;
export function windowIcon(
  kind: "minimize" | "maximize" | "restore" | "close",
) {
  const shape = {
    minimize: '<path d="M1 6.5h10"/>',
    maximize: '<rect x="1.5" y="1.5" width="9" height="9"/>',
    restore: '<path d="M3.5 1.5h7v7M1.5 3.5h7v7h-7z"/>',
    close: '<path d="m1.5 1.5 9 9m0-9-9 9"/>',
  }[kind];
  return `<svg class="caption-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true" focusable="false">${shape}</svg>`;
}
function updateWindowMaximized(value: boolean) {
  windowMaximized = value;
  const button = document.querySelector<HTMLButtonElement>("#window-maximize");
  if (button) {
    button.innerHTML = windowIcon(value ? "restore" : "maximize");
    button.setAttribute(
      "aria-label",
      value ? t("元のサイズに戻す") : t("最大化"),
    );
  }
}
const nativeWindow = window.__TAURI__?.window?.getCurrentWindow();
if (nativeWindow) {
  nativeWindow
    .isMaximized()
    .then(updateWindowMaximized)
    .catch(() => {});
  nativeWindow
    .onResized?.(() => {
      nativeWindow
        .isMaximized()
        .then(updateWindowMaximized)
        .catch(() => {});
    })
    .catch(() => {});
}
export async function windowControl(
  action: "minimize" | "toggleMaximize" | "close",
) {
  const current = window.__TAURI__?.window?.getCurrentWindow();
  if (!current) throw Error(t("ウィンドウ操作はデスクトップ版で利用できます"));
  await current[action]();
  if (action === "toggleMaximize") {
    const button =
      document.querySelector<HTMLButtonElement>("#window-maximize");
    if (button) {
      const maximized = await current.isMaximized();
      updateWindowMaximized(maximized);
      button.setAttribute(
        "aria-label",
        maximized ? t("元のサイズに戻す") : t("最大化"),
      );
    }
  }
}
export function invoke<K extends keyof Commands>(
  cmd: K,
  ...args: undefined extends Commands[K]["args"]
    ? [args?: Exclude<Commands[K]["args"], undefined>]
    : [Commands[K]["args"]]
): Promise<Commands[K]["result"]> {
  if (!window.__TAURI__)
    return Promise.reject(Error(t("デスクトップ版が必要です")));
  const parameters = args[0] as { id?: string; sessionId?: string } | undefined;
  const registerId = ["prepare_session", "watch_local_directory"].includes(cmd)
    ? parameters?.id : cmd === "prepare_sync" ? parameters?.sessionId : undefined;
  const execute = () => window.__TAURI__!.core.invoke<Commands[K]["result"]>(cmd, args[0]);
  const result = registerId ? registerWorkspace(registerId).then(execute) : execute();
  if (cmd === "unregister_workspace") return result.then(value => { if (parameters?.id) registrations.delete(parameters.id); return value; });
  if (cmd === "register_window") return result.then(value => {
    const registration = value as WindowRegistration | undefined;
    coordinated = !!registration?.label && Array.isArray(registration.ownedWorkspaceIds);
    for (const id of registration?.ownedWorkspaceIds ?? []) registrations.set(id, Promise.resolve());
    return value;
  });
  return result;
}
