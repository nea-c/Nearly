# GitHub Actions での手動 Windows ビルドと正式公開

PPK のネイティブテスト入力は `node scripts/ppk-fixtures.mjs` で生成します。Actions は Cargo のコンパイル前にこの処理を行います。ローカルで Cargo テストを直接実行する場合も先に実行してください。新しい RSA 鍵を使った暗号化済みの使い捨てテスト入力で、実際の鍵を読み取らず、既存ファイルも上書きしません。生成ファイルは Git の対象外で、配布にも含めません。

Windows のコンパイルパスは、既知のビルドルートの長い名前・8.3 別名・両方の区切り文字を列挙して匿名化します。通常の TEMP/TMP と明示された Cargo/Rustup の保存先も含めます。[Rust のパス置換は文字列単位であり、リンカー由来の情報には別の制約があります](https://doc.rust-lang.org/rustc/remap-source-paths.html)。そのため最終配布物の監査は省略しません。監査エラーは対象・文字コード・分類を示し、検出したパス自体は出力しません。

`.github/workflows/release-windows.yml` は **workflow_dispatch 専用**です。通常の push、タグの push、PR、定期実行では動きません。この設定を main に反映しただけではリリースしません。設定の commit・push、Actions の検証実行、正式公開は、それぞれ依頼された時点で行います。

## 使い方

ワークフローが既定ブランチ main に反映された後、GitHub の Actions → **Manual Windows build and release** → Run workflow を開き、実行ブランチには **main** を選びます。nea-c/Nearly 以外や main 以外からの実行は拒否します。

| 入力 | 内容 |
| --- | --- |
| mode | 既定は `validate`。明示的な正式公開時だけ `release` |
| commit | レビュー・push 済みの対象コミットの完全な40桁小文字 SHA。ブランチ名・短縮 SHA は不可 |
| version | 対象ソースに既に設定されている `rX.Y`。現在は `r1.0`＝内部 `1.0.0` |
| confirmation | release の場合だけ `release rX.Y <完全なコミットSHA>` をそのまま入力 |

対象コミットは、その時点の origin/main の履歴に含まれている必要があります。ツールがバージョンを書き換えたり、main を勝手に選び直したりしません。新バージョンでは先に `version.json` を変更して既存の `npm run version:sync` とテストを行い、公開用リリースノート `.github/release-notes/rX.Y.md` も用意してレビュー・push してください。

`validate` でも Windows のテスト、セットアップ生成、パス匿名化、配布物の照合まで行います。タグ・GitHub Release・ダウンロード可能な Actions artifact は作りません。ビルドしたファイルは使い捨てランナー内だけに置き、結果の識別子をジョブの Summary に表示します。

`release` はすべての検証成功後にだけ公開します。内容は `Nearly_rX.Y_x64-setup.exe` と、そのファイル名に `.sha256` を付けた UTF-8 チェックサムの2点です。ポータブル EXE、設定、鍵、バックアップ、診断、QA の生成物は添付しません。タグは選択した正確なコミットを指し、Release は正式版（draft=false、prerelease=false）にします。公開後にファイルを実際にダウンロードしてハッシュを再確認します。

## 権限とビルド

- workflow 全体の権限は空。Windows ビルドだけ contents:read、隔離された公開ジョブだけ contents:write。公開トークンは GitHub がそのジョブに渡す一時的な GITHUB_TOKEN で、ユーザーの PAT や署名用 Secret は不要です。
- 制御スクリプトは入力コミットではなく、実際に実行する workflow の SHA から取り出します。書込み権限のジョブは対象ソースの npm、Cargo、ビルドスクリプトを実行しません。Git 認証も checkout 後に残しません。
- 公式 checkout/setup-node/upload-artifact/download-artifact を完全なコミット SHA で固定。依存関係は npm/Cargo のロックを使用します。Rust 1.97.1、Windows-2025、Node 22 系を使用し、Node の保守パッチとランナーイメージは変わり得ます。完全な再現ビルドや署名を保証する構成ではありません。
- 新しい Windows ランナーでは公式 Tauri CLI 2.12.3 が使う NSIS 3.13 とプラグイン 0.5.3 だけを固定 URL・SHA256 で照合して展開し、既存 `requireCachedTools` 契約でも検証します。ホスト環境へソフトをインストールしたり、セットアップを実行したりしません。MSVC と WebView2/Edge はランナーの事前導入分を利用します。
- 既存の TypeScript/モデル、Rust（逐次）、生成 localhost SFTP、ブラウザーと本番表示、インストーラー契約テストが成功してからビルド・配布検査へ進みます。生成テスト鍵はランナー内だけに残り、artifact に含めません。
- Rust と MSVC のビルド時パスを匿名化し、最終セットアップと内包 EXE の両方を照合します。サイズ・SHA256・PE 機種・バージョン・設定非同梱・更新無効のメタデータも確認します。ソースと到達可能な履歴の秘密鍵・トークンらしい文字列、個人フォルダー、禁止出力、非公開メールの混入を検査します。このパターン検査だけでは、あらゆる個人情報や実ホスト名の判定はできません。公開前のソースレビューも必要です。

公開モードだけ、パスを含まない manifest と上記2ファイルを同じ実行の Actions artifact に7日間保存します。公開リポジトリの artifact は読取り権限を持つ人が取得できるため、秘密情報の保管場所として扱いません。公開ジョブは build ジョブが返した **artifact ID** と **manifest SHA256** の両方で選択し、コミット・ソース tree・バージョン・workflow SHA・run ID・各ファイルのハッシュを照合します。

履歴監査には、既に公開されたインストーラーテストの合成ユーザー例と、上流 NSIS コメントの Public フォルダー例について、正確なソース blob の SHA256 と対象文字列を固定した2件の例外があります。ファイル内容が変われば例外は適用しません。配布する EXE・セットアップには、このソース例外を適用しません。

## 失敗と再試行

実行はワークフロー共通の concurrency group で直列化し、実行中の公開を新しい実行で自動中止しません。GitHub の pending 実行の扱いにはプラットフォームの制限があるため、複数の公開要求を同時に積み上げないでください。

テストやビルドの失敗では公開ジョブは動きません。公開はタグ→非公開ドラフト→2ファイルの照合→正式公開の順です。通信エラーで書込み結果が不明な場合、自動的に同じ書込みを繰り返しません。タグやドラフトが残ることがありますが、設定・データや既存の公開資産を削除する後片付けは行いません。

公開ジョブだけが失敗した場合は、状態を確認したうえで GitHub の **Re-run failed jobs** を使います。同じ run ID・workflow SHA・ソース SHA・バージョン・ファイルハッシュを持つ、その実行自身のドラフトだけ再利用します。アップロード済みの一致する資産は再送しません。既に公開済みなら変更せずに検証します。公開直後のダウンロード検証が失敗したケースでは、Release は既に公開されている場合があります。

別コミットの既存タグ、別実行の Release、変更されたノート、未知の資産、不完全なアップロード、異なるバイト列は停止して保持します。retag、force push、asset の削除・上書き、Release の削除は実装していません。全ジョブの再実行では、既存の同名 artifact と衝突して止まる場合があります。ハッシュの違う再ビルドを既存のドラフトへ差し替える機能はありません。保守者が状態を確認し、必要なら別途明示的な整理方針を決めてください。

リポジトリ管理者による並行のタグ・資産変更と GitHub API の公開を原子的に比較することはできません。公開前後に再確認しますが、公開作業中は他の手段で同じバージョンを操作しないでください。

## 今回確認できる範囲

ローカルでは YAML パース・構造検証、PowerShell/JavaScript 構文、生成ファイルとモック GitHub API で入力不正、パッケージ改変、失敗・再試行・衝突を検証します。Actions の実 dispatch、GitHub の実公開、使い捨て Windows ランナーでの一連のビルドは、別途許可された検証実行が必要です。ローカル成功だけを hosted-run 成功として扱いません。

署名は追加せず、production_key は None、HANDOFF_RELEASE_VALIDATED は false のままです。実インストール・更新・アンインストール、実マウスのドラッグ・混在 DPI・長時間運転の検証を、このワークフローの合格に含めません。公開ノートにはこの制限と、メタデータ差分判定・ローカル優先・初回を含む削除 ON の挙動を明記します。

## 公式資料と固定値の出典

- [GitHub workflow syntax: workflow_dispatch, permissions, concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions の安全な使用: SHA 固定と入力の扱い](https://docs.github.com/en/actions/reference/security/secure-use)
- [既定環境変数と GITHUB_WORKFLOW_SHA](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)
- [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases) / [Release assets](https://docs.github.com/en/rest/releases/assets)
- [Tauri の GitHub ビルド例](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri CLI 2.12.3 NSIS の固定ツールと検証契約](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs)

公式 Actions の参照 SHA と NSIS の固定配布物は準備時に公開元と照合済みです。更新する際は action のスキーマ、Node ランタイム要件、NSIS の上流ハッシュ、既存ローカルの cached-tool 契約をまとめて再確認してください。
