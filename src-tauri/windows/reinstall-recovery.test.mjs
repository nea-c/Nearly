import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const s=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const body=n=>s.match(new RegExp(`Function ${n}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1]??'';
const install=s.slice(s.indexOf('Section Install'),s.indexOf('SectionEnd',s.indexOf('Section Install')));
test('repair pins only an owned recovery directory before touching payloads',()=>{
 const open=body('NearlyOpenRepairState');
 assert.match(open,/CreateFileW\(w "\$INSTDIR\\\.Nearly-update-state", i 0x10081, i 1, p 0, i 3, i 0x02200000/);
 assert.match(open,/StrCmp \$NearlyOwnedUpgrade 1/);
 assert.match(open,/ReadRegStr .*"NearlyRootIdentity"/);
 assert.match(open,/StrCmp \$0 "" nearly_repair_identity_ready/,'legacy owned roots without a persisted identity remain repairable');
 assert.match(open,/StrCmp \$0 \$NearlyRootIdentity/);
 assert.match(open,/GetFileInformationByHandle/);
 assert.match(open,/0x410/);
 assert.match(open,/GetFinalPathNameByHandleW/);
 assert.match(open,/StrCmp \$1 2 nearly_repair_absent/);
 assert.ok(install.indexOf('Call NearlyOpenRepairState')>=0);
 assert.ok(install.indexOf('Call NearlyOpenRepairState')<install.indexOf('Call NearlyWritePayloads'));
 assert.match(body('NearlyAcquireMutation'),/NearlyAcquireMutationBody/);
});
test('repair legacy identity admission still rejects a conflicting persisted identity',()=>{
 const open=body('NearlyOpenRepairState');
 assert.match(open,/ReadRegStr \$0 HKCU "\$\{UNINSTKEY\}" "NearlyRootIdentity"\s+StrCmp \$0 "" nearly_repair_identity_ready\s+StrCmp \$0 \$NearlyRootIdentity 0 nearly_repair_bad\s+nearly_repair_identity_ready:/);
 const native=fs.readFileSync(new URL('../src/install_root.rs',import.meta.url),'utf8');
 const admission=native.slice(native.indexOf('fn validate(owner:'),native.indexOf('pub(crate) fn root(&self)'));
 assert.doesNotMatch(admission,/NearlyRootIdentity/,'native registration admission supports legacy missing markers');
});
test('successful reinstall archives through the held handle without overwriting or deleting evidence',()=>{
 const archive=body('NearlyArchiveRepairState');
 assert.match(archive,/\.Nearly-update-state-reinstalled-/);
 assert.match(archive,/SetFileInformationByHandle\(p \$NearlyRepairHandle, i 3/);
 assert.match(archive,/\(i 0, p 0, i r1\)/,'rename must not replace existing destination');
 assert.doesNotMatch(archive,/DeleteFile|MoveFile|RMDir|\bDelete\b|ReadFile/);
 assert.ok(install.indexOf('Call NearlyArchiveRepairState')>install.indexOf('WriteRegStr HKCU'));
 assert.ok(install.indexOf('Call NearlyArchiveRepairState')>install.indexOf('NearlyApplyShortcut'));
 assert.ok(install.indexOf('Call NearlyArchiveRepairState')<install.indexOf('Call NearlyIoCleanup'));
 assert.match(body('.onGUIEnd'),/Call NearlyRepairCleanup/);
 assert.match(body('NearlyRepairFail'),/Call NearlyRepairCleanup/);
 assert.match(body('NearlyRepairFail'),/SetErrorLevel 6/);
 assert.doesNotMatch(body('NearlyOpenRepairState')+archive,/phase|owner-v3|OpenProcess|TerminateProcess/);
});
test('completed setup releases its mutation lease before the optional finish-page launch',()=>{
 const release=install.indexOf("kernel32::ReleaseMutex(p $NearlyMutationHandle)");
 assert.ok(release>install.indexOf('Call NearlyArchiveRepairState'));
 assert.ok(release>install.indexOf('Call NearlyIoCleanup'));
 assert.match(install.slice(release),/CloseHandle\(p \$NearlyMutationHandle\)/);
 assert.match(install.slice(release),/StrCpy \$NearlyMutationHandle 0/);
});
