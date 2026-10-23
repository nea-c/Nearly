# Nearly

[![最新リリース](https://img.shields.io/github/v/release/nea-c/Nearly?label=release&color=blue)](https://github.com/nea-c/Nearly/releases/latest)

Windows向けの **ローカル → SFTP 同期アプリ**。左右のファイル一覧で接続先を確認しながら、ローカルの変更をサーバーへ反映できます。

## ダウンロード

**[最新版のダウンロードページ](https://github.com/nea-c/Nearly/releases/latest)** · [r3.6のインストーラーを直接ダウンロード](https://github.com/nea-c/Nearly/releases/download/r3.6/Nearly_r3.6_x64-setup.exe)

Windows x64・WebView2 Runtimeが必要です。最新版ページの Assets から `Nearly_r<バージョン>_x64-setup.exe` を選んでください。ZIPの展開は不要です。SHA256と更新検証用の署名も同じページにあります。更新検証用署名はWindows Authenticode署名とは別です。

## 主な機能

- ローカルの変更を監視し、サイズ・更新日時による差分をアップロード
- 除外設定、サブフォルダー同期、任意の削除同期
- タブ・複数ウィンドウ、ブックマーク、接続先と同期設定の保存
- 日本語／英語、ライト／ダーク／ミッドナイト表示

## 使い方

1. インストーラーを実行し、Nearlyを開きます。更新時は起動中のNearlyを先に終了してください。
2. SFTP接続を追加し、接続先のホスト鍵を確認して接続します。
3. 左側で同期元、右側で同期先のフォルダーを開き、「同期」で対象と除外設定を確認して開始します。

停止後の「再開」は、そのタブの前回の条件で走査し直します。アプリ起動だけで自動接続・同期再開はしません。

## 注意事項

- **ローカル側の内容を優先します。** 同名ファイルはリモート側が新しくても上書きされます。サイズ・更新日時が同じ場合は送信を省略し、内容の一致までは確認しません。
- **削除同期は初期状態でOFFです。** ONでは、起動時に見つかったリモート側だけのファイルも削除対象です。開始前に同期先と除外を確認してください。[同期と削除の詳しい仕様](docs/synchronization.md)
- 設定はEXEと同じフォルダーに保存します。パスワード・パスフレーズは保存しません。更新・移動前には設定をバックアップしてください。[設定の保存・復旧](docs/storage-format.md)

> [!WARNING]
> 自動更新後に起動できない・更新用ファイルが残る報告を調査中です。解消済みではありません。発生時は復旧用ファイルを削除せず、再更新・再インストール前に状態を保全してください。[更新機構と制約](docs/startup-updates.md)

## 詳細・開発

[詳しい操作と開発・ビルド手順](docs/usage-and-development.md) · [インストーラーの仕様](docs/windows-installer.md) · [プロジェクト構成](docs/project-layout.md) · [不具合報告](https://github.com/nea-c/Nearly/issues)

TypeScript・Tauri 2・Rustで構成されています。開発環境や検証範囲、各機能の説明は上記の文書にまとめています。

## ライセンス

Nearly 本体のコード・文書・アイコンは [Apache-2.0](LICENSE) です。第三者コードには各元のライセンスが適用されます。[第三者通知・ソース入手先](DISTRIBUTION-LICENSES.txt) · [適用範囲](LICENSING.md)。
