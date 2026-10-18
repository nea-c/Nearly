import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
const template=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const body=name=>template.match(new RegExp(`Function ${name.replaceAll('.','\\.')}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1];

test('normal and stage paths share one unambiguous embedded application record',()=>{
  assert.equal((template.match(/File "\/oname=\$\{MAINBINARYNAME\}\.exe" "\$\{MAINBINARYSRCPATH\}"/g)||[]).length,1);
  assert.equal((template.match(/Call NearlyExtractApplication/g)||[]).length,2);
  assert.match(body('NearlyExtractApplication'),/File "\/oname=\$\{MAINBINARYNAME\}\.exe"/);
});
test('protocol3 staging branches before ordinary install effects and has only two output files',()=>{
  const stage=body('NearlyStageUpdate');assert.ok(stage,'stage authentication branch exists');
  const extract=body('NearlyExtractStage');assert.ok(extract);
  assert.match(extract,/SetOutPath "\$NearlyStageDirectory"/);
  assert.match(extract,/Call NearlyExtractApplication/);
  assert.match(extract,/WriteUninstaller "\$NearlyStageDirectory\\uninstall\.exe"/);
  assert.doesNotMatch(extract,/WriteReg|DeleteReg|CreateShortcut|RunAsUser|Delete |RMDir/i);
  const init=body('.onInit');assert.ok(init.indexOf('Call NearlyStageUpdate')<init.indexOf('Call NearlyLoadPreferences'));
  const section=template.match(/Section Install\r?\n([\s\S]*?)SectionEnd/)[1];
  assert.ok(section.indexOf('Call NearlyExtractStage')<section.indexOf('CreateDirectory'));
  assert.match(section,/Call NearlyExtractStage\s+Return/);
  const success=body('.onInstSuccess');assert.match(success,/NearlyUpdateMode = 3\s+Return/);
});
test('stage parser uses canonical complete arguments and exact retained helper identity',()=>{
  const stage=body('NearlyStageUpdate');assert.ok(stage);
  assert.match(stage,/StrCmp \$NearlyProtocol "3"/);
  assert.match(stage,/StrCmp \$0 \$1 0 nearly_stage_reject/);
  assert.match(stage,/GetProcessTimes/);assert.match(stage,/QueryFullProcessImageNameW/);
  assert.match(stage,/NearlyStageAuthorize/);assert.match(stage,/NearlyStageReady/);
  assert.match(stage,/previous-image\.exe/);
  assert.match(stage,/\.Nearly-update-state\\\$NearlyReady\\candidate/);
  assert.doesNotMatch(stage,/WriteReg|CreateShortcut|RunAsUser|TerminateProcess/);
});
test('legacy updater modes are rejected and ordinary install plus uninstall share native mutex',()=>{
  const old=body('NearlyWaitUpdateParent');assert.match(old,/SetErrorLevel 8\s+Abort/);
  assert.doesNotMatch(old,/OpenProcess|SetEvent|RunAsUser/);
  assert.match(body('.onInit'),/Call NearlyAcquireMutation/);
  assert.match(body('un.onInit'),/Call un.NearlyAcquireMutation/);
  assert.match(template,/NearlyInstallMutation-local\.syncfiles\.native-v3/);
  assert.match(template,/CreateMutexW\(p 0, i 1, w "Global\\NearlyInstallMutation-local\.syncfiles\.native-v3"/);
});
