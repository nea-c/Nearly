# ライセンス

Nearly の独自コード・文書・アイコンには標準の Apache License 2.0 を適用します。全文は [LICENSE](LICENSE) にあります。独自の再配布禁止・改変禁止条件やアイコン除外は追加しません。この変更に伴う新リリースはなく、過去の r3.6 配布物を置き換えません。

## 第三者コードと配布

- [DISTRIBUTION-LICENSES.txt](DISTRIBUTION-LICENSES.txt) は本体ライセンス、第三者の既存通知、正確な版のソース入手先をまとめた配布用文書です。インストーラーのライセンス画面に埋め込みます。追加のインストール先ファイルや updater の削除対象は増やしません。サイレント・更新時には画面を省略しますが、文書自体は setup EXE に含まれます。
- [第三者一覧](third-party-license-inventory.json) は Windows 向け Cargo の解決済み依存グラフ（ビルド・テスト用を含む）です。全項目が配布 EXE にリンクされるという意味ではありません。依存や lockfile を変える場合は、同じ版の原文を取得し、一覧と配布用文書を更新してください。重複本文は SHA256 で統合し、元の著作権表示・NOTICE は保持しています。
- MPL-2.0 の `cssparser`、`cssparser-macros`、`dtoa-short`、`option-ext`、`selectors` は MPL のままです。配布用文書に掲載した版別 crates.io URL から該当ソースを取得できます。これらを Nearly の Apache ライセンスに変更するものではありません。現在これらのソースへの独自変更はありません。
- `src-tauri/vendor/russh-sftp` は元の Apache-2.0 表示を保持します。Nearly のローカル変更もリポジトリに含まれます。インストーラーテンプレートは Tauri 由来の MIT 表示と既存の変更説明を保持します。
- npm の依存はすべて開発用です。現在のアプリのフロントエンドは外部 npm 実行時ライブラリを import していません。ビルドツール自体を再配布するものではありません。lockfile の license 欄だけで全権利確認が済んだとは扱いません。
- 開発手順で生成する単体の `Nearly.exe` を再配布する場合も、`LICENSE` と `DISTRIBUTION-LICENSES.txt` を添えてください。setup 内の表示は、単体 EXE に文書を自動添付するものではありません。
- NSIS 3.13 の実行時部分の既存通知（Modern UI、NSISdl、圧縮コードの CPL-1.0 を含む COPYING）も配布用文書に収録しています。これらを Apache に変更しません。[同じ版の公式ソース](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13-src.tar.bz2/download) の入手先を setup 内の文書にも掲載しています。

## 出所と残る確認

Cargo の SPDX 宣言と実ファイルを照合しました。`ring`、`aws-lc-sys`、`dpi` 等の複合条件や入れ子の通知も保持します。単独ライセンスファイルがない crate は、元ソースのライセンスヘッダーと公式全文、または固定 upstream の原文で補っています。`russh-util 0.52.0` の VCS 情報は dirty で、記録された基底 commit は 0.51.0 です。正確なソースの案内には公開 crate の版別 URL を使います。

管理者の公開ハンドルは `nea-c` です。リポジトリ所有者 `nea-c/Nearly` と、既存履歴の `45559303+nea-c@users.noreply.github.com` に対応します。このハンドルはプロジェクト管理者の識別に使用できます。git の作者名だけから法的な権利帰属を断定せず、根拠のない著作権者名・年は新設していません。

**アイコンの出所（ユーザー申告、2026-10-23）:** アプリのアイコンは、以前 ChatGPT で生成した「緑色のフォルダー全体で N を表す」案を参考に、ユーザー自身が描いたものです。`src-tauri/icons/icon-source.png` とその派生 ICO も、ユーザーの意向により本体と同じ Apache-2.0 の適用対象に含めます。アンインストーラーの SVG は既存文書に独自作成と記録されています。

この出所記録と適用方針はユーザーの申告・指示に基づきます。著作権の成立や第三者の権利を侵害しないことを法的に保証するものではありません。第三者コードの表示と適用条件はそれぞれ保持します。

## 原文を補った項目

元 crate に独立したライセンスファイルがない場合の補完元は以下です。元ソースのヘッダーも保持します。

- alloc-stdlib: [固定 upstream BSD 原文](https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE)
- delegate: [固定 upstream MIT 原文](https://raw.githubusercontent.com/kobzol/rust-delegate/b129d4cbf4cc499eff7743365dcb0fe5d8d2e820/LICENSE-MIT)
- webview2-com / webview2-com-sys: [固定 upstream MIT 原文](https://raw.githubusercontent.com/wravery/webview2-rs/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE)
- webview2-com-macros: [固定 upstream MIT 原文](https://raw.githubusercontent.com/wravery/webview2-rs/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE)
- pageant / russh / russh-cryptovec / russh-util: crate の Apache-2.0 宣言と [公式全文](https://www.apache.org/licenses/LICENSE-2.0.txt)。正確な版のソースは一覧の crate URL を使用します。
- selectors: crate の MPL ヘッダーと [Mozilla 公式全文](https://www.mozilla.org/media/MPL/2.0/index.f75d2927d3c1.txt)。

配布用文書は UTF-8 BOM 付きです。検証は実テンプレートのライセンス画面部分のコンパイルと通知本文のハッシュ照合までで、実際の画面での全文表示・スクロールは未検証です。通常アプリや setup は実行していません。
