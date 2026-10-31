import { operationFeedback, operationBusy } from "./operation-feedback.js";
import {openTextEditor} from './text-editor.js';
import {
  archiveEligibility,
  archiveDefaultName,
  formatArchiveError,
  type ArchiveAction,
} from "./archive-actions.js";
import { t, text, html, tError, getLanguage } from "./i18n.js";
import { invoke, native, type FileOperationRequest } from "./api.js";
import type { Entry, Profile, Side } from "./core.js";
import type { FileSelection } from "./selection.js";
import { childPath, supportedName } from "./tree.js";
interface Pane {
  path: string;
  entries: Entry[];
  selection: FileSelection;
  loading: boolean;
}
export interface ActionHost {
  workspaceId: string;
  sessionId?: string;
  profile?: Profile;
  panes: Record<Side, Pane>;
  syncRoots: string[];
  selected(side: Side): void;
  valid(): boolean;
  operationValid(): boolean;
  changed(
    side: Side,
    passphrase: string,
    change: {
      action: FileOperationRequest["action"] | 'edit';
      paths: string[];
      parent?: string;
      created?: boolean;
      affectedDirectories: readonly string[];
      removedDirectories?: readonly string[];
      affectedSubtrees?: readonly string[];
      uncertain?: boolean;
      partial?: boolean;
    },
  ): Promise<void>;
}
interface Item {
  path: string;
  name: string;
  dir: boolean;
}
interface Snapshot {
  host: ActionHost;
  side: Side;
  items: Item[];
  destination: string;
  createParent: string;
  profile?: Profile;
}
interface Clipboard {
  side: Side;
  profile?: Profile;
  items: Item[];
  cut: boolean;
}
let clipboard: Clipboard | undefined,
  latest: ActionHost | undefined,
  menuContext = "",
  menu: HTMLElement | undefined;
let operation:
  { cancelled: boolean; running: boolean; current?: string } | undefined;
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const profileKey = (p?: Profile) =>
  JSON.stringify(
    p
      ? {
          id: p.id,
          host: p.host,
          port: p.port,
          user: p.user,
          mode: p.mode,
          keyFile: p.keyFile,
          hostKey: p.hostKey,
        }
      : null,
  );
const portal = document.createElement("div");
portal.id = "file-action-root";
document.body.append(portal);
function closeMenu() {
  menu?.remove();
  menu = undefined;
  menuContext = "";
}
let noticeNode: HTMLElement | undefined;
let noticeRender: (() => string) | undefined;
export function refreshFileActionLocale() {
  closeMenu();
  if (noticeNode?.isConnected && noticeRender)
    noticeNode.textContent = noticeRender();
}
function notice(render: () => string) {
  document.querySelector(".file-toast")?.remove();
  const node = document.createElement("div");
  node.className = "file-toast";
  node.setAttribute("role", "status");
  noticeNode = node;
  noticeRender = render;
  node.textContent = render();
  portal.append(node);
  setTimeout(() => {
    node.remove();
    if (noticeNode === node) {
      noticeNode = undefined;
      noticeRender = undefined;
    }
  }, 2800);
}
function isAncestor(parent: string, path: string) {
  const p = parent.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase(),
    q = path.replaceAll("/", "\\").replace(/\\$/, "").toLowerCase();
  return p === q || q.startsWith(p + "\\");
}
function protectsRoot(snapshot: Snapshot) {
  return (
    snapshot.side === "local" &&
    snapshot.items.some((item) =>
      snapshot.host.syncRoots.some((root) => isAncestor(item.path, root)),
    )
  );
}
function clipboardAllowed(snapshot: Snapshot) {
  return (
    !!clipboard &&
    clipboard.side === snapshot.side &&
    (snapshot.side === "local" ||
      profileKey(clipboard.profile) === profileKey(snapshot.profile))
  );
}
function contextKey(host: ActionHost) {
  return JSON.stringify([
    host.workspaceId,
    profileKey(host.profile),
    host.panes.local.path,
    host.panes.remote.path,
  ]);
}
function snapshot(
  host: ActionHost,
  side: Side,
  items: Item[],
  destination = host.panes[side].path,
  createParent = host.panes[side].path,
): Snapshot {
  return {
    host,
    side,
    items: items.map((item) => ({ ...item })),
    destination,
    createParent,
    profile: host.profile ? { ...host.profile } : undefined,
  };
}
function listItems(host: ActionHost, side: Side): Item[] {
  const pane = host.panes[side];
  return pane.entries
    .filter(
      (entry) => supportedName(entry.name) && pane.selection.has(entry.name),
    )
    .map((entry) => ({
      path: childPath(side, pane.path, entry.name),
      name: entry.name,
      dir: entry.dir,
    }));
}
function decorateCut(host: ActionHost) {
  for (const side of ["local", "remote"] as Side[])
    document
      .querySelectorAll<HTMLElement>(`[data-list="${side}"] [data-entry]`)
      .forEach((row) => {
        if (!clipboard?.cut || !supportedName(row.dataset.name ?? "")) {
          row.classList.remove("cut");
          return;
        }
        const path = childPath(side, host.panes[side].path, row.dataset.name!);
        row.classList.toggle(
          "cut",
          !!clipboard?.cut &&
            clipboard.side === side &&
            (side === "local" ||
              profileKey(clipboard.profile) === profileKey(host.profile)) &&
            clipboard.items.some((item) => item.path === path),
        );
      });
}
function remember(snapshot: Snapshot, cut: boolean) {
  if (!snapshot.items.length) return;
  if (cut && protectsRoot(snapshot)) {
    notice(() =>
      t("同期ルートやその親は切り取れません。同期を停止してください"),
    );
    return;
  }
  clipboard = {
    side: snapshot.side,
    profile: snapshot.profile,
    items: snapshot.items.map((i) => ({ ...i })),
    cut,
  };
  closeMenu();
  if (latest) decorateCut(latest);
  notice(
    () =>
      text`${snapshot.items.length} 件を${cut ? t("切り取り") : t("コピー")}対象にしました（アプリ内）`,
  );
}
function paste(snapshot: Snapshot) {
  if (!clipboardAllowed(snapshot)) {
    notice(() =>
      t("同じ側の一覧で貼り付けてください。リモートは同じ接続先に限ります"),
    );
    return;
  }
  const source = clipboard!;
  showOperation(
    { ...snapshot, items: source.items.map((i) => ({ ...i })) },
    source.cut ? "move" : "copy",
  );
}
function showMenu(state: Snapshot, x: number, y: number) {
  if (operation || operationBusy()) return;
  closeMenu();
  menuContext = contextKey(state.host);
  const active = state.items.length > 0,
    protectedRoot = protectsRoot(state),
    canPaste = clipboardAllowed(state),
    archive = archiveAllowed(state);
  menu = document.createElement("div");
  menu.className = "file-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("ファイル操作"));
  menu.innerHTML = html`<div class="menu-context">
      ${active ? text`${state.items.length} 件を選択` : t("このフォルダ")}
    </div>
    <button
      role="menuitem"
      data-file-action="createfile"
      ${state.createParent === "@pc" ? "disabled" : ""}
    >
      新しいファイル</button
    ><button
      role="menuitem"
      data-file-action="mkdir"
      ${state.createParent === "@pc" ? "disabled" : ""}
    >
      新しいフォルダー
    </button>
    <div class="menu-rule"></div>
    <button role="menuitem" data-file-action="edittext" ${state.items.length!==1||state.items[0]?.dir?'disabled':''}>${getLanguage()==='ja'?'テキストを編集':'Edit text'}</button>
    <button
      role="menuitem"
      data-file-action="copy"
      ${!active ? "disabled" : ""}
    >
      コピー<small>Ctrl+C</small></button
    ><button
      role="menuitem"
      data-file-action="cut"
      ${!active || protectedRoot ? "disabled" : ""}
    >
      切り取り<small>Ctrl+X</small></button
    ><button
      role="menuitem"
      data-file-action="paste"
      ${!canPaste ? "disabled" : ""}
    >
      貼り付け${clipboard ? text`（${clipboard.items.length} 件）` : ""}<small
        >Ctrl+V</small
      >
    </button>
    <div class="menu-rule"></div>
    <button role="menuitem" data-file-action="duplicate" ${state.items.length !== 1 ? "disabled" : ""}>複製</button>
    <button role="menuitem" data-file-action="move" ${!active || protectedRoot ? "disabled" : ""}>移動</button>
    ${state.side === "remote" ? html`<button role="menuitem" disabled title="リモートZIPは利用できません。ローカルへダウンロードして操作してください。">ZIPに圧縮</button><div class="menu-explanation">リモートZIPは利用できません。ローカルへダウンロードして操作してください。</div>` : ""}
    ${archive.compress ? html`<button role="menuitem" data-file-action="compress">ZIPに圧縮</button>` : ""}${archive.extract ? html`<button role="menuitem" data-file-action="extract">ZIPを展開</button>` : ""}
    <button
      role="menuitem"
      class="danger"
      data-file-action="delete"
      ${!active || protectedRoot ? "disabled" : ""}
    >
      削除<small>Delete</small></button
    >${protectedRoot ? html`<div class="menu-explanation">同期ルートとその親は保護されています</div>` : ""}${clipboard && !canPaste ? html`<div class="menu-explanation">貼り付けは同じ側・同じリモート接続先で行えます</div>` : ""}`;
  portal.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left =
    Math.max(4, Math.min(x, innerWidth - bounds.width - 4)) + "px";
  menu.style.top =
    Math.max(4, Math.min(y, innerHeight - bounds.height - 4)) + "px";
  menu.querySelectorAll<HTMLButtonElement>("[data-file-action]").forEach(
    (button) =>
      (button.onclick = () => {
        const action = button.dataset.fileAction;
        closeMenu();
        if (!state.host.valid()) {
          notice(() => t("表示先が変わったため、もう一度対象を選んでください"));
          return;
        }
        if(action==='edittext')void openTextEditor({side:state.side,path:state.items[0].path,workspaceId:state.host.workspaceId,sessionId:state.host.sessionId},()=>state.host.operationValid(),()=>state.host.changed(state.side,'',{action:'edit',paths:[state.items[0].path],affectedDirectories:[parentPath(state.side,state.items[0].path)]})).catch(error=>notice(()=>tError(error)));
        else if (action === "compress" || action === "extract")
          showArchive(state, action);
        else if (action === "createfile" || action === "mkdir")
          showCreation(state, action);
        else if (action === "copy" || action === "cut")
          remember(state, action === "cut");
        else if (action === "paste") paste(state);
        else if (action === "duplicate") showOperation(state, "copy", "duplicate");
        else if (action === "move") showOperation(state, "move", "move");
        else showOperation(state, "delete");
      }),
  );
  const buttons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  buttons[0]?.focus();
  menu.onkeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      buttons[
        (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length
      ]?.focus();
    }
  };
}
function showOperation(
  state: Snapshot,
  action: FileOperationRequest["action"],
  prompt?: "duplicate" | "move",
) {
  if (operation || operationBusy() || !state.items.length) return;
  if (state.items.length > 500) {
    notice(() =>
      t("一度に操作できるのは500項目までです。対象を分けて選択してください"),
    );
    return;
  }
  closeMenu();
  if ((action === "delete" || action === "move") && protectsRoot(state)) {
    notice(() =>
      t("同期ルートやその親は操作できません。同期を停止してください"),
    );
    return;
  }
  const remote = state.side === "remote",
    label =
      action === "copy"
        ? t("コピー")
        : action === "move"
          ? t("移動")
          : remote
            ? t("削除")
            : t("ごみ箱へ移動");
  const duplicateParent = prompt === "duplicate" ? parentPath(state.side, state.items[0].path) : undefined;
  const allowed = native && (!remote || state.profile?.mode === "sftp");
  const overlay = document.createElement("div");
  overlay.className = "overlay operation-overlay";
  const endpoint = remote
    ? `${state.profile?.name} · ${state.profile?.user}@${state.profile?.host}:${state.profile?.port}`
    : t("ローカルの実ファイル");
  overlay.innerHTML = html`<section
    class="dialog operation-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="file-operation-title"
  >
    <h2 id="file-operation-title">
      ${esc(text`${state.items.length} 件を${label}`)}
    </h2>
    <p class="operation-endpoint">${esc(endpoint)}</p>
    <p>
      ${esc(text`${state.items.length} 項目${state.items.some((i) => i.dir) ? t("（フォルダは配下をすべて含みます）") : ""}が対象です。`)}
    </p>
    <ul class="operation-targets">
      ${state.items.map((i) => `<li><span>${i.dir ? t("フォルダ") : t("ファイル")}</span><code>${esc(i.path)}</code></li>`).join("")}
    </ul>
    ${
      action !== "delete"
        ? html`${prompt !== "duplicate" ? html`<div class="target">
              <small>移動先 / コピー先のフォルダ</small
              ><code>${esc(state.destination)}</code>
            </div>` : ""}
            <p class="subtle">
              同名の項目は上書きせず、失敗として表示します。途中で失敗したコピー先は残り、元の項目は保持されます。
            </p>`
        : remote
          ? html`<p class="warning">
              サーバーから削除します。元に戻せない可能性があります。対象と件数を確認して実行してください。
            </p>`
          : html`<p class="warning">
              ごみ箱へ移動します。ごみ箱に対応しない場所では中止し、完全削除へ切り替えません。
            </p>`
    }${!remote && state.host.syncRoots.length ? html`<p class="warning">同期中です。ローカルの変更・コピー・移動はアップロードに反映される場合があります。ローカル削除も、実行中の同期で「ファイルを削除する」が有効ならリモートへ反映されます。</p>` : ""}${remote && !state.host.sessionId ? html`<label>秘密鍵のパスフレーズ（必要な場合のみ）<input name="operation-passphrase" type="password" autocomplete="off" /></label>` : ""}${!allowed ? html`<p class="mock-note">ブラウザプレビュー／リモートのモックでは実ファイル操作を行いません。</p>` : ""}
    ${prompt ? html`<label>${prompt === "duplicate" ? t("複製の名前") : t("移動先の既存フォルダー")}<input name="operation-destination" autocomplete="off" value="${esc(prompt === "duplicate" ? state.items[0].name : state.destination)}" /></label>` : ""}
    ${prompt === "duplicate" ? html`<label>${esc(t("移動先の既存フォルダー"))}<input name="operation-folder" autocomplete="off" spellcheck="false" value="${esc(duplicateParent)}" /></label>` : ""}
    ${remote && action === "copy" ? html`<p class="subtle">リモートコピーはクライアント経由のSFTP転送です。</p>` : ""}
    <div class="operation-results" aria-live="polite"></div>
    <div class="actions">
      <button id="file-operation-cancel">キャンセル</button
      ><button
        class="primary ${action === "delete" ? "destructive" : ""}"
        id="file-operation-confirm"
        ${allowed ? "" : "disabled"}
      >
        ${action === "delete" && remote ? text`サーバーから ${state.items.length} 件を削除` : text`${label}を実行`}
      </button>
    </div>
  </section>`;
  portal.append(overlay);
  const cancel = overlay.querySelector<HTMLButtonElement>(
      "#file-operation-cancel",
    )!,
    confirm = overlay.querySelector<HTMLButtonElement>(
      "#file-operation-confirm",
    )!,
    results = overlay.querySelector<HTMLElement>(".operation-results")!;
  const stateRun = {
    cancelled: false,
    running: false,
    current: undefined as string | undefined,
  };
  operation = stateRun;
  const close = () => {
    overlay.remove();
    operation = undefined;
    if (latest) decorateCut(latest);
  };
  cancel.onclick = async () => {
    if (!stateRun.running) {
      close();
      return;
    }
    stateRun.cancelled = true;
    cancel.disabled = true;
    cancel.textContent = t("中止処理中…");
    if (stateRun.current)
      await invoke("cancel_file_operation", { id: stateRun.current }).catch(
        (error) => notice(() => tError(error)),
      );
  };
  overlay.querySelector<HTMLElement>("input,button")?.focus();
  confirm.onclick = async () => {
    if (stateRun.running) return;
    if (!state.host.valid()) {
      results.textContent = t(
        "表示先や接続先が変わりました。閉じてから対象を選び直してください",
      );
      confirm.disabled = true;
      return;
    }
    let destination = state.destination, duplicateTarget: string | undefined;
    try {
      const input=overlay.querySelector<HTMLInputElement>("[name=operation-destination]");
      if(prompt === "duplicate") {
        destination=overlay.querySelector<HTMLInputElement>("[name=operation-folder]")!.value;
        duplicateTarget=createTargetPath(state.side, destination, input!.value);
      }
      if(prompt === "move") {
        destination=input!.value;
        if ((remote ? !destination.startsWith("/") : !/^[A-Za-z]:[\\/]/.test(destination)) || destination.split(/[\\/]/).some(p=>p === "." || p === "..") || /[\x00-\x1f]/.test(destination)) throw Error(t("移動先には既存の絶対フォルダーパスを指定してください。"));
      }
    } catch(error) { results.textContent=tError(error); return; }
    stateRun.running = true;
    cancel.disabled = true;
    confirm.disabled = true;
    cancel.textContent = t("処理を中止");
    const field = overlay.querySelector<HTMLInputElement>(
      "[name=operation-passphrase]",
    );
    let passphrase = field?.value ?? "";
    if (field) {
      field.value = "";
      field.disabled = true;
    }
    results.textContent=t("処理中です。");
    const feedback=operationFeedback(label, results, cancel);
    overlay.remove();
    const statuses = state.items.map((item) => ({
      item,
      status: "待機中",
      error: "",
    }));
    const selectionProgress=statuses.length>1&&(action==='copy'||action==='delete');
    if(selectionProgress)feedback.selectionProgress(0,statuses.length);
    const draw = () => {
      const successes = statuses.filter((s) => s.status === "完了").length,
        failed = statuses.filter((s) => s.status === "失敗").length,
        skipped = statuses.filter((s) => s.status === "未実行").length;
      if(selectionProgress)feedback.selectionProgress(successes,statuses.length);
      results.innerHTML = html`<p class="operation-summary">
          ${esc(text`${successes} 件完了 / ${failed} 件失敗`)}${skipped ? esc(text` / ${skipped} 件未実行`) : ""}
        </p>
        <ul>
          ${statuses.map((s) => `<li class="${s.status === "失敗" ? "failed" : ""}"><strong>${esc(t(s.status))}</strong><code>${esc(s.item.path)}</code>${s.error ? `<p>${esc(tError(s.error))}</p>` : ""}</li>`).join("")}
        </ul>`;
    };
    const batched=remote&&statuses.length>1&&(action==='copy'||action==='delete');
    const moved = new Set<string>();
    let refreshError = "";
    try {
      for (const status of statuses) {
        if (stateRun.cancelled || !state.host.operationValid()) {
          status.status = "未実行";
          draw();
          continue;
        }
        status.status = "処理中";
        stateRun.current = crypto.randomUUID();
        draw();
        try {
          await invoke("prepare_file_operation", { id: stateRun.current });
          cancel.disabled = false;
          if(stateRun.cancelled || !state.host.operationValid()) {
            await invoke("cancel_file_operation", {id: stateRun.current, abandon:true});
            throw Error(t("接続が変わったか、中止が要求されました。"));
          }
          if(remote)feedback.track(stateRun.current);
          const outcome = await invoke("run_file_operation", {
            request: {
              id: stateRun.current,
              side: state.side,
              action,
              items:batched?statuses.map(s=>({source:s.item.path,destination:action==='delete'?undefined:childPath(state.side,destination,s.item.name)})):undefined,
              source: status.item.path,
              destination:
                action === "delete"
                  ? undefined
                  : duplicateTarget ?? childPath(state.side, destination, status.item.name),
              profile: remote ? state.profile : undefined,
              sessionId: remote ? state.host.sessionId : undefined,
              passphrase,
              confirmDelete: action === "delete",
            },
          });
          status.status = "完了";
          status.error = outcome.message;
          if(batched){if(!outcome.items||outcome.items.length!==statuses.length)throw Error('Incomplete native batch result; refresh before retrying');for(let i=0;i<statuses.length;i++){const result=outcome.items[i];if(result.source!==statuses[i].item.path)throw Error('Mismatched native batch result');statuses[i].status=result.completed?'完了':result.attempted?'失敗':'未実行';statuses[i].error=result.message;}}
          if (action === "move") moved.add(status.item.path);
        } catch (error) {
          status.status = "失敗";
          status.error = tError(error);
          if(batched)for(const other of statuses){other.status='失敗';other.error=tError(error);}
        }
        stateRun.current = undefined;
        draw();
        if(batched)break;
      }
      if (clipboard?.cut && action === "move") {
        clipboard.items = clipboard.items.filter((i) => !moved.has(i.path));
        if (!clipboard.items.length) clipboard = undefined;
      }
      await state.host
          .changed(state.side, passphrase, {
            action,
            affectedDirectories: Object.freeze([...new Set([...state.items.map(i=>parentPath(state.side,i.path)), ...(action === "delete" ? [] : [duplicateTarget ? parentPath(state.side,duplicateTarget) : destination])])]),
            removedDirectories: Object.freeze(action === "delete" || action === "move"
              ? statuses.filter(s=>s.item.dir && (s.status === "完了" || s.status === "失敗")).map(s=>s.item.path)
              : []),
            uncertain: statuses.some(s=>s.status === "失敗"),
            partial: statuses.some(s=>s.status === "完了") && statuses.some(s=>s.status !== "完了"),
            paths: statuses
              .filter((s) => s.status === "完了" || s.status === "失敗")
              .map((s) => s.item.path),
          })
          .catch((error) => {
            refreshError = t("一覧の再読込に失敗: ") + tError(error);
          });
    } finally {
      passphrase = "";
      stateRun.running = false;
      if(operation === stateRun) operation=undefined;
      feedback.finish(!stateRun.cancelled && !refreshError && statuses.every(s => s.status === "完了"));
      cancel.disabled = false;
      cancel.textContent = t("閉じる");
      cancel.onclick = () => { feedback.remove(); };
      draw();
      if (refreshError) {
        const p = document.createElement("p");
        p.textContent = refreshError;
        results.append(p);
      }
      if(statuses.some(s=>s.status === "失敗")) { const warning=document.createElement("p");warning.textContent=t("結果が不明な項目があります。再実行前に対象と保存先を確認してください。");results.append(warning); }
      if (stateRun.cancelled) {
        const p = document.createElement("p");
        p.className = "warning";
        p.textContent = t(
          "中止しました。最終の移動・削除がすでに完了している場合があります。項目ごとの結果を確認してください。",
        );
        results.prepend(p);
      }
    }
  };
}
export function createTargetPath(
  side: Side,
  parent: string,
  name: string,
): string {
  if (
    !name ||
    !name.trim() ||
    name === "." ||
    name === ".." ||
    name.length > 255 ||
    /[\\/\x00-\x1f\x7f-\x9f]/.test(name) ||
    /[\uD800-\uDFFF]/u.test(name)
  )
    throw Error(
      t(
        "区切り・移動記号・制御文字を含まない1〜255文字の名前を入力してください",
      ),
    );
  if (side === "local") {
    const stem = name.split(".")[0].replace(/ +$/, "");
    if (
      /[<>":|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i.test(stem)
    )
      throw Error(
        t("Windowsの予約名・特殊文字・末尾のドットや空白は使用できません"),
      );
    if (
      !/^[A-Za-z]:[\\/]/.test(parent) ||
      parent.split(/[\\/]/).some((p) => p === "." || p === "..") ||
      /[\x00-\x1f\x7f-\x9f]/.test(parent)
    )
      throw Error(
        t("作成先には実際のローカルドライブのフォルダーを選んでください"),
      );
  } else if (
    !parent.startsWith("/") ||
    parent.split("/").some((p) => p === "." || p === "..") ||
    /[\x00-\x1f\x7f-\x9f]/.test(parent)
  )
    throw Error(
      t("作成先には移動記号を含まないリモートの絶対フォルダーを選んでください"),
    );
  return childPath(side, parent, name);
}
function showCreation(state: Snapshot, action: "createfile" | "mkdir") {
  if (operation || operationBusy()) return;
  closeMenu();
  const remote = state.side === "remote",
    allowed = native && (!remote || state.profile?.mode === "sftp");
  const overlay = document.createElement("div");
  overlay.className = "overlay operation-overlay";
  const label = () =>
    t(action === "mkdir" ? "新しいフォルダー" : "新しいファイル");
  const endpoint =
    remote && state.profile
      ? `${state.profile.user}@${state.profile.host}:${state.profile.port}`
      : t("ローカル");
  overlay.innerHTML = html`<section
    class="dialog operation-dialog create-entry-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="create-entry-title"
  >
    <h2 id="create-entry-title">${esc(label())}</h2>
    <p class="operation-endpoint">${esc(endpoint)}</p>
    <div class="target">
      <small>作成先のフォルダー</small><code>${esc(state.createParent)}</code>
    </div>
    <label
      >名前<input
        name="create-name"
        maxlength="255"
        autocomplete="off"
        spellcheck="false"
    /></label>
    <p class="subtle">
      同名の項目は上書きしません。ファイルは空の状態で作成します。
    </p>
    ${!remote && state.host.syncRoots.length ? html`<p class="warning">同期中のフォルダーに作成するとアップロードされる場合があります。</p>` : ""}${remote && !state.host.sessionId ? html`<label>秘密鍵のパスフレーズ（必要な場合のみ）<input name="operation-passphrase" type="password" autocomplete="off" /></label>` : ""}${!allowed ? html`<p class="mock-note">ブラウザプレビューでは実ファイルを作成しません。</p>` : ""}
    <p class="operation-results" aria-live="polite"></p>
    <div class="actions">
      <button id="create-entry-cancel">キャンセル</button
      ><button
        class="primary"
        id="create-entry-confirm"
        ${allowed ? "" : "disabled"}
      >
        作成
      </button>
    </div>
  </section>`;
  portal.append(overlay);
  const field = overlay.querySelector<HTMLInputElement>("[name=create-name]")!,
    confirm = overlay.querySelector<HTMLButtonElement>(
      "#create-entry-confirm",
    )!,
    cancel = overlay.querySelector<HTMLButtonElement>("#create-entry-cancel")!,
    results = overlay.querySelector<HTMLElement>(".operation-results")!;
  const run = {
    cancelled: false,
    running: false,
    current: undefined as string | undefined,
  };
  operation = run;
  const close = () => {
    if (run.running) return;
    overlay.remove();
    if (operation === run) operation = undefined;
  };
  cancel.onclick = async () => {
    if (!run.running) {
      close();
      return;
    }
    run.cancelled = true;
    cancel.disabled = true;
    cancel.textContent = t("中止処理中…");
    if (run.current)
      await invoke("cancel_file_operation", { id: run.current }).catch((e) =>
        notice(() => tError(e)),
      );
  };
  let composing = false;
  field.addEventListener("compositionstart", () => {
    composing = true;
  });
  field.addEventListener("compositionend", () => {
    composing = false;
  });
  overlay.onkeydown = (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && !run.running) {
      e.preventDefault();
      close();
    }
    if (e.key === "Enter" && e.target === field) {
      e.preventDefault();
      if (!confirm.disabled) confirm.click();
    }
  };
  field.focus();
  confirm.onclick = async () => {
    if (run.running) return;
    if (!state.host.valid()) {
      results.textContent = t(
        "表示や接続が変わりました。閉じてから対象を選び直してください",
      );
      confirm.disabled = true;
      return;
    }
    let target: string;
    try {
      target = createTargetPath(state.side, state.createParent, field.value);
    } catch (e) {
      results.textContent = tError(e);
      field.focus();
      return;
    }
    const passField = overlay.querySelector<HTMLInputElement>(
      "[name=operation-passphrase]",
    );
    let passphrase = passField?.value ?? "";
    if (passField) {
      passField.value = "";
      passField.disabled = true;
    }
    field.disabled = true;
    confirm.disabled = true;
    cancel.disabled = true;
    run.running = true;
    run.current = crypto.randomUUID();
    results.textContent=t("処理中です。");
    const feedback=operationFeedback(label(), results, cancel);
    overlay.remove();
    let dispatched = false,
      created = false, refreshFailed = false;
    try {
      await invoke("prepare_file_operation", { id: run.current });
      cancel.disabled = false;
      if (run.cancelled || !state.host.operationValid()) {
        await invoke("cancel_file_operation", { id: run.current, abandon:true });
        throw Error(t("接続が変わったか、中止が要求されました。"));
      }
      dispatched = true;
      await invoke("run_file_operation", {
        request: {
          id: run.current,
          side: state.side,
          action,
          source: state.createParent,
          destination: target,
          profile: remote ? state.profile : undefined,
          sessionId: remote ? state.host.sessionId : undefined,
          passphrase,
          confirmDelete: false,
        },
      });
      created = true;
      results.textContent = t("作成しました。");
    } catch (e) {
      results.textContent = tError(e);
    } finally {
      run.current = undefined;
      if (dispatched)
        try {
          await state.host.changed(state.side, passphrase, {
            action,
            paths: [target],
            parent: state.createParent,
            affectedDirectories: Object.freeze([state.createParent]),
            uncertain: !created,
            created,
          });
        } catch (e) {
          refreshFailed = true;
          results.textContent += " " + t("一覧の再読込に失敗: ") + tError(e);
        }
      passphrase = "";
      run.running = false;
      if(operation === run) operation=undefined;
      feedback.finish(created && !run.cancelled && !refreshFailed);
      cancel.disabled = false;
      cancel.textContent = t("閉じる");
      cancel.onclick = () => { feedback.remove(); };
      if (!created && dispatched) results.textContent += " " + t("結果が不明な項目があります。再実行前に対象と保存先を確認してください。");
      if (run.cancelled)
        results.textContent +=
          " " +
          t(
            "中止要求前に作成が完了した場合があります。再実行前に一覧を確認してください。",
          );
    }
  };
}

function parentPath(side: Side, source: string): string {
 if(side === "remote") return source.slice(0,source.lastIndexOf("/")) || "/";
 return archiveParent(source) ?? source;
}
function archiveParent(source: string): string | undefined {
  const trimmed = source.replace(/[\\/]$/, ""),
    split = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (split < 2) return;
  return trimmed.slice(0, split) + (split === 2 ? "\\" : "");
}
function archiveAllowed(state: Snapshot) {
  const allowed = archiveEligibility(
    state.side,
    state.items.map((item) => ({ ...item, size: 0 })),
    native,
  );
  if (!state.items[0] || !archiveParent(state.items[0].path))
    return { compress: false, extract: false };
  return allowed;
}
function showArchive(state: Snapshot, action: ArchiveAction) {
  if (operation || !archiveAllowed(state)[action]) return;
  closeMenu();
  const item = state.items[0],
    parent = archiveParent(item.path)!;
  const overlay = document.createElement("div");
  overlay.className = "overlay operation-overlay";
  const label = t(action === "compress" ? "ZIPに圧縮" : "ZIPを展開");
  overlay.innerHTML = html`<section
    class="dialog operation-dialog archive-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="archive-title"
  >
    <h2 id="archive-title">${esc(label)}</h2>
    <p class="operation-endpoint">ローカル</p>
    <div class="target"><small>対象</small><code>${esc(state.items.map(item=>item.path).join("\n"))}</code></div>
    <div class="target">
      <small>保存先のフォルダー</small><code>${esc(parent)}</code>
    </div>
    <label
      >${esc(t(action === "compress" ? "ZIPファイル名" : "展開先フォルダー名"))}<input
        name="archive-name"
        maxlength="255"
        autocomplete="off"
        spellcheck="false"
        value="${esc(archiveDefaultName(action, item.name))}"
    /></label>
    <p class="subtle">
      同名の項目は上書きしません。完了後に新しい出力を確定します。
    </p>
    <p class="warning">
      同期中のフォルダーと重なる場合は、同期を停止してから実行してください。
    </p>
    <p class="operation-results" aria-live="polite"></p>
    <div class="actions">
      <button id="archive-cancel">キャンセル</button
      ><button class="primary" id="archive-confirm">実行</button>
    </div>
  </section>`;
  portal.append(overlay);
  const field = overlay.querySelector<HTMLInputElement>("[name=archive-name]")!,
    confirm = overlay.querySelector<HTMLButtonElement>("#archive-confirm")!,
    cancel = overlay.querySelector<HTMLButtonElement>("#archive-cancel")!,
    results = overlay.querySelector<HTMLElement>(".operation-results")!;
  const run = {
    cancelled: false,
    running: false,
    current: undefined as string | undefined,
  };
  operation = run;
  const close = () => {
    if (run.running) return;
    overlay.remove();
    if (operation === run) operation = undefined;
  };
  cancel.onclick = async () => {
    if (!run.running) {
      close();
      return;
    }
    run.cancelled = true;
    cancel.disabled = true;
    cancel.textContent = t("中止処理中…");
    if (run.current)
      await invoke("cancel_file_operation", { id: run.current }).catch((e) =>
        notice(() => tError(e)),
      );
  };
  let composing = false;
  field.addEventListener("compositionstart", () => {
    composing = true;
  });
  field.addEventListener("compositionend", () => {
    composing = false;
  });
  overlay.onkeydown = (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && !run.running) {
      e.preventDefault();
      close();
    }
    if (e.key === "Enter" && e.target === field) {
      e.preventDefault();
      if (!confirm.disabled) confirm.click();
    }
  };
  field.focus();
  field.select();
  confirm.onclick = async () => {
    if (run.running) return;
    if (!state.host.valid()) {
      results.textContent = t(
        "表示や接続が変わりました。閉じてから対象を選び直してください",
      );
      confirm.disabled = true;
      return;
    }
    let target: string;
    try {
      target = createTargetPath("local", parent, field.value);
      if (action === "compress" && !/\.zip$/i.test(field.value))
        throw Error(t("ZIPファイル名の末尾には.zipを付けてください"));
    } catch (e) {
      results.textContent = tError(e);
      field.focus();
      return;
    }
    run.running = true;
    run.current = crypto.randomUUID();
    cancel.disabled = true;
    confirm.disabled = true;
    field.disabled = true;
    results.textContent=t("処理中です。");
    const feedback=operationFeedback(label, results, cancel);
    overlay.remove();
    let dispatched = false,
      created = false,
      finalPath = target, refreshFailed = false;
    try {
      await invoke("prepare_file_operation", { id: run.current });
      cancel.disabled = false;
      if (run.cancelled || !state.host.operationValid()) {
        await invoke("cancel_file_operation", { id: run.current, abandon:true });
        throw Error(t("接続が変わったか、中止が要求されました。"));
      }
      dispatched = true;
      const outcome = await invoke("run_local_archive", {
        request: {
          id: run.current,
          action,
          side: "local",
          source: item.path,
          sources: action === "compress" ? state.items.map(i=>i.path) : undefined,
          destination: target,
        },
      });
      finalPath = outcome.finalPath;
      created = true;
      results.textContent = text`ZIP処理が完了しました。${outcome.entries}項目 / ${outcome.bytes}バイト`;
    } catch (error) {
      results.textContent = formatArchiveError(error);
    } finally {
      run.current = undefined;
      if (dispatched)
        try {
          await state.host.changed("local", "", {
            action: action === "compress" ? "createfile" : "mkdir",
            paths: [finalPath],
            parent,
            affectedDirectories: Object.freeze([parent]),
            uncertain: !created,
            created,
          });
        } catch (e) {
          refreshFailed = true;
          results.textContent += " " + t("一覧の再読込に失敗: ") + tError(e);
        }
      run.running = false;
      if(operation === run) operation=undefined;
      feedback.finish(created && !run.cancelled && !refreshFailed);
      cancel.disabled = false;
      cancel.textContent = t("閉じる");
      cancel.onclick = () => { feedback.remove(); };
      if (run.cancelled)
        results.textContent +=
          " " +
          t(
            "中止要求前に出力が確定した場合があります。再実行前に一覧を確認してください。",
          );
    }
  };
}

let fileActionBindings: AbortController | undefined;
export function bindFileActions(host: ActionHost) {
  fileActionBindings?.abort();
  fileActionBindings=new AbortController();
  const signal=fileActionBindings.signal;
  latest = host;
  if (menu && menuContext !== contextKey(host)) closeMenu();
  decorateCut(host);
  for (const side of ["local", "remote"] as Side[]) {
    const list = document.querySelector<HTMLElement>(`[data-list="${side}"]`)!;
    const fromList = (row?: HTMLElement) => {
      if (!row || row.hasAttribute("data-inert")) {
        host.panes[side].selection.clear();
        host.selected(side);
        return snapshot(host, side, [], host.panes[side].path);
      }
      if (row && !host.panes[side].selection.has(row.dataset.name!)) {
        const index = host.panes[side].entries.findIndex(
          (i) => i.name === row.dataset.name,
        );
        host.panes[side].selection.click(index);
        host.selected(side);
      }
      const items = listItems(host, side),
        dest =
          items.length === 1 && items[0].dir
            ? items[0].path
            : host.panes[side].path;
      return snapshot(host, side, items, dest);
    };
    list.oncontextmenu = (e) => {
      e.preventDefault();
      if (host.panes[side].loading) return;
      const row =
        (e.target as Element).closest<HTMLElement>("[data-entry]") ?? undefined;
      showMenu(fromList(row), e.clientX, e.clientY);
    };
    list.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase(),
        control = e.ctrlKey || e.metaKey;
      if (host.panes[side].loading || operation) return;
      const state = snapshot(host, side, listItems(host, side));
      if (control && ["c", "x", "v"].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
        if (key === "v") paste(state);
        else remember(state, key === "x");
      } else if (e.key === "Delete") {
        e.preventDefault();
        showOperation(state, "delete");
      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const r = (e.target as HTMLElement).getBoundingClientRect();
        showMenu(state, r.left + 20, r.bottom);
      }
    }, {signal});
  }
  document
    .querySelectorAll<HTMLButtonElement>("[data-tree-select]")
    .forEach((button) => {
      button.oncontextmenu = (e) => {
        e.preventDefault();
        const side = button.dataset.treeSelect as Side,
          path = button.dataset.treePath!,
          name =
            path
              .replace(/[\\/]$/, "")
              .split(/[\\/]/)
              .pop() || path;
        showMenu(
          snapshot(host, side, [{ path, name, dir: true }], path, path),
          e.clientX,
          e.clientY,
        );
      };
      button.addEventListener("keydown", (e) => {
        if (operation || operationBusy()) return;
        const control = e.ctrlKey || e.metaKey,
          key = e.key.toLowerCase(),
          side = button.dataset.treeSelect as Side,
          path = button.dataset.treePath!,
          name =
            path
              .replace(/[\\/]$/, "")
              .split(/[\\/]/)
              .pop() || path,
          state = snapshot(host, side, [{ path, name, dir: true }], path, path);
        if (control && ["c", "x", "v"].includes(key)) {
          e.preventDefault();
          e.stopPropagation();
          if (key === "v") paste(state);
          else remember(state, key === "x");
        } else if (e.key === "Delete") {
          e.preventDefault();
          showOperation(state, "delete");
        }
      }, {signal});
    });
}
document.addEventListener(
  "pointerdown",
  (e) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  },
  true,
);
window.addEventListener("resize", closeMenu);
