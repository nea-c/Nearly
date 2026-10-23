import { getLanguage } from "./i18n.js";

export function deletionRescanLabels() {
  return getLanguage() === "ja" ? {
    title: "削除同期の再走査が必要",
    help: "アップロードは継続できます。一部の削除基準が無効または未確定です。削除同期を再開するには、同期を停止してから再度開始し、最新状態を完全走査してください。自動で基準を更新することはありません。",
  } : {
    title: "Deletion tracking needs a new scan",
    help: "Uploads can continue. Some deletion baselines are invalid or unavailable. To restore deletion tracking, stop sync and start it again for a complete scan. Baselines are not automatically renewed.",
  };
}
