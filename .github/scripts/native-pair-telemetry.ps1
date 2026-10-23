param([int]$OwnerPid,[string]$Output,[string]$StopFile)
$ErrorActionPreference='Stop'
# No command lines, environments, memory contents or unrelated process records.
$known=@{};$last=@{};$ownerStart=$null
try {
 while(!(Test-Path -LiteralPath $StopFile)) {
  $rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,WorkingSetSize)
  $owner=$rows|Where-Object ProcessId -eq $OwnerPid
  if(!$owner){break}
  if(!$ownerStart){$ownerStart=$owner.CreationDate}
  if($owner.CreationDate -ne $ownerStart){break}
  $ids=@{};$ids[$OwnerPid]=$true
  do {$changed=$false;foreach($p in $rows){if($ids.ContainsKey([int]$p.ParentProcessId) -and !$ids.ContainsKey([int]$p.ProcessId)){$ids[[int]$p.ProcessId]=$true;$changed=$true}}}while($changed)
  foreach($p in $rows|Where-Object {$ids.ContainsKey([int]$_.ProcessId)}){
   $key="$($p.ProcessId):$($p.CreationDate.ToUniversalTime().Ticks)"
   $last[$key]=@{pid=[int]$p.ProcessId;cpuSeconds=([double]$p.KernelModeTime+[double]$p.UserModeTime)/10000000;readBytes=[double]$p.ReadTransferCount;writeBytes=[double]$p.WriteTransferCount;workingSetBytes=[double]$p.WorkingSetSize}
  }
  $phaseFile=Join-Path (Split-Path -Parent $Output) 'phase.txt'
  $phase=if(Test-Path -LiteralPath $phaseFile){[IO.File]::ReadAllText($phaseFile)}else{'build'}
  @{at=[DateTime]::UtcNow.ToString('o');phase=$phase;owner=$OwnerPid;logicalProcessors=[Environment]::ProcessorCount;processes=@($last.Values)}|ConvertTo-Json -Depth 6 -Compress|Add-Content -LiteralPath $Output -Encoding utf8
  Start-Sleep -Seconds 4
 }
}catch {
 @{at=[DateTime]::UtcNow.ToString('o');unavailable=$true;reason=$_.Exception.GetType().Name}|ConvertTo-Json -Compress|Add-Content -LiteralPath $Output -Encoding utf8
}
