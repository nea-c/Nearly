import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setLanguage,
  html,
  text,
  tError,
  getLocalizationDiagnostics,
} from "../.test-build/i18n.js";
import { Store, remotePath } from "../.test-build/core.js";

test("app translation leaves Japanese user values opaque and exact owned failures translate both ways", () => {
  setLanguage("en");
  assert.equal(
    html`<strong>設定</strong><span>${"設定"}</span>`,
    "<strong>Settings</strong><span>設定</span>",
  );
  assert.equal(text`${"設定"} のログ`, "Logs for 設定");
  assert.equal(tError("設定"), "設定");
  assert.throws(
    () => remotePath("設定"),
    (error) => tError(error) === "Remote paths must start with /.",
  );
  const failure = "言語設定が不正です";
  assert.equal(tError(failure), "Invalid language setting.");
  setLanguage("ja");
  assert.equal(tError("Invalid language setting."), failure);
  assert.equal(new Store({ language: "en", theme: "light" }).language, "en");
  assert.deepEqual(getLocalizationDiagnostics().conflicts, []);
});

test('all core-owned English failures localize in Japanese without modifying unknown details',()=>{
const pairs=[["設定のリビジョンが不正です","Invalid settings revision"],["保存されたブックマークが重複しています","Duplicate folder bookmark"],["フォルダの組み合わせ履歴が重複しています","Duplicate folder pair history"],["接続先は200件までです","Connections are limited to 200 profiles"],["ブックマークの接続先は変更できません","A bookmark cannot change its connection identity"],["このフォルダの組み合わせは登録済みです","This folder pair is already bookmarked"],["ブックマークは500件までです","Bookmarks are limited to 500 entries"],["閲覧要求カウンターが上限に達しました","Browse request counter exhausted"],["列幅には数値を指定してください","Column width must be numeric"]];
for(const [ja,en]of pairs){setLanguage('ja');assert.equal(tError(en),ja);setLanguage('en');assert.equal(tError(ja),en);}
setLanguage('ja');assert.equal(tError('OS details: 設定'),'OS details: 設定');
});
