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
        conflict: "同期の競合",
      }
    : {};
  return {
    path: failure.relativePath,
    operation: operations[failure.operation] ?? failure.operation,
    reason: conflictReason(failure.reason),
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
function conflictReason(reason:string){
 if(getLanguage()!=='ja'||!reason.startsWith('Sync conflict: '))return tError(reason);
 const messages:Record<string,string>={
  'remote changed since sync baseline; no overwrite attempted':'同期開始時・直前の反映時からリモートが変更されています。上書きしていません。',
  'size differs while remote timestamp is equal or newer; review both files':'リモートの日時が同じか新しく、サイズが異なります。両方の内容を確認してください。',
  'new local file already exists remotely; review both files':'新しいローカルファイルと同じ場所にリモートファイルが存在します。両方の内容を確認してください。',
  'remote metadata unavailable; no overwrite attempted':'リモートのサイズ・更新日時を確認できないため、上書きしていません。',
  'local timestamp unavailable; no overwrite attempted':'ローカルの更新日時を確認できないため、上書きしていません。',
  'remote target is not a regular file; no overwrite attempted':'リモートの対象が通常ファイルではないため、上書きしていません。',
  'sync baseline limit reached; stop and narrow the sync scope':'同期の基準情報の上限に達しました。停止して同期範囲を狭めてください。',
  'sync baseline unavailable':'同期の基準情報を取得できません。停止して状態を確認してください。',
  'initial comparison is incomplete; no overwrite attempted':'初回比較が完了していないため、上書きしていません。',
  'local source changed while preparing baseline; restart to rescan':'初回の基準情報を準備中にローカルファイルが変更されました。確認して再走査してください。',
  'local baseline unavailable; restart to rescan':'初回のローカル基準情報を取得できません。確認して再走査してください。',
  'local baseline read failed; restart to rescan':'初回のローカル基準情報を読み取れません。確認して再走査してください。',
 };
 return '同期の競合: '+(messages[reason.slice('Sync conflict: '.length)]??tError(reason.slice('Sync conflict: '.length)));
}
export function failureLabels(stopComplete = false,conflict=false) {
  const labels = getLanguage() === "ja"
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
  if(conflict){labels.title=getLanguage()==='ja'?(stopComplete?'競合のため同期を停止しました':'競合のため停止中です（完了確認待ち）'):(stopComplete?'Sync stopped after a conflict':'Stopping sync after a conflict (completion unconfirmed)');labels.help=getLanguage()==='ja'?'自動上書き・自動再試行は行いません。ローカルとリモートの内容を確認し、残す内容を決めてから再開してください。途中の一時ファイルが残る場合があります。':'No automatic overwrite or retry. Review local and remote content and resolve the difference before resuming. Staging files may remain.';}
  return labels;
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
