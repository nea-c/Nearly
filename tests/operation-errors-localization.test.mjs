import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { localizeNativeError } from '../.test-build/native-errors.js';
const messages=JSON.parse(fs.readFileSync(new URL('./fixtures/new-native-operation-messages.json',import.meta.url),'utf8'));
test('new creation and reservation failures have reversible owned translations',()=>{
  for(const message of messages){
    const japanese=localizeNativeError(message,'ja');
    assert.notEqual(japanese,message,`Missing native operation translation: ${message}`);
    assert.equal(localizeNativeError(japanese,'en'),message);
  }
  const opaque='D:\\設定\\New file creation failed; no existing item was overwritten\\$&.txt';
  assert.equal(localizeNativeError(opaque,'ja'),opaque);
});
