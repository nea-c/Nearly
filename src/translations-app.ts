/** Application-owned source literals only; interpolated names and paths stay opaque. */
export const appTranslations: Record<string, string> = {
  "接続先の設定が変わりました。リモートパスで Enter を押して再読込してください":
    "Connection settings changed. Press Enter in the remote path to reload.",
  フォルダ: "Folder",
  未接続: "Not connected",
  展開: "Expand",
  折り畳む: "Collapse",
  "読込中…": "Loading…",
  再読込: "Reload",
  サブフォルダなし: "No subfolders",
  先頭500フォルダを表示: "Showing the first 500 folders",
  リモート: "Remote",
  ローカル: "Local",
  " 件を選択": " selected",
  接続を中止してからタブを閉じてください:
    "Cancel the connection before closing this tab.",
  "同期中のタブは閉じられません。同期停止を押し、停止完了後に改めて閉じてください。":
    "This tab is syncing. Stop sync, wait for it to finish, then close the tab.",
  "設定の読込に失敗しているため保存できません。元の設定を復元して再起動してください。":
    "Settings could not be loaded, so saving is disabled. Restore the original settings and restart.",
  前のブックマーク設定の保存が完了するまでお待ちください:
    "Wait for the previous bookmark save to finish.",
  前の接続設定の保存が完了するまでお待ちください:
    "Wait for the previous connection save to finish.",
  接続先が変更されたためホスト鍵の確認を中止しました:
    "Host key verification was cancelled because the connection changed.",
  "保存された接続設定を確認できませんでした。設定を再読み込みしてください。":
    "The saved connection settings could not be verified. Reload settings.",
  接続設定の保存完了後に再試行してください:
    "Retry after the connection settings have finished saving.",
  "他の設定も更新されています。アプリを再起動して保存状態を読み直してください。":
    "Other settings have also changed. Restart the app to reload the saved settings.",
  接続先が変更されています: "The connection has changed.",
  "閉じています…": "Closing…",
  "開始中…": "Starting…",
  "停止中…": "Stopping…",
  同期停止: "Stop sync",
  同期: "Sync",
  接続先がありません: "No connection selected.",
  実SFTPはデスクトップで利用できます: "SFTP is available in the desktop app.",
  "組み合わせを開けませんでした。閲覧位置は変更していません。 ":
    "Could not open the folder pair. Browsing locations have not changed. ",
  "{0}の前回フォルダを開けませんでした: {1}。 {2}":
    "Could not open the previous {0} folder: {1}. {2}",
  "この PC": "This PC",
  表示中のリモートフォルダへ同期: "Sync to the displayed remote folder",
  "同期元: {0} → 同期先: {1}": "Source: {0} → Destination: {1}",
  戻る: "Back",
  進む: "Forward",
  親フォルダ: "Parent folder",
  更新: "Update",
  "..（親フォルダ）": ".. (Parent folder)",
  この名前の操作は未対応です: "Operations on this name are not supported.",
  このフォルダーは空です: "This folder is empty",
  " · 閲覧先を変えても同期先は変わりません":
    " · Browsing does not change the sync destination",
  "ペイン幅を保存できませんでした。 ": "Could not save the pane width. ",
  左右ペインの幅: "Local and remote pane width",
  通知を閉じる: "Dismiss notification",
  接続先を選択してください: "Select a connection",
  "接続中…": "Connecting…",
  同期元: "Source",
  同期先: "Destination",
  接続済み: "Connected",
  監視中: "Watching",
  "失敗・再試行が必要": "Failed · Retry required",
  停止済み: "Stopped",
  停止中: "Stopping",
  待機: "Pending",
  エラー: "Errors",
  送信: "Sent",
  ログ: "Logs",
  ログを閉じる: "Close logs",
  まだログはありません: "No logs yet",
  このタブのログ: "Logs for this tab",
  最大100件: "Up to 100 entries",
  再接続して再試行: "Reconnect and retry",
  モック動作確認: "Mock controls",
  同じファイルを20回変更: "Change the same file 20 times",
  次の転送を失敗させる: "Fail the next transfer",
  "表示設定を保存できませんでした。再起動して保存状態を確認してください。 {0}":
    "Could not save appearance settings. Restart to check the saved state. {0}",
  アプリ設定: "App settings",
  設定: "Settings",
  設定を閉じる: "Close settings",
  テーマ: "Theme",
  コンパクト表示: "Compact view",
  一覧とツリーの行間を狭くします: "Reduce row spacing in lists and trees",
  ライト: "Light",
  ダーク: "Dark",
  ミッドナイト: "Midnight",
  "接続を中止し、完了してからウィンドウを閉じてください。":
    "Cancel the connection and wait for it to finish before closing the window.",
  "同期中はウィンドウを閉じられません。各タブの同期停止を押し、停止完了後に改めて閉じてください。":
    "The window cannot close while syncing. Stop sync in each tab, wait for completion, then close it.",
  "index.html の変更20件を集約": "Coalesced 20 changes to index.html",
  次の転送で通信失敗を模擬:
    "Simulate a connection failure on the next transfer",
  タブを閉じる: "Close tab",
  同期する組み合わせを確認: "Confirm the folder pair to sync",
  接続プロファイル: "Connection profile",
  "同期停止を押し、停止完了後に改めて閉じてください。":
    "Stop sync and wait for completion before closing.",
  閉じる: "Close",
  "リモート同期先 /": "Remote destination /",
  ローカル同期元: "Local source",
  フォルダを選択: "Choose folder",
  "既存の同名ファイルを上書きします。初回は設定の対象となるファイルを送信し、その後は変更を監視します。削除とサブディレクトリの扱いは上の設定に従います。":
    "Existing files with the same name will be overwritten. The initial sync sends files included by these settings, then watches for changes. Deletion and subdirectories follow the settings above.",
  キャンセル: "Cancel",
  確認して同期開始: "Confirm and start sync",
  "モック：ファイル監視と転送をシミュレーションします。":
    "Mock: file watching and transfers are simulated.",
  "実 SFTP：開始すると接続・アップロードを実行します。":
    "SFTP: starting connects and uploads files.",
  名前: "Name",
  ホスト: "Host",
  ポート: "Port",
  ユーザー名: "Username",
  接続方式: "Connection type",
  "認証：PPK 秘密鍵": "Authentication: PPK private key",
  秘密鍵ファイル: "Private key file",
  "秘密鍵の .ppk ファイル": "Private key .ppk file",
  秘密鍵ファイルを選択: "Choose private key file",
  "確認済みホスト鍵（SHA-256）": "Verified host key (SHA-256)",
  初回接続時に確認: "Verify on first connection",
  "PPK v2/v3 を内蔵エンジンで読み込みます。保存するのは鍵のパスだけです。ホスト鍵は初回接続時に取得して確認・保存します。保存済みの鍵と異なる場合は接続を拒否します。":
    "PPK v2/v3 keys are read by the built-in engine. Only the key path is saved. On first connection, retrieve, verify and save the host key. Connections are rejected if the key differs from the saved one.",
  保存: "Save",
  デスクトップ版で鍵を選択してください: "Choose the key in the desktop app.",
  "ブラウザ版はパスを入力してください。デスクトップ版では選択ダイアログが開きます。":
    "Enter a path in the browser preview. The desktop app opens a folder picker.",
  ローカルフォルダを指定してください: "Specify a local folder.",
  "同じ接続先で重なる同期が実行中です。先に停止してください":
    "An overlapping sync is running on this connection. Stop it first.",
  "SFTP はデスクトップ版を起動してください": "Use the desktop app for SFTP.",
  接続を中止: "Cancel connection",
  接続を中止しました: "Connection cancelled.",
  同期を開始: "Sync started",
  "モック同期を開始。変更ボタンで送信を確認できます":
    "Mock sync started. Use the change button to test transfers.",
  "同期を停止。再開時は新しく開始してください":
    "Sync stopped. Start a new sync to resume.",
  " を送信完了（モック）": " sent (mock)",
  "通信失敗（モック）。待ち行列を保持。再試行してください":
    "Connection failed (mock). The queue is retained. Please retry.",
  デモ接続: "Demo connection",
  "設定を読み込めませんでした。上書きを避けるためアプリを再起動してください。 ":
    "Could not load settings. Restart the app to avoid overwriting them. ",
  接続先: "Connection",
  "接続後、このタブの接続先は固定されます。別の接続先は新しいタブで開いてください。":
    "After connecting, this tab keeps its connection. Open another connection in a new tab.",
  接続: "Connect",
  接続先を選択: "Select a connection",
  "接続先を追加するか、左のツリーから選択してください。":
    "Add a connection or select one from the tree on the left.",
  "グループ内の接続先を選択してください。グループの操作では接続しません。":
    "Select a connection inside the group. Group actions do not connect.",
  接続設定: "Connection settings",
  "モック接続：実際の接続や送信は行いません。":
    "Mock connection: no real connections or transfers.",
  "秘密鍵のパスフレーズ（必要な場合のみ）":
    "Private-key passphrase (if required)",
  "認証情報はこのタブを閉じるまでメモリ内に保持し、設定やログには保存しません。":
    "Credentials stay in memory until this tab closes. They are not saved in settings or logs.",
  接続先またはグループが見つかりません: "Connection or group not found.",
  "SFTP はデスクトップ版で接続してください":
    "Connect using SFTP in the desktop app.",
  "ホスト鍵を保存しました。必要な場合はパスフレーズを入力し、接続してください。":
    "Host key saved. Enter a passphrase if required, then connect.",
  "リモートパスは / で始めてください": "Remote paths must start with /.",
  "待ち件数が上限です。停止して再走査してください":
    "The pending queue is full. Stop and rescan.",
  タブは最大16個です: "You can open up to 16 tabs.",
  タブは閉じられています: "The tab is closed.",
  このタブで接続したプロファイルだけを同期できます:
    "Only this tab's connected profile can sync.",
  現在の同期を先に停止してください: "Stop the current sync first.",
  別の接続先は新しいタブで開いてください:
    "Open another connection in a new tab.",
  接続先が見つかりません: "Connection not found.",
  タブを閉じる前に同期を停止してください: "Stop sync before closing the tab.",
  "保存された列幅の一部を既定値に戻しました。":
    "Some saved column widths were reset to defaults.",
  除外ルールの設定形式が不正です: "Invalid exclusion rules format.",
  同期オプションの設定形式が不正です: "Invalid sync options format.",
  同期設定プロファイルの形式が不正です: "Invalid sync preset format.",
  設定ファイルの形式が不正です: "Invalid settings file format.",
  未対応の設定バージョンです: "Unsupported settings version.",
  テーマ設定が不正です: "Invalid theme setting.",
  言語設定が不正です: "Invalid language setting.",
  コンパクト表示設定が不正です: "Invalid compact view setting.",
  接続設定の形式が不正です: "Invalid connection settings format.",
  "保存された画面分割比の一部を既定値に戻しました。":
    "Some saved pane ratios were reset to defaults.",
  "名前・ホスト・ユーザー名と正しいポートを入力してください":
    "Enter a name, host, username and valid port.",
  "この接続先は接続中・接続処理中・同期中に使用されています。停止してタブを閉じてから削除してください。":
    "This connection is connected, connecting or syncing. Stop it and close the tab before deleting it.",
  "不正な画面分割比を直前の有効な値に戻しました。":
    "Invalid pane ratios were restored to their last valid values.",
  "不正な列幅を直前の有効な値に戻しました。":
    "Invalid column widths were restored to their last valid values.",
  名前と同期設定を確認してください: "Check the name and sync settings.",
  同期設定プロファイルは100件までです: "You can save up to 100 sync presets.",
  "除外ルールは64KiB・2048行以内、1行4096バイト以内で入力してください":
    "Exclusion rules must be within 64 KiB and 2,048 lines, with at most 4,096 bytes per line.",
  "{0} を{1}": "{1} {0}",
  "{0}のフォルダツリー": "{0} folder tree",
  "{0}フォルダ": "{0} folder",
  "{0}のツリー幅": "{0} tree width",
  "{0}のファイル一覧": "{0} file list",
  "{0}の{1}": "{0}: {1}",
  "{0} 項目": "{0} items",
  "エラー {0} 件のログを表示": "Show logs for {0} errors",
  "{0} のログ": "Logs for {0}",
};

export const appErrorTranslations: Record<string, string> = {
  "接続先の設定が変わりました。リモートパスで Enter を押して再読込してください":
    "Connection settings changed. Press Enter in the remote path to reload.",
  接続を中止してからタブを閉じてください:
    "Cancel the connection before closing this tab.",
  "同期中のタブは閉じられません。同期停止を押し、停止完了後に改めて閉じてください。":
    "This tab is syncing. Stop sync, wait for it to finish, then close the tab.",
  "設定の読込に失敗しているため保存できません。元の設定を復元して再起動してください。":
    "Settings could not be loaded, so saving is disabled. Restore the original settings and restart.",
  前のブックマーク設定の保存が完了するまでお待ちください:
    "Wait for the previous bookmark save to finish.",
  前の接続設定の保存が完了するまでお待ちください:
    "Wait for the previous connection save to finish.",
  接続先が変更されたためホスト鍵の確認を中止しました:
    "Host key verification was cancelled because the connection changed.",
  "保存された接続設定を確認できませんでした。設定を再読み込みしてください。":
    "The saved connection settings could not be verified. Reload settings.",
  接続設定の保存完了後に再試行してください:
    "Retry after the connection settings have finished saving.",
  "他の設定も更新されています。アプリを再起動して保存状態を読み直してください。":
    "Other settings have also changed. Restart the app to reload the saved settings.",
  実SFTPはデスクトップで利用できます: "SFTP is available in the desktop app.",
  "組み合わせを開けませんでした。閲覧位置は変更していません。 ":
    "Could not open the folder pair. Browsing locations have not changed. ",
  "{0}の前回フォルダを開けませんでした: {1}。 {2}":
    "Could not open the previous {0} folder: {1}. {2}",
  "同期元: {0} → 同期先: {1}": "Source: {0} → Destination: {1}",
  " · 閲覧先を変えても同期先は変わりません":
    " · Browsing does not change the sync destination",
  "表示設定を保存できませんでした。再起動して保存状態を確認してください。 {0}":
    "Could not save appearance settings. Restart to check the saved state. {0}",
  "接続を中止し、完了してからウィンドウを閉じてください。":
    "Cancel the connection and wait for it to finish before closing the window.",
  "同期中はウィンドウを閉じられません。各タブの同期停止を押し、停止完了後に改めて閉じてください。":
    "The window cannot close while syncing. Stop sync in each tab, wait for completion, then close it.",
  "index.html の変更20件を集約": "Coalesced 20 changes to index.html",
  "同期停止を押し、停止完了後に改めて閉じてください。":
    "Stop sync and wait for completion before closing.",
  "モック：ファイル監視と転送をシミュレーションします。":
    "Mock: file watching and transfers are simulated.",
  "実 SFTP：開始すると接続・アップロードを実行します。":
    "SFTP: starting connects and uploads files.",
  デスクトップ版で鍵を選択してください: "Choose the key in the desktop app.",
  "ブラウザ版はパスを入力してください。デスクトップ版では選択ダイアログが開きます。":
    "Enter a path in the browser preview. The desktop app opens a folder picker.",
  "同じ接続先で重なる同期が実行中です。先に停止してください":
    "An overlapping sync is running on this connection. Stop it first.",
  "SFTP はデスクトップ版を起動してください": "Use the desktop app for SFTP.",
  "モック同期を開始。変更ボタンで送信を確認できます":
    "Mock sync started. Use the change button to test transfers.",
  "同期を停止。再開時は新しく開始してください":
    "Sync stopped. Start a new sync to resume.",
  "通信失敗（モック）。待ち行列を保持。再試行してください":
    "Connection failed (mock). The queue is retained. Please retry.",
  "設定を読み込めませんでした。上書きを避けるためアプリを再起動してください。 ":
    "Could not load settings. Restart the app to avoid overwriting them. ",
  "接続後、このタブの接続先は固定されます。別の接続先は新しいタブで開いてください。":
    "After connecting, this tab keeps its connection. Open another connection in a new tab.",
  "接続先を追加するか、左のツリーから選択してください。":
    "Add a connection or select one from the tree on the left.",
  "グループ内の接続先を選択してください。グループの操作では接続しません。":
    "Select a connection inside the group. Group actions do not connect.",
  "モック接続：実際の接続や送信は行いません。":
    "Mock connection: no real connections or transfers.",
  "秘密鍵のパスフレーズ（必要な場合のみ）":
    "Private-key passphrase (if required)",
  接続先またはグループが見つかりません: "Connection or group not found.",
  "SFTP はデスクトップ版で接続してください":
    "Connect using SFTP in the desktop app.",
  "ホスト鍵を保存しました。必要な場合はパスフレーズを入力し、接続してください。":
    "Host key saved. Enter a passphrase if required, then connect.",
  "リモートパスは / で始めてください": "Remote paths must start with /.",
  "待ち件数が上限です。停止して再走査してください":
    "The pending queue is full. Stop and rescan.",
  このタブで接続したプロファイルだけを同期できます:
    "Only this tab's connected profile can sync.",
  別の接続先は新しいタブで開いてください:
    "Open another connection in a new tab.",
  タブを閉じる前に同期を停止してください: "Stop sync before closing the tab.",
  "保存された列幅の一部を既定値に戻しました。":
    "Some saved column widths were reset to defaults.",
  同期設定プロファイルの形式が不正です: "Invalid sync preset format.",
  "保存された画面分割比の一部を既定値に戻しました。":
    "Some saved pane ratios were reset to defaults.",
  "名前・ホスト・ユーザー名と正しいポートを入力してください":
    "Enter a name, host, username and valid port.",
  "この接続先は接続中・接続処理中・同期中に使用されています。停止してタブを閉じてから削除してください。":
    "This connection is connected, connecting or syncing. Stop it and close the tab before deleting it.",
  "不正な画面分割比を直前の有効な値に戻しました。":
    "Invalid pane ratios were restored to their last valid values.",
  "不正な列幅を直前の有効な値に戻しました。":
    "Invalid column widths were restored to their last valid values.",
  同期設定プロファイルは100件までです: "You can save up to 100 sync presets.",
  "除外ルールは64KiB・2048行以内、1行4096バイト以内で入力してください":
    "Exclusion rules must be within 64 KiB and 2,048 lines, with at most 4,096 bytes per line.",
  タブは最大16個です: "You can open up to 16 tabs.",
  タブは閉じられています: "The tab is closed.",
  現在の同期を先に停止してください: "Stop the current sync first.",
  接続先が見つかりません: "Connection not found.",
  除外ルールの設定形式が不正です: "Invalid exclusion rules format.",
  同期オプションの設定形式が不正です: "Invalid sync options format.",
  設定ファイルの形式が不正です: "Invalid settings file format.",
  未対応の設定バージョンです: "Unsupported settings version.",
  テーマ設定が不正です: "Invalid theme setting.",
  言語設定が不正です: "Invalid language setting.",
  コンパクト表示設定が不正です: "Invalid compact view setting.",
  接続設定の形式が不正です: "Invalid connection settings format.",
  名前と同期設定を確認してください: "Check the name and sync settings.",
  "組み合わせを開けませんでした。閲覧位置は変更していません。 {0}":
    "Could not open the folder pair. Browsing locations have not changed. {0}",
  "ペイン幅を保存できませんでした。 {0}": "Could not save the pane width. {0}",
  "設定を読み込めませんでした。上書きを避けるためアプリを再起動してください。 {0}":
    "Could not load settings. Restart the app to avoid overwriting them. {0}",
};

// Exact inverse pairs for core-owned English diagnostics; unknown details remain opaque.
const coreOwnedErrors: Record<string,string> = {
  "設定のリビジョンが不正です": "Invalid settings revision",
  "保存されたブックマークが重複しています": "Duplicate folder bookmark",
  "フォルダの組み合わせ履歴が重複しています": "Duplicate folder pair history",
  "接続先は200件までです": "Connections are limited to 200 profiles",
  "ブックマークの接続先は変更できません": "A bookmark cannot change its connection identity",
  "このフォルダの組み合わせは登録済みです": "This folder pair is already bookmarked",
  "ブックマークは500件までです": "Bookmarks are limited to 500 entries",
  "閲覧要求カウンターが上限に達しました": "Browse request counter exhausted",
  "列幅には数値を指定してください": "Column width must be numeric"
};
Object.assign(appTranslations, coreOwnedErrors);
Object.assign(appErrorTranslations, coreOwnedErrors);
