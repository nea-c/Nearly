import {
  MAX_RETAINED_SYNCS,
  snapshotRetainedSync,
  validateRetainedSyncs,
} from "./retained-sync.js";
import type { RetainedSync, RetainedPendingState } from "./retained-sync.js";
export type { RetainedSync, RetainedPendingState } from "./retained-sync.js";
import type { Language } from "./i18n.js";
import {
  reorderedWorkspaces,
  retainedSyncsInWorkspaceOrder,
} from "./workspace-order.js";
import { BrowseHistory } from "./navigation.js";
import { FolderTree, PC_ROOT } from "./tree.js";
import { FileSelection } from "./selection.js";
import { validateBrowseLocations } from "./browse-preferences.js";
import type { BrowseLocations, BrowseLocation } from "./browse-preferences.js";
export type { BrowseLocations, BrowseLocation } from "./browse-preferences.js";
import {
  BookmarkTreeEditor,
  flatBookmarkTree,
  validateBookmarkTree,
  BOOKMARK_TREE_WARNING,
} from "./bookmark-tree.js";
import type { BookmarkTree } from "./bookmark-tree.js";
export type { BookmarkTree, BookmarkTreeNode } from "./bookmark-tree.js";
import {
  ConnectionTreeEditor,
  flatConnectionTree,
  validateConnectionTree,
  TREE_WARNING,
} from "./connection-tree.js";
import type { ConnectionTree } from "./connection-tree.js";
export type { ConnectionTree, ConnectionTreeNode } from "./connection-tree.js";
import {
  connectionKey,
  defaultPaneColumns,
  localFolder,
  remoteFolder,
  pairKey,
  validateBookmark,
  validatePair,
  validateCollection,
  validatePaneColumns,
} from "./explorer-preferences.js";
import type {
  FolderBookmark,
  FolderPairHistoryEntry,
  PaneColumns,
  PaneSort,
} from "./explorer-preferences.js";
export { connectionKey } from "./explorer-preferences.js";
export type {
  FolderBookmark,
  FolderPairHistoryEntry,
  PaneColumnSettings,
  PaneColumns,
  ColumnId,
  PaneSort,
} from "./explorer-preferences.js";
export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: "key";
  mode: "mock" | "sftp";
  keyFile: string;
  hostKey: string;
}
// `system` is accepted only as a historical/uninitialized load sentinel.
export type ThemePreference =
  "light" | "dark" | "midnight" | "forest" | "mint" | "system";
export const DEFAULT_SYNC_PRESET_ID = "nearly:sync-default:v1";
export interface SyncOptions {
  deleteRemoved: boolean;
  recursive: boolean;
  presetId?: string;
}
export interface SyncPreset extends SyncOptions {
  id: string;
  name: string;
  exclusionRules: string;
}
export interface Settings {
  lastSelectedProfileId?: string;
  lastSelectedProfileChanged?: boolean;
  retainedSyncs?: RetainedSync[];
  settingsRevision?: number;
  version: 1;
  profiles: Profile[];
  history: Record<string, string>;
  theme?: ThemePreference;
  language?: Language;
  compactExplorer?: boolean;
  localPaneRatio?: number;
  localTreeRatio?: number;
  remoteTreeRatio?: number;
  exclusions?: Record<string, string>;
  syncOptions?: Record<string, SyncOptions>;
  syncPresets?: SyncPreset[];
  folderBookmarks?: FolderBookmark[];
  folderPairHistory?: FolderPairHistoryEntry[];
  paneColumns?: PaneColumns;
  connectionTree?: ConnectionTree;
  connectionTreeChanged?: boolean;
  connectionTreeWarning?: string;
  bookmarkTree?: BookmarkTree;
  bookmarkTreeChanged?: boolean;
  bookmarkTreeWarning?: string;
  browseLocations?: BrowseLocations;
  browseLocationsChanged?: boolean;
  preferenceWarnings?: string[];
}
export interface Entry {
  name: string;
  dir: boolean;
  size: number;
  modifiedAt?: number;
  permissions?: number;
  owner?: string;
  hidden?: boolean;
}
export interface Status {
  remoteChanges?: import("./auto-refresh.js").RemoteChanges;
  status: "running" | "failed" | "stopped" | "stopping";
  pending?: number;
  sent: number;
  speed: number;
  latency: number;
  logs: string[];
  errorCount?: number;
}
export interface SyncTab extends Status {
  retainedId?: string;
  id: string;
  profile: Profile;
  local: string;
  remote: string;
  queue: Queue;
  busy?: boolean;
  failNext?: boolean;
  exclusionRules?: string;
  deleteRemoved?: boolean;
  recursive?: boolean;
}
export interface Pending {
  path: string;
  first: number;
  last: number;
  attempt: number;
}
export type Side = "local" | "remote";
export interface Workspace {
  id: string;
  profileId: string;
  localBrowse: string;
  remoteBrowse: string;
  entries: Record<Side, Entry[]>;
  loading: Record<Side, boolean>;
  generation: Record<Side, number>;
  navigation: Record<Side, BrowseHistory>;
  notice: string;
  trees: Record<Side, FolderTree>;
  selections: Record<Side, FileSelection>;
  jobId?: string;
  starting?: boolean;
  connection?: Readonly<Profile>;
  connecting?: boolean;
  logsOpen: boolean;
}
export function remotePath(p: string): string {
  if (
    typeof p !== "string" ||
    !p.startsWith("/") ||
    p.includes("\\") ||
    /[\x00-\x1f]/.test(p)
  )
    throw Error("リモートパスは / で始めてください");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}
export const overlap = (a: string, b: string): boolean => {
  a = remotePath(a);
  b = remotePath(b);
  return (
    a === b ||
    a === "/" ||
    b === "/" ||
    a.startsWith(b + "/") ||
    b.startsWith(a + "/")
  );
};
export function exclusionKey(profileId: string, remote: string, local: string) {
  return JSON.stringify([
    profileId,
    remotePath(remote),
    local.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(),
  ]);
}
export class Queue {
  items = new Map<string, Pending>();
  constructor(public limit = 10000) {}
  get size() {
    return this.items.size;
  }
  push(path: string, now = Date.now()) {
    if (!this.items.has(path) && this.size >= this.limit)
      throw Error("待ち件数が上限です。停止して再走査してください");
    const old = this.items.get(path);
    this.items.set(path, {
      path,
      first: old?.first ?? now,
      last: now,
      attempt: 0,
    });
  }
  take(now = Date.now()) {
    for (const [path, item] of this.items) {
      if (now - item.last >= 500) {
        this.items.delete(path);
        return item;
      }
    }
    return null;
  }
  retry(item: Pending, now = Date.now()) {
    if (!this.items.has(item.path))
      this.items.set(item.path, {
        ...item,
        last: now,
        attempt: item.attempt + 1,
      });
  }
}
export class Store {
  lastSelectedProfileId: string | undefined;
  lastSelectedProfileChanged = false;
  lastSelectedProfileRevision = 0;
  initialProfileId(): string {
    return this.profiles.some(p => p.id === this.lastSelectedProfileId)
      ? this.lastSelectedProfileId! : this.profiles[0]?.id ?? "";
  }
  selectSavedProfile(id: string): boolean {
    if (!this.profiles.some(p => p.id === id)) return false;
    this.lastSelectedProfileId = id;
    this.lastSelectedProfileChanged = true;
    this.lastSelectedProfileRevision++;
    return true;
  }
  markLastSelectedProfileSaved(revision = this.lastSelectedProfileRevision): boolean {
    if (revision !== this.lastSelectedProfileRevision) return false;
    this.lastSelectedProfileChanged = false;
    return true;
  }
  browseLocations: BrowseLocations = {};
  browseLocationsChanged = false;
  browsePreferencesRevision = 0;
  preferenceWarnings: string[] = [];
  private browseTokens = new Map<string, number>();
  private browseSequence = 0;
  private lastGoodLayout = {
    localPaneRatio: 0.5,
    localTreeRatio: 0.28,
    remoteTreeRatio: 0.28,
  };
  private lastGoodWidths = defaultPaneColumns();
  bookmarkTree: BookmarkTree = { version: 1, nodes: [] };
  bookmarkTreeChanged = false;
  bookmarkTreeWarning = "";
  connectionTree: ConnectionTree = { version: 1, nodes: [] };
  connectionTreeChanged = false;
  connectionTreeWarning = "";
  folderBookmarks: FolderBookmark[] = [];
  folderPairHistory: FolderPairHistoryEntry[] = [];
  paneColumns: PaneColumns = defaultPaneColumns();
  theme: ThemePreference;
  language: Language;
  compactExplorer: boolean;
  localPaneRatio = 0.5;
  localTreeRatio = 0.28;
  remoteTreeRatio = 0.28;
  exclusions: Record<string, string> = {};
  syncOptions: Record<string, SyncOptions> = {};
  syncPresets: SyncPreset[] = [];
  profiles: Profile[];
  history: Record<string, string>;
  retainedSyncs: RetainedSync[] = [];
  tabs: SyncTab[] = [];
  workspaces: Workspace[] = [];
  /** Reordering changes presentation only; workspace/job/session objects survive. */
  reorderWorkspaces(orderedIds: string[]): boolean {
    const reordered = reorderedWorkspaces(this.workspaces, orderedIds);
    if (!reordered) return false;
    this.workspaces = reordered;
    return true;
  }
  createWorkspace(
    profileId = this.initialProfileId(),
    localBrowse?: string,
  ): Workspace {
    if (this.workspaces.length >= 16) throw Error("タブは最大16個です");
    let id: string;
    do {
      id = globalThis.crypto.randomUUID();
    } while (
      this.workspaces.some((w) => w.id === id) ||
      this.retainedSyncs.some((r) => r.ownerTabId === id)
    );
    const profile = this.profiles.find((p) => p.id === profileId);
    const remembered = profile ? this.lastBrowse(profile) : {};
    const workspace: Workspace = {
      id,
      profileId,
      localBrowse: localBrowse ?? remembered.local ?? "C:\\Projects",
      remoteBrowse: remembered.remote ?? "/",
      entries: { local: [], remote: [] },
      loading: { local: false, remote: false },
      generation: { local: 0, remote: 0 },
      navigation: { local: new BrowseHistory(), remote: new BrowseHistory() },
      notice: "",
      logsOpen: false,
      trees: {
        local: new FolderTree("local", PC_ROOT),
        remote: new FolderTree("remote", "/"),
      },
      selections: { local: new FileSelection(), remote: new FileSelection() },
    };
    this.workspaces.push(workspace);
    return workspace;
  }
  /** Ownership is never inferred from matching connections or folder pairs. */
  ownRetainedForWorkspace(workspaceId: string): RetainedSync | undefined {
    if (!this.workspaces.some((w) => w.id === workspaceId)) return undefined;
    const record = this.retainedSyncs.find(
      (r) => r.ownerTabId === workspaceId && !r.ownerTabClosed,
    );
    return record ? snapshotRetainedSync(record) : undefined;
  }
  ensureRetainedWorkspace(ownerId: string): Workspace | undefined {
    const record = this.retainedSyncs.find(
      (r) => r.ownerTabId === ownerId && r.ownerTabClosed === false,
    );
    if (!record) return undefined;
    const existing = this.workspaces.find((w) => w.id === ownerId);
    if (existing) return existing;
    const workspace = this.createWorkspace(record.profile.id, record.local);
    workspace.id = ownerId;
    workspace.remoteBrowse = record.remote;
    return workspace;
  }
  closeRetainedWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    const job = this.tabs.find((t) => t.id === workspace?.jobId);
    if (
      workspace?.connecting ||
      workspace?.starting ||
      (job && (job.status !== "stopped" || job.busy))
    )
      throw Error("Stop the linked sync before closing its retained tab");
    const index = this.retainedSyncs.findIndex(
      (r) => r.ownerTabId === workspaceId,
    );
    if (index < 0 || this.retainedSyncs[index].ownerTabClosed) return;
    // An explicit close ends this owner's session-only stopped context.
    // Unrelated closed, foreign, and legacy records remain unchanged.
    this.retainedSyncs.splice(index, 1);
  }
  restoreLastRetainedWorkspace(): Workspace | undefined {
    // Historical closed records remain opaque shared metadata, never reopenable tabs.
    return undefined;
  }
  listRetainedSyncs(): RetainedSync[] {
    return validateRetainedSyncs(this.retainedSyncs);
  }
  upsertRetainedSync(record: RetainedSync): RetainedSync {
    const clean = snapshotRetainedSync(record);
    const index = this.retainedSyncs.findIndex(
      (value) => value.id === clean.id,
    );
    if (index < 0 && this.retainedSyncs.length >= MAX_RETAINED_SYNCS)
      throw Error("Retained syncs are limited to 100 records");
    const previous = this.retainedSyncs[index];
    if (previous && previous.ownerTabId !== clean.ownerTabId)
      throw Error("Retained tab ownership cannot be reassigned");
    const candidate = this.retainedSyncs.map((r, i) =>
      i === index ? clean : r,
    );
    if (index < 0) candidate.push(clean);
    this.retainedSyncs = validateRetainedSyncs(candidate);
    return snapshotRetainedSync(clean);
  }
  updateRetainedPending(id: string, state: RetainedPendingState): RetainedSync {
    const record = this.retainedSyncs.find((value) => value.id === id);
    if (!record) throw Error("Retained sync not found");
    return this.upsertRetainedSync({ ...record, pendingState: state });
  }
  removeRetainedSync(id: string): boolean {
    if (
      this.tabs.some(
        (job) =>
          job.retainedId === id && (job.status !== "stopped" || job.busy),
      )
    )
      throw Error("Stop the linked sync before removing its retained entry");
    const index = this.retainedSyncs.findIndex((record) => record.id === id);
    if (index < 0) return false;
    this.retainedSyncs.splice(index, 1);
    return true;
  }
  attachJob(workspaceId: string, job: SyncTab) {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) throw Error("タブは閉じられています");
    if (
      !workspace.connection ||
      JSON.stringify(workspace.connection) !== JSON.stringify(job.profile)
    )
      throw Error("このタブで接続したプロファイルだけを同期できます");
    if (job.retainedId !== undefined) {
      const retained = this.retainedSyncs.find(
        (record) => record.id === job.retainedId,
      );
      if (!retained) throw Error("Retained sync not found");
      if (
        retained.ownerTabId !== undefined &&
        (retained.ownerTabId !== workspaceId || retained.ownerTabClosed)
      )
        throw Error("Retained sync belongs to another tab");
      if (
        this.tabs.some(
          (active) =>
            active.id !== workspace.jobId &&
            active.retainedId === job.retainedId &&
            (active.status !== "stopped" || active.busy),
        )
      )
        throw Error("This retained sync already has an active job");
    }
    const previous = this.tabs.find((t) => t.id === workspace.jobId);
    if (previous && previous.status !== "stopped")
      throw Error("現在の同期を先に停止してください");
    this.tabs = this.tabs.filter((t) => t.id !== workspace.jobId);
    this.tabs.push({
      ...job,
      profile: { ...job.profile },
      remote: remotePath(job.remote),
    });
    workspace.jobId = job.id;
  }
  connectWorkspace(workspaceId: string, profile: Profile) {
    const w = this.workspaces.find((w) => w.id === workspaceId);
    if (!w) throw Error("タブは閉じられています");
    if (
      w.connection &&
      JSON.stringify(w.connection) !== JSON.stringify(profile)
    )
      throw Error("別の接続先は新しいタブで開いてください");
    w.connection ??= Object.freeze({ ...profile });
    w.profileId = w.connection.id;
  }
  changeWorkspaceProfile(workspaceId: string, profileId: string) {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || !this.profiles.some((p) => p.id === profileId))
      throw Error("接続先が見つかりません");
    const job = this.tabs.find((t) => t.id === workspace.jobId);
    if (
      workspace.connection ||
      workspace.connecting ||
      workspace.starting ||
      (job && job.status !== "stopped")
    )
      throw Error("別の接続先は新しいタブで開いてください");
    this.tabs = this.tabs.filter((t) => t.id !== workspace.jobId);
    workspace.jobId = undefined;
    workspace.profileId = profileId;
    const remembered = this.lastBrowse(
      this.profiles.find((p) => p.id === profileId)!,
    );
    workspace.localBrowse = remembered.local ?? workspace.localBrowse;
    workspace.remoteBrowse = remembered.remote ?? "/";
    workspace.navigation.local = new BrowseHistory();
    workspace.entries.local = [];
    workspace.generation.local++;
    workspace.loading.local = false;
    workspace.trees.local = new FolderTree("local", PC_ROOT);
    workspace.selections.local = new FileSelection();
    workspace.navigation.remote = new BrowseHistory();
    workspace.entries.remote = [];
    workspace.generation.remote++;
    workspace.loading.remote = false;
    workspace.trees.remote = new FolderTree("remote", "/");
    workspace.selections.remote = new FileSelection();
    workspace.notice = "";
  }
  closeWorkspace(workspaceId: string) {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return;
    const job = this.tabs.find((t) => t.id === workspace.jobId);
    if (
      workspace.connecting ||
      workspace.starting ||
      (job && job.status !== "stopped")
    )
      throw Error("タブを閉じる前に同期を停止してください");
    this.closeRetainedWorkspace(workspaceId);
    workspace.generation.local++;
    workspace.generation.remote++;
    this.tabs = this.tabs.filter((t) => t.id !== workspace.jobId);
    this.workspaces = this.workspaces.filter((w) => w.id !== workspaceId);
  }
  settingsRevision = 0;
  constructor(
    data: Partial<Settings> = {},
    options: { ownedWorkspaceIds?: readonly string[] } = {},
  ) {
    if (data.lastSelectedProfileId != null &&
      (typeof data.lastSelectedProfileId !== "string" || !data.lastSelectedProfileId || data.lastSelectedProfileId.length > 128))
      throw Error("Invalid last selected profile ID");
    this.lastSelectedProfileId = data.lastSelectedProfileId ?? undefined;
    if (data.retainedSyncs !== undefined)
      this.retainedSyncs = validateRetainedSyncs(data.retainedSyncs);
    if (data.settingsRevision !== undefined) {
      if (
        !Number.isSafeInteger(data.settingsRevision) ||
        data.settingsRevision < 0
      )
        throw new Error("Invalid settings revision");
      this.settingsRevision = data.settingsRevision;
    }
    if (data.browseLocations !== undefined)
      this.browseLocations = validateBrowseLocations(data.browseLocations);
    if (
      Array.isArray(data.preferenceWarnings) &&
      data.preferenceWarnings.every((v) => typeof v === "string")
    )
      this.preferenceWarnings = [...data.preferenceWarnings];
    if (data.folderBookmarks !== undefined) {
      this.folderBookmarks = validateCollection(
        data.folderBookmarks,
        validateBookmark,
        500,
      );
      if (
        new Set(this.folderBookmarks.map((x) => x.id)).size !==
          this.folderBookmarks.length ||
        new Set(this.folderBookmarks.map(pairKey)).size !==
          this.folderBookmarks.length
      )
        throw Error("Duplicate folder bookmark");
    }
    if (data.folderPairHistory !== undefined) {
      this.folderPairHistory = validateCollection(
        data.folderPairHistory,
        validatePair,
      );
      if (
        new Set(this.folderPairHistory.map(pairKey)).size !==
        this.folderPairHistory.length
      )
        throw Error("Duplicate folder pair history");
    }
    if (data.paneColumns !== undefined) {
      this.paneColumns = validatePaneColumns(data.paneColumns, true);
      if (
        ["local", "remote"].some((side) =>
          Object.values(data.paneColumns![side as Side]?.widths ?? {}).some(
            (v) => v === null,
          ),
        )
      )
        this.warnPreference("保存された列幅の一部を既定値に戻しました。");
    }
    for (const key of ["localTreeRatio", "remoteTreeRatio"] as const) {
      const value = data[key];
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0.15 &&
        value <= 0.65
      )
        this[key] = value;
    }
    if (
      typeof data.localPaneRatio === "number" &&
      Number.isFinite(data.localPaneRatio) &&
      data.localPaneRatio >= 0.2 &&
      data.localPaneRatio <= 0.8
    )
      this.localPaneRatio = data.localPaneRatio;
    if (data.exclusions !== undefined) {
      if (
        !data.exclusions ||
        typeof data.exclusions !== "object" ||
        Array.isArray(data.exclusions) ||
        Object.values(data.exclusions).some((v) => typeof v !== "string")
      )
        throw Error("除外ルールの設定形式が不正です");
      this.exclusions = { ...data.exclusions };
    }
    if (data.syncOptions !== undefined) {
      if (
        !data.syncOptions ||
        typeof data.syncOptions !== "object" ||
        Array.isArray(data.syncOptions)
      )
        throw Error("同期オプションの設定形式が不正です");
      for (const [key, value] of Object.entries(data.syncOptions)) {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          (value.deleteRemoved !== undefined &&
            typeof value.deleteRemoved !== "boolean") ||
          (value.recursive !== undefined &&
            typeof value.recursive !== "boolean") ||
          (value.presetId !== undefined && typeof value.presetId !== "string")
        )
          throw Error("同期オプションの設定形式が不正です");
        this.syncOptions[key] = {
          deleteRemoved: value.deleteRemoved ?? false,
          recursive: value.recursive ?? true,
          ...(value.presetId ? { presetId: value.presetId } : {}),
        };
      }
    }
    if (data.syncPresets !== undefined) {
      if (!Array.isArray(data.syncPresets))
        throw Error("同期設定プロファイルの形式が不正です");
      for (const preset of data.syncPresets) {
        const value = this.checkedSyncPreset(preset);
        if (
          typeof preset.id !== "string" ||
          !preset.id ||
          preset.id.length > 128 ||
          this.syncPresets.some((p) => p.id === preset.id)
        )
          throw Error("同期設定プロファイルの形式が不正です");
        this.syncPresets.push({ ...value, id: preset.id, name: preset.name });
      }
      if (
        this.syncPresets.filter((p) => p.id !== DEFAULT_SYNC_PRESET_ID).length >
        100
      )
        throw Error("同期設定プロファイルは100件までです");
    }
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray(data.profiles ?? []) ||
      (data.history !== undefined &&
        (data.history === null ||
          typeof data.history !== "object" ||
          Array.isArray(data.history) ||
          Object.values(data.history).some((v) => typeof v !== "string")))
    )
      throw Error("設定ファイルの形式が不正です");
    if (data.version !== undefined && data.version !== 1)
      throw Error("未対応の設定バージョンです");
    if (
      data.theme !== undefined &&
      !["light", "dark", "midnight", "forest", "mint", "system"].includes(
        data.theme,
      )
    )
      throw Error("テーマ設定が不正です");
    this.theme = data.theme ?? "system";
    if (
      data.language !== undefined &&
      data.language !== "ja" &&
      data.language !== "en"
    )
      throw Error("言語設定が不正です");
    if (
      data.compactExplorer !== undefined &&
      typeof data.compactExplorer !== "boolean"
    )
      throw Error("コンパクト表示設定が不正です");
    this.language = data.language ?? "ja";
    this.compactExplorer = data.compactExplorer ?? false;
    this.profiles = [];
    this.history = { ...data.history };
    for (const p of data.profiles ?? []) {
      if (
        !p ||
        typeof p.id !== "string" ||
        !p.id ||
        this.profiles.some((x) => x.id === p.id)
      )
        throw Error("接続設定の形式が不正です");
      this.saveProfile(p);
    }
    try {
      this.connectionTree =
        data.connectionTree == null
          ? flatConnectionTree(this.profiles)
          : validateConnectionTree(data.connectionTree, this.profiles, true);
      this.connectionTreeWarning =
        typeof data.connectionTreeWarning === "string"
          ? data.connectionTreeWarning
          : "";
    } catch {
      this.connectionTree = flatConnectionTree(this.profiles);
      this.connectionTreeWarning = TREE_WARNING;
    }
    this.connectionTreeChanged = false;
    try {
      this.bookmarkTree =
        data.bookmarkTree == null
          ? flatBookmarkTree(this.folderBookmarks)
          : validateBookmarkTree(data.bookmarkTree, this.folderBookmarks, true);
      this.bookmarkTreeWarning =
        typeof data.bookmarkTreeWarning === "string"
          ? data.bookmarkTreeWarning
          : "";
    } catch {
      this.bookmarkTree = flatBookmarkTree(this.folderBookmarks);
      this.bookmarkTreeWarning = BOOKMARK_TREE_WARNING;
    }
    this.bookmarkTreeChanged = false;
    for (const record of this.retainedSyncs)
      if (
        record.ownerTabId !== undefined &&
        record.ownerTabClosed === false &&
        options.ownedWorkspaceIds?.includes(record.ownerTabId)
      )
        this.ensureRetainedWorkspace(record.ownerTabId);
    this.lastGoodLayout = {
      localPaneRatio: this.localPaneRatio,
      localTreeRatio: this.localTreeRatio,
      remoteTreeRatio: this.remoteTreeRatio,
    };
    for (const side of ["local", "remote"] as const)
      this.lastGoodWidths[side].widths = {
        ...this.lastGoodWidths[side].widths,
        ...this.paneColumns[side].widths,
      };
    for (const key of [
      "localPaneRatio",
      "localTreeRatio",
      "remoteTreeRatio",
    ] as const)
      if (data[key] === null)
        this.warnPreference("保存された画面分割比の一部を既定値に戻しました。");
  }
  saveProfile(p: Partial<Profile>): Profile {
    if (
      !p.name?.trim() ||
      !p.host?.trim() ||
      !p.user?.trim() ||
      !Number.isInteger(Number(p.port)) ||
      Number(p.port) < 1 ||
      Number(p.port) > 65535
    )
      throw Error("名前・ホスト・ユーザー名と正しいポートを入力してください");
    const clean: Profile = {
      id: p.id || globalThis.crypto.randomUUID(),
      name: p.name.trim(),
      host: p.host.trim().toLowerCase(),
      port: Number(p.port),
      user: p.user.trim(),
      auth: "key",
      mode: p.mode === "sftp" ? "sftp" : "mock",
      keyFile: p.keyFile ?? "",
      hostKey: p.hostKey ?? "",
    };
    const i = this.profiles.findIndex((x) => x.id === clean.id);
    if (i < 0) {
      if (this.profiles.length >= 200)
        throw Error("Connections are limited to 200 profiles");
      const nextProfiles = [...this.profiles, clean];
      const nextTree = {
        version: 1 as const,
        nodes: [
          ...this.connectionTree.nodes,
          {
            id: clean.id,
            kind: "profile" as const,
            profileId: clean.id,
            parentId: null,
          },
        ],
      };
      this.connectionTree = validateConnectionTree(nextTree, nextProfiles);
      this.profiles = nextProfiles;
      this.connectionTreeChanged = true;
    } else {
      this.profiles[i] = clean;
    }
    return clean;
  }
  remember(id: string, remote: string, local: string) {
    const profile = this.profiles.find((p) => p.id === id);
    if (profile) this.rememberSyncPair(profile, local, remote);
  }
  local(id: string, remote: string) {
    const profile = this.profiles.find((p) => p.id === id);
    return profile ? this.localFor(profile, remote) : "";
  }
  localFor(profile: Profile, remote: string) {
    return (
      this.history[
        JSON.stringify([connectionKey(profile), remotePath(remote)])
      ] ?? ""
    );
  }
  rememberSyncPair(profile: Profile, local: string, remote: string) {
    const path = localFolder(local),
      target = remoteFolder(remote);
    this.history[JSON.stringify([connectionKey(profile), target])] = path;
    this.rememberFolderPair(profile, path, target);
  }
  rememberFolderPair(profile: Profile, local: string, remote: string) {
    const pair = validatePair({
      connectionKey: connectionKey(profile),
      local,
      remote,
      openedAt: Date.now(),
    });
    this.folderPairHistory = [
      pair,
      ...this.folderPairHistory.filter((p) => pairKey(p) !== pairKey(pair)),
    ].slice(0, 200);
  }
  legacyFolderPairs(
    profile: Profile,
  ): Array<{ local: string; remote: string }> {
    const result: Array<{ local: string; remote: string }> = [];
    for (const [key, local] of Object.entries(this.history)) {
      try {
        const parts: unknown = JSON.parse(key);
        if (
          Array.isArray(parts) &&
          parts.length === 2 &&
          parts[0] === profile.id
        )
          result.push({
            local: localFolder(local),
            remote: remoteFolder(parts[1]),
          });
      } catch {
        /* Unknown legacy paths remain untrusted and are not opened. */
      }
    }
    return result.slice(0, 200);
  }
  saveFolderBookmark(
    profile: Profile,
    input: { id?: string; name: string; local: string; remote: string },
  ): FolderBookmark {
    const candidate = validateBookmark({
      ...input,
      id: input.id || globalThis.crypto.randomUUID(),
      connectionKey: connectionKey(profile),
    });
    const duplicate = this.folderBookmarks.find(
      (b) => pairKey(b) === pairKey(candidate),
    );
    const existing = input.id
      ? this.folderBookmarks.find((b) => b.id === input.id)
      : duplicate;
    if (existing && existing.connectionKey !== candidate.connectionKey)
      throw Error("A bookmark cannot change its connection identity");
    if (duplicate && duplicate.id !== existing?.id)
      throw Error("This folder pair is already bookmarked");
    if (existing) {
      candidate.id = existing.id;
      const bookmarks = this.folderBookmarks.map((b) =>
        b.id === existing.id ? candidate : b,
      );
      this.bookmarkTree = validateBookmarkTree(this.bookmarkTree, bookmarks);
      this.folderBookmarks = bookmarks;
    } else {
      if (this.folderBookmarks.length >= 500)
        throw Error("Bookmarks are limited to 500 entries");
      const bookmarks = [...this.folderBookmarks, candidate];
      const tree = validateBookmarkTree(
        {
          version: 1,
          nodes: [
            ...this.bookmarkTree.nodes,
            {
              id: candidate.id,
              kind: "bookmark",
              bookmarkId: candidate.id,
              connectionKey: candidate.connectionKey,
              parentId: null,
            },
          ],
        },
        bookmarks,
      );
      this.folderBookmarks = bookmarks;
      this.bookmarkTree = tree;
      this.bookmarkTreeChanged = true;
    }
    return candidate;
  }
  removeFolderBookmark(id: string) {
    const bookmarks = this.folderBookmarks.filter((b) => b.id !== id);
    if (bookmarks.length === this.folderBookmarks.length) return;
    const tree = validateBookmarkTree(
      {
        version: 1,
        nodes: this.bookmarkTree.nodes.filter(
          (n) => n.kind !== "bookmark" || n.bookmarkId !== id,
        ),
      },
      bookmarks,
    );
    this.folderBookmarks = bookmarks;
    this.bookmarkTree = tree;
    this.bookmarkTreeChanged = true;
  }
  private editBookmarkTree<T>(action: (editor: BookmarkTreeEditor) => T): T {
    const editor = new BookmarkTreeEditor(
      this.bookmarkTree,
      this.folderBookmarks,
    );
    const result = action(editor);
    editor.finish();
    this.bookmarkTree = editor.tree;
    this.folderBookmarks = editor.bookmarks;
    this.bookmarkTreeChanged = true;
    return result;
  }
  createBookmarkGroup(
    key: string,
    name: string,
    parentId: string | null = null,
  ) {
    return this.editBookmarkTree((e) => e.create(key, name, parentId));
  }
  renameBookmarkNode(key: string, id: string, name: string) {
    this.editBookmarkTree((e) => e.rename(key, id, name));
  }
  moveBookmarkNode(
    key: string,
    id: string,
    parentId: string | null,
    beforeId: string | null = null,
  ) {
    this.editBookmarkTree((e) => e.move(key, id, parentId, beforeId));
  }
  ungroupBookmarkFolder(key: string, id: string) {
    this.editBookmarkTree((e) => e.ungroup(key, id));
  }
  markBookmarkTreeSaved() {
    this.bookmarkTreeChanged = false;
    this.bookmarkTreeWarning = "";
  }
  private editConnectionTree<T>(
    action: (editor: ConnectionTreeEditor) => T,
  ): T {
    const editor = new ConnectionTreeEditor(this.connectionTree, this.profiles);
    const result = action(editor);
    editor.finish();
    this.connectionTree = editor.tree;
    this.profiles = editor.profiles;
    this.connectionTreeChanged = true;
    return result;
  }
  createConnectionGroup(name: string, parentId: string | null = null) {
    return this.editConnectionTree((e) => e.create(name, parentId));
  }
  renameConnectionNode(id: string, name: string) {
    this.editConnectionTree((e) => e.rename(id, name));
  }
  setConnectionGroupExpanded(id: string, expanded: boolean) {
    const dirty = this.connectionTreeChanged;
    this.editConnectionTree((e) => e.expanded(id, expanded));
    this.connectionTreeChanged = dirty;
  }
  moveConnectionNode(
    id: string,
    parentId: string | null,
    beforeId: string | null = null,
  ) {
    this.editConnectionTree((e) => e.move(id, parentId, beforeId));
  }
  duplicateConnectionNode(id: string) {
    return this.editConnectionTree((e) => e.duplicate(id));
  }
  dissolveConnectionGroup(id: string) {
    this.editConnectionTree((e) => e.dissolve(id));
  }
  assertConnectionProfileDeletable(
    id: string,
    references: Pick<Store, "workspaces" | "tabs"> = this,
  ) {
    if (!this.profiles.some((p) => p.id === id))
      throw Error("接続先が見つかりません");
    if (
      references.workspaces.some(
        (w) =>
          w.connection?.id === id ||
          (w.profileId === id && (w.connecting || w.starting)),
      ) ||
      references.tabs.some(
        (t) => t.profile.id === id && (t.status !== "stopped" || t.busy),
      )
    )
      throw Error(
        "この接続先は接続中・接続処理中・同期中に使用されています。停止してタブを閉じてから削除してください。",
      );
  }
  deleteConnectionNode(
    id: string,
    references: Pick<Store, "workspaces" | "tabs"> = this,
  ) {
    const node = this.connectionTree.nodes.find((n) => n.id === id);
    if (!node) throw Error("接続先またはグループが見つかりません");
    if (node.kind === "profile")
      this.assertConnectionProfileDeletable(node.profileId, references);
    this.editConnectionTree((e) => e.remove(id));
    if (node.kind === "profile")
      for (const w of this.workspaces)
        if (!w.connection && !w.connecting && w.profileId === node.profileId)
          w.profileId = "";
  }
  markConnectionTreeSaved() {
    this.connectionTreeChanged = false;
    this.connectionTreeWarning = "";
  }
  private warnPreference(message: string) {
    if (!this.preferenceWarnings.includes(message))
      this.preferenceWarnings.push(message);
  }
  takePreferenceWarnings() {
    const warnings = [...this.preferenceWarnings];
    this.preferenceWarnings = [];
    return warnings;
  }
  beginBrowse(profile: Profile, side: Side): number {
    if (this.browseSequence >= Number.MAX_SAFE_INTEGER)
      throw Error("Browse request counter exhausted");
    const token = ++this.browseSequence;
    this.browseTokens.set(
      JSON.stringify([connectionKey(profile), side]),
      token,
    );
    return token;
  }
  rememberSuccessfulBrowse(
    profile: Profile,
    side: Side,
    path: string,
    token: number,
  ): boolean {
    const key = connectionKey(profile);
    if (this.browseTokens.get(JSON.stringify([key, side])) !== token)
      return false;
    const value = side === "local" ? localFolder(path) : remoteFolder(path);
    this.browseLocations = validateBrowseLocations({
      ...this.browseLocations,
      [key]: { ...this.browseLocations[key], [side]: value },
    });
    this.browseLocationsChanged = true;
    this.browsePreferencesRevision++;
    return true;
  }
  lastBrowse(profile: Profile): BrowseLocation {
    return { ...this.browseLocations[connectionKey(profile)] };
  }
  markBrowseLocationsSaved(revision = this.browsePreferencesRevision) {
    if (revision !== this.browsePreferencesRevision) return false;
    this.browseLocationsChanged = false;
    return true;
  }
  setPaneSort(side: Side, sort: PaneSort) {
    const panes = validatePaneColumns({
      ...this.paneColumns,
      [side]: { ...this.paneColumns[side], sort },
    });
    this.paneColumns[side].sort = panes[side].sort;
    this.browseLocationsChanged = true;
    this.browsePreferencesRevision++;
  }
  private finitePaneColumns(): PaneColumns {
    for (const key of [
      "localPaneRatio",
      "localTreeRatio",
      "remoteTreeRatio",
    ] as const) {
      const n = this[key],
        min = key === "localPaneRatio" ? 0.2 : 0.15,
        max = key === "localPaneRatio" ? 0.8 : 0.65;
      if (typeof n === "number" && Number.isFinite(n) && n >= min && n <= max)
        this.lastGoodLayout[key] = n;
      else {
        this[key] = this.lastGoodLayout[key];
        this.warnPreference("不正な画面分割比を直前の有効な値に戻しました。");
      }
    }
    const allowed = [
      "name",
      "size",
      "type",
      "modified",
      "permissions",
      "owner",
    ] as const;
    for (const side of ["local", "remote"] as const)
      for (const id of allowed) {
        const n = this.paneColumns[side].widths[id];
        if (n === undefined) continue;
        if (typeof n === "number" && Number.isFinite(n) && n >= 40 && n <= 1200)
          this.lastGoodWidths[side].widths[id] = n;
        else if (n === null || typeof n === "number") {
          const fallback = this.lastGoodWidths[side].widths[id];
          if (fallback === undefined) delete this.paneColumns[side].widths[id];
          else this.paneColumns[side].widths[id] = fallback;
          this.warnPreference("不正な列幅を直前の有効な値に戻しました。");
        } else throw Error("Column width must be numeric");
      }
    return validatePaneColumns(this.paneColumns);
  }
  resolveInitialTheme(osDark: boolean): boolean {
    if (this.theme !== "system") return false;
    this.theme = osDark ? "dark" : "light";
    return true;
  }
  serialize(): Settings {
    const panes = this.finitePaneColumns();
    return {
      version: 1,
      retainedSyncs: retainedSyncsInWorkspaceOrder(
        this.listRetainedSyncs(),
        this.workspaces,
      ),
      settingsRevision: this.settingsRevision,
      lastSelectedProfileId: this.lastSelectedProfileId,
      lastSelectedProfileChanged: this.lastSelectedProfileChanged,
      profiles: this.profiles,
      history: this.history,
      theme: this.theme,
      language: this.language,
      compactExplorer: this.compactExplorer,
      localPaneRatio: this.localPaneRatio,
      localTreeRatio: this.localTreeRatio,
      remoteTreeRatio: this.remoteTreeRatio,
      exclusions: this.exclusions,
      syncOptions: this.syncOptions,
      syncPresets: this.syncPresets,
      folderBookmarks: this.folderBookmarks,
      folderPairHistory: this.folderPairHistory,
      paneColumns: panes,
      connectionTree: this.connectionTree,
      connectionTreeChanged: this.connectionTreeChanged,
      bookmarkTree: this.bookmarkTree,
      bookmarkTreeChanged: this.bookmarkTreeChanged,
      browseLocations: this.browseLocations,
      browseLocationsChanged: this.browseLocationsChanged,
    };
  }
  private checkedSyncPreset(p: Partial<SyncPreset>): SyncPreset {
    if (
      !p ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      [...p.name].length > 100 ||
      (p.exclusionRules !== undefined &&
        typeof p.exclusionRules !== "string") ||
      (p.deleteRemoved !== undefined && typeof p.deleteRemoved !== "boolean") ||
      (p.recursive !== undefined && typeof p.recursive !== "boolean")
    )
      throw Error("名前と同期設定を確認してください");
    validateRules(p.exclusionRules ?? "");
    return {
      id: p.id || globalThis.crypto.randomUUID(),
      name: p.name.trim(),
      exclusionRules: p.exclusionRules ?? "",
      deleteRemoved: p.deleteRemoved ?? false,
      recursive: p.recursive ?? true,
    };
  }
  defaultSyncPreset(): SyncPreset {
    return {
      ...(this.syncPresets.find((p) => p.id === DEFAULT_SYNC_PRESET_ID) ?? {
        id: DEFAULT_SYNC_PRESET_ID,
        name: "Default",
        exclusionRules: "",
        deleteRemoved: false,
        recursive: true,
      }),
    };
  }
  saveDefaultSyncPreset(
    p: Omit<SyncOptions, "presetId"> & { exclusionRules: string },
  ): SyncPreset {
    const value = this.checkedSyncPreset({
      ...p,
      id: DEFAULT_SYNC_PRESET_ID,
      name: "Default",
    });
    const index = this.syncPresets.findIndex(
      (p) => p.id === DEFAULT_SYNC_PRESET_ID,
    );
    if (index < 0) this.syncPresets.push(value);
    else this.syncPresets[index] = value;
    return value;
  }
  saveSyncPreset(p: Partial<SyncPreset>): SyncPreset {
    if (p.id === DEFAULT_SYNC_PRESET_ID)
      throw Error("デフォルトは専用の保存操作で更新してください");
    const value = this.checkedSyncPreset(p);
    const current = this.syncPresets.find((x) => x.id === p.id);
    const matches = this.syncPresets.filter(
      (x) => x.id !== DEFAULT_SYNC_PRESET_ID && x.name.trim() === value.name,
    );
    let id = current?.name.trim() === value.name ? current.id : undefined;
    if (!id && matches.length > 1)
      throw Error(
        "同名のプロファイルが複数あります。更新するプロファイルを選択してください",
      );
    id ??= matches[0]?.id ?? current?.id ?? value.id;
    value.id = id;
    const index = this.syncPresets.findIndex((x) => x.id === id);
    if (index < 0) {
      if (
        this.syncPresets.filter((x) => x.id !== DEFAULT_SYNC_PRESET_ID)
          .length >= 100
      )
        throw Error("同期設定プロファイルは100件までです");
      this.syncPresets.push(value);
    } else this.syncPresets[index] = value;
    return value;
  }
  deleteSyncPreset(id: string): void {
    if (id === DEFAULT_SYNC_PRESET_ID)
      throw Error("デフォルトのプロファイルは削除できません");
    if (!this.syncPresets.some((p) => p.id === id))
      throw Error("削除するプロファイルが見つかりません");
    const fallback = this.defaultSyncPreset();
    this.syncPresets = this.syncPresets.filter((p) => p.id !== id);
    for (const [key, options] of Object.entries(this.syncOptions))
      if (options.presetId === id) {
        this.syncOptions[key] = {
          deleteRemoved: fallback.deleteRemoved,
          recursive: fallback.recursive,
        };
        this.exclusions[key] = fallback.exclusionRules;
      }
  }
}
export function validateRules(text: string) {
  const bytes = new TextEncoder();
  if (
    bytes.encode(text).length > 65536 ||
    text.split("\n").length > 2048 ||
    text.split("\n").some((line) => bytes.encode(line).length > 4096)
  )
    throw Error(
      "除外ルールは64KiB・2048行以内、1行4096バイト以内で入力してください",
    );
}
export function conflict(
  tabs: SyncTab[],
  profile: Profile,
  remote: string,
): boolean {
  return tabs.some(
    (t) =>
      t.status !== "stopped" &&
      t.profile.mode === profile.mode &&
      t.profile.host.toLowerCase() === profile.host.toLowerCase() &&
      t.profile.port === profile.port &&
      overlap(t.remote, remote),
  );
}
