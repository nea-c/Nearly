import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyUpdaterProof} from '../.github/scripts/updater-proof.mjs';
import {fixture} from './helpers/updater-proof-fixture.mjs';
test('independent verifier accepts both maintained minisign framing variants on generated data',()=>{
  for(const prehash of [true,false]){const f=fixture({prehash});assert.equal(verifyUpdaterProof(f.installer,f.signature,f.publicRaw,f.expected),true);}
});
test('proof verifies message and global comment before accepting exact payload/version/file/protocol',()=>{
  const f=fixture();
  for(const field of ['version','file','payloadSha256'])assert.throws(()=>verifyUpdaterProof(f.installer,f.signature,f.publicRaw,{...f.expected,[field]:'wrong'}));
  const tampered=Buffer.from(f.installer);tampered[200]^=1;
  assert.throws(()=>verifyUpdaterProof(tampered,f.signature,f.publicRaw,f.expected));
  assert.throws(()=>verifyUpdaterProof(f.installer,f.signature,fixture().publicRaw,f.expected));
  const inner=Buffer.from(f.signature.toString(),'base64').toString().replace('version:3.1.0','version:3.2.0');
  assert.throws(()=>verifyUpdaterProof(f.installer,Buffer.from(Buffer.from(inner).toString('base64')),f.publicRaw,f.expected));
  for(const suffix of ['\tversion:3.1.0','\tupdater-protocol:2','\tunknown:1']){const bad=fixture({comment:`version:3.1.0\tfile:Nearly_r3.1_x64-setup.exe\tpayload-sha256:${'a'.repeat(64)}\tupdater-protocol:3${suffix}`});assert.throws(()=>verifyUpdaterProof(bad.installer,bad.signature,bad.publicRaw,bad.expected));}
});
test('framing rejects oversized, noncanonical base64 and wrong public/signature framing',()=>{
  const f=fixture();for(const signature of [Buffer.alloc(0),Buffer.from('garbage!'),Buffer.alloc(16385,65),Buffer.from(f.signature.toString()+'!')])assert.throws(()=>verifyUpdaterProof(f.installer,signature,f.publicRaw,f.expected));
  assert.throws(()=>verifyUpdaterProof(f.installer,f.signature,Buffer.alloc(42),f.expected));
});
