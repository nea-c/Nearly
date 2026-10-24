# 先行試用版の配布

先行試用版は手動導入向けです。内部版は `X.Y.0-pre.N`、表示・タグは `rX.Y-pre.N`（Nは1〜65535）、setup名は `Nearly_rX.Y-pre.N_x64-setup.exe` です。Windows固定数値版は `X.Y.0.0`、FileVersion/ProductVersionの表示にはpreを含めます。アップグレード順序は固定数値版ではなく、登録した内部semverで比較します。

## 安定版との関係

- GitHubにはprereleaseとして公開し、Latestにはしません。公開前後で既存LatestのID・タグを照合します。
- 安定版の更新検出はlatest安定版のみで、preタグ・prereleaseは拒否します。r3.7-pre.1の配布中はLatestと安定版更新先をr3.6のまま保ちます。
- preから将来の正式r3.7はsemver上のアップグレードです。正式版の手動setup、または正式版公開後の既存の安定版更新経路を利用できます。自動更新では更新元だけcanonicalなpreを認め、更新先・署名検証・削除receiptの安定版制約は維持します。実機移行試験は別途必要です。
- preのsetupは通常版と同じアプリ登録・導入先・設定を使い、手動導入すると本体を置き換えます。設定分離版や並存版ではありません。導入前に同期停止・終了と設定のバックアップを行ってください。
- preからr3.6のsetupへの単純上書きはダウングレードとして拒否します。正式r3.7以降への前進移行を基本とし、r3.6への復帰操作は今回検証していません。

## 公開前の手順

1. exact sourceとmetadataを固定し、全試験・UI shards・Windows build・最終EXE監査・ソースprivacy監査を完了する。
2. 通常のPR・保護条件で統合する（別途承認が必要）。署名workflowはmainのexact SHAとcanonicalタグを指定し、既存の全job成功・SHA一致を要求する。
3. 署名時のnearly-updater-production本人承認を得る。鍵・権限・gateを変更しない。validateは署名・公開しない。
4. 公開する場合はpre flag、Latest不変、exact tag/source SHA、単体EXE・sha256・sigの3資産、公開鍵による更新署名、内部EXEの版・AMD64・hashを照合する。

ローカル作成EXEは未署名です。Authenticodeと更新署名は別であり、ローカルのダミー鍵試験は製品署名の代わりになりません。過去の自動更新後起動事象は、再試行成功の報告がある原因未確定の過去事象です。この同期/UI変更の修正項目とはしていません。
