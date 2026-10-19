import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {instrumentProbeTemplate,diagnosticCodes} from '../scripts/installer-probe-codes.mjs';
const source=fs.readFileSync(new URL('../src-tauri/windows/installer.nsi',import.meta.url),'utf8');
test('diagnostic subcodes preserve every product guard and change only isolated rejection reporting',()=>{
 const changed=instrumentProbeTemplate(source);
 assert.deepEqual(Object.keys(diagnosticCodes),['51','52','53','54','55','56']);
 for(const code of Object.keys(diagnosticCodes))assert.ok(changed.includes(`StrCpy $NearlyProbeCode ${code}`));
 const original=changed.replace('Var NearlyProbeCode\n','').replace(/^  StrCpy \$NearlyProbeCode (?:5|5[1-6])\n/gm,'').replace('  SetErrorLevel $NearlyProbeCode\n','  SetErrorLevel 5\n');
 assert.equal(original,source.replaceAll('\r\n','\n'));
 assert.equal((changed.match(/Function (?:un)?\.onInit\n  StrCpy \$NearlyProbeCode 5\n/g)||[]).length,2);
});
test('unsupported diagnostic template or repeated instrumentation fails closed',()=>{
 for(const value of [undefined,'',source.replace('Function NearlyResolveRegistration','Function UnknownResolver'),source.replace('Var NearlyPendingBuffer','Var UnknownBuffer'),source.replace('  nearly_resolve_use:','  unknown_use:')])assert.throws(()=>instrumentProbeTemplate(value));
 assert.throws(()=>instrumentProbeTemplate(instrumentProbeTemplate(source)));
});
