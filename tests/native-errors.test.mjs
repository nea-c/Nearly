import test from "node:test";
import assert from "node:assert/strict";
import { localizeNativeError } from "../.test-build/native-errors.js";
import {
  nativeErrorLiterals,
  nativeErrorTemplates,
} from "../.test-build/translations-native-errors.js";
test("owned English and Japanese errors translate in both directions", () => {
  assert.equal(
    localizeNativeError("Operation stopped", "ja"),
    "操作を停止しました。",
  );
  assert.equal(
    localizeNativeError("操作を停止しました。", "en"),
    "Operation stopped",
  );
  assert.equal(
    localizeNativeError("終了処理中です。しばらくお待ちください。", "en"),
    "The application is closing. Please wait.",
  );
});
test("settings path and OS detail are opaque even when they equal owned text", () => {
  const file = "C:\\設定\\Operation stopped\\$&<b>English</b>\\settings.json";
  const detail =
    "終了処理中です。しばらくお待ちください。\nAccess is denied (os error 5)";
  const input = `設定ファイル「${file}」の保存データの書き込みができません（${detail}）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。`;
  const translated = localizeNativeError(input, "en");
  assert.equal(
    translated,
    `Cannot write settings data for settings file “${file}” (${detail}). Move Nearly.exe and the settings file to a writable folder.`,
  );
  assert.equal(localizeNativeError(translated, "ja"), input);
});
test("owned format templates preserve technical rule details and user text", () => {
  const detail = "設定 $& ${x} <img src=x> Operation stopped\nInvalid profile";
  assert.equal(
    localizeNativeError(`Invalid exclusion rule on line 7: ${detail}`, "ja"),
    `除外ルールの7行目が無効です: ${detail}`,
  );
  assert.equal(
    localizeNativeError(
      `SFTP ${detail} failed; check connection and permissions. Staging files are retained.`,
      "ja",
    ),
    `SFTP の ${detail} に失敗しました。接続と権限を確認してください。一時ファイルは保持されています。`,
  );
});
test("unknown and embedded strings remain byte-for-byte unchanged", () => {
  for (const message of [
    "C:\\設定\\Operation stopped.txt",
    "Server says: Invalid profile",
    "Permission denied (os error 5)",
    "設定",
    "<script>Invalid profile</script>",
    "Operation stopped\n",
  ]) {
    assert.equal(localizeNativeError(message, "en"), message);
    assert.equal(localizeNativeError(message, "ja"), message);
  }
});
test("every owned literal and template translates reversibly without replacing captured text", () => {
  for (const [ja, en] of nativeErrorLiterals) {
    assert.equal(localizeNativeError(ja, "en"), en);
    assert.equal(localizeNativeError(en, "ja"), ja);
  }
  const values = ["設定/English/$&/{1}/<b>\n", "SHA256:generated/$`/$'/${x}"];
  const fill = (text) =>
    text.replace(/\{(\d+)\}/g, (_m, n) => values[Number(n)]);
  for (const [ja, en] of nativeErrorTemplates) {
    assert.equal(localizeNativeError(fill(ja), "en"), fill(en));
    assert.equal(localizeNativeError(fill(en), "ja"), fill(ja));
  }
});
test("ambiguous template delimiters inside a user path are left untouched", () => {
  const path =
    "C:\\設定」の保存データの書き込みができません（evil\\settings.json";
  const message = `設定ファイル「${path}」の保存データの書き込みができません（Access denied）。Nearly.exe と設定ファイルを、書き込み可能なフォルダーへ移動してください。`;
  assert.equal(localizeNativeError(message, "en"), message);
});
