import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// Load the current source catalog without touching shared compiler output. The
// catalog contains data and only one array type annotation per export.
const catalogSource=(await fs.readFile(new URL('../src/translations-native-errors.ts',import.meta.url),'utf8')).replace(/: ReadonlyArray<readonly \[string, string\]>/g,'');
const catalogUrl='data:text/javascript;base64,'+Buffer.from(catalogSource).toString('base64');
const localizerSource=(await fs.readFile(new URL('../.test-build/native-errors.js',import.meta.url),'utf8')).replace('./translations-native-errors.js',catalogUrl);
const {localizeNativeError}=await import('data:text/javascript;base64,'+Buffer.from(localizerSource).toString('base64'));
const {nativeErrorLiterals,nativeErrorTemplates}=await import(catalogUrl);
const expected=[
  "At most 16 local directory watches are allowed",
  "Invalid local watch ID",
  "Invalid local watch path",
  "Invalid local watch token",
  "Local directory watch not found",
  "Local directory watcher could not be initialized",
  "Local directory watcher could not watch the folder",
  "Local directory watcher could not watch the parent folder",
  "Local directory watcher failed; refresh and watch the folder again",
  "Local directory watcher lost events; refresh and watch the folder again",
  "Local directory watcher revision limit reached; watch the folder again",
  "Local directory watching refuses reparse points",
  "Local directory watching requires an absolute local drive path",
  "Local directory watching requires an absolute path without traversal",
  "Local directory watching requires an available local drive",
  "Local watch directory cannot be resolved",
  "Local watch directory is unavailable",
  "Local watch path is not an ordinary directory",
  "Local watch token already belongs to another directory",
  "Local watcher notice lock failed",
  "Local watcher registry lock failed",
  "Stale local watch token",
  "The watched local folder moved or was removed; select the folder again",
  "Local watch worker failed",
  "Remote refresh journal exhausted; stop and restart sync"
];

test('all automatic explorer refresh native messages localize reversibly',()=>{
 const literals=new Map(nativeErrorLiterals.map(([ja,en])=>[en,ja]));
 for(const en of expected){assert.ok(literals.has(en),'Missing automatic refresh message: '+en);const ja=literals.get(en);assert.match(ja,/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);assert.equal(localizeNativeError(en,'ja'),ja);assert.equal(localizeNativeError(ja,'en'),en);assert.equal(localizeNativeError(en,'en'),en);}
});

test('automatic refresh guidance stays explicit for lost events and exhausted journal',()=>{
 assert.equal(localizeNativeError('The watched local folder moved or was removed; select the folder again','ja'),'監視中のローカルフォルダーが移動または削除されました。フォルダーを選択し直してください。');
 assert.equal(localizeNativeError('Remote refresh journal exhausted; stop and restart sync','ja'),'リモート一覧の更新履歴が上限に達しました。同期を停止して開始し直してください。');
 assert.match(localizeNativeError('Local directory watcher lost events; refresh and watch the folder again','ja'),/更新.*監視/);
});

test('automatic refresh localization does not rewrite paths or unknown server details',()=>{
 for(const input of ['C:\\設定\\Invalid local watch ID\\$&<b>name.txt','Server says: Local watch worker failed','Local watch worker failed\n']){assert.equal(localizeNativeError(input,'ja'),input);assert.equal(localizeNativeError(input,'en'),input);}
});
