import { confirmPresetRemoval } from "./confirmation-dialog.js";
import { t, text, html, tError } from "./i18n.js";
import {
  DEFAULT_SYNC_PRESET_ID,
  exclusionKey,
  validateRules,
  type Store,
  type SyncOptions,
} from "./core.js";
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function syncSettingsMarkup() {
  // Preserve catalog text boundaries inside this localized template.
  // prettier-ignore
  return html`<section class="sync-settings"><label for="sync-preset">同期設定プロファイル<select id="sync-preset" name="syncPreset"><option value="">デフォルト</option></select></label><div class="sync-option-flags"><label><input id="delete-removed" name="deleteRemoved" type="checkbox">ファイルを削除する</label><label><input id="recursive-sync" name="recursive" type="checkbox" checked>サブディレクトリも更新する</label></div><p id="delete-warning" class="warning" hidden>同期対象内でローカルにないリモートのファイルと空フォルダーを、開始時の比較と変更監視で削除します。除外とサブディレクトリの設定に従います。元に戻せない可能性があります。</p><details id="exclusion-details" class="exclusion-editor"><summary>除外ルール・プロファイルの保存</summary><label for="exclusion-rules">除外ルール（1行に1パターン）</label><textarea id="exclusion-rules" name="exclusionRules" rows="4" spellcheck="false" placeholder="sample/&#10;*.txt&#10;!sample.txt"></textarea><p class="subtle">同期元からの相対パスで指定します。*、**、?、/、末尾 /、# コメント、! 再対象化が使えます。除外ルールによって既存のリモートファイルを削除することはありません。</p><div class="preset-save-row"><label for="preset-name">設定名</label><div class="preset-controls"><input id="preset-name" maxlength="100" placeholder="例：Webサイト"><button type="button" id="preset-save">保存</button><button type="button" id="preset-duplicate">複製して保存</button><button type="button" id="preset-delete">削除</button></div></div><p class="subtle">名前を空欄にするとデフォルトを更新します。</p><p id="preset-result" role="status"></p></details><p class="subtle sync-settings-note">ルールとオプションは次の同期開始から適用します。接続先・パス・認証情報は同期設定プロファイルに含まれません。</p></section>`;
}
interface Draft extends SyncOptions {
  exclusionRules: string;
}
export function bindSyncSettings(
  root: HTMLElement,
  store: Store,
  profileId: string,
  remote: string,
  persist: () => Promise<void>,
  initial?: Draft,
  isolated = false,
) {
  const local = root.querySelector<HTMLInputElement>(
    "#start-form [name=local]",
  )!;
  const rules = root.querySelector<HTMLTextAreaElement>("#exclusion-rules")!;
  const select = root.querySelector<HTMLSelectElement>("#sync-preset")!;
  const name = root.querySelector<HTMLInputElement>("#preset-name")!;
  const remove = root.querySelector<HTMLInputElement>("#delete-removed")!;
  const recursive = root.querySelector<HTMLInputElement>("#recursive-sync")!;
  const save = root.querySelector<HTMLButtonElement>("#preset-save")!;
  const duplicate = root.querySelector<HTMLButtonElement>("#preset-duplicate")!;
  const result = root.querySelector<HTMLElement>("#preset-result")!;
  const warning = root.querySelector<HTMLElement>("#delete-warning")!;
  const erase = root.querySelector<HTMLButtonElement>("#preset-delete")!;
  const drafts = new Map<string, Draft>();
  let key = exclusionKey(profileId, remote, local.value);
  const custom = () =>
    store.syncPresets.filter((p) => p.id !== DEFAULT_SYNC_PRESET_ID);
  function options() {
    const value = select.value,
      presets = custom();
    select.innerHTML =
      html`<option value="">デフォルト</option>` +
      presets
        .map((p) => {
          const same = presets.filter((q) => q.name.trim() === p.name.trim());
          const suffix =
            same.length > 1 || p.name.trim() === t("デフォルト")
              ? " (" + (same.findIndex((q) => q.id === p.id) + 1) + ")"
              : "";
          return (
            '<option value="' +
            esc(p.id) +
            '">' +
            esc(p.name + suffix) +
            "</option>"
          );
        })
        .join("");
    select.value = presets.some((p) => p.id === value) ? value : "";
  }
  function read(): Draft {
    return {
      exclusionRules: rules.value,
      deleteRemoved: remove.checked,
      recursive: recursive.checked,
      ...(select.value ? { presetId: select.value } : {}),
    };
  }
  function paint(value: Draft) {
    rules.value = value.exclusionRules;
    remove.checked = value.deleteRemoved ?? false;
    recursive.checked = value.recursive ?? true;
    select.value = custom().some((p) => p.id === value.presetId)
      ? value.presetId!
      : "";
    name.value = custom().find((p) => p.id === select.value)?.name ?? "";
    warning.hidden = !remove.checked;
    save.textContent = select.value ? t("更新") : t("保存");
    erase.disabled = !select.value;
    result.textContent = "";
  }
  function remembered(): Draft {
    if (isolated) return store.defaultSyncPreset();
    const option = store.syncOptions[key];
    if (option?.presetId && !custom().some((p) => p.id === option.presetId))
      return store.defaultSyncPreset();
    return option
      ? { ...option, exclusionRules: store.exclusions[key] ?? "" }
      : store.defaultSyncPreset();
  }
  options();
  paint(initial ?? remembered());
  local.addEventListener("input", () => {
    drafts.set(key, read());
    key = exclusionKey(profileId, remote, local.value);
    paint(drafts.get(key) ?? remembered());
  });
  remove.onchange = () => {
    warning.hidden = !remove.checked;
  };
  select.onchange = () => {
    const preset = custom().find((p) => p.id === select.value);
    paint(
      preset ? { ...preset, presetId: preset.id } : store.defaultSyncPreset(),
    );
    if (preset)
      root.querySelector<HTMLDetailsElement>("#exclusion-details")!.open = true;
  };
  function busy() {
    const form = local.form!;
    return !!(
      form.dataset.submitting ||
      form.dataset.settingsSaving ||
      form.dataset.pickingFolder
    );
  }
  async function mutate(change: () => string | undefined, success: string) {
    if (busy()) return;
    const form = local.form!,
      before = {
        presets: store.syncPresets.map((p) => ({ ...p })),
        options: structuredClone(store.syncOptions),
        exclusions: { ...store.exclusions },
      },
      beforeDraft = read(),
      beforeName = name.value;
    const controls = Array.from(
      form.querySelectorAll<
        | HTMLInputElement
        | HTMLButtonElement
        | HTMLSelectElement
        | HTMLTextAreaElement
      >("input,button,select,textarea"),
    ).map((node) => ({ node, disabled: node.disabled }));
    form.dataset.settingsSaving = "true";
    controls.forEach((x) => (x.node.disabled = true));
    try {
      const id = change();
      await persist();
      options();
      const preset = custom().find((p) => p.id === id);
      paint(
        preset ? { ...preset, presetId: preset.id } : store.defaultSyncPreset(),
      );
      for (const [draftKey, draft] of drafts)
        if (draft.presetId && !custom().some((p) => p.id === draft.presetId))
          drafts.set(draftKey, { ...store.defaultSyncPreset() });
      result.textContent = success;
    } catch (error) {
      store.syncPresets = before.presets;
      store.syncOptions = before.options;
      store.exclusions = before.exclusions;
      options();
      paint(beforeDraft);
      name.value = beforeName;
      result.textContent = tError(error);
    } finally {
      delete form.dataset.settingsSaving;
      if (!form.dataset.submitting) {
        controls.forEach((x) => (x.node.disabled = x.disabled));
        erase.disabled = !select.value;
      }
    }
  }
  function savePreset(copy: boolean) {
    if (busy()) return;
    const current = read();
    let chosenName = name.value.trim();
    if (copy) {
      const base = text`${chosenName || t("同期設定")} のコピー`;
      chosenName = base;
      let n = 2;
      while (custom().some((p) => p.name.trim() === chosenName))
        chosenName = base + " (" + n++ + ")";
    }
    void mutate(
      () => {
        validateRules(current.exclusionRules);
        if (!copy && !select.value && !chosenName) {
          store.saveDefaultSyncPreset(current);
          return undefined;
        }
        const preset = store.saveSyncPreset({
          ...current,
          id: copy ? undefined : select.value || undefined,
          name: chosenName,
        });
        return preset.id;
      },
      copy ? t("複製を保存しました") : t("同期設定を保存しました"),
    );
  }
  save.onclick = () => savePreset(false);
  duplicate.onclick = () => savePreset(true);
  erase.onclick = async () => {
    if (busy()) return;
    const id = select.value,
      preset = custom().find((p) => p.id === id);
    if (!preset) return;
    const snapshot = JSON.stringify(preset);
    if (!(await confirmPresetRemoval(preset.name, erase))) return;
    // A delayed confirmation can never target a newly selected/replaced preset.
    if (!root.isConnected || busy() || select.value !== id ||
        JSON.stringify(custom().find(p => p.id === id)) !== snapshot) return;
    void mutate(() => {
      store.deleteSyncPreset(id);
      return undefined;
    }, t("同期設定プロファイルを削除しました"));
  };
}
