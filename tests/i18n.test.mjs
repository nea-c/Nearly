import test from 'node:test';
import assert from 'node:assert/strict';
import { t, text, html, tError, getLanguage, setLanguage, getLocalizationDiagnostics } from '../.test-build/i18n.js';

test('English translates owned text while Japanese retains source text',()=>{
 setLanguage('ja');assert.equal(t('設定'),'設定');
 setLanguage('en');assert.equal(t('設定'),'Settings');assert.equal(getLanguage(),'en');
 assert.throws(()=>setLanguage('unsupported'),/language/i);assert.equal(getLanguage(),'en');setLanguage('ja');
});
test('literal-only HTML localization never changes or escapes already-escaped user substitutions',()=>{
 setLanguage('en');const name='設定',escaped='&lt;設定&gt;&amp;$&';
 assert.equal(html`<button title="設定">${name}</button><p>${escaped}</p>`,'<button title="Settings">設定</button><p>&lt;設定&gt;&amp;$&</p>');
 setLanguage('ja');
});
test('dynamic text can reorder slots and keeps dollar replacements and UI-word paths opaque',()=>{
 setLanguage('en');const name='D:\\設定\\$&.txt';
 assert.equal(text`「${name}」を削除しますか？`,'Delete "D:\\設定\\$&.txt"?');
 assert.equal(t('「{name}」を削除しますか？',{name:'設定$1'}),'Delete "設定$1"?');setLanguage('ja');
});
test('HTML uses the longest catalog phrase instead of partially translating short labels',()=>{
 setLanguage('en');assert.equal(html`<p>設定を保存</p><button>設定</button>`,'<p>Save settings</p><button>Settings</button>');setLanguage('ja');
});
test('owned translation quotes cannot break HTML attributes while substitutions remain caller-owned',()=>{
 setLanguage('en');assert.equal(html`<span title="「{name}」を削除しますか？"></span>`,'<span title="Delete &quot;{name}&quot;?"></span>');setLanguage('ja');
});
test('cached owned error messages translate only complete templates with unchanged details',()=>{
 setLanguage('en');assert.equal(tError(new Error('テーマを保存できませんでした。 D:\\設定\\$&.json')),'Could not save the theme. D:\\設定\\$&.json');
 assert.equal(tError('D:\\設定\\file.txt'),'D:\\設定\\file.txt');assert.equal(tError('設定'),'設定');
 assert.equal(tError('EACCES: native system message 設定'),'EACCES: native system message 設定');setLanguage('ja');
});
test('switching language affects future render calls without freezing imported labels',()=>{
 const render=()=>html`<b>設定</b>`;setLanguage('ja');assert.equal(render(),'<b>設定</b>');
 setLanguage('en');assert.equal(render(),'<b>Settings</b>');setLanguage('ja');assert.equal(render(),'<b>設定</b>');
});
test('owned-message matching preserves final newline inside captured technical details',()=>{
 setLanguage('en');assert.equal(tError('テーマを保存できませんでした。 D:\\設定\\file.json\n'),'Could not save the theme. D:\\設定\\file.json\n');setLanguage('ja');
});
test('ambiguous owned-message delimiters never reinterpret captured user data',()=>{
 setLanguage('en');assert.equal(tError('2 件完了 / 1 件失敗'),'2 completed / 1 failed');const raw='設定 件完了 / パス 件完了 / 2 件失敗';assert.equal(tError(raw),raw);setLanguage('ja');
});
test('untranslated owned-literal diagnostics stay bounded and never inspect interpolated user data',()=>{
 setLanguage('en');const before=getLocalizationDiagnostics().missing.length;
 html`<span>${'未知のユーザー名'}</span>`;assert.equal(getLocalizationDiagnostics().missing.length,before);
 for(let i=0;i<300;i++)t('未登録の固定文言'+i);
 const d=getLocalizationDiagnostics();assert.ok(d.missing.length>0);assert.ok(d.missing.length<=128);assert.deepEqual(d.conflicts,[]);setLanguage('ja');
});
