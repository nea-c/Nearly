import test from 'node:test';
import assert from 'node:assert/strict';
import {localizeNativeError} from '../.test-build/native-errors.js';

test('comparison logs distinguish skip, overwrite and delete while preserving opaque paths',()=>{
 const name='資料/Uploaded <img src=x> $& 設定.txt';
 for(const [source,expected] of [
  [`Local source changed; waiting to resend ${name}`,`ローカルファイルが更新されたため、最新版の再送を待っています: ${name}`],
  [`Skipped unchanged ${name}`,`変更のないファイルを省略しました: ${name}`],
  [`Remote newer; source-authoritative overwrite ${name}`,`リモートの方が新しいため、ローカル優先で上書きします: ${name}`],
  [`Deleted verified file ${name}`,`削除対象を確認したファイルを削除しました: ${name}`],
  [`Retained remote directory with excluded or unsupported entries ${name}`,`除外または非対応の項目があるリモートフォルダーを保持しました: ${name}`],
  [`Retained nonempty remote directory ${name}`,`空ではないリモートフォルダーを保持しました: ${name}`],
 ]){
  assert.equal(localizeNativeError(source,'ja'),expected);
  assert.equal(localizeNativeError(expected,'en'),source);
 }
});

test('destructive-operation refusals explain retention without translating arbitrary server data',()=>{
 for(const [source,expected] of [
  ['Local source identity unavailable','ローカル送信元のファイル識別情報を取得できません。'],
  ['Local comparison path became a reparse point','比較中のローカルパスが再解析ポイントに変わったため停止しました。'],
  ['Changed-source staging changed; cleanup refused','更新前の一時ファイルに変化があるため削除を拒否しました。'],
  ['Changed-source staging removal was not confirmed; restart to reconcile','更新前の一時ファイルの削除を確認できません。同期待ちの状態を確認して手動で開始し直してください。'],
  ['SFTP source timestamp preservation refused; staging was not committed','更新日時の保存を SFTP サーバーが拒否しました。一時ファイルは確定していません。'],
  ['Remote mirror inventory read failed; deletion refused','リモートのミラー対象一覧を読み取れないため、削除を拒否しました。'],
  ['Local source entry unreadable; initial scan incomplete, mirror deletion refused','同期元の項目を読み取れず初回走査が完了しないため、ミラー削除を拒否しました。'],
  ['Retained directory tracking limit reached; deletion paused, stop and start a new sync','保持するフォルダーの追跡上限に達したため削除を中断しました。同期を停止して開始し直してください。'],
 ])assert.equal(localizeNativeError(source,'ja'),expected);
 const server='Server says: SFTP source timestamp preservation refused; staging was not committed';
 assert.equal(localizeNativeError(server,'ja'),server);
});
