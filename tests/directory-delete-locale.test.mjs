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
  "Cannot hold original local root/parents during removal; deletion refused",
  "Deleted previously uploaded file",
  "Deleted verified empty directory",
  "Directory deletion authority unavailable after reconnect or incomplete verification; restore local directory or stop and restart",
  "Directory outside local root",
  "Directory tracking limit reached; stop and restart",
  "Local directory changed type or is a reparse point",
  "Local directory depth exceeds 64",
  "Local directory disappeared during verification",
  "Local directory entry metadata failed",
  "Local directory entry read failed",
  "Local directory inaccessible",
  "Local directory metadata unavailable",
  "Local directory recreated before remote removal; deletion refused",
  "Local directory state uncertain; deletion refused",
  "Local parent changed type or is a reparse point",
  "Local parent handle metadata unavailable",
  "Local root or ancestor changed during absence check; deletion refused",
  "Remote canonical directory lookup failed",
  "Remote directory cannot be read; deletion refused",
  "Remote directory canonical path changed; deletion refused",
  "Remote directory changed during empty check; deletion refused",
  "Remote directory close failed",
  "Remote directory close failed; deletion refused",
  "Remote directory contains unowned, excluded, or pending entries; nonrecursive removal refused",
  "Remote directory emptiness could not be verified",
  "Remote directory guard changed since authorization; deletion refused",
  "Remote directory guard lookup failed; deletion refused",
  "Remote directory permissions unavailable",
  "Remote directory read failed; deletion refused",
  "Remote directory removal failed or outcome is uncertain; authority suspended until a verified local counterpart exists",
  "Remote directory/ancestor changed type or is a symlink; deletion refused",
  "Tracked local directory changed type; deletion refused",
  "Verified local/remote directory {}"
];

test('every new directory deletion message has reversible Japanese localization',()=>{
 const english=new Set([...nativeErrorLiterals,...nativeErrorTemplates].map(([,en])=>en));
 for(const input of expected){
  const message=input.replace('{}','{0}');assert.ok(english.has(message),'Missing owned message: '+message);
  const sample=message.replace('{0}','D:\\設定\\$&<b>日本語</b>\\name.txt');
  const ja=localizeNativeError(sample,'ja');assert.match(ja,/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);assert.notEqual(ja,sample);assert.equal(localizeNativeError(ja,'en'),sample);
 }
});

test('directory log templates preserve Unicode, dollar signs, markup and newlines in paths',()=>{
 const path='D:\\設定\\Operation stopped\\$&$1<svg>日本語</svg>\\nested\nfile.txt';
 for(const [en,ja] of [
  ['Verified local/remote directory ','ローカルとリモートのフォルダーを確認しました: '],
  ['Deleted verified empty directory ','空であることを確認したフォルダーを削除しました: '],
  ['Deleted previously uploaded file ','この同期でアップロードしたファイルを削除しました: '],
 ]){assert.equal(localizeNativeError(en+path,'ja'),ja+path);assert.equal(localizeNativeError(ja+path,'en'),en+path);}
});

test('directory failure messages remain explicit and unknown server text stays opaque',()=>{
 const authority='Directory deletion authority unavailable after reconnect or incomplete verification; restore local directory or stop and restart';
 assert.equal(localizeNativeError(authority,'ja'),'接続の再確立後、または確認未完了のため、フォルダーを削除できません。ローカルのフォルダーを復元するか、同期を停止して開始し直してください。');
 for(const message of ['Server says: Remote directory read failed; deletion refused','D:\\Remote directory permissions unavailable\\設定.txt','Remote directory read failed; deletion refused\n'])assert.equal(localizeNativeError(message,'ja'),message);
});

test('the complete source native catalog remains conflict-free and reversible',()=>{
 for(const [ja,en] of nativeErrorLiterals){assert.equal(localizeNativeError(en,'ja'),ja);assert.equal(localizeNativeError(ja,'en'),en);}
 const values=['設定/English/$&/{1}/<b>\n','SHA256:generated/$`/$\'/${x}'];
 const fill=value=>value.replace(/\{(\d+)\}/g,(_match,index)=>values[Number(index)]);
 for(const [ja,en] of nativeErrorTemplates){assert.equal(localizeNativeError(fill(en),'ja'),fill(ja));assert.equal(localizeNativeError(fill(ja),'en'),fill(en));}
});
