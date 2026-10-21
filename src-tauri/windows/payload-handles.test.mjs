import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const s=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const body=n=>s.match(new RegExp(`Function ${n}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1]??'';
test('live payload bytes are written only through verified exclusive handles',()=>{
 const open=body('\\$\\{prefix\\}NearlyIoOpenDestination');
 assert.match(open,/0x40010080, i 0/);
 assert.match(open,/StrCpy \$NearlyIoDisposition 1/);
 assert.match(open,/StrCpy \$NearlyIoDisposition 3/);
 assert.match(open,/NearlyIoExpected/);
 assert.match(open,/Call \$\{prefix\}NearlyIoInspect/);
 const copy=body('\\$\\{prefix\\}NearlyIoCopy');
 assert.match(copy,/SetEndOfFile\(p \$NearlyIoWriteHandle\)/);
 assert.match(copy,/WriteFile\(p \$NearlyIoWriteHandle/);
 assert.doesNotMatch(copy,/CreateFile|DeleteFile|MoveFile/);
 const install=s.slice(s.indexOf('Section Install'),s.indexOf('SectionEnd',s.indexOf('Section Install')));
 assert.doesNotMatch(install,/WriteUninstaller "\$INSTDIR|Call NearlyExtractApplication/);
 assert.ok(install.indexOf('Call NearlyWritePayloads')<install.indexOf('SetOutPath "$INSTDIR"'));
 assert.ok(install.indexOf('Call NearlyWritePayloads')<install.indexOf('WriteRegStr'));
});
test('uninstall deletes the held verified objects without reopening their names',()=>{
 const uninstall=s.slice(s.indexOf('Section Uninstall'));
 assert.doesNotMatch(uninstall,/Delete "\$INSTDIR/);
 assert.match(uninstall,/StrCpy \$NearlyIoWriteHandle \$NearlyRegisteredImageHandle/);
 assert.match(uninstall,/Call un.NearlyIoDelete/);
 assert.match(body('\\$\\{prefix\\}NearlyIoDelete'),/SetFileInformationByHandle\(p \$NearlyIoWriteHandle, i 4/);
});
test('hosted guard probe selects exactly the actual Temp test and includes native payload checks',()=>{
 const guest=fs.readFileSync(new URL('../../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
 const readonly=fs.readFileSync(new URL('./readonly-root.test.mjs',import.meta.url),'utf8');
 const name=guest.match(/\$tempTestName='([^']+)'/)[1];
 assert.equal(readonly.split(`test('${name}'`).length,2);
 assert.match(guest,/\[regex\]::Matches[^\n]+\.Count -ne 1/);
 assert.match(guest,/--test-name-pattern=\^/);
 assert.match(guest,/& node --test[^\n]+payload-native\.test\.mjs/);
});
