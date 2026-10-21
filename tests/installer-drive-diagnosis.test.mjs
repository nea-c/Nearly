import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=new URL('../scripts/installer-qa-drive-diagnosis.ps1',import.meta.url);
test('drive diagnosis is definitions-only and exposes no mutation or caller-selected root',async()=>{
 const source=await fs.readFile(script,'utf8').catch(()=>null);assert.ok(source,'Read-only drive diagnosis missing');
 assert.match(source,/function Get-NearlyDriveRootDiagnosis/);
 assert.doesNotMatch(source,/Set-Acl|SetAccessControl|SetOwner|SetSecurity|New-Item|Remove-Item|Start-Process|Add-Type|Write-(?:Host|Output|Error)|\$env:|Get-ChildItem/i);
});
test('drive diagnosis sanitizes mocked metadata and bounded rules without inspecting host drive',{skip:process.platform!=='win32'},async()=>{
 const source=await fs.readFile(script,'utf8').catch(()=>null);assert.ok(source,'Read-only drive diagnosis missing');
 const path64=Buffer.from(fileURLToPath(script)).toString('base64');
 const code=`$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path64}'))
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count -ne 0 -or @($ast.EndBlock.Statements | Where-Object { $_ -isnot [Management.Automation.Language.FunctionDefinitionAst] }).Count -ne 0){throw 'Definitions only required'}
. $path
$rootRefused=$false;try{Read-NearlyDriveRootMetadata -Root 'C:\\' | Out-Null}catch{$rootRefused=$true};if(!$rootRefused){throw 'Non-D root admitted'}
$current='S-1-5-21-11-22-33-1001'
$cases=@{'S-1-5-18'='system';'S-1-5-32-544'='admin';'S-1-3-0'='creatorOwner';'S-1-3-4'='ownerRights';'S-1-1-0'='everyone';'S-1-5-11'='authenticatedUsers';'S-1-5-32-545'='builtinUsers';'S-1-15-2-123-456'='appContainer';'S-1-5-21-44-55-66-1001'='otherAccount';'foreign PRIVATE name'='other'}
$cases[$current]='currentUser'
foreach($sid in $cases.Keys){if((Get-NearlyDrivePrincipalClass $sid $current) -cne $cases[$sid]){throw 'Principal class mismatch'}}
$provider={param($root) if($root -cne 'D:\\'){throw 'Unexpected root'}; [pscustomobject]@{driveMetadataAvailable=$true;driveType=3;format='NTFS';attributesAvailable=$true;attributes=1024;securityAvailable=$true;ownerSid=$current;currentSid=$current;rules=@([pscustomobject]@{sid='S-1-1-0';mask=0x500C0040;type=0;inherited=$true;inheritance=3;propagation=0})}}
$result=Get-NearlyDriveRootDiagnosis -Provider $provider
$expectedKeys=@('schemaVersion','kind','driveMetadataAvailable','driveType','fixed','fileSystemFormat','attributesAvailable','reparsePoint','securityAvailable','ownerPrincipalClass','rules','aclOverflow','ruleDataInvalid')
if((@($result.PSObject.Properties.Name|Sort-Object)-join ',') -cne (($expectedKeys|Sort-Object)-join ',')){throw 'Unexpected schema fields'}
if(!$result.fixed -or $result.driveType -cne 'fixed' -or $result.fileSystemFormat -cne 'NTFS' -or !$result.reparsePoint -or $result.ownerPrincipalClass -cne 'currentUser' -or $result.rules.Count -ne 1 -or $result.rules[0].mask -ne 0x500C0040 -or $result.rules[0].accessType -cne 'allow' -or !$result.rules[0].inherited -or $result.rules[0].inheritanceFlags -ne 3){throw 'Mocked metadata mismatch'}
$json=$result|ConvertTo-Json -Depth 5 -Compress
if($json.Contains('S-1-') -or $json.Contains('PRIVATE') -or $json.Contains('D:')){throw 'Raw identity/path leaked'}
$many={param($root) [pscustomobject]@{driveMetadataAvailable=$true;driveType=4;format='ReFS';attributesAvailable=$true;attributes=16;securityAvailable=$true;ownerSid='PRIVATE';currentSid=$current;rules=@(1..70|ForEach-Object{[pscustomobject]@{sid='S-1-5-11';mask=-1;type=1;inherited=$false;inheritance=0;propagation=0}})}}
$bounded=Get-NearlyDriveRootDiagnosis -Provider $many
if($bounded.rules.Count -ne 64 -or !$bounded.aclOverflow -or $bounded.rules[0].mask -ne 4294967295 -or $bounded.rules[0].accessType -cne 'deny' -or $bounded.fileSystemFormat -cne 'ReFS' -or $bounded.driveType -cne 'network' -or $bounded.fixed){throw 'Rule bound/mask/type mismatch'}
$failure=Get-NearlyDriveRootDiagnosis -Provider {throw 'PRIVATE secret S-1-5-123 C:\\secret'}
if($failure.securityAvailable -or $failure.driveMetadataAvailable -or $failure.attributesAvailable -or $failure.rules.Count -ne 0 -or ($failure|ConvertTo-Json -Compress).Contains('PRIVATE')){throw 'Failure leaked or falsely succeeded'}
$invalid=Get-NearlyDriveRootDiagnosis -Provider {[pscustomobject]@{driveMetadataAvailable=$true;driveType=999;format='PRIVATE';attributesAvailable=$false;securityAvailable=$true;ownerSid='PRIVATE';currentSid='PRIVATE';rules=@([pscustomobject]@{sid='PRIVATE';mask=1;type=0;inherited=$false;inheritance=99;propagation=0})}}
if($invalid.driveType -cne 'unknown' -or $invalid.fileSystemFormat -cne 'other' -or $invalid.ownerPrincipalClass -cne 'other' -or !$invalid.ruleDataInvalid -or $invalid.rules.Count -ne 0 -or ($invalid|ConvertTo-Json -Compress).Contains('PRIVATE')){throw 'Malformed metadata unsafely represented'}
'Drive diagnosis mock models passed'`;
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Drive diagnosis mock models passed/);
});
