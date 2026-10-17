import { t, html, tError } from "./i18n.js";
import { invoke } from "./api.js";
import type { Profile } from "./core.js";

type Options = {
  profile: Profile;
  current: (profile?: Profile) => boolean;
  busy: (value: boolean) => void;
  approve: (requestId: string, token: string, profile: Profile) => Promise<Profile>;
  reload: () => Promise<Profile | undefined>;
  saved: (profile: Profile) => void;
};
type Pending = { id: string; overlay: HTMLElement; options: Options; cancelled: boolean; committing?: boolean; timer?: number };
let pending: Pending | undefined;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);

export function cancelHostKeyApproval() {
  const task = pending;
  if (!task || task.committing) return;
  pending = undefined;
  task.cancelled = true;
  if (task.timer !== undefined) clearTimeout(task.timer);
  task.overlay.remove();
  task.options.busy(false);
  void invoke("cancel_host_key", { requestId: task.id }).catch(() => {});
}
document.addEventListener("keydown", event => {
  if (pending && event.key === "Escape") { event.preventDefault(); cancelHostKeyApproval(); }
});

export async function showHostKeyApproval(options: Options) {
  cancelHostKeyApproval();
  const overlay = document.createElement("div");
  overlay.id = "host-key-overlay";
  overlay.className = "overlay";
  const task: Pending = { id: crypto.randomUUID(), overlay, options, cancelled: false };
  pending = task;
  const valid = (profile = options.profile) => pending === task && !task.cancelled && options.current(profile);
  overlay.innerHTML = html`<section class="dialog host-key-dialog" role="dialog" aria-modal="true" aria-labelledby="host-key-title"><h2 id="host-key-title">初回のホスト鍵を確認</h2><div class="target"><small>接続先</small><code><span id="host-key-host">${esc(options.profile.host)}</span>:<span id="host-key-port">${options.profile.port}</span></code></div><p id="host-key-status" role="status">サーバーの公開ホスト鍵を取得しています。認証やファイル操作は行いません。</p><div id="host-key-candidate"></div><p class="form-error" role="alert"></p><div class="actions"><button id="host-key-cancel">キャンセル</button><button id="host-key-approve" class="primary" hidden>確認した鍵を承認して保存</button></div></section>`;
  document.body.append(overlay);
  const cancel = overlay.querySelector<HTMLButtonElement>("#host-key-cancel")!;
  const approve = overlay.querySelector<HTMLButtonElement>("#host-key-approve")!;
  const status = overlay.querySelector<HTMLElement>("#host-key-status")!;
  const error = overlay.querySelector<HTMLElement>(".form-error")!;
  const reload = document.createElement("button");
  reload.id = "host-key-reload";
  reload.textContent = t("保存状態を再読み込み");
  reload.hidden = true;
  approve.before(reload);
  reload.onclick = async () => {
    if (!valid()) return;
    reload.disabled = true;
    try {
      const profile = await options.reload();
      if (profile && valid(profile)) {
        pending = undefined;
        if (task.timer !== undefined) clearTimeout(task.timer);
        overlay.remove();
        options.busy(false);
        options.saved(profile);
      } else if (valid()) error.textContent = t("保存済みのホスト鍵は確認できませんでした。閉じてから取得し直してください。");
    } catch (reason) { if (valid()) error.textContent = tError(reason); }
    finally { reload.disabled = false; }
  };
  cancel.onclick = cancelHostKeyApproval;
  cancel.focus();
  options.busy(true);
  try {
    const candidate = await invoke("probe_host_key", { requestId: task.id, profile: options.profile });
    if (!valid()) return;
    if (candidate.requestId !== task.id || candidate.host !== options.profile.host || candidate.port !== options.profile.port || !candidate.token || !candidate.fingerprint || !candidate.algorithm)
      throw Error(t("接続先に一致するホスト鍵を確認できませんでした。再試行してください。"));
    options.busy(false);
    status.textContent = t("管理者など信頼できる別の経路で、接続先とフィンガープリントが一致することを確認してください。一致を確認できない場合はキャンセルしてください。");
    overlay.querySelector<HTMLElement>("#host-key-candidate")!.innerHTML = html`<div class="target"><small>鍵の種類</small><code id="host-key-algorithm">${esc(candidate.algorithm)}</code><small>SHA-256 フィンガープリント</small><code id="host-key-fingerprint">${esc(candidate.fingerprint)}</code></div><p class="subtle">承認するとこの鍵を保存します。保存後にパスフレーズを入力し、接続ボタンで接続してください。</p>`;
    approve.hidden = false;
    const seconds = Math.max(1, Math.min(120, Number(candidate.expiresInSeconds) || 120));
    task.timer = window.setTimeout(() => {
      if (!valid()) return;
      approve.disabled = true;
      error.textContent = t("確認の有効期限が切れました。閉じてから、接続ボタンで鍵を取得し直してください。");
      void invoke("cancel_host_key", { requestId: task.id }).catch(() => {});
    }, seconds * 1000);
    approve.onclick = async () => {
      if (!valid() || approve.disabled) return;
      approve.disabled = true;
      task.committing = true;
      cancel.disabled = true;
      if (task.timer !== undefined) clearTimeout(task.timer);
      options.busy(true);
      try {
        // This command persists the pin and trust record natively. Never issue
        // a second save_settings that could race or overwrite that result.
        const profile = await options.approve(task.id, candidate.token, options.profile);
        if (!valid(profile)) return;
        pending = undefined;
        overlay.remove();
        options.busy(false);
        options.saved(profile);
      } catch (reason) {
        if (!valid()) return;
        error.textContent = tError(reason) + t(" 閉じてから再試行してください。必要な場合は設定の再読み込みで保存状態を確認できます。");
        task.committing = false;
        cancel.disabled = false;
        cancel.textContent = t("閉じる");
        reload.hidden = false;
        // An approval token is one-use, including failed persistence attempts.
        options.busy(false);
      }
    };
  } catch (reason) {
    if (valid()) {
      options.busy(false);
      status.textContent = t("ホスト鍵を取得できませんでした。認証は行っていません。");
      error.textContent = tError(reason);
      cancel.textContent = t("閉じる");
      reload.hidden = false;
    }
  }
}
