import test from 'node:test';
import assert from 'node:assert/strict';
import {syncLogMarkup,syncIndicatorClass,syncActivityLabel} from '../.test-build/sync-presentation.js';
import {localizeNativeError} from '../.test-build/native-errors.js';
test('completed-upload translation preserves the entire path bidirectionally',()=>{
 const path='folder/日本語 <tag> $&.txt';
 assert.equal(localizeNativeError('Uploaded '+path,'ja'),'アップロード完了: '+path);
 assert.equal(localizeNativeError('アップロード完了: '+path,'en'),'Uploaded '+path);
});
test('completed upload separates the label and full opaque path in both languages',()=>{
 const path='deep/'.repeat(80)+'<img src=x> $& 日本語.txt';
 for(const [lang,label]of [['ja','アップロード完了'],['en','Upload complete']]){
  const result=syncLogMarkup('Uploaded '+path,lang);
  assert.ok(result.includes(label));assert.ok(result.includes('deep/'.repeat(80)));
  assert.ok(result.includes('&lt;img src=x&gt; $&amp; 日本語.txt'));assert.ok(result.includes('<code title='));assert.ok(!result.includes('<img'));
 }
 for(const line of ['Created remote directory a','Verified local/remote directory a','Skipped unchanged a','Upload committed; verification failed','Local source changed; waiting to resend a'])assert.ok(!syncLogMarkup(line,'en').includes('log-upload'));
});
test('active is bright only while actual work is underway, never after error or stop',()=>{
 const status=(syncPhase,extra={})=>({status:'running',pending:0,syncPhase,...extra});
 assert.equal(syncIndicatorClass(status('scanning')),'sync-active');
 assert.equal(syncIndicatorClass(status('working')),'sync-active');
 assert.equal(syncIndicatorClass(status('caught_up')),'sync-complete');
 assert.equal(syncIndicatorClass(status('deletion_rescan_required')),'sync-paused');
 assert.equal(syncIndicatorClass(status('working',{status:'failed'})),'error');
 assert.equal(syncIndicatorClass(status('working',{status:'stopped'})),'off');
 assert.equal(syncIndicatorClass(status('working',{status:'stopping'})),'sync-paused');
 assert.equal(syncIndicatorClass(status(undefined)),'sync-watching');
 assert.equal(syncIndicatorClass(status(undefined,{pending:3})),'sync-active');
 assert.equal(syncActivityLabel(status('scanning'),'ja'),'走査中');
 assert.equal(syncActivityLabel(status('working'),'en'),'Syncing');
 assert.equal(syncActivityLabel(status('caught_up'),'en'),'Up to date · watching');
});
