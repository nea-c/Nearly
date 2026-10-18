import { watchTransferChoices } from './transfer-conflict.js';
import { formatTransferOutcome } from './transfer-outcome.js';
import { startExternalDownload } from './external-download.js';
import { invoke, native, type NativeFileDrop } from "./api.js";
import type { ActionHost } from "./file-actions.js";
import { operationBusy, operationFeedback } from "./operation-feedback.js";
import { marqueeWhitespace } from "./marquee-selection.js";
import { childPath, supportedName } from "./tree.js";
import { getLanguage, tError } from "./i18n.js";
export interface DropHost extends ActionHost {
  uploadAllowed(): boolean;
  remoteDirectory(path: string): boolean;
  localDirectory(path: string): boolean;
  dragging(value: boolean, cancel?: () => void): void;
}
const say = (ja: string, en: string) => (getLanguage() === "ja" ? ja : en);
export function physicalToCss(
  position: { x: number; y: number },
  scale: number,
) {
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  )
    return undefined;
  return { x: position.x / scale, y: position.y / scale };
}
export function uploadTargets(sources: readonly string[], remote: string) {
  return sources.flatMap((path) => {
    if (/^[A-Za-z]:[\\/]*$/.test(path)) return [];
    const name = path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
    return name && supportedName(name)
      ? [childPath("remote", remote, name)]
      : [];
  });
}
export function sourcesOverlapSync(
  sources: readonly string[],
  roots: readonly string[],
) {
  const normalize = (path: string) =>
    path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  return sources.some((source) =>
    roots.some((root) => {
      const a = normalize(source),
        b = normalize(root);
      return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\");
    }),
  );
}

let latest: DropHost | undefined,
  installed = false,
  subscribed = false;
let overlay: HTMLElement | undefined;
const allowed = (host: DropHost) =>
  native &&
  !operationBusy() &&
  host.uploadAllowed() &&
  !!host.sessionId &&
  host.profile?.mode === "sftp" &&
  !host.panes.remote.loading;
/** Only actual list rows and model-backed tree directories may supply destinations. */
export function remoteDropTarget(
  host: DropHost,
  element: Element | null,
): string | undefined {
  if (!element || !host.valid() || !allowed(host)) return;
  if (
    element.closest(
      "thead,button:not([data-tree-select]),input,select,[data-column-resize],[data-parent-row]",
    )
  )
    return;
  const list = element.closest<HTMLElement>('[data-list="remote"]');
  if (list) {
    if (list.dataset.workspace !== host.workspaceId) return;
    const row = element.closest<HTMLElement>("[data-entry]");
    if (row) {
      if (row.hasAttribute("data-inert")) return;
      const entry = host.panes.remote.entries.find(
        (e) => e.name === row.dataset.name,
      );
      return entry?.dir
        ? childPath("remote", host.panes.remote.path, entry.name)
        : undefined;
    }
    return host.panes.remote.path;
  }
  const row = element.closest<HTMLElement>('[data-tree-row="remote"]');
  const path = row?.dataset.treePath;
  if (path && host.remoteDirectory(path)) return path;
}
export function localDropTarget(host:DropHost,element:Element|null):string|undefined {
 if(!element||!host.valid()||!allowed(host)||host.panes.local.loading)return;
 if(element.closest('thead,button:not([data-tree-select]),input,select,[data-column-resize],[data-parent-row]'))return;
 const list=element.closest<HTMLElement>('[data-list="local"]');
 if(list){if(list.dataset.workspace!==host.workspaceId)return;const row=element.closest<HTMLElement>('[data-entry]');if(row){if(row.hasAttribute('data-inert'))return;const entry=host.panes.local.entries.find(e=>e.name===row.dataset.name);return entry?.dir?childPath('local',host.panes.local.path,entry.name):undefined;}return host.panes.local.path;}
 const row=element.closest<HTMLElement>('[data-tree-row="local"]'),path=row?.dataset.treePath;
 if(path&&path!=='@pc'&&host.localDirectory(path))return path;
}
function mark(element?: Element | null) {
  document
    .querySelectorAll(".upload-drop-target")
    .forEach((e) => e.classList.remove("upload-drop-target"));
  element
    ?.closest("[data-entry],[data-tree-row],[data-list]")
    ?.classList.add("upload-drop-target");
}
function confirmUpload(
  host: DropHost,
  sources: readonly string[],
  remote: string,
  knownFolder: boolean,
  direction: 'upload'|'download' = 'upload',
) {
  if (
    overlay ||
    !allowed(host) ||
    !host.valid() ||
    !sources.length ||
    sources.length > 10000 ||
    sourcesOverlapSync(direction==='upload'?sources:[remote], host.syncRoots)
  )
    return;
  const frozen = Object.freeze([...sources]);
  if (frozen.some((path) => !path || path.includes("\0"))) return;
  const sessionId = host.sessionId!,
    targets = Object.freeze(direction==='upload'?uploadTargets(frozen, remote):frozen.map(p=>childPath('local',remote,p.split('/').pop()!)));
  const node = document.createElement("div");
  node.className = "overlay operation-overlay";
  overlay = node;
  const dialog = document.createElement("section");
  dialog.className = "dialog operation-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = document.createElement("h2");
  title.textContent = direction==='upload'?say("コピーでアップロード", "Upload copies"):say('コピーでダウンロード','Download copies');
  const description = document.createElement("p");
  description.textContent = direction==='download'?say('リモートの元データを保持します。同名の項目があれば転送中に確認します。','Remote sources are retained. Name conflicts are confirmed during transfer.'):say(
    "ローカルの元データを保持します。同名の項目があれば転送中に確認します。",
    "Local sources are retained. Name conflicts are confirmed during transfer.",
  );
  const destination = document.createElement("p");
  destination.textContent = remote;
  const paths = document.createElement("pre");
  paths.textContent = frozen.join("\n");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const cancel = document.createElement("button");
  cancel.id = "upload-cancel";
  cancel.textContent = say("キャンセル", "Cancel");
  const confirm = document.createElement("button");
  confirm.id = direction==='upload'?"upload-confirm":'download-confirm';
  confirm.textContent = direction==='upload'?say("コピーをアップロード", "Upload copies"):say('コピーをダウンロード','Download copies');
  const close = () => {
    node.remove();
    overlay = undefined;
    window.removeEventListener("keydown", key);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener("keydown", key);
  cancel.onclick = close;
  let submitted = false;
  confirm.onclick = () => {
    if (submitted) return;
    if (
      !host.valid() ||
      !allowed(host) ||
      sourcesOverlapSync(direction==='upload'?frozen:[remote], host.syncRoots)
    ) {
      error.textContent = say(
        "接続または表示が変更されました。",
        "The connection or view changed.",
      );
      return;
    }
    submitted = true;
    const recurse = true;
    close();
    void run(host, frozen, remote, sessionId, recurse, targets, direction);
  };
  dialog.append(
    title,
    description,
    destination,
    paths,
    error,
    cancel,
    confirm,
  );
  node.append(dialog);
  document.body.append(node);
  confirm.focus();
}
async function run(
  host: DropHost,
  sources: readonly string[],
  remote: string,
  sessionId: string,
  recursive: boolean,
  targets: readonly string[],
  direction: 'upload'|'download' = 'upload',
) {
  const id = crypto.randomUUID(),
    results = document.createElement("div"),
    cancel = document.createElement("button");
  cancel.id = "upload-cancel";
  cancel.textContent = say("キャンセル", "Cancel");
  let cancelled = false,
    prepared = false,
    dispatched = false, successful = false, terminalCancelled = false;
  cancel.onclick = () => {
    cancelled = true;
    cancel.disabled = true;
    if (dispatched)
      void invoke("cancel_file_operation", { id }).catch((e) => {
        results.textContent = tError(e);
      });
  };
  const feedback = operationFeedback(
    direction==='upload'?say("アップロード", "Upload"):say('ダウンロード','Download'),
    results,
    cancel,
  );
  results.textContent = say("準備中…", "Preparing…");
  try {
    await invoke("prepare_file_operation", { id });
    prepared = true;
    if (cancelled || !host.operationValid() || !host.uploadAllowed()) {
      await invoke("cancel_file_operation", { id, abandon: true });
      prepared = false;
      terminalCancelled = cancelled;
      results.textContent = say(
        "接続が変更されたか、キャンセルが要求されました。",
        "The connection changed or cancellation was requested.",
      );
      return;
    }
    dispatched = true;
    const stopChoices = watchTransferChoices(id);
    let outcome;
    try { outcome = direction==='download'?await invoke('run_download',{request:{id,sessionId,sources:[...sources],local:remote}}):await invoke("run_upload", {
      request: { id, sessionId, sources: [...sources], remote, recursive, interactive: true },
    }); } finally { stopChoices(); }
    results.textContent = formatTransferOutcome(outcome);
    if (outcome.message) {
      const detail = document.createElement("p");
      detail.textContent = tError(outcome.message);
      results.append(detail);
    }
    if (outcome.status !== "completed")
      results.append(
        document.createTextNode(
          say(
            " 新しい不完全な対象が残る可能性があります。再試行の前に更新してください。",
            " New partial targets may remain. Refresh before retrying.",
          ),
        ),
      );
    await host.changed(direction==='upload'?"remote":'local', "", {
      action: "createfile",
      paths: [...targets],
      parent: remote,
      affectedDirectories: [remote],
      affectedSubtrees: targets,
      uncertain: outcome.status !== "completed",
      partial: outcome.status !== "completed",
    });
    terminalCancelled = outcome.status === "cancelled";
    successful = outcome.status === "completed" && !cancelled;
  } catch (error) {
    results.textContent = tError(error);
    if (dispatched) {
      results.append(
        document.createTextNode(
          say(
            " 新しい不完全な対象が残る可能性があります。再試行の前に更新してください。",
            " New partial targets may remain. Refresh before retrying.",
          ),
        ),
      );
      try {
        await host.changed(direction==='upload'?"remote":'local', "", {
          action: "createfile",
          paths: [...targets],
          affectedDirectories: [remote],
          affectedSubtrees: targets,
          uncertain: true,
          partial: true,
        });
      } catch (e) {
        results.append(document.createTextNode(tError(e)));
      }
    } else if (prepared)
      try {
        await invoke("cancel_file_operation", { id, abandon: true });
      } catch (e) {
        results.append(document.createTextNode(tError(e)));
      }
  } finally {
    feedback.finish(direction==='download'&&terminalCancelled?'cancelled':successful);
  }
}
function nativeDrop(event: NativeFileDrop) {
  mark();
  // Only events classified at native ingress are eligible. A queued self drop
  // keeps its provenance even after operation feedback releases its reservation.
  if (event.ownOutbound !== false) return;
  const host = latest;
  if (event.type === "leave" || !host || overlay || !event.position) return;
  const point = physicalToCss(event.position, window.devicePixelRatio),
    element = point && document.elementFromPoint(point.x, point.y);
  const remote = remoteDropTarget(host, element || null);
  if (remote === undefined) return;
  if (event.type === "drop") {
    if (
      Array.isArray(event.paths) &&
      event.paths.every((path) => typeof path === "string")
    )
      confirmUpload(host, event.paths, remote, false);
  } else mark(element);
}
export function bindFileDrop(host: DropHost) {
  latest = host;
  const events = window.__TAURI__?.event;
  if (events && !subscribed) {
    subscribed = true;
    void events
      .listen<NativeFileDrop>('native-file-drop', (e) => nativeDrop(e.payload))
      .catch(() => {
        subscribed = false;
      });
  }
  if (installed) return;
  installed = true;
  document.addEventListener("pointerdown", (event) => {
    const host = latest,
      target = event.target instanceof Element ? event.target : null,
      row = target?.closest<HTMLElement>(
        '[data-list] [data-entry]:not([data-inert])',
      );
    if (
      event.button !== 0 ||
      !host ||
      !row ||
      overlay ||
      !allowed(host) ||
      !host.valid() ||
      marqueeWhitespace(target, event.clientX, event.clientY) ||
      target?.closest("button,input,thead")
    )
      return;
    const list = row.closest<HTMLElement>("[data-list]");
    if (list?.dataset.workspace !== host.workspaceId) return;
    const side = list.dataset.list as 'local'|'remote', direction = side==='local'?'upload':'download';
    const destinationAt = (element:Element|null)=>direction==='upload'?remoteDropTarget(host,element):localDropTarget(host,element);
    const entry = host.panes[side].entries.find(
      (e) => e.name === row.dataset.name,
    );
    if (!entry || host.panes[side].loading) return;
    event.preventDefault();
    const selected = host.panes[side].selection.has(entry.name)
      ? host.panes[side].selection.values()
      : [entry.name];
    const entries = host.panes[side].entries.filter((e) =>
        selected.includes(e.name),
      ),
      sources = Object.freeze(
        entries.map((e) => childPath(side, host.panes[side].path, e.name)),
      );
    const origin = { x: event.clientX, y: event.clientY };
    const sessionId = host.sessionId!;
    if(side==='remote')try{row.setPointerCapture(event.pointerId);}catch{/* A cancelled pointer cannot be captured. */}
    let dragging = false,
      active = true;
    const finish = (commit: boolean, e?: PointerEvent) => {
      if (!active) return;
      active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      if(side==='remote')try{row.releasePointerCapture(event.pointerId);}catch{/* Already released by Windows/WebView. */}
      mark();
      if (!dragging) return;
      host.dragging(false);
      document.body.classList.remove("upload-pointer-drag");
      const suppress = (click: Event) => {
        click.preventDefault();
        click.stopImmediatePropagation();
      };
      document.addEventListener("click", suppress, {
        capture: true,
        once: true,
      });
      setTimeout(
        () => document.removeEventListener("click", suppress, true),
        0,
      );
      if (commit && e && host.valid()) {
        const remote = destinationAt(
          document.elementFromPoint(e.clientX, e.clientY),
        );
        if (remote !== undefined)
          confirmUpload(
            host,
            sources,
            remote,
            entries.some((e) => e.dir),
            direction,
          );
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      if (
        !dragging &&
        Math.hypot(e.clientX - origin.x, e.clientY - origin.y) >= 5
      ) {
        if (!host.valid()) {
          finish(false);
          return;
        }
        dragging = true;
        host.dragging(true, () => finish(false));
        document.body.classList.add("upload-pointer-drag");
        if(direction==='download') {
          finish(false);
          if(host.valid()) void startExternalDownload(host, sources, sessionId, position => {
            const point = physicalToCss(position, window.devicePixelRatio);
            const destination = point && localDropTarget(host, document.elementFromPoint(point.x, point.y));
            if(destination !== undefined && host.valid()) confirmUpload(host, sources, destination, entries.some(e=>e.dir), 'download');
          });
          return;
        }
      }
      if (dragging) {
        e.preventDefault();
        const element = document.elementFromPoint(e.clientX, e.clientY);
        mark(destinationAt(element) !== undefined ? element : null);
      }
    };
    const up = (e: PointerEvent) => {
        if (e.pointerId === event.pointerId) finish(true, e);
      },
      cancel = () => finish(false),
      key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
  });
  // Browser File objects are deliberately never interpreted as native source paths.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());
}
