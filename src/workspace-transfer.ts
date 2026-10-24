import { Store, Queue, remotePath } from "./core.js";
import type { Settings, Workspace, Profile, Entry, SyncTab } from "./core.js";
import { FolderTree, PC_ROOT, supportedName } from "./tree.js";
import type { TreeSnapshot } from "./tree.js";
import type { NavigationSnapshot } from "./navigation.js";
import type { SelectionSnapshot } from "./selection.js";
import { BrowseHistory, normalizeLocalBrowse } from "./navigation.js";
import { FileSelection } from "./selection.js";

/** Ephemeral, secret-free IPC payload. It is never a settings document. */
export interface WorkspaceTransfer {
  version: 1;
  viewState?: {
    selection: Record<"local" | "remote", SelectionSnapshot>;
    navigation: Record<"local" | "remote", NavigationSnapshot>;
    trees: Record<"local" | "remote", TreeSnapshot>;
  };
  workspace: Pick<
    Workspace,
    "id" | "profileId" | "localBrowse" | "remoteBrowse" | "logsOpen" | "entries"
  > & { connection?: Profile };
  job?: Omit<
    SyncTab,
    "queue" | "busy" | "failNext" | "remoteChanges" | "status"
  > & { status: "running" | "failed" | "stopped" };
}
export const MAX_WORKSPACE_TRANSFER_BYTES = 2 * 1024 * 1024;
const profileFields = [
  "id",
  "name",
  "host",
  "port",
  "user",
  "auth",
  "mode",
  "keyFile",
  "hostKey",
];
const entryFields = ["name", "dir", "size"];
const entryOptional = ["modifiedAt", "permissions", "owner", "hidden"];
const jobFields = [
  "id",
  "profile",
  "local",
  "remote",
  "status",
  "sent",
  "speed",
  "latency",
  "logs",
];
const jobOptional = [
  "syncPhase",
  "retainedId",
  "pending",
  "errorCount",
  "exclusionRules",
  "deleteRemoved",
  "recursive",
  "failure",
  "statusError",
  "stopComplete",
  "deletionRescanRequired",
];
function fail(): never {
  throw Error("Invalid workspace transfer");
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  return value as Record<string, unknown>;
}
/** Read only approved own data fields. Unknown runtime fields are never evaluated. */
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
  project = false,
): Record<string, unknown> {
  const raw = object(value),
    out: Record<string, unknown> = {};
  if (
    !project &&
    Reflect.ownKeys(raw).some(
      (key) =>
        typeof key !== "string" || ![...required, ...optional].includes(key),
    )
  )
    fail();
  for (const key of [...required, ...optional]) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor) {
      if (required.includes(key)) fail();
      continue;
    }
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw Error("Transfer fields must be ordinary data");
    if (descriptor.value !== undefined || !project) out[key] = descriptor.value;
  }
  return out;
}
function str(value: unknown, max = 4096, empty = true): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value) ||
    value.includes("\0") ||
    /[\ud800-\udfff]/u.test(value)
  )
    fail();
  return value;
}
function id(value: unknown): string {
  const out = str(value, 64, false);
  if (!/^[A-Za-z0-9_-]+$/.test(out)) fail();
  return out;
}
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) fail();
  if (
    Reflect.ownKeys(value).some(
      (k) =>
        typeof k !== "string" ||
        (k !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= value.length)),
    )
  )
    fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, "value"))
      throw Error("Transfer fields must be ordinary data");
    return d.value;
  });
}
function profile(value: unknown, project: boolean): Profile {
  const p = fields(value, profileFields, [], project);
  for (const k of ["id", "name", "host", "user", "keyFile", "hostKey"])
    str(
      p[k],
      k === "id" ? 128 : k === "name" ? 100 : 4096,
      !["id", "name", "host", "user"].includes(k),
    );
  if (
    p.auth !== "key" ||
    !["mock", "sftp"].includes(p.mode as string) ||
    !Number.isInteger(p.port) ||
    num(p.port) < 1 ||
    Number(p.port) > 65535
  )
    fail();
  return p as unknown as Profile;
}
function local(value: unknown): string {
  const p = str(value, 4096, false);
  normalizeLocalBrowse(p);
  return p;
}
function remote(value: unknown): string {
  const p = str(value, 4096, false);
  remotePath(p);
  return p;
}
function entries(value: unknown, project: boolean): Entry[] {
  return array(value, 20000).map((raw) => {
    const e = fields(raw, entryFields, entryOptional, project);
    str(e.name, 4096, false);
    bool(e.dir);
    num(e.size);
    for (const k of ["modifiedAt", "permissions"])
      if (Object.hasOwn(e, k)) num(e[k]);
    if (Object.hasOwn(e, "owner")) str(e.owner);
    if (Object.hasOwn(e, "hidden")) bool(e.hidden);
    return e as unknown as Entry;
  });
}
function checked(input: unknown, project = false): WorkspaceTransfer {
  const raw = fields(
    input,
    ["version", "workspace"],
    ["job", "viewState"],
    project,
  );
  if (raw.version !== 1) fail();
  const w = fields(
    raw.workspace,
    ["id", "profileId", "localBrowse", "remoteBrowse", "logsOpen", "entries"],
    ["connection"],
    project,
  );
  id(w.id);
  str(w.profileId, 128);
  local(w.localBrowse);
  remote(w.remoteBrowse);
  bool(w.logsOpen);
  const listing = fields(w.entries, ["local", "remote"], [], project);
  w.entries = {
    local: entries(listing.local, project),
    remote: entries(listing.remote, project),
  };
  if (
    (w.entries as Workspace["entries"]).local.length +
      (w.entries as Workspace["entries"]).remote.length >
    20000
  )
    fail();
  if (Object.hasOwn(w, "connection")) {
    w.connection = profile(w.connection, project);
    if ((w.connection as Profile).id !== w.profileId) fail();
  }
  const result: WorkspaceTransfer = {
    version: 1,
    workspace: w as unknown as WorkspaceTransfer["workspace"],
  };
  if (Object.hasOwn(raw, "viewState")) {
    const state = fields(raw.viewState, ["selection", "navigation", "trees"]);
    const selection = fields(state.selection, ["local", "remote"]),
      navigation = fields(state.navigation, ["local", "remote"]),
      trees = fields(state.trees, ["local", "remote"]);
    for (const side of ["local", "remote"] as const) {
      const path = side === "local" ? local : remote,
        current = side === "local" ? w.localBrowse : w.remoteBrowse;
      const s = fields(selection[side], ["selected", "focus"], ["anchor"]);
      s.selected = array(s.selected, 20000).map((v) => {
        const name = str(v, 4096, false);
        if (!supportedName(name)) fail();
        return name;
      });
      str(s.focus);
      if (s.focus && !supportedName(s.focus as string)) fail();
      if (
        Object.hasOwn(s, "anchor") &&
        !supportedName(str(s.anchor, 4096, false))
      )
        fail();
      const names = new Set(
        (w.entries as Workspace["entries"])[side].map((e) => e.name),
      );
      if (
        (s.selected as string[]).some((n) => !names.has(n)) ||
        new Set(s.selected as string[]).size !==
          (s.selected as string[]).length ||
        (s.focus && !names.has(s.focus as string)) ||
        (s.anchor && !names.has(s.anchor as string))
      )
        fail();
      selection[side] = s;
      const n = fields(navigation[side], ["paths", "cursor"]);
      n.paths = array(n.paths, 64).map(path);
      if (
        !Number.isInteger(n.cursor) ||
        Number(n.cursor) < -1 ||
        Number(n.cursor) >= (n.paths as string[]).length ||
        ((n.paths as string[]).length > 0 && Number(n.cursor) < 0) ||
        ((n.paths as string[]).length > 0 &&
          (n.paths as string[])[Number(n.cursor)] !== current)
      )
        fail();
      navigation[side] = n;
      const t = fields(trees[side], ["root", "key", "expanded"]);
      const treePath = (v: unknown) =>
        side === "local" && v === PC_ROOT ? PC_ROOT : path(v);
      treePath(t.root);
      str(t.key, 32768);
      t.expanded = array(t.expanded, 256).map(treePath);
      if (
        new Set(t.expanded as string[]).size !== (t.expanded as string[]).length
      )
        fail();
      // Construction also bounds implicit ancestor nodes, before any store mutation.
      const tree = new FolderTree(side, t.root as string, t.key as string);
      tree.restore(t as unknown as TreeSnapshot);
      tree.record(current as string, (w.entries as Workspace["entries"])[side]);
      if (tree.root !== t.root) fail();
      trees[side] = t;
    }
    result.viewState = {
      selection,
      navigation,
      trees,
    } as unknown as WorkspaceTransfer["viewState"];
  }
  if (Object.hasOwn(raw, "job")) {
    const j = fields(raw.job, jobFields, jobOptional, project);
    id(j.id);
    j.profile = profile(j.profile, project);
    local(j.local);
    remote(j.remote);
    if (!["running", "failed", "stopped"].includes(j.status as string)) fail();
    if (
      !w.connection ||
      JSON.stringify(w.connection) !== JSON.stringify(j.profile)
    )
      fail();
    for (const k of ["sent", "speed", "latency", "pending", "errorCount"])
      if (Object.hasOwn(j, k)) num(j[k]);
    if (Object.hasOwn(j, "retainedId")) str(j.retainedId, 128, false);
    if (Object.hasOwn(j, "exclusionRules")) str(j.exclusionRules, 65536);
    for (const k of ["deleteRemoved", "recursive"])
      if (Object.hasOwn(j, k)) bool(j[k]);
    j.logs = array(j.logs, 100).map((value) => str(value, 16384));
    if(Object.hasOwn(j,'syncPhase')&&!['scanning','working','caught_up','deletion_rescan_required','error','stopping','stopped'].includes(str(j.syncPhase,64,false)))fail();
    if(Object.hasOwn(j,'statusError'))str(j.statusError,16384);
    if(Object.hasOwn(j,'stopComplete'))bool(j.stopComplete);
    if(Object.hasOwn(j,'deletionRescanRequired'))bool(j.deletionRescanRequired);
    if(Object.hasOwn(j,'failure')&&j.failure!==null){
      const f=fields(j.failure,['relativePath','operation','reason','commitState','pending','requiresRescan'],[],project);
      if(f.relativePath!==null){const path=str(f.relativePath,16384,false);if(/^(?:[\\/]|[A-Za-z]:)/.test(path)||path.split(/[\\/]/).includes('..'))fail();}
      str(f.operation,128,false);str(f.reason,16384,false);num(f.pending);
      if(!['not_committed','committed','unknown'].includes(f.commitState as string)||f.requiresRescan!==true)fail();
      j.failure=f;
    }
    result.job = j as unknown as WorkspaceTransfer["job"];
  }
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    MAX_WORKSPACE_TRANSFER_BYTES
  )
    throw Error("Workspace transfer exceeds 2 MiB");
  return result;
}
export function validateWorkspaceTransfer(input: unknown): WorkspaceTransfer {
  return checked(input);
}
export function snapshotWorkspaceTransfer(
  store: Store,
  workspaceId: string,
  activity: { modalOpen?: boolean; fileOperationBusy?: boolean } = {},
): WorkspaceTransfer {
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) throw Error("Workspace not found");
  const job = store.tabs.find((j) => j.id === workspace.jobId);
  if (
    workspace.connecting ||
    workspace.starting ||
    workspace.loading.local ||
    workspace.loading.remote ||
    job?.busy ||
    activity.modalOpen ||
    activity.fileOperationBusy
  )
    throw Error("Workspace is busy");
  if (workspace.jobId && !job) throw Error("Workspace job not found");
  if (job?.profile.mode === "mock" && job.status !== "stopped")
    throw Error("Running development mock jobs cannot move between windows");
  // Limit displayed history without reading or serializing Queue, authentication, or form state.
  const jobData = job ? fields(job, jobFields, jobOptional, true) : undefined;
  if (jobData) jobData.logs = array(jobData.logs, 100000).slice(-100);
  const viewState = {
    selection: {
      local: FileSelection.prototype.snapshot.call(workspace.selections.local),
      remote: FileSelection.prototype.snapshot.call(
        workspace.selections.remote,
      ),
    },
    navigation: {
      local: BrowseHistory.prototype.snapshot.call(workspace.navigation.local),
      remote: BrowseHistory.prototype.snapshot.call(
        workspace.navigation.remote,
      ),
    },
    trees: {
      local: FolderTree.prototype.snapshot.call(workspace.trees.local),
      remote: FolderTree.prototype.snapshot.call(workspace.trees.remote),
    },
  };
  return checked(
    { version: 1, workspace, viewState, ...(jobData ? { job: jobData } : {}) },
    true,
  );
}
/** Call only after native transfer claim; builds UI state without connecting or starting work. */
export function hydrateWorkspaceTransfer(
  store: Store,
  input: unknown,
  expectedWorkspaceId: string,
): Workspace {
  const dto = validateWorkspaceTransfer(input),
    w = dto.workspace,
    job = dto.job;
  if (
    w.id !== id(expectedWorkspaceId) ||
    store.workspaces.some((x) => x.id === w.id) ||
    store.workspaces.length >= 16 ||
    (job && store.tabs.some((x) => x.id === job.id))
  )
    throw Error("Workspace transfer identity conflict");
  if (w.profileId && !store.profiles.some((p) => p.id === w.profileId))
    throw Error("Workspace profile not found");
  const owner = store.retainedSyncs.find((r) => r.ownerTabId === w.id);
  if (owner?.ownerTabClosed) throw Error("Retained owner is closed");
  if (job?.retainedId) {
    const record = store.retainedSyncs.find((r) => r.id === job.retainedId);
    if (
      !record ||
      record.ownerTabId !== w.id ||
      record.ownerTabClosed ||
      store.tabs.some((t) => t.retainedId === job.retainedId)
    )
      throw Error("Retained sync belongs to another tab");
  }
  const restored: Workspace = {
    ...w,
    connection: w.connection ? Object.freeze(w.connection) : undefined,
    loading: { local: false, remote: false },
    generation: { local: 0, remote: 0 },
    navigation: { local: new BrowseHistory(), remote: new BrowseHistory() },
    notice: "",
    trees: {
      local: new FolderTree("local", PC_ROOT),
      remote: new FolderTree(
        "remote",
        "/",
        JSON.stringify(
          w.connection ??
            store.profiles.find((p) => p.id === w.profileId) ??
            {},
        ),
      ),
    },
    selections: { local: new FileSelection(), remote: new FileSelection() },
    ...(job ? { jobId: job.id } : {}),
  };
  for (const side of ["local", "remote"] as const) {
    const path = side === "local" ? w.localBrowse : w.remoteBrowse;
    const state = dto.viewState;
    if (state) {
      restored.navigation[side].restore(state.navigation[side]);
      restored.trees[side].restore(state.trees[side]);
      if (side === "remote")
        restored.trees[side].key = JSON.stringify(
          restored.connection ??
            store.profiles.find((p) => p.id === w.profileId) ??
            {},
        );
      restored.selections[side].restore(
        JSON.stringify([
          side,
          side === "remote" ? restored.connection : null,
          path,
        ]),
        w.entries[side].filter((e) => supportedName(e.name)).map((e) => e.name),
        state.selection[side],
      );
    }
    if (!restored.navigation[side].length)
      restored.navigation[side].commit(path);
    restored.trees[side].record(path, w.entries[side]);
  }
  // All construction/validation completes before mutating the store.
  store.workspaces.push(restored);
  if (job) store.tabs.push({ ...job, queue: new Queue() });
  return restored;
}
/** Source object stays live until destination readiness is acknowledged. No close/disconnect calls. */
export function detachTransferredWorkspace(
  store: Store,
  workspaceId: string,
): void {
  const w = store.workspaces.find((w) => w.id === workspaceId);
  if (!w) throw Error("Workspace not found");
  w.generation.local++;
  w.generation.remote++;
  w.trees.local.reset(w.trees.local.root);
  w.trees.remote.reset(w.trees.remote.root);
  store.workspaces = store.workspaces.filter((x) => x !== w);
  store.tabs = store.tabs.filter((j) => j.id !== w.jobId);
}
/** Native owner IDs filter local tabs; all global retained records remain in settings. */
export function createWindowStore(
  settings: Partial<Settings>,
  ownedWorkspaceIds: readonly string[],
): Store {
  for (const value of ownedWorkspaceIds) id(value);
  return new Store(settings, { ownedWorkspaceIds });
}
