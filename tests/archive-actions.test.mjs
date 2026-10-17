import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
const modulePath = new URL(
  "../.test-build/archive-actions.js",
  import.meta.url,
);
const load = async () => {
  assert.ok(existsSync(modulePath), "The archive actions helper must exist");
  return import(modulePath.href);
};
const entry = (name, dir = false) => ({ name, dir, size: 1 });
test("archive eligibility requires local capability and exactly one supported selection", async () => {
  const { archiveEligibility } = await load();
  for (const name of ["archive.zip", "archive.ZIP", "設定.ZiP"])
    assert.deepEqual(archiveEligibility("local", [entry(name)], true), {
      compress: true,
      extract: true,
    });
  assert.deepEqual(
    archiveEligibility("local", [entry("folder.zip", true)], true),
    { compress: true, extract: false },
  );
  assert.deepEqual(archiveEligibility("local", [entry("plain.txt")], true), {
    compress: true,
    extract: false,
  });
  for (const entries of [
    [],
    [entry("a"), entry("b")],
    [entry("..")],
    [entry("bad/name")],
    [entry("bad\\name")],
    [entry("bad\0name")],
  ])
    assert.deepEqual(archiveEligibility("local", entries, true), {
      compress: false,
      extract: false,
    });
  for (const capability of [false, undefined, null, 1, "true"])
    assert.deepEqual(
      archiveEligibility("local", [entry("a.zip")], capability),
      { compress: false, extract: false },
    );
  assert.deepEqual(archiveEligibility("remote", [entry("a.zip")], true), {
    compress: false,
    extract: false,
  });
});
test("default leaf names preserve user bytes and only the empty ZIP stem is localized", async () => {
  const { archiveDefaultName } = await load();
  const { setLanguage } = await import("../.test-build/i18n.js");
  const name = '設定 "quote" & <value>';
  for (const language of ["ja", "en"]) {
    setLanguage(language);
    assert.equal(archiveDefaultName("compress", name), name + ".zip");
    assert.equal(archiveDefaultName("extract", name + ".ZIP"), name);
    assert.equal(
      archiveDefaultName("extract", ".zip"),
      language === "ja" ? "展開したファイル" : "Extracted files",
    );
  }
});
test("archive code messages are bilingual, opaque paths remain exact, unknown objects are readable", async () => {
  const { formatArchiveError } = await load();
  const { setLanguage, getLocalizationDiagnostics } =
    await import("../.test-build/i18n.js");
  const pairs = {
    remote_unsupported: [
      "リモートではZIP操作を利用できません。",
      "ZIP operations are not available remotely.",
    ],
    invalid_request: [
      "ZIP操作の指定が不正です。",
      "The ZIP operation request is invalid.",
    ],
    unsupported_zip: [
      "このZIP形式には対応していません。",
      "This ZIP format is not supported.",
    ],
    unsafe_entry: [
      "ZIP内に安全に展開できない項目があります。",
      "The ZIP contains an entry that cannot be extracted safely.",
    ],
    limit_exceeded: [
      "ZIP処理の上限を超えました。",
      "The ZIP operation exceeded its limits.",
    ],
    cancelled: ["ZIP処理を中止しました。", "The ZIP operation was cancelled."],
    io_error: [
      "ZIP処理中に入出力エラーが発生しました。",
      "An I/O error occurred during the ZIP operation.",
    ],
    collision: [
      "保存先に同じ名前の項目が存在します。上書きは行いません。",
      "An item with the same name already exists at the destination. Nothing will be overwritten.",
    ],
    sync_overlap: [
      "同期中のフォルダと重なるためZIP処理を開始できません。",
      "The ZIP operation cannot start because it overlaps a folder being synchronized.",
    ],
    busy: [
      "別のZIP処理が実行中です。完了してから再試行してください。",
      "Another ZIP operation is running. Wait for it to finish before trying again.",
    ],
  };
  const opaque = 'C:\\設定 "quote" & <value>\\stage';
  for (const [i, language] of ["ja", "en"].entries()) {
    setLanguage(language);
    for (const [code, pair] of Object.entries(pairs))
      assert.equal(
        formatArchiveError({ code, stagePath: null, committed: false }),
        pair[i],
      );
    const retained = formatArchiveError({
      code: "io_error",
      stagePath: opaque,
      committed: false,
    });
    assert.ok(retained.endsWith(opaque));
    assert.ok(retained.includes(pairText(language)));
    const unknown = formatArchiveError({
      code: "future_backend_code",
      stagePath: null,
      committed: false,
    });
    assert.ok(unknown.length > 0);
    assert.ok(!unknown.includes("[object Object]"));
    assert.ok(!unknown.includes("future_backend_code"));
    assert.equal(
      formatArchiveError("Opaque OS detail 設定"),
      "Opaque OS detail 設定",
    );
    const committed = formatArchiveError({
      code: "cancelled",
      stagePath: null,
      committed: true,
    });
    assert.ok(
      committed.includes(
        language === "ja" ? "既に作成" : "already been created",
      ),
    );
    assert.ok(
      !committed.includes(language === "ja" ? "中止しました" : "was cancelled"),
    );
  }
  assert.deepEqual(getLocalizationDiagnostics().conflicts, []);
});
function pairText(language) {
  return language === "ja"
    ? "一時出力が残っています: "
    : "Temporary output retained at: ";
}

test("additional native archive codes and malformed errors stay explicit and readable", async () => {
  const { formatArchiveError } = await load();
  const { setLanguage } = await import("../.test-build/i18n.js");
  const pairs = {
    unsupported_platform: [
      "この環境ではZIP操作を利用できません。",
      "ZIP operations are not available on this platform.",
    ],
    publish_refused: [
      "出力を安全に確定できませんでした。保存先と残された一時出力を確認してください。",
      "The output could not be published safely. Check the destination and any retained temporary output.",
    ],
    source_changed: [
      "ZIP処理中に入力が変更されました。",
      "The source changed during the ZIP operation.",
    ],
    integrity_error: [
      "ZIPの整合性を確認できませんでした。",
      "ZIP integrity validation failed.",
    ],
  };
  for (const [i, language] of ["ja", "en"].entries()) {
    setLanguage(language);
    for (const [code, messages] of Object.entries(pairs))
      assert.equal(
        formatArchiveError({ code, stagePath: null, committed: false }),
        messages[i],
      );
    const fallback =
      language === "ja"
        ? "ZIP処理に失敗しました。"
        : "The ZIP operation failed.";
    for (const error of [
      null,
      undefined,
      [],
      17,
      {},
      { code: "toString" },
      { code: 17, stagePath: 42 },
    ])
      assert.equal(formatArchiveError(error), fallback);
    assert.equal(
      formatArchiveError(new Error('Opaque native detail 設定 & "quotes"')),
      'Opaque native detail 設定 & "quotes"',
    );
    const retained = 'C:\\設定 "quote" & <value>\\.partial';
    assert.ok(
      formatArchiveError({
        code: "future_code",
        stagePath: retained,
        committed: true,
      }).endsWith(retained),
    );
  }
});

test('ZIP dialog owned action and destination labels use exact catalog keys',async()=>{const {t,setLanguage}=await import('../.test-build/i18n.js');setLanguage('en');for(const [ja,en]of [['対象','Target'],['実行','Run'],['展開先フォルダー名','Extraction folder name'],['ZIPファイル名','ZIP file name']])assert.equal(t(ja),en);});
