/** Application-owned archive phrases. Names and paths are interpolation values. */
export const archiveTranslations: Record<string, string> = {
  "対象":"Target",
  "実行":"Run",
  ZIPに圧縮: "Compress to ZIP",
  ZIPを展開: "Extract ZIP",
  ZIPファイル名: "ZIP file name",
  展開先フォルダー名: "Extraction folder name",
  展開したファイル: "Extracted files",
  "リモートではZIP操作を利用できません。":
    "ZIP operations are not available remotely.",
  "ZIP操作の指定が不正です。": "The ZIP operation request is invalid.",
  "この環境ではZIP操作を利用できません。":
    "ZIP operations are not available on this platform.",
  "このZIP形式には対応していません。": "This ZIP format is not supported.",
  "ZIP内に安全に展開できない項目があります。":
    "The ZIP contains an entry that cannot be extracted safely.",
  "ZIP処理の上限を超えました。": "The ZIP operation exceeded its limits.",
  "ZIP処理を中止しました。": "The ZIP operation was cancelled.",
  "ZIP処理中に入出力エラーが発生しました。":
    "An I/O error occurred during the ZIP operation.",
  "出力を安全に確定できませんでした。保存先と残された一時出力を確認してください。":
    "The output could not be published safely. Check the destination and any retained temporary output.",
  "保存先に同じ名前の項目が存在します。上書きは行いません。":
    "An item with the same name already exists at the destination. Nothing will be overwritten.",
  "同期中のフォルダと重なるためZIP処理を開始できません。":
    "The ZIP operation cannot start because it overlaps a folder being synchronized.",
  "別のZIP処理が実行中です。完了してから再試行してください。":
    "Another ZIP operation is running. Wait for it to finish before trying again.",
  "ZIP処理中に入力が変更されました。":
    "The source changed during the ZIP operation.",
  "ZIPの整合性を確認できませんでした。": "ZIP integrity validation failed.",
  "ZIP処理に失敗しました。": "The ZIP operation failed.",
  "ZIP出力は既に作成されています。保存先を確認し、同じ処理を再実行しないでください。":
    "The ZIP output has already been created. Check the destination and do not repeat the operation.",
  "一時出力が残っています: {0}": "Temporary output retained at: {0}",
  "保存先のフォルダー":"Destination folder",
  "同名の項目は上書きしません。完了後に新しい出力を確定します。":"Existing items will never be overwritten. New output is published only after completion.",
  "同期中のフォルダーと重なる場合は、同期を停止してから実行してください。":"Stop synchronization before operating on overlapping folders.",
  "ZIPファイル名の末尾には.zipを付けてください":"The ZIP file name must end in .zip",
  "ZIP処理が完了しました。{0}項目 / {1}バイト":"ZIP operation completed. {0} entries / {1} bytes",
  "中止要求前に出力が確定した場合があります。再実行前に一覧を確認してください。":"Output may have been published before cancellation. Refresh before retrying.",
};
