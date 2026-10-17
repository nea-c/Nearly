// Owned native messages only. Tuple order: Japanese, English.
// Complete templates use numeric placeholders; captured data is never translated.
export const nativeErrorLiterals: ReadonlyArray<readonly [string, string]> = [
  ["保持するフォルダーの追跡上限に達したため削除を中断しました。同期を停止して開始し直してください。","Retained directory tracking limit reached; deletion paused, stop and start a new sync"],
  ["フォルダー検証情報のメモリー上限に達しました。より浅い範囲で同期を開始し直してください。","Directory authority memory limit reached; stop and start a shallower sync"],
  ["走査対象のローカルパスが同期元の外にあります。","Local scan path outside root"],
  ["同期元の項目を読み取れず初回走査が完了しないため、ミラー削除を拒否しました。","Local source entry unreadable; initial scan incomplete, mirror deletion refused"],
  ["ファイル検証情報のメモリー上限に達したため削除を無効にしました。より浅い範囲で同期を開始し直してください。","Deletion disabled: file authority memory limit reached; stop and start a shallower sync"],
  ["初回走査中に同期元ルートが変わったため、削除を拒否しました。","Local root changed during initial scan; deletion refused"],
  ["ミラー対象の取得中に同期元ルートが変わったため、削除を拒否しました。","Local root changed during mirror inventory; deletion refused"],
  ["ミラー対象取得後に同期元ルートを読み取れません。","Local root unreadable after mirror inventory"],
  ["ミラー対象取得後に同期元ルート内の項目を読み取れません。","Local root entry unreadable after mirror inventory"],
  ["フォルダー追跡数の上限に達したため、削除を拒否しました。","Directory tracking limit reached; deletion refused"],
  ["リモート削除前にローカルファイルが再作成されたため、削除を拒否しました。","Local file recreated before remote removal; deletion refused"],
  ["比較する同期元を参照できません。","Local source unavailable for comparison"],
  ["比較するローカルパスが同期元の外にあります。","Local comparison path escaped root"],
  ["比較する同期元を読み取れません。","Local source unreadable for comparison"],
  ["比較するローカルのメタデータを取得できません。","Local metadata unavailable for comparison"],
  ["比較するローカルの同期元はファイルではありません。","Local comparison source is not a file"],
  ["比較先が無効です。","Invalid comparison target"],
  ["比較先の親フォルダーを安全に参照できません。","Remote comparison parent unavailable or unsafe"],
  ["リモートの比較先を照会できません。","Remote comparison lookup failed"],
  ["リモートの比較先は通常のファイルではありません。","Remote comparison target is not a regular file"],
  ["比較するローカルの同期元が変わりました。","Local comparison source changed"],
  ["比較中にローカルの同期元が変わりました。","Local source changed during comparison"],
  ["リモート検証情報のメモリー上限に達したため、削除を拒否しました。","Remote mirror authority memory limit reached; deletion refused"],
  ["リモートのミラー対象一覧を開けないため、削除を拒否しました。","Remote mirror inventory open failed; deletion refused"],
  ["リモートのミラー対象一覧の取得回数上限に達したため、削除を拒否しました。","Remote mirror listing budget exceeded; deletion refused"],
  ["リモートのミラー対象が10,000件を超えたため、削除を拒否しました。","Remote mirror inventory exceeds 10,000 entries; deletion refused"],
  ["リモートのミラー対象名が重複しているか大文字小文字が曖昧なため、削除を拒否しました。","Duplicate or case-ambiguous remote mirror entry; deletion refused"],
  ["リモートのミラー対象が64階層を超えたため、削除を拒否しました。","Remote mirror directory depth exceeds 64; deletion refused"],
  ["リモートのミラー対象一覧を読み取れないため、削除を拒否しました。","Remote mirror inventory read failed; deletion refused"],
  ["リモートのミラー対象一覧を閉じられないため、削除を拒否しました。","Remote mirror inventory close failed; deletion refused"],
  ["一覧取得中にリモートフォルダーが変わったため、削除を拒否しました。","Remote mirror directory changed during inventory; deletion refused"],
  ["リモートフォルダーを照会できません。","Remote directory lookup failed"],
  ["アップロード後にローカルの同期元が変わりました。","Local source changed after upload"],
  ["ローカルの同期元の更新日時を取得できません。","Local source mtime unavailable"],
  ["アップロード後にリモートの更新日時が変わったため、削除用の検証情報を記録しませんでした。","Remote timestamp changed after upload; deletion ownership was not recorded"],
  ["確認後にリモートファイルの親フォルダーが変わったため、削除を拒否しました。","Remote file parent changed since verification; deletion refused"],
  ["確認後にリモートファイルが変わったため、削除を拒否しました。","Remote file changed since verification; deletion refused"],
  ["確認中にリモートファイルの親フォルダーが変わったため、削除を拒否しました。","Remote file parent changed during verification; deletion refused"],
  ["同期元の更新日時は SFTPv3 で扱えないため、アップロードを確定しませんでした。","Local source timestamp unsupported by SFTPv3; upload was not committed"],
  ["更新日時を SFTP サーバーへ保存できません。一時ファイルは確定していません。","SFTP source timestamp preservation failed; staging was not committed"],
  ["更新日時の保存を SFTP サーバーが拒否しました。一時ファイルは確定していません。","SFTP source timestamp preservation refused; staging was not committed"],
  ["SFTP 一時ファイルの更新日時を検証できません。一時ファイルは確定していません。","SFTP staging timestamp verification failed; staging was not committed"],
  ["SFTP 一時ファイルの更新日時またはサイズが保存されていないため、確定しませんでした。","SFTP staging timestamp or size was not preserved; staging was not committed"],
  ["ミラー対象を確認しました。同期対象内でローカルにないファイルと空フォルダーだけを削除します。","Mirror inventory verified; only in-scope source-absent files and empty directories may be deleted"],
  ["サイズと秒単位の UTC 更新日時で比較します。メタデータの一致は内容の一致を保証しません。","Comparison uses size and whole-second UTC mtime; equal metadata does not prove equal content"],
  // Retained stopped-sync records and native validation.
  ["保存した同期のIDが重複しています。","Duplicate retained sync ID"],
  ["保存した同期の一覧が無効です。","Invalid retained sync collection"],
  ["保存した同期の除外ルールが無効です。","Invalid retained sync exclusion rules"],
  ["保存した同期のデータ形式が無効です。","Invalid retained sync object"],
  ["保存した同期のオプションまたは未反映状態が無効です。","Invalid retained sync options or pending state"],
  ["保存した同期の接続情報が無効です。","Invalid retained sync profile"],
  ["保存した同期の接続情報に無効な項目があります。","Invalid retained sync profile field"],
  ["この接続先を削除する前に、関連する保存済みの同期を削除してください。","Remove retained sync entries before deleting this connection profile"],
  ["保存した同期の項目には通常のデータを指定してください。","Retained sync fields must be ordinary data"],
  ["保存した同期が見つかりません。","Retained sync not found"],
  ["保存した同期のパスが4096バイトを超えています。","Retained sync paths exceed 4096 bytes"],
  ["保存できる同期は最大100件です。","Retained syncs are limited to 100 records"],
  ["保存した同期の項目を削除する前に、関連する同期を停止してください。","Stop the linked sync before removing its retained entry"],
  ["この保存済みの同期はすでに実行中です。","This retained sync already has an active job"],
  ["保存した同期に不明な項目があるか、必要な項目が不足しています。","Unknown or missing retained sync field"],
  ["停止済みの同期登録は最大100件です。","At most 100 stopped sync registrations"],
  ["停止済みの同期登録IDが無効か、重複しています。","Invalid or duplicate stopped sync registration ID"],
  ["停止済みの同期に保存された接続情報が無効です。","Invalid stopped sync profile snapshot"],
  ["停止済みの同期の接続識別情報が無効です。","Invalid stopped sync identity"],
  ["停止済みの同期の除外ルールにNUL文字が含まれています。","Stopped sync exclusion rules contain NUL"],
  // Automatic explorer refresh: fixed native notices and lifecycle errors.
  ["ローカルフォルダーの監視は最大16件です。","At most 16 local directory watches are allowed"],
  ["ローカルフォルダーの監視IDが無効です。","Invalid local watch ID"],
  ["ローカルフォルダーの監視パスが無効です。","Invalid local watch path"],
  ["ローカルフォルダーの監視トークンが無効です。","Invalid local watch token"],
  ["ローカルフォルダーの監視が見つかりません。","Local directory watch not found"],
  ["ローカルフォルダーの監視を初期化できません。","Local directory watcher could not be initialized"],
  ["ローカルフォルダーを監視できません。","Local directory watcher could not watch the folder"],
  ["ローカルフォルダーの親フォルダーを監視できません。","Local directory watcher could not watch the parent folder"],
  ["ローカルフォルダーの監視に失敗しました。一覧を更新して監視を開始し直してください。","Local directory watcher failed; refresh and watch the folder again"],
  ["ローカルフォルダーの変更通知が失われました。一覧を更新して監視を開始し直してください。","Local directory watcher lost events; refresh and watch the folder again"],
  ["ローカルフォルダーの変更通知数が上限に達しました。監視を開始し直してください。","Local directory watcher revision limit reached; watch the folder again"],
  ["再解析ポイントのローカルフォルダーは監視できません。","Local directory watching refuses reparse points"],
  ["ローカルフォルダーの監視には、ローカルドライブの絶対パスを指定してください。","Local directory watching requires an absolute local drive path"],
  ["ローカルフォルダーの監視には、上位参照を含まない絶対パスを指定してください。","Local directory watching requires an absolute path without traversal"],
  ["ローカルフォルダーの監視には、利用可能なローカルドライブが必要です。","Local directory watching requires an available local drive"],
  ["監視するローカルフォルダーのパスを解決できません。","Local watch directory cannot be resolved"],
  ["監視するローカルフォルダーを利用できません。","Local watch directory is unavailable"],
  ["監視先のパスが通常のローカルフォルダーではありません。","Local watch path is not an ordinary directory"],
  ["監視トークンは別のローカルフォルダーで使用されています。","Local watch token already belongs to another directory"],
  ["ローカルフォルダーの変更通知を安全に読み書きできません。","Local watcher notice lock failed"],
  ["ローカルフォルダーの監視情報を安全に読み書きできません。","Local watcher registry lock failed"],
  ["ローカルフォルダーの監視トークンが古くなっています。","Stale local watch token"],
  ["監視中のローカルフォルダーが移動または削除されました。フォルダーを選択し直してください。","The watched local folder moved or was removed; select the folder again"],
  ["ローカルフォルダーの監視処理に失敗しました。","Local watch worker failed"],
  ["リモート一覧の更新履歴が上限に達しました。同期を停止して開始し直してください。","Remote refresh journal exhausted; stop and restart sync"],
  // Verified directory synchronization and nonrecursive removal.
  ["削除中に元のローカルルートと親フォルダーを保護できないため、削除を中止しました。","Cannot hold original local root/parents during removal; deletion refused"],
  ["この同期でアップロードしたファイルを削除しました","Deleted previously uploaded file"],
  ["空であることを確認したフォルダーを削除しました","Deleted verified empty directory"],
  ["接続の再確立後、または確認未完了のため、フォルダーを削除できません。ローカルのフォルダーを復元するか、同期を停止して開始し直してください。","Directory deletion authority unavailable after reconnect or incomplete verification; restore local directory or stop and restart"],
  ["フォルダーがローカルの同期ルート外にあります。","Directory outside local root"],
  ["フォルダー追跡数の上限に達しました。同期を停止して開始し直してください。","Directory tracking limit reached; stop and restart"],
  ["ローカルフォルダーの種類が変わったか、再解析ポイントです。","Local directory changed type or is a reparse point"],
  ["ローカルフォルダーの階層が上限の64を超えています。","Local directory depth exceeds 64"],
  ["確認中にローカルフォルダーが見つからなくなりました。","Local directory disappeared during verification"],
  ["ローカルフォルダー内の項目のメタデータを取得できません。","Local directory entry metadata failed"],
  ["ローカルフォルダー内の項目を読み取れません。","Local directory entry read failed"],
  ["ローカルフォルダーにアクセスできません。","Local directory inaccessible"],
  ["ローカルフォルダーのメタデータを取得できません。","Local directory metadata unavailable"],
  ["リモート側の削除前にローカルフォルダーが再作成されたため、削除を中止しました。","Local directory recreated before remote removal; deletion refused"],
  ["ローカルフォルダーの状態を確認できないため、削除を中止しました。","Local directory state uncertain; deletion refused"],
  ["ローカルの親フォルダーの種類が変わったか、再解析ポイントです。","Local parent changed type or is a reparse point"],
  ["ローカルの親フォルダーを開いたハンドルからメタデータを取得できません。","Local parent handle metadata unavailable"],
  ["削除確認中にローカルのルートまたは親フォルダーが変わったため、削除を中止しました。","Local root or ancestor changed during absence check; deletion refused"],
  ["リモートフォルダーの正規パスを取得できません。","Remote canonical directory lookup failed"],
  ["リモートフォルダーを読み取れないため、削除を中止しました。","Remote directory cannot be read; deletion refused"],
  ["リモートフォルダーの正規パスが変わったため、削除を中止しました。","Remote directory canonical path changed; deletion refused"],
  ["空であることの確認中にリモートフォルダーが変わったため、削除を中止しました。","Remote directory changed during empty check; deletion refused"],
  ["リモートフォルダーのクローズに失敗しました。","Remote directory close failed"],
  ["リモートフォルダーのクローズに失敗したため、削除を中止しました。","Remote directory close failed; deletion refused"],
  ["リモートフォルダーに管理対象外・除外対象・処理待ちの項目があるため、空のフォルダーとして削除できません。","Remote directory contains unowned, excluded, or pending entries; nonrecursive removal refused"],
  ["リモートフォルダーが空であることを確認できません。","Remote directory emptiness could not be verified"],
  ["確認済みのリモートフォルダーの情報が変わったため、削除を中止しました。","Remote directory guard changed since authorization; deletion refused"],
  ["リモートフォルダーの確認情報を取得できないため、削除を中止しました。","Remote directory guard lookup failed; deletion refused"],
  ["リモートフォルダーのアクセス権を取得できません。","Remote directory permissions unavailable"],
  ["リモートフォルダーの読み取りに失敗したため、削除を中止しました。","Remote directory read failed; deletion refused"],
  ["リモートフォルダーの削除に失敗したか、結果を確認できません。対応するローカルフォルダーを確認できるまで、削除を保留します。","Remote directory removal failed or outcome is uncertain; authority suspended until a verified local counterpart exists"],
  ["リモートフォルダーまたは親フォルダーの種類が変わったか、シンボリックリンクであるため、削除を中止しました。","Remote directory/ancestor changed type or is a symlink; deletion refused"],
  ["追跡中のローカルフォルダーの種類が変わったため、削除を中止しました。","Tracked local directory changed type; deletion refused"],
  ["パスフレーズまたは鍵ファイルを確認してください", "Check the passphrase or key file"],
  ["区切り文字・相対参照・制御文字を含まない、1～255文字の名前を指定してください。","Use a single name of 1 to 255 characters without separators, traversal or control characters"],
  ["Windowsの予約名、代替データストリーム、使用できない文字、末尾のドットや空白は使えません。","Windows reserved names, alternate streams, special characters and trailing dots/spaces are refused"],
  ["作成先には通常のローカルドライブの絶対パスを指定してください。","Creation requires an ordinary absolute local drive folder"],
  ["ネットワークドライブでの新規作成には対応していません。","Creation on network drives is unsupported"],
  ["作成先のドライブを利用できません。","Creation parent drive is unavailable"],
  ["作成する項目の名前を1つ指定してください。","Creation target needs one filename"],
  ["作成先の親フォルダーが必要です。","Creation target needs a parent"],
  ["選択した親フォルダーの直下に作成してください。","Creation target must be one immediate child of the selected parent"],
  ["この親フォルダーには作成できません。","Unsupported creation parent"],
  ["この作成先には対応していません。","Unsupported creation target"],
  ["ファイルを新規作成できませんでした。既存の項目は上書きしていません。","New file creation failed; no existing item was overwritten"],
  ["作成したファイルの書き込み確定に失敗しました。既に作成済みの可能性があるため、再試行前に一覧を更新してください。","New file may already exist; creation flush failed. Refresh before retrying"],
  ["フォルダーを新規作成できませんでした。既存の項目は上書きしていません。","New folder creation failed; no existing item was overwritten"],
  ["この新規作成操作には対応していません。","Unsupported creation action"],
  ["項目を1つ作成しました。親フォルダーの一覧を更新してください。","Created one new entry; refresh its parent folder."],
  ["新規作成には専用の検証処理が必要です。","Creation requires its dedicated validation path"],
  ["検証中に作成先が変更されました。","Creation target changed during validation"],
  ["リモートファイルの新規作成に失敗したか、結果を確認できません。上書きや自動再試行はしていません。再試行前に一覧を更新してください。","Remote new file creation failed or result is uncertain; no overwrite or automatic retry was attempted. Refresh before retrying"],
  ["リモートファイルの作成終了を確認できません。既に作成済みの可能性があるため、再試行前に一覧を更新してください。","Remote new file may already exist; close acknowledgement failed. Refresh before retrying"],
  ["リモートフォルダーの新規作成に失敗したか、結果を確認できません。親階層の一括作成や自動再試行はしていません。再試行前に一覧を更新してください。","Remote new folder creation failed or result is uncertain; no recursive creation or automatic retry was attempted. Refresh before retrying"],
  ["リモート項目の作成結果を確認できません。既に作成済みの可能性があるため、再試行前に一覧を更新してください。","Remote entry may already exist; creation verification failed. Refresh before retrying"],
  ["リモート項目の種類または空のサイズを確認できません。既に作成済みの可能性があるため、再試行前に一覧を更新してください。","Remote entry may already exist but its type or empty size could not be verified. Refresh before retrying"],
  ["同じローカルパスに対する操作が進行中です。","An overlapping local operation is in progress"],
  ["ZIPの一時出力先が同期ルートと重なります。この場所でZIPを作成する前に同期を停止してください。","Archive staging overlaps a sync root; stop sync before creating archives here"],
  [
    "ブックマークの接続識別情報が無効です。",
    "Invalid bookmark connection identity",
  ],
  [
    "ブックマークツリーのバージョンまたは件数が無効です。",
    "Bookmark tree version/count invalid",
  ],
  ["無効または重複したブックマークがあります。", "Invalid/duplicate bookmarks"],
  [
    "ブックマークノードのIDが無効または重複しています。",
    "Invalid/duplicate bookmark node ID",
  ],
  ["ブックマークフォルダーが無効です。", "Invalid bookmark group"],
  [
    "ブックマークの参照または接続範囲が無効です。",
    "Invalid bookmark reference/connection scope",
  ],
  [
    "ブックマークツリーが循環しているか、深さが8を超えています。",
    "Bookmark tree cycle or depth exceeds 8",
  ],
  [
    "ブックマークの親は同じ接続に属するフォルダーである必要があります。",
    "Bookmark parent must be a group on the same connection",
  ],
  ["ツリーにブックマークがありません。", "Bookmark missing from tree"],
  [
    "ブックマークツリーのノード数が700を超えています。",
    "Bookmark tree exceeds 700 nodes",
  ],
  ["閲覧先の接続キーが無効です。", "Invalid browse connection key"],
  [
    "閲覧先の接続識別情報が正規形式ではありません。",
    "Browse connection identity must be canonical",
  ],
  ["正常に閲覧できたパスが必要です。", "A successful browse path is required"],
  [
    "閲覧先の接続識別情報が500件を超えています。",
    "Browse locations exceed 500 connection identities",
  ],
  ["セッションの閲覧をキャンセルしました。", "Session browsing cancelled"],
  ["閲覧用接続のロックに失敗しました。", "Browsing transport lock failed"],
  [
    "セッションの閲覧用接続はすでに登録されています。",
    "Session browsing transport already installed",
  ],
  [
    "接続ツリーのバージョンまたは件数が無効です。",
    "Connection tree version/count invalid",
  ],
  [
    "接続ツリーのプロファイルIDが無効または重複しています。",
    "Invalid/duplicate profile ID in connection tree",
  ],
  [
    "接続ノードのIDが無効または重複しています。",
    "Invalid/duplicate connection node ID",
  ],
  ["接続フォルダーが無効です。", "Invalid connection group"],
  [
    "接続プロファイルの参照が無効または重複しています。",
    "Invalid/duplicate connection profile reference",
  ],
  [
    "接続ツリーが循環しているか、深さが8を超えています。",
    "Connection tree cycle or depth exceeds 8",
  ],
  [
    "接続の親はフォルダーを参照する必要があります。",
    "Connection parent must reference a group",
  ],
  [
    "ツリーに接続プロファイルがありません。",
    "Connection profile missing from tree",
  ],
  [
    "接続ツリーのノード数が400を超えています。",
    "Connection tree exceeds 400 nodes",
  ],
  [
    "Windowsのドライブ一覧を取得できませんでした。",
    "Windows could not list logical drives",
  ],
  [
    "ドライブ一覧の取得はWindowsで利用できます。",
    "Logical drive listing is available on Windows",
  ],
  [
    "ローカルルートを利用できないため、ファイル削除と判断しません。",
    "Local root unavailable; refusing to infer file deletion",
  ],
  [
    "ローカルルートの同一性を確認できないため、削除を拒否しました。",
    "Cannot verify local root identity; deletion refused",
  ],
  [
    "ローカルルートが通常のディレクトリではないため、削除を拒否しました。",
    "Local root is not a regular directory; deletion refused",
  ],
  ["ローカルルートを利用できません。", "Local root unavailable"],
  ["ローカルルートが無効です。", "Invalid local root"],
  ["操作を停止しました。", "Operation stopped"],
  ["ローカルの転送パスが無効です。", "Invalid local transfer path"],
  [
    "ローカルルートの同一性が変わりました。停止して新しい同期を開始してください。",
    "Local root identity changed; stop and start a new sync",
  ],
  [
    "ローカルの親の種類が変わったか、再解析ポイントになったため、削除を拒否しました。",
    "Local parent changed type or is a reparse point; deletion refused",
  ],
  [
    "ローカルの親にアクセスできないため、削除を拒否しました。",
    "Local parent inaccessible; deletion refused",
  ],
  [
    "ローカルパスが再解析ポイントのため、転送を拒否しました。",
    "Local path is a reparse point; transfer refused",
  ],
  [
    "ローカルディレクトリにアクセスできないため、削除を拒否しました。",
    "Local directory inaccessible; deletion refused",
  ],
  [
    "ローカルディレクトリの読み取りに失敗したため、削除を拒否しました。",
    "Local directory read failed; deletion refused",
  ],
  [
    "ローカルファイルの状態が不明なため、削除を拒否しました。",
    "Local file state uncertain; deletion refused",
  ],
  [
    "ローカルファイルにアクセスできないため、削除を拒否しました。",
    "Local file inaccessible; deletion refused",
  ],
  [
    "キューの上限に達しました。停止して再開し、再スキャンしてください。",
    "Queue limit reached. Stop and restart to rescan.",
  ],
  [
    "ローカルディレクトリの読み取りに失敗しました。",
    "Local directory read failed",
  ],
  ["ローカル項目の取得に失敗しました。", "Local entry failed"],
  ["ローカルメタデータの取得に失敗しました。", "Local metadata failed"],
  ["監視対象のパスがルートの外にあります。", "Watcher path outside root"],
  [
    "ローカルディレクトリの深さが64を超えています。停止して浅い階層をルートにするか、深いディレクトリを除外して再開してください。",
    "Local directory depth exceeds 64; stop and restart with a shallower root or exclude the deep directory",
  ],
  [
    "削除を無効にしました。アップロード済みファイルの追跡上限に達しました。停止して新しい同期を開始してください。このジョブでは以後リモート削除を行いません。",
    "Deletion disabled: uploaded-file tracking limit reached. Stop and start a new sync; no further remote deletions will be attempted by this job",
  ],
  [
    "同期状態を確認できないため終了できません。",
    "Cannot close because the sync state could not be verified.",
  ],
  [
    "接続状態を確認できないため終了できません。",
    "Cannot close because the connection state could not be verified.",
  ],
  [
    "同期・接続・停止処理が残っているため終了できません。すべてのタブの同期を停止し、停止完了後にもう一度ウィンドウを閉じてください。",
    "Cannot close while sync, connection, or stopping operations remain. Stop sync in every tab, wait for it to finish, then close the window again.",
  ],
  [
    "終了処理中です。しばらくお待ちください。",
    "The application is closing. Please wait.",
  ],
  ["予約状態のロックに失敗しました。", "Reservation lock failed"],
  ["アプリケーションは終了処理中です。", "Application is closing"],
  ["開始処理のロックに失敗しました。", "Start lock failed"],
  ["開始処理が準備されていません。", "Start not prepared"],
  ["開始処理はすでに実行中です。", "Start already running"],
  [
    "変更カウンターの上限に達しました。同期を開始する前にアプリを再起動してください。",
    "Mutation counter exhausted; restart application before starting sync",
  ],
  [
    "同期準備中にファイル操作で予約状態が変わりました。両方のルートを更新して同期をやり直してください。",
    "A file operation changed reservations during sync setup. Refresh both roots and start sync again",
  ],
  ["ジョブIDが無効です。", "Invalid job id"],
  ["ジョブのロックに失敗しました。", "Job lock failed"],
  ["ジョブIDが重複しています。", "Duplicate job id"],
  ["開始IDが重複しています。", "Duplicate start id"],
  ["ジョブは最大16件です。", "At most 16 jobs"],
  [
    "アプリが終了処理中か、ジョブがすでに登録されています。",
    "Application closing or job already registered",
  ],
  ["ローカルフォルダーが見つかりません。", "Local folder not found"],
  ["ローカルルートがフォルダーではありません。", "Local root is not a folder"],
  ["サーバーの接続先を解決できません。", "Cannot resolve server endpoint"],
  [
    "開始をキャンセルしたか、アプリが終了処理中です。",
    "Start cancelled or application closing",
  ],
  [
    "タブは最大16個です。先に停止済みのタブを閉じてください。",
    "At most 16 tabs; close a stopped tab first",
  ],
  ["操作のロックに失敗しました。", "Operation lock failed"],
  [
    "重なる範囲でファイル操作を実行中です。完了を待ってから同期を開始してください。",
    "An overlapping file operation is in progress; wait for it before starting sync",
  ],
  ["状態のロックに失敗しました。", "Status lock failed"],
  [
    "重なるリモート転送先がすでに予約されています（失敗したジョブを含む）。",
    "Overlapping remote destination is already reserved (including failed jobs)",
  ],
  ["ジョブが見つかりません。", "Job not found"],
  [
    "このエラーから復旧するには、停止して新しい同期を開始し、全体を再スキャンする必要があります。",
    "This failure requires stopping and starting a new sync for a full rescan",
  ],
  [
    "同期はすでに停止処理中です。完了までお待ちください。",
    "Sync is already stopping; wait until it finishes",
  ],
  ["同期ワーカーが異常終了しました。", "Sync worker panicked"],
  ["操作IDが無効です。", "Invalid operation id"],
  ["アプリは終了処理中です。", "Application closing"],
  [
    "操作IDが重複しているか、操作がすでに取得されています。",
    "Duplicate operation id or operation already claimed",
  ],
  [
    "アプリが終了処理中、操作が重複、または同時操作数が上限の8件に達しています。",
    "Application closing, duplicate operation, or at most eight concurrent operations",
  ],
  [
    "操作が未準備か終了済みのため、キャンセルは登録されませんでした。",
    "Operation is not prepared or has already finished; cancellation was not registered",
  ],
  ["操作の予約はすでに解除されています。", "Operation no longer reserved"],
  [
    "ローカルルートまたはその親を移動・削除する前に同期を停止してください。",
    "Stop sync before moving or deleting its local root or ancestor",
  ],
  [
    "このリモートパスを変更する前に、範囲が重なる同期ジョブを停止してください（失敗・停止処理中のジョブを含む）。",
    "Stop the overlapping sync job before changing this remote path (including failed/stopping jobs)",
  ],
  [
    "重なる範囲でファイル操作を実行中です。",
    "An overlapping file operation is in progress",
  ],
  [
    "変更カウンターの上限に達しました。ファイルを変更する前にアプリを再起動してください。",
    "Mutation counter exhausted; restart application before changing files",
  ],
  [
    "ファイル監視の初期化に失敗しました。停止して再開してください。",
    "File watcher initialization failed; stop and restart",
  ],
  [
    "監視エラーが発生しました。停止して再開し、全体を再スキャンしてください。",
    "Watcher error: stop and restart for a full rescan",
  ],
  [
    "ローカルの監視パスにアクセスできません。停止して再開し、全体を再スキャンしてください。",
    "Local watcher path inaccessible; stop and restart for a full rescan",
  ],
  [
    "このファイルはこの同期ジョブでアップロードされていません。",
    "File was not uploaded by this sync job",
  ],
  [
    "除外ルールは64 KiB以下で、NUL文字を含められません。",
    "Exclusion rules must be at most 64 KiB and contain no NUL characters",
  ],
  [
    "除外ルールは最大2048行、1行4096バイトまでです。",
    "Exclusion rules allow at most 2048 lines and 4096 bytes per line",
  ],
  [
    "除外対象のパスは同期ルートに対する相対パスである必要があります。",
    "Exclusion candidate must stay relative to its sync root",
  ],
  ["不明な列幅フィールドです。", "Unknown column width field"],
  [
    "エクスプローラーの接続識別情報が無効です。",
    "Invalid explorer connection identity",
  ],
  [
    "エクスプローラーのフォルダーペアが無効です。",
    "Invalid explorer folder pair",
  ],
  ["エクスプローラーの識別情報が無効です。", "Invalid explorer identity"],
  [
    "列設定が無効です。名前列は必須で、幅は40〜1200である必要があります。",
    "Invalid explorer columns; name is required and widths must be 40 to 1200",
  ],
  [
    "ブックマークが500件、または履歴が200件を超えています。",
    "Explorer bookmarks exceed 500 or history exceeds 200 entries",
  ],
  [
    "無効または重複したエクスプローラーブックマークがあります。",
    "Invalid or duplicate explorer bookmark",
  ],
  [
    "無効または重複したエクスプローラー履歴があります。",
    "Invalid or duplicate explorer history",
  ],
  [
    "ローカルで使用できない並べ替え列です。",
    "Local sorting column is unsupported",
  ],
  [
    "削除の明示的な確認が必要です。",
    "Explicit delete confirmation is required",
  ],
  [
    "最終的な転送先の完全なパスが必要です。",
    "A full final destination path is required",
  ],
  [
    "ファイルシステムのルートに対する操作は拒否しました。",
    "Filesystem root operations are refused",
  ],
  [
    "コピー・移動先を元の場所やその配下にはできません。",
    "Cannot copy/move to the source or its descendant",
  ],
  [
    "リモート操作にはプロファイルが必要です。",
    "Remote operation requires a profile",
  ],
  ["リモートの接続先を解決できません。", "Cannot resolve remote endpoint"],
  [
    "操作をキャンセルしました。発行済みの名前変更・ごみ箱移動・削除は完了している場合があります。コピーや削除が一部だけ実行されている可能性があるため、更新してから再試行してください。",
    "Operation cancelled. A previously issued rename/recycle/delete may have completed; partial copies or deletions may remain. Refresh before retrying.",
  ],
  ["上位階層へのパス移動は拒否しました。", "Path traversal is refused"],
  [
    "リモートファイルシステムのルートに対する操作は拒否しました。",
    "Remote filesystem root operations are refused",
  ],
  [
    "転送先は元の場所と異なり、その配下ではない必要があります。",
    "Destination must differ from source and cannot be inside it",
  ],
  [
    "上位階層への移動を含まないローカルの絶対パスを指定してください。",
    "Use an absolute local path without traversal",
  ],
  [
    "通常のローカルドライブのパスだけを使用できます。ネットワーク・デバイスパスや代替データストリームは拒否しました。",
    "Only ordinary local drive paths are supported; network/device paths and alternate streams are refused",
  ],
  [
    "曖昧な名前またはWindowsの予約ファイル名は拒否しました。",
    "Ambiguous or reserved Windows filename refused",
  ],
  [
    "転送先がすでに存在します。上書きはできません。",
    "Destination already exists; overwrite is unsupported",
  ],
  ["転送先のメタデータを取得できません。", "Destination metadata unavailable"],
  ["ローカルパスを利用できません。", "Local path unavailable"],
  [
    "シンボリックリンクと再解析ポイントは拒否しました。",
    "Symlinks and reparse points are refused",
  ],
  [
    "ローカルの親がディレクトリではありません。",
    "Local parent is not a directory",
  ],
  ["ローカルパスの正規化ができません。", "Local canonical path unavailable"],
  ["転送先には親が必要です。", "Destination needs a parent"],
  ["転送先の親を利用できません。", "Destination parent unavailable"],
  ["転送先には名前が必要です。", "Destination needs a name"],
  [
    "ローカルの親が置き換わらないようロックできないため、操作を拒否しました。",
    "Cannot lock local parent against replacement; operation refused",
  ],
  [
    "ディレクトリハンドルのメタデータを取得できません。",
    "Directory handle metadata unavailable",
  ],
  [
    "ローカルの親が再解析ポイントまたは未対応の項目に変わりました。",
    "Local parent changed to a reparse point or unsupported entry",
  ],
  [
    "コピー元を利用できないか変更中です。一部の転送先は保持されています。",
    "Copy source unavailable or changing; partial target retained",
  ],
  [
    "コピー元ハンドルのメタデータを取得できません。",
    "Copy source handle metadata unavailable",
  ],
  [
    "コピー元が再解析ポイントまたは未対応の項目です。一部の転送先は保持されています。",
    "Copy source is a reparse point or unsupported entry; partial target retained",
  ],
  [
    "操作対象のツリーが10,000項目または深さ64を超えています。",
    "Operation tree exceeds 10,000 entries or depth 64",
  ],
  ["操作元のメタデータを取得できません。", "Source metadata unavailable"],
  [
    "操作元のツリーに未対応の項目、シンボリックリンク、または再解析ポイントがあります。変更は行っていません。",
    "Source tree contains an unsupported entry, symlink or reparse point; nothing was changed",
  ],
  ["操作元のディレクトリを利用できません。", "Source directory unavailable"],
  [
    "操作対象のツリーが10,000項目を超えています。",
    "Operation tree exceeds 10,000 entries",
  ],
  ["操作元の項目を利用できません。", "Source entry unavailable"],
  ["未対応のパスです。", "Unsupported path"],
  ["移動先が必要です。", "Move requires destination"],
  ["コピー先が必要です。", "Copy requires destination"],
  ["操作元のパスは未対応です。", "Unsupported source path"],
  ["操作元がツリーの外に出ました。", "Source escaped tree"],
  ["転送先のパスは未対応です。", "Unsupported target path"],
  [
    "コピー先のディレクトリ作成に失敗しました。一部の転送先は保持されています。",
    "Copy directory creation failed; partial target retained",
  ],
  [
    "コピー元のメタデータを取得できません。",
    "Copy source metadata unavailable",
  ],
  [
    "コピー先の作成に失敗しました。既存項目は上書きしていません。一部の転送先は保持されています。",
    "Copy target creation failed; no existing item overwritten; partial target retained",
  ],
  [
    "コピーの読み取りに失敗しました。一部の転送先は保持されています。",
    "Copy read failed; partial target retained",
  ],
  [
    "コピーの書き込みに失敗しました。一部の転送先は保持されています。",
    "Copy write failed; partial target retained",
  ],
  [
    "コピーの書き込み確定に失敗しました。一部の転送先は保持されています。",
    "Copy flush failed; partial target retained",
  ],
  [
    "操作元が変わりました。一部の転送先は保持されています。",
    "Source changed; partial target retained",
  ],
  [
    "コピー中に操作元が変わりました。一部の転送先は保持され、操作元は削除していません。",
    "Source changed during copy; partial target retained; source was not removed",
  ],
  [
    "移動を拒否しました（転送先の重複、別ボリューム、または権限）。上書きや削除してからコピーする代替処理は行っていません。更新してから再試行してください。",
    "Move refused (destination collision, cross-volume or permissions). No overwrite or delete-before-copy fallback was attempted; refresh before retrying",
  ],
  [
    "上書きしないアトミックな移動はWindowsのみ対応しています。操作元は保持されています。",
    "Atomic no-replace move is only implemented on Windows; source retained",
  ],
  [
    "ごみ箱のCOM初期化に失敗しました。操作元は保持されています。",
    "Recycle COM initialization failed; source retained",
  ],
  [
    "ごみ箱へ移す操作元を利用できません。操作元は保持されています。",
    "Recycle source unavailable; source retained",
  ],
  [
    "ごみ箱へ移す操作元の親を利用できません。操作元は保持されています。",
    "Recycle parent unavailable; source retained",
  ],
  [
    "この場所は安全なごみ箱移動に対応していません。操作元は保持されています。",
    "This location does not support safe recycling; source retained",
  ],
  [
    "ごみ箱を利用できません。操作元は保持されています。",
    "Recycle Bin unavailable; source retained",
  ],
  [
    "Windowsでこの項目をごみ箱へ移せませんでした。完全削除への代替処理は行っていません。更新して操作元を確認してください。",
    "Windows could not recycle this item. No permanent-delete fallback was attempted; refresh to verify the source",
  ],
  [
    "ごみ箱だけを使う削除はWindowsのみ対応しています。操作元は保持されています。",
    "Recycle-only deletion is supported on Windows only; source retained",
  ],
  [
    "接続先のホスト鍵ピンが重複するか、上限を超えています。",
    "Duplicate or excess endpoint pins",
  ],
  [
    "ホスト鍵台帳のバージョンまたは件数が無効です。",
    "Host pin ledger version/count invalid",
  ],
  ["ホスト鍵台帳の接続先が無効です。", "Host pin ledger endpoint invalid"],
  [
    "ホスト鍵台帳が正規形式ではありません。",
    "Host pin ledger is not canonical",
  ],
  [
    "既知の接続先のホスト鍵が異なります。初回承認で既存のピンを更新することはできません。",
    "Known endpoint host key differs; initial approval cannot rotate an existing pin",
  ],
  [
    "ホスト鍵台帳がいっぱいです。記憶した信頼情報は自動削除しません。",
    "Host pin ledger is full; remembered trust is never pruned automatically",
  ],
  [
    "既知の接続先のピンは消去できません。ホスト鍵の更新には別の信頼確認が必要です。",
    "A known endpoint pin cannot be cleared; host key rotation requires a separate trust decision",
  ],
  [
    "保存プロファイルと記憶した接続先のピンが一致しません。",
    "Saved profile conflicts with its remembered endpoint pin",
  ],
  [
    "ホスト鍵を確認するには、有効なホストとポートが必要です。",
    "A valid host and port are required for host-key verification",
  ],
  ["サーバーの接続先を識別できません。", "Cannot identify server endpoint"],
  ["ホスト鍵の要求IDが無効です。", "Invalid host-key request id"],
  ["ホスト鍵の確認対象を固定できません。", "Cannot snapshot host-key target"],
  [
    "ホスト鍵の対象プロファイルが大きすぎます。",
    "Host-key target profile is too large",
  ],
  [
    "ピン留めしたサーバーには厳密な検証が必要です。初回承認で保存済みの鍵を置き換えることはできません。",
    "A pinned server must use strict verification; initial approval cannot replace a saved key",
  ],
  [
    "ホスト鍵の承認はSFTPの鍵認証プロファイルで利用できます。",
    "Host-key approval is available for SFTP key profiles",
  ],
  ["ホスト鍵の状態を取得できません。", "Host-key state unavailable"],
  [
    "ホスト鍵確認の上限に達しました。保留中の要求が失効するまでお待ちください。",
    "Host-key verification capacity reached; wait for pending requests to expire",
  ],
  [
    "ホスト鍵の要求はキャンセル済み、使用済み、または開始済みです。新しい要求IDを使用してください。",
    "Host-key request was cancelled, consumed, or already started; use a new request id",
  ],
  [
    "ホスト鍵のキャンセル登録数が上限に達しました。",
    "Host-key cancellation capacity reached",
  ],
  [
    "ホスト鍵の候補が失効またはキャンセルされました。再取得してください。",
    "Host-key candidate expired or was cancelled; probe again",
  ],
  [
    "ホスト鍵の候補がこのプロファイルと一致しないか、キャンセルされました。",
    "Host-key candidate no longer matches this profile or was cancelled",
  ],
  [
    "ホスト鍵の取得で候補がまだ得られていません。",
    "Host-key probe has not produced a candidate",
  ],
  [
    "ホスト鍵の承認トークンが一致しません。",
    "Host-key approval token does not match",
  ],
  [
    "ホスト鍵の確認中です。キャンセルして完了を待ってから閉じてください。",
    "Host-key verification is still running. Cancel it and wait for completion before closing",
  ],
  [
    "サーバーのホスト鍵アルゴリズムは未対応です。",
    "Unsupported server host-key algorithm",
  ],
  [
    "安全なホスト鍵トークンの生成に失敗しました。",
    "Secure host-key token generation failed",
  ],
  [
    "ホスト鍵の取得をキャンセルしたか、アプリが終了処理中です。",
    "Host-key probe cancelled or application closing",
  ],
  ["ホスト鍵の要求が失効しました。", "Host-key request expired"],
  ["ホスト鍵の要求は有効ではありません。", "Host-key request no longer active"],
  [
    "ツリー幅の比率は0.15〜0.65の有限数である必要があります。",
    "Tree ratios must be finite numbers between 0.15 and 0.65",
  ],
  [
    "localPaneRatioは0.20〜0.80の有限数である必要があります。",
    "localPaneRatio must be a finite number between 0.20 and 0.80",
  ],
  [
    "保存した除外ルールが64 KiB、2048行、または1行4096バイトを超えています。",
    "Saved exclusion text exceeds 64 KiB, 2048 lines, or 4096 bytes per line",
  ],
  [
    "保存した同期の組み合わせキーが対応サイズを超えています。",
    "Saved sync combination key exceeds supported size",
  ],
  [
    "同期の組み合わせキーはJSON形式の[profile,remote,local]である必要があります。",
    "Sync combination key must be JSON [profile,remote,local]",
  ],
  [
    "同期の組み合わせキーにはprofile、remote、localが必要です。",
    "Sync combination key must contain profile, remote, and local",
  ],
  [
    "同期の組み合わせは最大500件、プリセットは最大100件です。",
    "At most 500 sync combinations and 100 sync presets",
  ],
  ["同期プリセットの参照が無効です。", "Invalid sync preset reference"],
  [
    "同期プリセットのIDは一意で、名前は1〜100文字である必要があります。",
    "Sync preset IDs must be unique and names must contain 1–100 characters",
  ],
  [
    "保存できる除外設定の組み合わせは最大500件です。",
    "At most 500 saved exclusion combinations",
  ],
  ["設定のロックに失敗しました。", "Settings lock failed"],
  [
    "設定の件数またはバージョンが無効です。",
    "Settings limit or version invalid",
  ],
  ["プロファイルが無効です。", "Invalid profile"],
  [
    "ホスト鍵を確認する前に、この接続プロファイルを保存してください。",
    "Save this connection profile before verifying its host key",
  ],
  [
    "保存した接続が変わりました。この承認を閉じ、現在のプロファイルから接続し直してください。",
    "The saved connection changed; dismiss this approval and reconnect from the current profile",
  ],
  [
    "この接続先には記憶したホスト鍵があります。初回承認では置き換えられません。別の鍵更新手順を使用してください。",
    "This endpoint already has a remembered host key. Initial approval cannot replace it; use a separate rotation procedure",
  ],
  [
    "取得中にこの接続先の鍵がピン留めされました。初回承認は利用できません。",
    "This endpoint was pinned while probing; initial approval is no longer available",
  ],
  ["ホスト鍵取得ワーカーが失敗しました。", "Host key probe worker failed"],
  [
    "読み込み後に設定が変更されました。承認前に再読み込みしてください（リビジョン競合）。",
    "Settings changed since loading; reload before approving (revision conflict)",
  ],
  [
    "この接続先には記憶した鍵があります。初回承認で更新することはできません。",
    "This endpoint already has a remembered key; initial approval cannot rotate it",
  ],
  ["フォルダー選択ダイアログに失敗しました。", "Folder dialog failed"],
  [
    "ローカル一覧のワーカーが処理中です。待ってから再試行してください。",
    "Local listing workers are still busy; wait before retrying",
  ],
  [
    "ローカルドライブの絶対パスを指定してください。ネットワーク共有の一覧表示は未対応です。",
    "Use an absolute local drive path; network share listing is unsupported",
  ],
  [
    "ネットワークドライブの閲覧は未対応です。ネットワークのスキャンは行っていません。",
    "Network drive browsing is unsupported; no network scan was attempted",
  ],
  ["このドライブは利用できません。", "This drive is unavailable"],
  ["ローカルディレクトリを利用できません。", "Local directory unavailable"],
  ["ローカル項目を利用できません。", "Local entry unavailable"],
  ["ローカルメタデータを取得できません。", "Local metadata unavailable"],
  ["フォルダー内の項目が多すぎます。", "Folder contains too many entries"],
  [
    "ローカル一覧の取得がタイムアウトしました。ドライブが切断されているか、利用できない可能性があります。",
    "Local listing timed out; the drive may be disconnected or unavailable",
  ],
  ["ローカル一覧のワーカーが失敗しました。", "Local listing worker failed"],
  [
    "セッション接続のワーカーが失敗しました。",
    "Session connection worker failed",
  ],
  ["リモート一覧のワーカーが失敗しました。", "Remote listing worker failed"],
  ["開始ワーカーが失敗しました。", "Start worker failed"],
  ["ホームフォルダーを利用できません。", "Home folder unavailable"],
  ["鍵ファイル選択ダイアログに失敗しました。", "Key dialog failed"],
  ["状態取得ワーカーが失敗しました。", "Status worker failed"],
  ["再試行ワーカーが失敗しました。", "Retry worker failed"],
  ["停止ワーカーが失敗しました。", "Stop worker failed"],
  ["リモートプロファイルが必要です。", "Remote profile is required"],
  [
    "ファイル操作ワーカーが失敗しました。一部の操作が実行済みの可能性があります。更新してから再試行してください。",
    "File operation worker failed; outcome may be partial; refresh before retrying",
  ],
  [
    "接続処理中のタブがあります。接続をキャンセルし、処理の完了後にもう一度ウィンドウを閉じてください。",
    "A tab is still connecting. Cancel the connection, wait for it to finish, then close the window again.",
  ],
  ["セッションIDが無効です。", "Invalid session id"],
  ["セッションのロックに失敗しました。", "Session lock failed"],
  [
    "セッションはすでに準備済み、接続中、または切断中です。",
    "Session is already prepared, connecting, or disconnecting",
  ],
  ["タブのセッションは最大16件です。", "At most 16 tab sessions"],
  [
    "セッションのパスフレーズが対応サイズを超えています。",
    "Session passphrase exceeds supported size",
  ],
  [
    "アプリが終了処理中か、セッションワーカーが上限に達しています。",
    "Application closing or session worker limit reached",
  ],
  [
    "接続前にセッションを準備してください。",
    "Prepare the session before connecting",
  ],
  ["セッションの接続をキャンセルしました。", "Session connection cancelled"],
  [
    "セッションの接続はすでに実行中です。",
    "Session connection is already running",
  ],
  ["セッションの認証情報を取得できません。", "Session credentials unavailable"],
  ["セッションは切断されています。", "Session is disconnected"],
  [
    "セッションが未接続または切断処理中です。",
    "Session is not connected or is being disconnected",
  ],
  ["セッションが切断されました。", "Session disconnected"],
  [
    "セッションのキャンセル連携数が上限に達しました。",
    "Session cancellation link limit reached",
  ],
  [
    "接続完了前にセッションが切断されました。",
    "Session disconnected before connection completed",
  ],
  ["セッションは切断されました。", "Session was disconnected"],
  ["セッションの世代が変わりました。", "Session generation changed"],
  [
    "SYNCFILES_CONFIG_DIR が空です。書き込み可能な設定フォルダーを指定してください。",
    "SYNCFILES_CONFIG_DIR is empty. Specify a writable settings folder.",
  ],
  [
    "実行中の Nearly.exe の絶対パスを取得できません。設定は読み込み・保存していません。",
    "Cannot obtain the absolute path of the running Nearly.exe. Settings have not been read or saved.",
  ],
  [
    "Nearly.exe の保存フォルダーを取得できません。",
    "Cannot obtain the folder containing Nearly.exe.",
  ],
  [
    "実行中の Nearly.exe の場所を取得できません。設定は読み込み・保存していません。",
    "Cannot locate the running Nearly.exe. Settings have not been read or saved.",
  ],
  [
    "操作を停止しました。発行済みの最終的な名前変更は完了している場合があります。再開して状態を確認してください。",
    "Operation stopped; an already issued final rename may have completed. Restart to reconcile.",
  ],
  [
    "操作を停止しました。一時ファイルが残り、発行済みの最終的な名前変更が完了している場合があります。再開して状態を確認してください。",
    "Operation stopped; staging may remain and an issued final rename may have completed. Restart to reconcile.",
  ],
  [
    "確認済みのSHA256ホスト指紋が必要です。自動で信頼することはありません。",
    "A verified SHA256 host fingerprint is required; automatic trust is disabled",
  ],
  ["SHA256指紋が無効です。", "Invalid SHA256 fingerprint"],
  [
    "SHA256指紋は32バイトである必要があります。",
    "SHA256 fingerprint must contain 32 bytes",
  ],
  [
    "ピン留めしたホスト鍵に初回承認は使用できません。",
    "Pinned host keys cannot enter first-use approval",
  ],
  [
    "ホスト鍵取得のTCP接続がタイムアウトしました。",
    "Host-key probe TCP connection timed out",
  ],
  [
    "ホスト鍵取得のTCP接続に失敗しました。",
    "Host-key probe TCP connection failed",
  ],
  [
    "ホスト鍵取得のソケットを利用できません。",
    "Host-key probe socket unavailable",
  ],
  [
    "ホスト鍵取得のキャンセル用ソケットを利用できません。",
    "Host-key probe cancellation socket unavailable",
  ],
  ["ホスト鍵の取得を停止しました。", "Host-key probe stopped"],
  ["ホスト鍵の取得結果を利用できません。", "Host-key probe result unavailable"],
  [
    "SSHホスト鍵の取得に失敗したか、サーバーが未対応の証明書を返しました。",
    "SSH host-key probe failed or the server supplied an unsupported certificate",
  ],
  ["SSHホスト鍵の取得がタイムアウトしました。", "SSH host-key probe timed out"],
  [
    "サーバーから正規化されたホームパスが1件返されませんでした。",
    "Server did not return one canonical home path",
  ],
  [
    "サーバーから安全でないホームパスが返されました。",
    "Server returned an unsafe canonical home path",
  ],
  [
    "PuTTY PPK v2またはv3の鍵を選択してください。",
    "Select a PuTTY PPK v2 or v3 key",
  ],
  ["PPKファイルが1 MiBを超えています。", "PPK file exceeds 1 MiB"],
  ["鍵デコーダーを利用できません。", "Key decoder unavailable"],
  ["PPK鍵ファイルを読み取れません。", "PPK key file cannot be read"],
  [
    "PPK鍵ファイルが有効なテキストではありません。",
    "PPK key file is not valid text",
  ],
  [
    "PPK検証に失敗しました。パスフレーズ違い、MAC破損、または未対応の鍵です。",
    "PPK verification failed: wrong passphrase, damaged MAC, or unsupported key",
  ],
  ["PPKデコーダーが失敗しました。", "PPK decoder failed"],
  [
    "PPK秘密鍵を使うSFTPプロファイルを使用してください。",
    "Use a PPK private-key SFTP profile",
  ],
  ["TCP接続がタイムアウトしました。", "TCP connection timed out"],
  ["TCP接続に失敗しました。", "TCP connection failed"],
  ["TCPソケットを利用できません。", "TCP socket unavailable"],
  [
    "接続キャンセルの準備ができません。",
    "Cannot prepare connection cancellation",
  ],
  ["SSHハンドシェイクがタイムアウトしました。", "SSH handshake timed out"],
  [
    "SSHハンドシェイクまたはホスト鍵の検証に失敗しました。",
    "SSH handshake or host-key verification failed",
  ],
  [
    "SSH認証方式の交渉に失敗しました。",
    "SSH authentication negotiation failed",
  ],
  ["SSH鍵認証がタイムアウトしました。", "SSH key authentication timed out"],
  ["SSH鍵認証に失敗しました。", "SSH key authentication failed"],
  [
    "サーバーがこのSSH鍵またはユーザー名を拒否しました。",
    "SSH server refused this key or username",
  ],
  ["SFTPチャネルを開けません。", "Cannot open SFTP channel"],
  ["サーバーがSFTPを拒否しました。", "Server refused SFTP"],
  ["SFTPの初期化に失敗しました。", "SFTP initialization failed"],
  ["SFTPの接続準備がタイムアウトしました。", "SFTP connection setup timed out"],
  [
    "リモートルートがディレクトリではありません。",
    "Remote root is not a directory",
  ],
  [
    "リモートパスにシンボリックリンクまたはディレクトリ以外の項目があります。",
    "Remote path contains a symlink or non-directory",
  ],
  [
    "POSIX形式のリモート絶対パスを指定してください。",
    "Use an absolute POSIX remote path",
  ],
  [
    "リモート一覧が20,000項目を超えています。",
    "Remote listing exceeds 20,000 entries",
  ],
  [
    "転送先の確認に失敗しました。変更は行っていません。",
    "Destination lookup failed; no changes attempted",
  ],
  [
    "リモートツリーにシンボリックリンクまたは未対応の項目があるため、操作を拒否しました。",
    "Remote tree contains a symlink or unsupported entry; operation refused",
  ],
  [
    "安全でないリモート項目名のため、変更前に操作を拒否しました。",
    "Unsafe remote entry name; operation refused before mutation",
  ],
  [
    "リモートの名前変更に失敗したか、結果が不明です。削除してからコピーする代替処理は行っていません。更新してから再試行してください。",
    "Remote rename failed or result uncertain; no delete-before-copy fallback was attempted. Refresh before retrying",
  ],
  [
    "リモートの操作元が変わったため、削除を停止しました。それ以前の項目は削除済みの可能性があります。",
    "Remote source changed; deletion stopped. Earlier items may already be deleted",
  ],
  [
    "リモートディレクトリの削除に失敗しました。選択した配下の項目が一部削除済みの可能性があります。",
    "Remote directory deletion failed; some selected descendants may already be deleted",
  ],
  [
    "リモート削除に失敗しました。選択した配下の項目が一部削除済みの可能性があります。",
    "Remote deletion failed; some selected descendants may already be deleted",
  ],
  [
    "リモートの操作元が変わりました。一部のコピー先は保持され、操作元は削除していません。",
    "Remote source changed; partial copy retained; source not removed",
  ],
  ["リモートの操作元がツリーの外に出ました。", "Remote source escaped tree"],
  [
    "リモートコピー先のディレクトリ作成に失敗しました。一部の転送先は保持されています。",
    "Remote copy directory creation failed; partial target retained",
  ],
  [
    "リモートファイルのサイズを取得できないため、コピーを拒否しました。",
    "Remote file size unavailable; copy refused",
  ],
  [
    "リモート転送先の作成に失敗しました。一部の転送先は保持され、上書きは行っていません。",
    "Remote target creation failed; partial target retained; no overwrite attempted",
  ],
  [
    "リモートコピーの読み取りに失敗しました。一部の転送先は保持されています。",
    "Remote copy read failed; partial target retained",
  ],
  [
    "リモートコピー元のサイズが変わりました。一部の転送先は保持されています。",
    "Remote copy source size changed; partial target retained",
  ],
  [
    "リモートコピーの書き込みに失敗しました。一部の転送先は保持されています。",
    "Remote copy write failed; partial target retained",
  ],
  [
    "リモートコピー中に操作元が変わりました。一部の転送先は保持されています。",
    "Remote source changed during copy; partial target retained",
  ],
  [
    "追跡対象ファイルの相対パスが安全ではありません。",
    "Unsafe owned-file relative path",
  ],
  ["追跡対象ファイルの名前は未対応です。", "Unsupported owned filename"],
  [
    "追跡対象ファイルの削除が同期ルートの外に出ました。",
    "Owned-file deletion escaped its sync root",
  ],
  [
    "追跡対象のリモート項目が通常の非シンボリックリンクファイルではないため、削除を拒否しました。",
    "Owned remote entry is not a regular non-symlink file; deletion refused",
  ],
  [
    "リモートサイズを取得できないため、削除用の所有記録を作成できません。",
    "Remote size unavailable; deletion ownership cannot be recorded",
  ],
  [
    "リモート更新時刻を取得できないか未対応のため、削除を拒否しました。",
    "Remote modification time unavailable or unsupported; deletion refused",
  ],
  ["追跡対象が無効です。", "Invalid owned target"],
  [
    "アップロードは完了しましたが所有確認用のメタデータを取得できず、削除用の所有記録は作成していません。",
    "Upload completed but ownership metadata is unavailable; deletion ownership was not recorded",
  ],
  [
    "アップロード後にリモートファイルが変わったため、削除用の所有記録は作成していません。",
    "Remote file changed after upload; deletion ownership was not recorded",
  ],
  [
    "追跡対象のリモートファイルを利用できません。削除は行っていません。",
    "Owned remote file unavailable; no removal attempted",
  ],
  [
    "このジョブでアップロードした後にリモートファイルが変わったため、削除を拒否しました。",
    "Remote file changed since this job uploaded it; deletion refused",
  ],
  [
    "追跡対象のリモート削除に失敗したか、結果が不明です。更新してから再試行してください。",
    "Owned remote deletion failed or outcome is uncertain; refresh before retrying",
  ],
  ["相対パスが安全ではありません。", "Unsafe relative path"],
  ["ローカルの操作元を利用できません。", "Local source unavailable"],
  ["ローカルパスがルートの外に出ました。", "Local path escaped root"],
  ["ローカルのシンボリックリンクは拒否しました。", "Local symlink refused"],
  ["未対応のファイル名です。", "Unsupported filename"],
  ["リモートパスが無効です。", "Invalid remote path"],
  ["時刻を取得できません。", "Clock unavailable"],
  [
    "リモート転送先が通常のファイルではありません。",
    "Remote target is not a regular file",
  ],
  [
    "サーバーがposix-rename@openssh.comに対応しておらず、安全に上書きできません。既存の転送先は削除していません。",
    "Server lacks posix-rename@openssh.com; safe overwrite is unavailable. The existing target was not deleted.",
  ],
  [
    "ローカルの操作元が通常のファイルではありません。",
    "Local source is not a regular file",
  ],
  ["ローカルの読み取りに失敗しました。", "Local read failed"],
  ["ローカルの操作元が変わりました。", "Local source changed"],
  [
    "アップロード中にローカルの操作元が変わったため、一時ファイルを確定していません。",
    "Local source changed during upload; staging was not committed",
  ],
  [
    "最終的な名前変更の前に停止しました。一時ファイルは保持されています。",
    "Stopped before final rename; staging retained",
  ],
  ["JSONキーが重複しています。", "Duplicate JSON key"],
  ["統合設定が16 MBを超えています。", "Unified settings exceed 16 MB"],
  [
    "設定JSONが無効か、キーが重複しています。元のファイルは変更していません。",
    "Settings JSON is invalid or contains duplicate keys; original file is unchanged",
  ],
  [
    "統合設定が無効か未対応の形式です。以前の分割設定には別途一度だけ変換が必要です。アプリ内で移行は行いません。",
    "Unified settings are invalid or use an unsupported format. Existing split settings require the separate one-time conversion; the app does not migrate them",
  ],
  [
    "設定のスキーマまたはリビジョンが未対応です。設定は変更していません。",
    "Unsupported settings schema or revision; settings were not changed",
  ],
  [
    "設定バックアップの状態を取得できません。",
    "Settings backup status unavailable",
  ],
  [
    "設定の本体がありませんが、バックアップは存在します。開く・保存する前に明示的に復元してください。",
    "Settings primary is missing but its backup exists; restore it explicitly before opening or saving",
  ],
  [
    "設定を利用できません。既定値の読み込みや保存は行っていません。",
    "Settings unavailable; no defaults were loaded or saved",
  ],
  [
    "設定の読み取りに失敗しました。既定値は読み込んでいません。",
    "Settings read failed; no defaults were loaded",
  ],
  [
    "保存プロファイルのピンが正式な信頼台帳にありません。",
    "Saved profile pin is absent from authoritative trust",
  ],
  ["設定のシリアライズに失敗しました。", "Settings serialization failed"],
  [
    "読み込み後に設定が変更されました。保存前に再読み込みしてください（リビジョン競合）。",
    "Settings changed since loading; reload before saving (revision conflict)",
  ],
  ["設定リビジョンの上限に達しました。", "Settings revision exhausted"],
  [
    "新しい接続先のピンにはホスト鍵の明示的な承認が必要です。",
    "A new endpoint pin requires explicit host key approval",
  ],
  [
    "この接続先には承認済みのホスト鍵がありません。接続前に明示的に確認してください。",
    "Endpoint has no approved host key; explicitly verify it before connecting",
  ],
  [
    "接続のホスト鍵が正式な信頼台帳と一致しません。",
    "Connection host key differs from authoritative trust",
  ],
  [
    "ローカルフォルダーを監視できません。停止して再開してください。",
    "Cannot monitor local folder; stop and restart",
  ],
  [
    "監視キューがあふれました。停止して再開し、全体を再スキャンしてください。",
    "Watcher overflow: stop and restart for a full rescan",
  ],
  [
    "監視機能が再スキャンを要求しました。停止して再開してください。",
    "Watcher requested rescan: stop and restart",
  ],
  [
    "サーバーの同一性が変わりました。停止して確認してから再開してください。",
    "Server identity changed; stop and verify before starting again",
  ],
  [
    "操作が完了しました。フォルダーを更新して、同時に行われた外部変更を確認してください。",
    "Operation completed. Refresh the folders to reconcile any concurrent external changes.",
  ],
  [
    "リモート操作が完了しました。両方のフォルダーを更新してください。",
    "Remote operation completed; refresh both folders.",
  ],
];

export const nativeErrorTemplates: ReadonlyArray<readonly [string, string]> = [
  ["変更のないファイルを省略しました: {0}","Skipped unchanged {0}"],
  ["リモートの方が新しいため、ローカル優先で上書きします: {0}","Remote newer; source-authoritative overwrite {0}"],
  ["削除対象を確認したファイルを削除しました: {0}","Deleted verified file {0}"],
  ["除外または非対応の項目があるリモートフォルダーを保持しました: {0}","Retained remote directory with excluded or unsupported entries {0}"],
  ["空ではないリモートフォルダーを保持しました: {0}","Retained nonempty remote directory {0}"],
  // Whole log messages: filenames remain opaque captured data.
  ["ローカルとリモートのフォルダーを確認しました: {0}","Verified local/remote directory {0}"],
  ["空であることを確認したフォルダーを削除しました: {0}","Deleted verified empty directory {0}"],
  ["この同期でアップロードしたファイルを削除しました: {0}","Deleted previously uploaded file {0}"],
  [
    "除外ルールの{0}行目が無効です: {1}",
    "Invalid exclusion rule on line {0}: {1}",
  ],
  ["除外ルールが無効です: {0}", "Invalid exclusion rules: {0}"],
  [
    "{0} 変更要求が発行済みの場合、転送先や削除対象のツリーが一部だけ処理されている可能性があります。更新してから再試行してください。",
    "{0} If a mutation was issued, a partial target or partially deleted tree may remain. Refresh before retrying.",
  ],
  [
    "PPKの導出コストは未対応です: {0} の上限は {1}。鍵の変換や変更は行っていません。",
    "PPK derivation cost is unsupported: {0} maximum {1}. The key is not converted or modified.",
  ],
  [
    "SFTP の {0} に失敗しました。接続と権限を確認してください。一時ファイルは保持されています。",
    "SFTP {0} failed; check connection and permissions. Staging files are retained.",
  ],
  [
    "設定ファイル「{0}」の保存フォルダーの準備ができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot prepare the settings folder for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
  [
    "設定ファイル「{0}」の保存先の書き込み確認ができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot verify that the destination is writable for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
  [
    "設定ファイル「{0}」のバックアップ前の読み取りができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot read settings before backup for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
  [
    "設定ファイル「{0}」のバックアップの置き換えができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot replace the backup for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
  [
    "設定ファイル「{0}」の保存ができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot save settings for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
  [
    "設定ファイル「{0}」の一時保存ファイルの作成ができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot create the temporary settings file for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
  [
    "設定ファイル「{0}」の保存データの書き込みができません（{1}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。",
    "Cannot write settings data for settings file “{0}” ({1}). Move Nearly.exe and the settings file to a writable folder.",
  ],
];
