import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/installer-qa-root-inventory.ps1',import.meta.url));
test('diagnosis workflow is one isolated read-only guest and preserves the ordinary seven guests',()=>{
 const text=fs.readFileSync(new URL('../.github/workflows/installer-qa-windows.yml',import.meta.url),'utf8');
 assert.match(text,/diagnosis_only:\s+description:[^\n]+\s+type: boolean\s+default: false/);
 const diagnosis=text.match(/^  root-diagnosis:\r?\n([\s\S]*?)(?=^  guest:)/m)?.[1];assert.ok(diagnosis);
 assert.match(diagnosis,/if: inputs\.diagnosis_only &&/);assert.match(diagnosis,/runs-on: windows-2025/);
 assert.doesNotMatch(diagnosis,/matrix:|prepare-windows|installer-qa\.mjs (?:preflight|guard-probe|run|production)|npm ci|cargo|rustup|Start-Process|Set-Acl|upload-artifact|GH_TOKEN/);
 assert.match(diagnosis,/actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
 assert.match(diagnosis,/ref: \$\{\{ github\.workflow_sha \}\}/);assert.match(diagnosis,/persist-credentials: false/);
 assert.match(diagnosis,/actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
 const validation=diagnosis.indexOf('validateContext(process.env)');const invocation=diagnosis.indexOf('$inventory=Get-NearlyHostedRootInventory');
 assert.ok(validation>0&&invocation>validation);assert.match(diagnosis,/if \(\$LASTEXITCODE -ne 0\)/);
 assert.match(diagnosis,/if \(!\$inventory.complete\)/);
 const guest=text.slice(text.indexOf('  guest:'));
 assert.match(guest,/if: [^\r\n]+&& !inputs\.diagnosis_only/);
 assert.match(guest,/phase: \[candidate\]/);assert.match(guest,/scenario: \[success, health-failure\]/);
 const destinations=/destination: \$\{\{ fromJSON\(inputs\.root_coverage_only && '([^']+)' \|\| '([^']+)'\) \}\}/.exec(guest);
 const included=/include: \$\{\{ fromJSON\(inputs\.root_coverage_only && '([^']+)' \|\| '([^']+)'\) \}\}/.exec(guest);
 assert.ok(destinations&&included);
 assert.deepEqual(JSON.parse(destinations[2]),['default','custom','drive']);assert.deepEqual(JSON.parse(included[2]),[{phase:'production',scenario:'success',destination:'default'}]);
 assert.deepEqual(JSON.parse(destinations[1]),['drive-c']);assert.deepEqual(JSON.parse(included[1]),[]);
});

test('mocked root inventory bounds SID, ACL and roots without reading local drives',{skip:process.platform!=='win32'},()=>{
 assert.ok(fs.existsSync(script),'definitions-only inventory script missing');
 const source=String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('__SCRIPT__',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Inventory parse error'}
foreach($name in @('Assert-NearlyInventorySid','Get-NearlyInventoryPrincipalClass','ConvertTo-NearlyRootEvidence','Get-NearlyRootInventory')){
 $fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
 if($fn.Count -ne 1){throw 'Inventory function missing'};Invoke-Expression $fn[0].Extent.Text
}
# OS readers are deliberately not loaded, called or mocked through host access.
$script:reads=0;$script:fixture=$null
$reader={param($root)if($root -cnotin @('C:\','D:\')){throw 'Nonroot read'};$script:reads++;return $script:fixture}
$user='S-1-5-21-100-200-300-1001'
function Fixture {
 $script:fixture=[pscustomobject]@{DriveType='Fixed';Ready=$true;Format='NTFS';Attributes=16;OwnerSid='S-1-5-18';Rules=@(
  [pscustomobject]@{Sid=$user;Mask=2032127;Type='Allow';Inheritance=3;Propagation=0},
  [pscustomobject]@{Sid='S-1-5-32-544';Mask=2032127;Type='Allow';Inheritance=3;Propagation=0},
  [pscustomobject]@{Sid='S-1-1-0';Mask=1;Type='Deny';Inheritance=0;Propagation=0},
  [pscustomobject]@{Sid='S-1-5-21-900-800-700-1002';Mask=4294967295;Type='Allow';Inheritance=3;Propagation=2}
 )}
}
Fixture;$r=Get-NearlyRootInventory -Roots @('C:\','D:\') -CurrentUserSid $user -ReadMetadata $reader
if(!$r.complete -or $r.roots.Count -ne 2 -or $reads -ne 2 -or $r.roots[1].ownerSid -cne 'S-1-5-18' -or !$r.roots[1].trustedOwner -or $r.roots[1].currentUserOwner){throw 'Exact root owner evidence incorrect'}
if($r.roots[0].aces[0].principal -cne 'current-user' -or $r.roots[0].aces[1].principal -cne 'administrators' -or $r.roots[0].aces[2].principal -cne 'everyone' -or $r.roots[0].aces[3].principal -cne 'other' -or $r.roots[0].aces[3].mask -ne 4294967295){throw 'Bounded ACE classes/masks incorrect'}
$json=ConvertTo-Json $r -Depth 8 -Compress
if($json.Contains($user) -or $json.Contains('900-800-700') -or $json.Contains('runneradmin')){throw 'ACE identity or account name leaked'}
foreach($sid in @($user,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464','S-1-5-21-900-800-700-1002')){
 Fixture;$fixture.OwnerSid=$sid;$r=Get-NearlyRootInventory -Roots @('D:\') -CurrentUserSid $user -ReadMetadata $reader
 if(!$r.complete -or $r.roots[0].ownerSid -cne $sid -or $r.roots[0].currentUserOwner -ne ($sid -ceq $user) -or $r.roots[0].trustedOwner -ne ($sid -cne 'S-1-5-21-900-800-700-1002')){throw 'Owner classification incorrect'}
}
# A maximum-size canonical SID is 184 chars (48-bit authority, 15 uint32 subauthorities).
$maximum='S-1-281474976710655'+('-4294967295'*15)
Assert-NearlyInventorySid $maximum
Fixture;$fixture.OwnerSid=$maximum;$r=Get-NearlyRootInventory -Roots @(('D:'+[char]92)) -CurrentUserSid $user -ReadMetadata $reader
if(!$r.complete -or $r.roots[0].ownerSid.Length -ne 184){throw '184-character valid owner SID rejected'}
foreach($bad in @('',('S'*185),('S-1-5-18'+[char]10),'S-1-05-18','S-1-5-4294967296','S-1-281474976710656-1','S-2-5-18')){
 Fixture;$fixture.OwnerSid=$bad;$r=Get-NearlyRootInventory -Roots @('D:\') -CurrentUserSid $user -ReadMetadata $reader
 if($r.complete -or $r.roots[0].state -cne 'unavailable' -or (ConvertTo-Json $r -Depth 8 -Compress).Contains($bad) -and $bad.Length -gt 0){throw 'Malformed owner SID accepted or leaked'}
}
Fixture;$fixture.Rules=@($fixture.Rules[0])*64;$r=Get-NearlyRootInventory -Roots @('D:\') -CurrentUserSid $user -ReadMetadata $reader
if(!$r.complete -or $r.roots[0].aces.Count -ne 64){throw '64 ACE boundary rejected'}
foreach($kind in @('tooManyAces','badPrincipal','badMask','badFlags','badType','missingOwner','badFormat','notFixed','notReady','missingMetadata','throwing')){
 Fixture
 switch($kind){
  'tooManyAces'{$fixture.Rules=@($fixture.Rules[0])*65}
  'badPrincipal'{$fixture.Rules[0].Sid='sensitive account name'}
  'badMask'{$fixture.Rules[0].Mask=-1}
  'badFlags'{$fixture.Rules[0].Inheritance=4}
  'badType'{$fixture.Rules[0].Type='Unknown'}
  'missingOwner'{$fixture.PSObject.Properties.Remove('OwnerSid')}
  'badFormat'{$fixture.Format='sensitive/path'}
  'notFixed'{$fixture.DriveType='Network'}
  'notReady'{$fixture.Ready=$false}
  'missingMetadata'{$script:fixture=$null}
 }
 $activeReader=if($kind -eq 'throwing'){{param($root)throw 'sensitive path exception'}}else{$reader}
 $r=Get-NearlyRootInventory -Roots @('D:\') -CurrentUserSid $user -ReadMetadata $activeReader
 if($r.complete -or $r.roots[0].state -cne 'unavailable' -or (ConvertTo-Json $r -Depth 8 -Compress) -match 'sensitive|account|exception'){throw ('Invalid metadata did not fail closed: '+$kind)}
}
foreach($badRoots in @(@('D:\leaf'),@(([string][char]92+[char]92+'server'+[char]92+'share')),@('d:\'),@('D:\','D:\'),(@('D:\')*27),@())){
 $before=$reads;$rejected=$false
 try{Get-NearlyRootInventory -Roots $badRoots -CurrentUserSid $user -ReadMetadata $reader}catch{$rejected=$true}
 if(!$rejected -or $reads -ne $before){throw 'Invalid root scope read metadata'}
}
Fixture
$allRoots=@(65..90 | ForEach-Object {([char]$_).ToString()+':'+[char]92})
$r=Get-NearlyRootInventory -Roots $allRoots -CurrentUserSid $user -ReadMetadata {param($root)return $script:fixture}
if(!$r.complete -or $r.roots.Count -ne 26){throw '26-root boundary rejected'}
$r=Get-NearlyRootInventory -Roots @(('C:'+[char]92),('D:'+[char]92)) -CurrentUserSid $user -ReadMetadata {param($root)if($root -ceq ('C:'+[char]92)){return $script:fixture};throw 'sensitive path exception'}
if($r.complete -or $r.roots[0].state -cne 'available' -or $r.roots[1].state -cne 'unavailable'){throw 'Partial inventory failure was reported complete'}
'Mocked root inventory contract passed'
`.replace('__SCRIPT__',script.replaceAll("'","''"));
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command','& ([scriptblock]::Create([Console]::In.ReadToEnd()))'],{input:source,encoding:'utf8',windowsHide:true,timeout:60000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Mocked root inventory contract passed/);
});

test('inventory has definitions only and its OS reader only reads existing fixed root metadata',{skip:process.platform!=='win32'},()=>{
 const text=fs.readFileSync(script,'utf8');
 assert.doesNotMatch(text,/Set-Acl|SetAccessRule|SetOwner|CreateDirectory|New-Item|Remove-Item|Get-ChildItem|Start-Process|Add-Type|DllImport|Translate\(|\.Owner\b/);
 assert.match(text,/GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
 assert.match(text,/GetAccessRules\(\$true,\$true,\[Security\.Principal\.SecurityIdentifier\]\)/);
 assert.match(text,/\[IO\.DriveInfo\]::GetDrives\(\)/);
 const source=String.raw`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('__SCRIPT__',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Inventory parse error'}
foreach($statement in $ast.EndBlock.Statements){if($statement -isnot [Management.Automation.Language.FunctionDefinitionAst]){throw 'Inventory entrypoint must contain definitions only'}}
'Definitions-only inventory parsed'
`.replace('__SCRIPT__',script.replaceAll("'","''"));
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',source],{encoding:'utf8',windowsHide:true,timeout:60000});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
