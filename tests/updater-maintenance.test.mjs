import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL('../'+name, import.meta.url), 'utf8');
const gate = (source, declaration, condition) => {
  assert.match(source, new RegExp(`#\\[cfg\\(${condition}\\)\\]\\s+${declaration}`), declaration+' must be excluded from production');
};

test('retired protocol2 launcher and binding compile only for historical tests', () => {
  const handoff=read('src-tauri/src/update_handoff.rs');
  for(const declaration of ['pub struct LaunchedInstaller','impl LaunchedInstaller','fn spawn_installer','fn validate_sibling','fn validate_canonical_layout','fn validate_nonce','pub fn launch_verified_sibling']) gate(handoff,declaration,'test');
  gate(handoff,'mod native','all\\(test,\\s*windows\\)');
  const transaction=read('src-tauri/src/update_transaction_windows.rs');
  for(const declaration of ['pub\\(crate\\) fn bind_installer\\(','fn bind_native','struct ProcessGuard','impl Drop for ProcessGuard','fn launched_process']) gate(transaction,declaration,'test');
});

test('retired private ACL policy and its exclusive FFI are QA/test only', () => {
  const root=read('src-tauri/src/install_root.rs');
  const qa='any\\(test,\\s*feature\\s*=\\s*"installer-qa"\\)';
  for(const declaration of ['pub\\(crate\\) struct Trusted','impl Trusted','struct Local','impl Drop for Local','pub\\(crate\\) struct SecuritySnapshot','pub\\(crate\\) fn inspect_directory','pub\\(crate\\) fn require_unregistered','fn safe_security','fn safe_acl\\(','fn safe_acl_scope','fn dangerous_rights_at']) gate(root,declaration,qa);
  for(const name of ['GetSecurityInfo','ConvertStringSidToSidW','ConvertSidToStringSidW','ConvertSecurityDescriptorToStringSecurityDescriptorW','LookupAccountNameW','EqualSid','IsValidSid','GetLengthSid','GetAce','IsValidAcl','LocalFree']) gate(root,'fn '+name,qa);
});

test('current protocol3 entry points and shared failure proof remain in production', () => {
  const main=read('src-tauri/src/main.rs'), handoff=read('src-tauri/src/update_handoff.rs');
  assert.match(main,/update_handoff::launch_verified_recovery\(&prepared\)/);
  assert.match(main,/bind_recovery\(/);
  assert.match(handoff,/pub struct LaunchFailure/);
  assert.match(handoff,/pub\(crate\) fn installed_executable/);
  const installer=read('src-tauri/windows/installer.nsi');
  const refusal=installer.match(/Function NearlyWaitUpdateParent\r?\n([\s\S]*?)FunctionEnd/)[1];
  assert.match(refusal,/\$\{GetOptions\} \$0 "\/NEARLY" \$1/);
  assert.match(refusal,/SetErrorLevel 8\s+Abort "Unsupported or malformed update mode/);
});

test('installer CompanyName uses the same configured identity as installed-apps Publisher', () => {
  const config=JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.bundle.publisher,'Nearly');
  const installer=read('src-tauri/windows/installer.nsi');
  assert.match(installer,/!define MANUFACTURER "\{\{manufacturer\}\}"/);
  assert.match(installer,/VIAddVersionKey "CompanyName" "\$\{MANUFACTURER\}"/);
  assert.match(installer,/WriteRegStr HKCU "\$\{UNINSTKEY\}" "Publisher" "\$\{MANUFACTURER\}"/);
  assert.match(installer,/VIAddVersionKey "FileVersion" "\$\{PUBLICVERSION\}"/);
  assert.match(installer,/VIAddVersionKey "ProductVersion" "\$\{PUBLICVERSION\}"/);
});
