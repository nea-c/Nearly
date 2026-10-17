import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const path=new URL('../.test-build/connection-errors.js',import.meta.url);
test('only the typed native key-unlock failure routes inline; message text never classifies',async()=>{
 assert.ok(existsSync(path),'The structured connection-error parser must exist');
 const {connectionError}=await import(path.href);
 assert.deepEqual(connectionError({kind:'keyUnlockFailed',message:'Fixture ambiguous key message'}),{kind:'keyUnlockFailed',message:'Fixture ambiguous key message'});
 for(const value of ['Incorrect passphrase','keyUnlockFailed',Error('Incorrect passphrase'),{kind:'other',message:'Incorrect passphrase'},{kind:'future',message:'Incorrect passphrase'}, {kind:'keyUnlockFailed',message:123},['keyUnlockFailed','Incorrect passphrase']])assert.equal(connectionError(value).kind,'other');
 assert.deepEqual(connectionError({kind:'other',message:'Host <fixture> mismatch'}),{kind:'other',message:'Host <fixture> mismatch'});
 assert.equal(connectionError(new Error('Opaque OS detail')).message,'Opaque OS detail');
});
