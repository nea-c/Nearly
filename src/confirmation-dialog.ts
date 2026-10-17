import { getLanguage, t } from "./i18n.js";
import { refreshBlockedCloseNotice } from "./window-close-notice.js";

/** A top-layer dialog: the existing settings modal remains intact and inert below it. */
export function confirmPresetRemoval(name: string, source: HTMLElement): Promise<boolean> {
  if (!source.isConnected) return Promise.resolve(false);
  if (document.querySelector("dialog.preset-removal-dialog[open]")) return Promise.resolve(false);
  const dialog = document.createElement("dialog");
  dialog.className = "preset-removal-dialog";
  dialog.id = "preset-removal-dialog";
  dialog.setAttribute("aria-labelledby", "preset-removal-title");
  dialog.setAttribute("aria-describedby", "preset-removal-description");
  const title = document.createElement("h2");
  title.id = "preset-removal-title";
  title.textContent = t("「{0}」を削除しますか？", {0: name});
  const description = document.createElement("p");
  description.id = "preset-removal-description";
  description.textContent = getLanguage() === "en"
    ? "Only this sync preset will be removed. Files will not be deleted. Saved sync settings that refer to it will use the default."
    : "この同期設定プロファイルだけを削除します。ファイルは削除しません。この設定を参照する保存済み同期先はデフォルトに戻ります。";
  const actions = document.createElement("div");
  actions.className = "preset-removal-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "preset-removal-cancel";
  cancel.textContent = t("キャンセル");
  cancel.autofocus = true;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.id = "preset-removal-confirm";
  remove.className = "preset-removal-danger";
  remove.textContent = t("削除");
  actions.append(cancel, remove);
  dialog.append(title, description, actions);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (source.isConnected) source.focus({preventScroll: true});
      resolve(confirmed);
    };
    const observer = new MutationObserver(() => {
      if (!source.isConnected || !dialog.isConnected) finish(false);
    });
    observer.observe(document.body, {childList: true, subtree: true});
    cancel.onclick = () => finish(false);
    remove.onclick = () => finish(true);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    });
    dialog.addEventListener("close", () => finish(false));
    dialog.addEventListener("keydown", event => {
      // Do not dismiss the underlying settings dialog or trigger tab shortcuts.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
        )).filter(node => !node.hidden && node.getClientRects().length > 0);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    });
    try {
      dialog.showModal();
      refreshBlockedCloseNotice();
      cancel.focus({preventScroll: true});
    } catch {
      // Fail closed when a detached owner or unavailable top layer prevents confirmation.
      finish(false);
    }
  });
}
