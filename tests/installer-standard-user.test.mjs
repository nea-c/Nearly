import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=new URL('../scripts/installer-qa-standard-user.ps1',import.meta.url);
const helper=new URL('../scripts/installer-qa-standard-user.cs',import.meta.url);
test('hosted launcher exists and gates exact repository, branch and SHA before native execution',async()=>{
  const source=await fs.readFile(script,'utf8').catch(()=>null);
  assert.ok(source,'Hosted standard-user launcher is missing');
  for(const marker of ['GuestScript','GuestArgumentsBase64','TimeoutSeconds','github-hosted','nea-c/Nearly','refs/heads/main','refs/heads/codex/private-install-directory','QA_CONTROLLER_SHA','QA_CONFIRMATION'])assert.ok(source.includes(marker),marker);
  assert.ok(source.indexOf('Exact hosted QA authorization required')<source.indexOf('Add-Type'));
});
test('launcher proves restricted medium same-user child before resuming and never changes ACLs',async()=>{
  const source=await fs.readFile(helper,'utf8').catch(()=>null);assert.ok(source,'Native standard-user launcher is missing');
  for(const marker of ['CreateRestrictedToken','SetTokenInformation','CreateProcessAsUserW','TokenElevation','TokenIntegrityLevel','SE_GROUP_USE_FOR_DENY_ONLY','winsta0\\default','CREATE_SUSPENDED','PROC_THREAD_ATTRIBUTE_HANDLE_LIST','ResumeThread','GetExitCodeProcess'])assert.ok(source.includes(marker),marker);
  assert.ok(source.indexOf('VerifyStandard(childToken')<source.indexOf('ResumeThread(child.hThread)'));
  assert.doesNotMatch(source,/SetNamedSecurityInfo|SetSecurityInfo|SetFileSecurity|LogonUser|CreateProcessWithLogon|net user|runas/i);
});
test('native launcher compiles and pure argument/token models run without invoking Windows launcher',{skip:process.platform!=='win32'},async()=>{
  const source=await fs.readFile(helper,'utf8').catch(()=>null);assert.ok(source,'Native standard-user launcher is missing');
  const command=`$ErrorActionPreference='Stop'\nAdd-Type -Path ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fileURLToPath(helper)).toString('base64')}')))\n[NearlyQaStandardUser]::PureSelfTest()\n'Pure standard-user launcher models passed'`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Pure standard-user launcher models passed/);
});
