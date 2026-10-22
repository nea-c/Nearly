import type { Status, SyncFailure } from "./core.js";
import { getLanguage, tError } from "./i18n.js";

export function failureDetails(failure: SyncFailure) {
  const ja = getLanguage() === "ja";
  const operations: Record<string, string> = ja
    ? {
        scan: "ローカル走査",
        inventory: "リモート一覧取得",
        "compare/upload": "比較・アップロード",
        compare: "差分比較",
        validate: "安全性の検証",
        record: "反映結果の記録",
        upload: "アップロード",
        directory: "フォルダー検証",
        delete: "削除",
        watch: "変更監視",
        connect: "接続",
        sync: "同期",
      }
    : {};
  return {
    path: failure.relativePath,
    operation: operations[failure.operation] ?? failure.operation,
    reason: tError(failure.reason),
    pending: failure.pending,
    commit:
      failure.commitState === "not_committed"
        ? ja
          ? "対象への反映前"
          : "Not committed"
        : failure.commitState === "committed"
          ? ja
            ? "対象への反映済み"
            : "Committed"
          : ja
            ? "対象への反映結果は不明"
            : "Commit outcome unknown",
  };
}
export function failureLabels(stopComplete = false) {
  return getLanguage() === "ja"
    ? {
        title: stopComplete
          ? "エラーのため同期を停止しました"
          : "エラーのため同期を停止しています（完了未確認）",
        path: "対象",
        operation: "処理",
        reason: "理由",
        pending: "未反映の可能性がある項目",
        restart: "確認して再開",
        help: "自動再試行は行いません。再開時に最新の状態を走査・比較します。",
        status: "状態の取得に失敗しました",
      }
    : {
        title: stopComplete
          ? "Sync stopped after an error"
          : "Stopping sync after an error (completion unconfirmed)",
        path: "Target",
        operation: "Operation",
        reason: "Reason",
        pending: "Potentially pending items",
        restart: "Review and resume",
        help: "No automatic retry. Resuming scans and compares the latest state.",
        status: "Could not retrieve sync status",
      };
}

export function applyStatusPollFailure(status: Status, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  if (status.statusError !== reason)
    status.errorCount = (status.errorCount ?? 0) + 1;
  status.statusError = reason;
  status.stopComplete = false;
  status.status = "failed";
  status.speed = 0;
}
const statusStopAttempts = new WeakMap<Status, boolean>();
export async function stopAfterStatusFailure(
  status: Status,
  error: unknown,
  stop: () => Promise<unknown>,
): Promise<boolean> {
  if (statusStopAttempts.has(status)) return statusStopAttempts.get(status)!;
  applyStatusPollFailure(status, error);
  statusStopAttempts.set(status, false);
  try {
    await stop();
    status.stopComplete = true;
    statusStopAttempts.set(status, true);
    return true;
  } catch (stopError) {
    status.statusError +=
      "\n" +
      (stopError instanceof Error ? stopError.message : String(stopError));
    return false;
  }
}
