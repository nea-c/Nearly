import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditBytes} from '../.github/scripts/release-contract.mjs';

test('Windows build mappings cover canonical, short and slash aliases without retaining profile names', {skip:process.platform!=='win32'}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-build-path-alias-fixture-'));
  try {
    await fs.mkdir(path.join(root,'child'));
    const script=fileURLToPath(new URL('./fixtures/inspect-build-paths.ps1',import.meta.url));
    const result=JSON.parse(execFileSync('pwsh',['-NoProfile','-NonInteractive','-File',script,'-Root',root],{encoding:'utf8',windowsHide:true}));
    for(const from of [root,result.long,result.short])for(const variant of [from,from.replaceAll('\\','/')]){
      assert.ok(result.mappings.some(m=>m.From===variant && m.To==='/build/fixture'));
    }
    assert.ok(result.mappings.some(m=>m.From===path.join(root,'child') && m.To==='/build/fixture-child'));
    assert.ok(result.mappings.every(m=>['/build/fixture','/build/fixture-child'].includes(m.To)));
  } finally {
    const actual=await fs.realpath(root), base=await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(),base.toLowerCase());assert.match(path.basename(actual),/^nearly-build-path-alias-fixture-/);
    await fs.rm(actual,{recursive:true,force:true});
  }
});

test('privacy errors identify encoding and path category without logging the matched private text',()=>{
  const value=['C:','Users','SyntheticCiPrivateName','secret-source.rs'].join('/');
  assert.throws(()=>auditBytes(Buffer.from(value)),error=>{
    assert.match(error.message,/encoding=utf8; path=windows-user/);
    assert.ok(!error.message.includes('SyntheticCiPrivateName'));
    assert.ok(!error.message.includes('secret-source.rs'));
    return true;
  });
});
