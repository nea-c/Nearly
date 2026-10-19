param(
  [Parameter(Mandatory)][ValidateSet('preflight','extract','production','source','launch','verify','uninstall')][string]$Action,
  [Parameter(Mandatory)][string]$RunRoot,
  [string]$Setup,
  [string]$ExpectedPayload,
  [string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

# This file is never invoked by unit tests. Every entrypoint requires the same
# explicit manual guest authorization; a path alone does not authorize mutation.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'nea-c/Nearly' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cne 'refs/heads/main') { throw 'Manual hosted Windows guest required' }
if ($env:QA_CONTROLLER_SHA -cnotmatch '\A[a-f0-9]{40}\z' -or $env:GITHUB_SHA -cne $env:QA_CONTROLLER_SHA -or $env:GITHUB_WORKFLOW_SHA -cne $env:QA_CONTROLLER_SHA -or $env:QA_CONFIRMATION -cne "installer-qa $env:QA_CONTROLLER_SHA") { throw 'Exact SHA confirmation required' }
if ($env:GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '\A[1-9][0-9]*\z' -or !$env:RUNNER_TEMP -or !$env:LOCALAPPDATA -or $env:SYNCFILES_CONFIG_DIR) { throw 'Unexpected run/storage context' }
$expectedRoot = Join-Path $env:RUNNER_TEMP "nearly-installer-qa-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if ($RunRoot -cne $expectedRoot) { throw 'Exact run root required' }
$install = Join-Path $env:LOCALAPPDATA 'Nearly'
$exe = Join-Path $install 'Nearly.exe'
$uninstaller = Join-Path $install 'uninstall.exe'
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native'
$preferences = 'HKCU:\Software\local.syncfiles.native\Installer'
$startDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nearly'
$startShortcut = Join-Path $startDirectory 'Nearly.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Nearly.lnk'
$names = @('settings.json','history.json','bookmarks.json','sync-profiles.json','connections.json')

function Assert-LocalPath([string]$Path) {
  if ($Path -cnotmatch '\A[A-Za-z]:\\' -or $Path.Contains('/') -or $Path.Substring(2).Contains(':') -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'Canonical local path required' }
  $cursor = $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path refused' }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
foreach ($owned in @($RunRoot,$install,$startDirectory,$desktopShortcut)) { Assert-LocalPath $owned }
function Assert-Regular([string]$Path) {
  Assert-LocalPath $Path
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 67108864) { throw 'Bounded regular file required' }
}
function Assert-UnderRun([string]$Path) {
  Assert-Regular $Path
  if (!$Path.StartsWith($RunRoot + '\',[StringComparison]::Ordinal)) { throw 'Input outside owned run root' }
}
function Wait-Condition([scriptblock]$Condition,[int]$Seconds=30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) { if (& $Condition) { return }; Start-Sleep -Milliseconds 250 }
  throw 'Bounded guest state wait timed out; evidence retained'
}
function Invoke-Bounded([string]$File,[string[]]$Arguments) {
  Assert-Regular $File
  $p = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  if (!$p.WaitForExit(120000)) { throw 'Installer process timeout; runner retained for failure evidence' }
  if ($p.ExitCode -ne 0) { throw "Installer exited with $($p.ExitCode)" }
}
function Assert-NoApp {
  foreach ($p in @(Get-Process -Name Nearly -ErrorAction SilentlyContinue)) { throw 'Nearly process already running' }
}
function Assert-Registration([string]$Version) {
  $r = Get-ItemProperty -LiteralPath $registration
  if ($r.NearlyOwner -cne 'local.syncfiles.native' -or $r.InstallLocation -ine $install -or $r.NearlyInternalVersion -cne $Version -or $r.DisplayVersion -cne ('r' + ($Version -replace '\.0$','')) -or $r.UninstallString -cne ('"' + $uninstaller + '"')) { throw 'Installed registration/version mismatch' }
}
function Assert-Payload([string]$Digest,[string]$Version) {
  if ($Digest -cnotmatch '\A[a-f0-9]{64}\z') { throw 'Expected payload hash required' }
  Assert-Regular $exe; Assert-Regular $uninstaller
  if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Digest) { throw 'Installed executable hash mismatch' }
  $actual = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
  if ($actual -cne $Version -and $actual -cne ($Version + '.0')) { throw 'Installed executable resource version mismatch' }
  Assert-Registration $Version
}
function Assert-Shortcuts([int]$Start,[int]$Desktop) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($pair in @(@($startShortcut,$Start),@($desktopShortcut,$Desktop))) {
    $exists = Test-Path -LiteralPath $pair[0]
    if ($exists -ne [bool]$pair[1]) { throw 'Shortcut choice was not preserved' }
    if ($exists) { Assert-Regular $pair[0]; if ($shell.CreateShortcut($pair[0]).TargetPath -ine $exe) { throw 'Shortcut targets foreign executable' } }
  }
  $prefs = Get-ItemProperty -LiteralPath $preferences
  if ($prefs.StartMenuShortcut -ne $Start -or $prefs.DesktopShortcut -ne $Desktop) { throw 'Shortcut preference registration differs' }
}
function Normalize-JsonValue($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $normalized=[ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object -Property Name -CaseSensitive)) { $normalized[$property.Name]=Normalize-JsonValue $property.Value }
    return $normalized
  }
  if ($Value -is [array]) { return ,@($Value | ForEach-Object { Normalize-JsonValue $_ }) }
  return $Value
}
function Assert-Settings([bool]$Exact) {
  foreach ($name in $names) {
    $primary = Join-Path $install $name
    $backup = Join-Path $install ($name -replace '\.json$','.backup.json')
    foreach ($file in @($primary,$backup)) {
      Assert-Regular $file
      $json = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      if ($json.metadata.installerQa -cne 'generated-offline-fixture') { throw 'Generated settings metadata lost' }
      if ($Exact -and (Get-FileHash -LiteralPath $file).Hash -cne (Get-FileHash -LiteralPath (Join-Path $RunRoot "settings\$name")).Hash) { throw 'Setup/uninstall changed adjacent settings bytes' }
    }
  }
  if (!$Exact) {
    $s = Get-Content -LiteralPath (Join-Path $install 'settings.json') -Raw | ConvertFrom-Json
    if ($s.appearance.theme -cne 'dark' -or $s.appearance.language -cne 'en') { throw 'Appearance settings changed' }
    foreach ($name in $names | Select-Object -Skip 1) {
      $v = Get-Content -LiteralPath (Join-Path $install $name) -Raw | ConvertFrom-Json
      $reference = $s.manifest.PSObject.Properties[$name].Value
      if ($reference.sha256 -cne (Get-FileHash -LiteralPath (Join-Path $install $name) -Algorithm SHA256).Hash.ToLowerInvariant() -or $reference.revision -ne $v.revision) { throw 'Settings integrity manifest mismatch' }
      $baseline = Get-Content -LiteralPath (Join-Path $RunRoot "settings\$name") -Raw | ConvertFrom-Json
      foreach ($property in $baseline.PSObject.Properties | Where-Object { $_.Name -notin @('schemaVersion','kind','revision') }) {
        $actual=ConvertTo-Json -InputObject (Normalize-JsonValue $v.($property.Name)) -Depth 50 -Compress
        $expected=ConvertTo-Json -InputObject (Normalize-JsonValue $property.Value) -Depth 50 -Compress
        if ($actual -cne $expected) { throw 'Persistent settings content changed during update' }
      }
    }
  }
}
function Seed-Settings {
  New-Item -ItemType Directory -Path $install -Force | Out-Null
  foreach ($name in $names) {
    $inputFile = Join-Path $RunRoot "settings\$name"; Assert-UnderRun $inputFile
    foreach ($leaf in @($name,($name -replace '\.json$','.backup.json'))) { $destination=Join-Path $install $leaf; Assert-LocalPath $destination; Copy-Item -LiteralPath $inputFile -Destination $destination -Force }
  }
}
function Set-Choices([int]$Start,[int]$Desktop) {
  New-Item -Path $preferences -Force | Out-Null
  New-ItemProperty -LiteralPath $preferences -Name StartMenuShortcut -PropertyType DWord -Value $Start -Force | Out-Null
  New-ItemProperty -LiteralPath $preferences -Name DesktopShortcut -PropertyType DWord -Value $Desktop -Force | Out-Null
}
function Uninstall-Owned([bool]$Exact) {
  Assert-NoApp
  Invoke-Bounded $uninstaller @('/S')
  Wait-Condition { !(Test-Path -LiteralPath $exe) -and !(Test-Path -LiteralPath $uninstaller) -and !(Test-Path -LiteralPath $registration) }
  if ((Test-Path -LiteralPath $startShortcut) -or (Test-Path -LiteralPath $desktopShortcut)) { throw 'Owned shortcuts survived uninstall' }
  Assert-Settings $Exact
}

if ($Action -eq 'preflight') {
  foreach ($target in @($RunRoot,$install,$registration,$preferences,$startDirectory,$desktopShortcut,'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native')) { if (Test-Path -LiteralPath $target) { throw 'Preexisting Nearly state; guest is not fresh' } }
  Assert-NoApp
  if (![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'Interactive desktop unavailable; qualification cannot skip' }
  $webview = @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
  $available = $false
  foreach ($key in $webview) { if (Test-Path -LiteralPath $key) { $v=(Get-ItemProperty -LiteralPath $key).pv; if ($v -match '^\d+\.\d+\.\d+\.\d+$' -and $v -ne '0.0.0.0') { $available=$true } } }
  if (!$available) { throw 'WebView2 unavailable; no runtime download and no skipped pass' }
  return
}
$planPath=Join-Path $RunRoot 'plan.json'; Assert-UnderRun $planPath
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 1 -or $plan.controllerSha -cne $env:GITHUB_SHA -or $plan.runRoot -cne $RunRoot -or $plan.installRoot -cne $install -or $plan.runId -cne $env:GITHUB_RUN_ID -or $plan.runAttempt -cne $env:GITHUB_RUN_ATTEMPT) { throw 'Owned plan marker mismatch' }
switch ($Action) {
  'extract' {
    $zipPath=Join-Path $RunRoot 'signed.zip'; Assert-UnderRun $zipPath
    if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'e8baf6d70cdfe9278e8ad162d75c989a434226cec9da04b62b9a691895ec9526') { throw 'Pinned ZIP mismatch' }
    $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $expected=@('Nearly_r2.0_x64-setup.exe','Nearly_r2.0_x64-setup.exe.sha256','Nearly_r2.0_x64-setup.exe.sig','signed-manifest.json')
      if ($zip.Entries.Count -ne 4) { throw 'Unexpected signed ZIP entries' }
      $seen=@{}
      foreach ($entry in $zip.Entries) { if ($entry.FullName -cnotin $expected -or $seen.ContainsKey($entry.FullName) -or $entry.Length -le 0 -or $entry.Length -gt 67108864 -or (($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000) { throw 'Unsafe ZIP member' }; $seen[$entry.FullName]=$true }
      $destination=Join-Path $RunRoot 'signed'
      New-Item -ItemType Directory -Path $destination | Out-Null
      foreach ($entry in $zip.Entries) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $destination $entry.FullName),$false) }
    } finally { $zip.Dispose() }
  }
  'production' {
    Assert-UnderRun $Setup; Assert-NoApp
    foreach ($choice in @(@(0,0),@(0,1),@(1,0),@(1,1))) {
      Seed-Settings; Set-Choices $choice[0] $choice[1]
      Invoke-Bounded $Setup @('/S'); Assert-Payload $ExpectedPayload '2.0.0'; Assert-Settings $true; Assert-Shortcuts $choice[0] $choice[1]
      # Reinstall is a real ordinary NSIS upgrade of an owned installed payload.
      Invoke-Bounded $Setup @('/S'); Assert-Payload $ExpectedPayload '2.0.0'; Assert-Settings $true; Assert-Shortcuts $choice[0] $choice[1]
      Uninstall-Owned $true
    }
  }
  'source' {
    Assert-UnderRun $Setup; Assert-NoApp
    if ((Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $uninstaller) -or (Test-Path -LiteralPath $registration)) { throw 'Previous case not uninstalled' }
    Seed-Settings; Set-Choices 1 1
    Invoke-Bounded $Setup @('/S'); Assert-Payload $ExpectedPayload '1.9.0'; Assert-Settings $true; Assert-Shortcuts 1 1
  }
  'launch' {
    Assert-NoApp; Assert-Regular $exe
    if ($env:NEARLY_QA_RUN_ROOT -cne $RunRoot -or $env:NEARLY_QA_SCENARIO -cnotin @('success','health-failure')) { throw 'QA scenario context missing' }
    $p=Start-Process -FilePath $exe -PassThru -WorkingDirectory $install -WindowStyle Hidden
    if ($p.Id -le 0) { throw 'Installed QA process did not launch' }
  }
  'verify' {
    Assert-Payload $ExpectedPayload $ExpectedVersion; Assert-Settings $false; Assert-Shortcuts 1 1
    $apps=@(Get-Process -Name Nearly -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $exe })
    if ($apps.Count -ne 1) { throw 'Expected exact restarted installed application process' }
    if (!$apps[0].CloseMainWindow()) { throw 'Restarted application has no closable frontend window' }
    if (!$apps[0].WaitForExit(30000)) { throw 'Restarted application did not close within deadline' }
    Assert-Payload $ExpectedPayload $ExpectedVersion; Assert-Settings $false
  }
  'uninstall' {
    Uninstall-Owned $false
    $prefs=Get-ItemProperty -LiteralPath $preferences
    if ($prefs.StartMenuShortcut -ne 1 -or $prefs.DesktopShortcut -ne 1) { throw 'Uninstall discarded independent shortcut preferences' }
  }
}
