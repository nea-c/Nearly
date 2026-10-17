import type { Entry, Side } from "./core.js";
import { t, text, tError } from "./i18n.js";
import { supportedName } from "./tree.js";

export type ArchiveAction = "compress" | "extract";
export function archiveEligibility(
  side: Side,
  selected: readonly Entry[],
  localCapability: boolean,
): { compress: boolean; extract: boolean } {
  const entry = selected.length === 1 ? selected[0] : undefined;
  const compress =
    side === "local" &&
    localCapability === true &&
    !!entry &&
    typeof entry.name === "string" &&
    supportedName(entry.name);
  return {
    compress,
    extract: compress && !entry!.dir && /\.zip$/i.test(entry!.name),
  };
}

/** Leaf-name suggestion only. The native operation validates the final path. */
export function archiveDefaultName(
  action: ArchiveAction,
  name: string,
): string {
  return action === "compress"
    ? name + ".zip"
    : name.replace(/\.zip$/i, "") || t("展開したファイル");
}

const codeMessages: Readonly<Record<string, string>> = {
  remote_unsupported: "リモートではZIP操作を利用できません。",
  invalid_request: "ZIP操作の指定が不正です。",
  unsupported_platform: "この環境ではZIP操作を利用できません。",
  unsupported_zip: "このZIP形式には対応していません。",
  unsafe_entry: "ZIP内に安全に展開できない項目があります。",
  limit_exceeded: "ZIP処理の上限を超えました。",
  cancelled: "ZIP処理を中止しました。",
  io_error: "ZIP処理中に入出力エラーが発生しました。",
  publish_refused:
    "出力を安全に確定できませんでした。保存先と残された一時出力を確認してください。",
  collision: "保存先に同じ名前の項目が存在します。上書きは行いません。",
  sync_overlap: "同期中のフォルダと重なるためZIP処理を開始できません。",
  busy: "別のZIP処理が実行中です。完了してから再試行してください。",
  source_changed: "ZIP処理中に入力が変更されました。",
  integrity_error: "ZIPの整合性を確認できませんでした。",
};

/** Returns plain text; consumers must use textContent or their normal escaping.
 * Only owned codes choose messages. A retained stage path is opaque user data. */
export function formatArchiveError(error: unknown): string {
  if (typeof error === "string" || error instanceof Error) return tError(error);
  if (typeof error !== "object" || error === null || Array.isArray(error))
    return t("ZIP処理に失敗しました。");
  const value = error as Record<string, unknown>;
  const known =
    typeof value.code === "string" && Object.hasOwn(codeMessages, value.code)
      ? codeMessages[value.code]
      : "ZIP処理に失敗しました。";
  let message =
    value.committed === true
      ? t(
          "ZIP出力は既に作成されています。保存先を確認し、同じ処理を再実行しないでください。",
        )
      : t(known);
  if (typeof value.stagePath === "string" && value.stagePath.length)
    message += "\n" + text`一時出力が残っています: ${value.stagePath}`;
  return message;
}
