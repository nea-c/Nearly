import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('uninstall observer waits for actual maximum and rejects persistent partial progress or premature exit',{skip:process.platform!=='win32'},()=>{
  const script=String.raw`$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText($env:QA_TEST_SOURCE)
$begin=$source.IndexOf('  $completion=@{observed=')
$end=$source.IndexOf([char]10+'}'+[char]10+'function New-SharedEmptyDriveFixture',$begin)
if($end -lt 0){$end=$source.IndexOf([char]13+[char]10+'}'+[char]13+[char]10+'function New-SharedEmptyDriveFixture',$begin)}
if($begin -lt 0 -or $end -lt 0){throw 'Exact observer block required'}
$block=[scriptblock]::Create($source.Substring($begin,$end-$begin))
Add-Type -TypeDefinition @'
using System;
public static class NearlyOwnedUi {
 public static int Position,Maximum=30000;
 public static string Class(IntPtr h,int p){return h==(IntPtr)1?"Button":"msctls_progress32";}
 public static int GetDlgCtrlID(IntPtr h){return 1;}
 public static bool IsWindowEnabled(IntPtr h){return true;}
 public static string Text(IntPtr h,int p){return "Close";}
 public static IntPtr Send(IntPtr h,int p,int m,int w,int l){return (IntPtr)(m==1032?Position:Maximum);}
}
'@
function Owned-Windows($parent){return @([IntPtr]1,[IntPtr]2)}
function Click-Owned($parent,$id){if([NearlyOwnedUi]::Position -ne [NearlyOwnedUi]::Maximum){throw 'Early close'};$script:clicks++;$script:p.HasExited=$true}
function Wait-Condition($condition,$seconds){if($seconds -ne 60){throw 'Bounded wait changed'};foreach($sample in $script:samples){[NearlyOwnedUi]::Position=$sample;if(& $condition){return}};throw 'Bounded observation expired'}
foreach($case in @('advances','partial','premature','nonzero','invalid')){
 $script:clicks=0;$script:p=[pscustomobject]@{HasExited=($case -eq 'premature');ExitCode=$(if($case -eq 'nonzero'){9}else{0});Id=17};$main=[IntPtr]3;$Mode='Decline'
 [NearlyOwnedUi]::Maximum=if($case -eq 'invalid'){0}else{30000}
 $script:samples=if($case -eq 'partial'){@(0,12000,12000)}elseif($case -eq 'invalid'){@(0)}else{@(0,12000,30000,30000)}
 $rejected=$false;try{. $block}catch{$rejected=$true}
 if($case -eq 'advances'){if($rejected -or $script:clicks -ne 1){throw 'Advancing real progress was not accepted'}}
 elseif(!$rejected){throw "Invalid completion accepted: $case"}
 if($case -in @('partial','premature','invalid') -and $script:clicks -ne 0){throw 'Incomplete process was closed'}
}
'Pure uninstall observation cases passed'
`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QA_TEST_SOURCE:fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr||r.stdout);assert.match(r.stdout,/Pure uninstall observation cases passed/);
});
