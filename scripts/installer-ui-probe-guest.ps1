param([Parameter(Mandatory)][string]$RunRoot,[switch]$Boundary)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function New-ProbeEvent([string]$Phase,[string]$Event,[int]$Code) {
  if ($Phase -cnotin @('boundary','installed','seed','reinstall','uninstall','uninstall-wait','verify','complete') -or $Event -cnotin @('start','exit','verified','failure') -or $Code -lt -1 -or $Code -gt 65535) { throw 'Unsupported lifecycle diagnostic' }
  return [ordered]@{phase=$Phase;event=$Event;code=$Code}
}
function Write-ProbeEvent([string]$Phase,[string]$Event,[int]$Code=-1) {
  $script:phase=$Phase
  Write-Host ('Mock lifecycle: ' + (ConvertTo-Json -InputObject (New-ProbeEvent $Phase $Event $Code) -Compress))
}
function Assert-Path([string]$Path) {
  if ($Path -cnotmatch '\A[A-Za-z]:\\' -or $Path.Contains('/') -or $Path.Substring(2).Contains(':') -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'Invalid lifecycle path' }
  $cursor=$Path
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse lifecycle path refused' }
    $parent=Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }; $cursor=$parent
  }
}
function Assert-Regular([string]$Path,[long]$Maximum=67108864) {
  Assert-Path $Path
  $item=Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt $Maximum) { throw 'Invalid lifecycle file' }
}
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'nea-c/Nearly' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cne 'refs/heads/main') { throw 'Manual hosted lifecycle guest required' }
if ($env:QA_CONTROLLER_SHA -cnotmatch '\A[a-f0-9]{40}\z' -or $env:GITHUB_SHA -cne $env:QA_CONTROLLER_SHA -or $env:GITHUB_WORKFLOW_SHA -cne $env:QA_CONTROLLER_SHA -or $env:QA_CONFIRMATION -cne "installer-qa $env:QA_CONTROLLER_SHA") { throw 'Exact lifecycle SHA confirmation required' }
$expectedKind=if ($Boundary) { 'boundary' } else { 'lifecycle' }
if ($env:GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '\A[1-9][0-9]*\z' -or $env:QA_DESTINATION -cne 'custom' -or $env:QA_SCENARIO -cne 'success' -or $env:QA_UI_PROBE -cne 'navigation-only' -or $env:QA_PROBE_KIND -cne $expectedKind -or $env:QA_PROBE_NAVIGATION -cnotin @('Click','Command') -or ($Boundary -and $env:QA_PROBE_NAVIGATION -cne 'Command') -or [Environment]::GetEnvironmentVariables().Contains('SYNCFILES_CONFIG_DIR')) { throw 'Explicit lifecycle diagnostic context required' }
foreach ($value in @($env:RUNNER_TEMP,$env:LOCALAPPDATA,$RunRoot)) { Assert-Path $value }
if ($RunRoot -cne (Join-Path $env:RUNNER_TEMP "nearly-installer-qa-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT")) { throw 'Exact lifecycle run root required' }
$install=Join-Path $env:LOCALAPPDATA "Nearly Installer QA $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT\日本語 space\Nearly"
$planFile=Join-Path $RunRoot 'plan.json'; Assert-Regular $planFile 16384
$plan=Get-Content -LiteralPath $planFile -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 2 -or $plan.controllerSha -cne $env:GITHUB_SHA -or $plan.runId -cne $env:GITHUB_RUN_ID -or $plan.runAttempt -cne $env:GITHUB_RUN_ATTEMPT -or $plan.runRoot -cne $RunRoot -or $plan.destinationKind -cne 'custom' -or $plan.installRoot -cne $install -or $plan.destinations.custom -cne $install) { throw 'Owned lifecycle plan required' }
if ($plan.destinations.default -cne (Join-Path $env:LOCALAPPDATA 'Nearly') -or $plan.destinations.drive -cne "D:\Nearly QA 日本語 $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT") { throw 'Owned diagnostic destination table required' }
if ($Boundary) { $install=$plan.destinations.drive }
Assert-Path $install
$setup=Join-Path $RunRoot 'diagnostic-setup.exe'
$mock=Join-Path $RunRoot 'mock-payload.exe'
$exe=Join-Path $install 'Nearly.exe'
$uninstaller=Join-Path $install 'uninstall.exe'
$registration='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native'
$preferences='HKCU:\Software\local.syncfiles.native\Installer'
$startDirectory=Join-Path ([Environment]::GetFolderPath('Programs')) 'Nearly'
$startShortcut=Join-Path $startDirectory 'Nearly.lnk'
$desktopShortcut=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Nearly.lnk'
$names=@('settings.json','history.json','bookmarks.json','sync-profiles.json','connections.json')
$hashes=@{}
function Assert-NoApp {
  if (@(Get-Process -Name Nearly -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Mock image must never launch' }
}
function Assert-Choices {
  $prefs=Get-ItemProperty -LiteralPath $preferences
  if ($prefs.StartMenuShortcut -ne 0 -or $prefs.DesktopShortcut -ne 0) { throw 'Mock shortcut choices changed' }
  foreach ($shortcut in @($startShortcut,$desktopShortcut)) { Assert-Path $shortcut; if (Test-Path -LiteralPath $shortcut) { throw 'Unselected mock shortcut exists' } }
}
function Assert-Installed {
  Assert-NoApp
  foreach ($file in @($exe,$uninstaller)) { Assert-Regular $file }
  if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $mock -Algorithm SHA256).Hash) { throw 'Installed mock bytes differ' }
  $r=Get-ItemProperty -LiteralPath $registration
  if ($r.NearlyOwner -cne 'local.syncfiles.native' -or $r.NearlyInternalVersion -cne '1.9.0' -or $r.DisplayVersion -cne 'r1.9' -or $r.InstallLocation -ine $install -or $r.UninstallString -cne ('"'+$uninstaller+'"')) { throw 'Owned mock registration changed' }
  Assert-Choices
}
function Assert-Settings {
  foreach ($leaf in $hashes.Keys) {
    $file=Join-Path $install $leaf; Assert-Regular $file 1048576
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -cne $hashes[$leaf]) { throw 'Generated mock settings bytes changed' }
  }
}
function Invoke-Phase([string]$Phase,[string]$File) {
  Assert-NoApp; Assert-Regular $File
  Write-ProbeEvent $Phase 'start'
  $process=Start-Process -FilePath $File -ArgumentList @('/S') -PassThru -WindowStyle Hidden
  if (!$process.WaitForExit(120000)) { throw 'Mock lifecycle child timeout' }
  Write-ProbeEvent $Phase 'exit' $process.ExitCode
  if ($process.ExitCode -ne 0) { throw 'Mock lifecycle child failed' }
}
if ($Boundary) {
  try {
    Write-ProbeEvent 'boundary' 'start'
    $reportFile=Join-Path $RunRoot 'ui-evidence\probe-drive\evidence.json'; Assert-Regular $reportFile 65536
    $report=Get-Content -LiteralPath $reportFile -Raw | ConvertFrom-Json
    if ($report.schemaVersion -ne 1 -or $report.case -cne 'probe-drive' -or $report.mode -cne 'Drive' -or $report.destinationKind -cne 'drive' -or $report.result -cnotin @('installed','rejected')) { throw 'Exact boundary UI evidence required' }
    Assert-NoApp
    foreach ($otherRoot in @($plan.destinations.default,$plan.destinations.custom)) { Assert-Path $otherRoot; if (Test-Path -LiteralPath $otherRoot) { throw 'Boundary changed another destination' } }
    if ($report.result -ceq 'rejected') {
      foreach ($target in @($install,$registration,$preferences,$startDirectory,$desktopShortcut)) { if (Test-Path -LiteralPath $target) { throw 'Rejected boundary mutated owned state' } }
    } else {
      Assert-Regular $mock 80
      Assert-Installed
    }
    Write-ProbeEvent 'boundary' 'verified' 0
  } catch {
    Write-ProbeEvent 'boundary' 'failure'
    throw 'Mock boundary postconditions failed'
  }
  return
}
$script:phase='installed'
try {
  Write-ProbeEvent 'installed' 'start'
  Assert-Regular $setup; Assert-Regular $mock 80
  $bytes=[IO.File]::ReadAllBytes($mock)
  if ($bytes.Length -ne 80 -or [BitConverter]::ToUInt16($bytes,0) -ne 0x5a4d -or [BitConverter]::ToUInt32($bytes,60) -ne 64 -or [BitConverter]::ToUInt32($bytes,64) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,68) -ne 0x8664) { throw 'Invalid nonlaunchable mock fixture' }
  Assert-Installed
  $originalCreated=(Get-Item -LiteralPath $install -Force).CreationTimeUtc.Ticks
  Write-ProbeEvent 'installed' 'verified' 0
  Write-ProbeEvent 'seed' 'start'
  foreach ($name in $names) {
    $source=Join-Path $RunRoot "settings\$name"; Assert-Regular $source 1048576
    $json=Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
    if ($json.metadata.installerQa -cne 'generated-offline-fixture') { throw 'Generated settings marker required' }
    foreach ($leaf in @($name,($name -replace '\.json$','.backup.json'))) {
      $destination=Join-Path $install $leaf; Assert-Path $destination
      if (Test-Path -LiteralPath $destination) { throw 'Unexpected preexisting mock settings' }
      Copy-Item -LiteralPath $source -Destination $destination
      $hashes[$leaf]=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    }
  }
  Assert-Settings; Write-ProbeEvent 'seed' 'verified' 0
  Invoke-Phase 'reinstall' $setup
  Assert-Installed; Assert-Settings
  if ((Get-Item -LiteralPath $install -Force).CreationTimeUtc.Ticks -ne $originalCreated) { throw 'Original mock root replaced' }
  Write-ProbeEvent 'reinstall' 'verified' 0
  Invoke-Phase 'uninstall' $uninstaller
  Write-ProbeEvent 'uninstall-wait' 'start'
  # NSIS uninstall may relay through an owned temporary child: parent exit 0
  # alone proves nothing. Wait for exact owned state removal without launching it.
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  do {
    $removed=!(Test-Path -LiteralPath $exe) -and !(Test-Path -LiteralPath $uninstaller) -and !(Test-Path -LiteralPath $registration)
    if ($removed) { break }; Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (!$removed) { throw 'Mock uninstall state timeout' }
  Write-ProbeEvent 'uninstall-wait' 'verified' 0
  Write-ProbeEvent 'verify' 'start'
  Assert-NoApp; Assert-Path $install; Assert-Settings; Assert-Choices
  if (!(Test-Path -LiteralPath $install) -or (Get-Item -LiteralPath $install -Force).CreationTimeUtc.Ticks -ne $originalCreated -or $hashes.Count -ne 10) { throw 'Original settings root was not preserved' }
  Write-ProbeEvent 'verify' 'verified' 0
  Write-ProbeEvent 'complete' 'verified' 0
} catch {
  Write-ProbeEvent $script:phase 'failure'
  throw 'Mock lifecycle diagnostic failed; inspect fixed phase/exit records'
}
