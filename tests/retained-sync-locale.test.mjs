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
  "Duplicate retained sync ID",
  "Invalid retained sync collection",
  "Invalid retained sync exclusion rules",
  "Invalid retained sync object",
  "Invalid retained sync options or pending state",
  "Invalid retained sync profile",
  "Invalid retained sync profile field",
  "Remove retained sync entries before deleting this connection profile",
  "Retained sync fields must be ordinary data",
  "Retained sync not found",
  "Retained sync paths exceed 4096 bytes",
  "Retained syncs are limited to 100 records",
  "Stop the linked sync before removing its retained entry",
  "This retained sync already has an active job",
  "Unknown or missing retained sync field",
  "At most 100 stopped sync registrations",
  "Invalid or duplicate stopped sync registration ID",
  "Invalid stopped sync profile snapshot",
  "Invalid stopped sync identity",
  "Stopped sync exclusion rules contain NUL"
];

test('retained sync model and native validation errors have exact reversible Japanese translations',()=>{
 const pairs=new Map(nativeErrorLiterals.map(([ja,en])=>[en,ja]));
 for(const en of expected){assert.ok(pairs.has(en),'Missing retained-sync error: '+en);const ja=pairs.get(en);assert.match(ja,/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);assert.equal(localizeNativeError(en,'ja'),ja);assert.equal(localizeNativeError(ja,'en'),en);assert.equal(localizeNativeError(en,'en'),en);}
});

test('retained deletion guards and native stop-summary errors stay actionable',()=>{
 assert.equal(localizeNativeError('Stop the linked sync before removing its retained entry','ja'),'保存した同期の項目を削除する前に、関連する同期を停止してください。');
 assert.equal(localizeNativeError('Remove retained sync entries before deleting this connection profile','ja'),'この接続先を削除する前に、関連する保存済みの同期を削除してください。');
 for(const en of ['Job lock failed','Start lock failed','Status lock failed','Sync worker panicked','Sync is already stopping; wait until it finishes','Stop worker failed']){const ja=localizeNativeError(en,'ja');assert.notEqual(ja,en);assert.equal(localizeNativeError(ja,'en'),en);}
});

test('retained localization preserves exact authentication details, paths and unknown server text',()=>{
 const detail='  exact user  @EXAMPLE.invalid /日本語/$&$1<key>  ';
 const path='C:\\設定\\  exact user  \\Invalid retained sync profile\\$&<b>key.ppk';
 for(const input of [detail,path,'Server says: Invalid retained sync profile','Invalid retained sync profile\n']){assert.equal(localizeNativeError(input,'ja'),input);assert.equal(localizeNativeError(input,'en'),input);}
 const en='Verified local/remote directory '+path;const ja=localizeNativeError(en,'ja');assert.equal(ja,'ローカルとリモートのフォルダーを確認しました: '+path);assert.equal(localizeNativeError(ja,'en'),en);
});
