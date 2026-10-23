import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>fs.readFileSync(path.join(root,p));
test('project keeps the unmodified official Apache text and ships it in the installer license document',()=>{
  const apache=read('LICENSE');
  assert.equal(createHash('sha256').update(apache).digest('hex'),'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.equal(JSON.parse(read('package.json')).license,'Apache-2.0');
  const config=JSON.parse(read('src-tauri/tauri.conf.json'));
  const distribution=fs.readFileSync(path.resolve(root,'src-tauri',config.bundle.licenseFile));
  assert.ok(distribution.includes(apache));
  assert.ok(distribution.includes(read('src-tauri/windows/upstream/LICENSE-MIT')));
  assert.ok(distribution.includes(read('src-tauri/vendor/russh-sftp/LICENSE')));
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].license,'Apache-2.0');
  assert.match(read('src-tauri/Cargo.toml').toString(),/^license = "Apache-2.0"$/m);
  assert.match(read('tools/updater-signer/Cargo.toml').toString(),/^license = "Apache-2.0"$/m);
});
test('inventory notices are preserved byte for byte and MPL sources remain available by exact version',()=>{
  const distribution=read('DISTRIBUTION-LICENSES.txt');
  const inventory=JSON.parse(read('third-party-license-inventory.json'));
  assert.equal(inventory.packages.length,414);
  const text=distribution.toString('utf8');
  for(const p of inventory.packages){
    assert.ok(p.notices.length>0,`${p.name}: notices missing`);
    if(p.license==='MPL-2.0')assert.equal(p.source,`https://crates.io/api/v1/crates/${p.name}/${p.version}/download`);
    for(const n of p.notices){
      const marker=Buffer.from(`========== NOTICE ${n.sha256} ==========\n`);
      const start=distribution.indexOf(marker);
      assert.ok(start>=0,`${p.name}: notice body missing`);
      const bodyStart=distribution.indexOf(Buffer.from('\n\n'),start+marker.length)+2;
      const next=distribution.indexOf(Buffer.from('\n\n========== NOTICE '),bodyStart);
      const body=distribution.subarray(bodyStart,next<0?distribution.length:next);
      assert.equal(createHash('sha256').update(body).digest('hex'),n.sha256,`${p.name}: notice changed`);
    }
  }
  assert.match(text,/Copyright 2016 Pierre-\u00c9tienne Meunier/);
  assert.match(text,/This Source Code Form is subject to the terms of the Mozilla Public/);
  assert.match(text,/COMMON PUBLIC LICENSE VERSION 1.0/);
  assert.ok(text.includes('original code, documentation and icons are licensed under Apache-2.0'));
  assert.ok(!text.includes('icon provenance is pending'));
  assert.ok(text.includes('https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13-src.tar.bz2/download'));
});
test('the actual installer license-page block compiles with bundled texts without running setup', {skip:process.platform!=='win32'},()=>{
  const template=read('src-tauri/windows/installer.nsi').toString();
  const block=template.match(/\{\{#if license\}\}([\s\S]*?)\{\{\/if\}\}/)?.[1];
  assert.ok(block,'custom template must embed the configured license document');
  assert.match(block,/NearlySkipPassive/);
  const config=JSON.parse(read('src-tauri/tauri.conf.json'));
  const license=path.resolve(root,'src-tauri',config.bundle.licenseFile);
  const nsis=process.env.NEARLY_NSIS_ROOT??path.join(process.env.LOCALAPPDATA,'tauri','NSIS');
  const dir=fs.mkdtempSync(path.join(fs.mkdirSync(path.join(root,'test-results'),{recursive:true})||path.join(root,'test-results'),'license-'));
  const file=path.join(dir,'license.nsi');
  const output=path.join(dir,'license-fixture-DO-NOT-RUN.exe');
  fs.writeFileSync(file,`Unicode true\nRequestExecutionLevel user\nOutFile "${output}"\n!include MUI2.nsh\n${block.replaceAll('{{license}}',license)}\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_LANGUAGE English\nFunction NearlySkipPassive\nIfSilent 0 +2\nAbort\nFunctionEnd\nSection\nSectionEnd\n`);
  const result=spawnSync(path.join(nsis,'Bin','makensis.exe'),['/V2','/INPUTCHARSET','UTF8',file],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,NSISDIR:nsis}});
  fs.writeFileSync(path.join(dir,'compile.log'),`${result.stdout??''}\n${result.stderr??''}`);
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(fs.statSync(output).size>0);
});
