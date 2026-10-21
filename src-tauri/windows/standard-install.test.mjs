import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const text=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const functionBody=name=>text.match(new RegExp(`Function ${name}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1]??'';
test('ordinary non-elevated install has no private-leaf preparation or helper dependency',()=>{
 assert.match(text,/RequestExecutionLevel user/);
 assert.doesNotMatch(text,/--nearly-install-(?:check|prepare)|NearlyEnsurePolicyHelper|NearlyCheckFreshPlan|NearlyPrepareFreshRoot|NearlyProtectExisting|NearlyProtectNew/);
 const section=text.slice(text.indexOf('Section Install'),text.indexOf('SectionEnd',text.indexOf('Section Install')));
 assert.match(section,/CreateDirectory "\$INSTDIR"/);
 assert.match(section,/Call NearlyPinRoot/);
 assert.match(section,/0x40010000/,'write access is probed using create-new delete-on-close');
 assert.doesNotMatch(text,/SetSecurityInfo|SetNamedSecurity|NtSetInformationFile|\.Nearly-preserved-/);
});
test('all installer lifecycle entries retain namespace and regular-file checks without ACL ownership admission',()=>{
 assert.doesNotMatch(text,/Function \$\{prefix\}NearlyCheckAcl|Call \$\{prefix\}NearlyCheckAcl/);
 const pin=functionBody('\\$\\{prefix\\}NearlyPinDirectory');
 for(const api of ['GetFileInformationByHandle','GetFinalPathNameByHandleW'])assert.ok(pin.includes(api));
 assert.match(pin,/0x81/);assert.match(pin,/i 3, p 0, i 3, i 0x02200000/);
 const payload=functionBody('\\$\\{prefix\\}NearlyValidatePayload');
 assert.match(payload,/NumberOfLinks must be single-link/);
 assert.match(payload,/0x410/);
 assert.match(functionBody('un.onInit'),/Call un.NearlyPinRoot/);
 assert.match(functionBody('un.onInit'),/Call un.NearlyVerifyUninstallerImage/);
 assert.match(text,/Call NearlyValidatePayloads/);
});
test('custom destination reinstalls preserve the same known settings as the default',()=>{
 const contents=functionBody('NearlyRequireFreshContents');
 assert.doesNotMatch(contents,/StrCmp \$INSTDIR \$NearlyDefaultRoot/);
 for(const name of ['settings.json','settings.backup.json','history.json','connections.json','bookmarks.json','sync-profiles.json'])assert.ok(contents.includes(name));
 assert.match(contents,/Abort "\$\(NearlyExistingFiles\)"/);
 const uninstall=text.slice(text.indexOf('Section Uninstall'));
 assert.doesNotMatch(uninstall,/Delete .*\.json|RMDir \/r/);
});
