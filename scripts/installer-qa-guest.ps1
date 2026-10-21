param(
  [Parameter(Mandatory)][ValidateSet('preflight','guard-probe','extract','production','ui','drive','source','launch','verify','uninstall')][string]$Action,
  [Parameter(Mandatory)][string]$RunRoot,
  [string]$Setup,
  [string]$ExpectedPayload,
  [string]$ExpectedVersion,
  [ValidateSet('en','ja')][string]$Language='en',
  [ValidateSet(0,1)][int]$Start=1,
  [ValidateSet(0,1)][int]$Desktop=1,
  [string]$CaseName,
  [ValidateSet('Install','Cancel')][string]$UiMode='Install'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

# This file is never invoked by unit tests. Every entrypoint requires the same
# explicit manual guest authorization; a path alone does not authorize mutation.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'nea-c/Nearly' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cnotin @('refs/heads/main','refs/heads/codex/private-install-directory')) { throw 'Manual hosted Windows guest required' }
if ($env:QA_CONTROLLER_SHA -cnotmatch '\A[a-f0-9]{40}\z' -or $env:GITHUB_SHA -cne $env:QA_CONTROLLER_SHA -or $env:GITHUB_WORKFLOW_SHA -cne $env:QA_CONTROLLER_SHA -or $env:QA_CONFIRMATION -cne "installer-qa $env:QA_CONTROLLER_SHA") { throw 'Exact SHA confirmation required' }
if ($env:GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '\A[1-9][0-9]*\z' -or !$env:RUNNER_TEMP -or !$env:LOCALAPPDATA -or $env:SYNCFILES_CONFIG_DIR) { throw 'Unexpected run/storage context' }
$expectedRoot = Join-Path $env:RUNNER_TEMP "nearly-installer-qa-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if ($RunRoot -cne $expectedRoot) { throw 'Exact run root required' }
function Resolve-GuestInstallRoot([string]$Action,[string]$DestinationKind,[System.Collections.IDictionary]$Destinations) {
  if ($DestinationKind -cnotin @('default','custom','drive','drive-c')) { throw 'Explicit QA destination required' }
  if ($Action -ceq 'production') { return $Destinations.default }
  if ($Action -ceq 'drive') {
    if ($DestinationKind -ceq 'drive-c') { return $Destinations['drive-c'] }
    return $Destinations.drive
  }
  return $Destinations[$DestinationKind]
}
if ($env:QA_DESTINATION -cnotin @('default','custom','drive','drive-c')) { throw 'Explicit QA destination required' }
$destinations = [ordered]@{
  default = Join-Path $env:LOCALAPPDATA 'Nearly'
  custom = Join-Path $env:LOCALAPPDATA "Nearly Installer QA $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT\日本語 space\Nearly"
  drive = "D:\Nearly QA 日本語 $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
  'drive-c' = "C:\Nearly QA 日本語 $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
}
$install = Resolve-GuestInstallRoot $Action $env:QA_DESTINATION $destinations
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
$script:passiveDiagnosticsAttempted=$false
function Invoke-DiagnosticObserver($Process,[string]$Image) {
  . (Join-Path $PSScriptRoot 'installer-qa-passive-observer.ps1')
  Watch-NearlyPassiveInstaller -OwnedProcessId $Process.Id -ExpectedImage $Image -ExpectedStartTimeUtcTicks $Process.StartTime.ToUniversalTime().Ticks -TimeoutSeconds 30
}
function Write-ProductionFailureDiagnostic([string]$File,[int]$OriginalExitCode) {
  # A diagnostic follow-up can change a partially installed payload. Capture the
  # original state first; the caller ALWAYS throws the original /S failure.
  if ($Action -cne 'production' -or $File -cne $Setup -or $OriginalExitCode -ne 6 -or $script:passiveDiagnosticsAttempted) { return }
  $script:passiveDiagnosticsAttempted=$true
  try {
    Assert-UnderRun $File
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'fc65ec21d586227172f2d8f99ce055e2b2c394db675c59444f47129cae5551dc') { throw 'Immutable diagnostic artifact differs' }
    $snapshot=[ordered]@{kind='immutableProductionFailureSnapshot';originalExitCode=$OriginalExitCode;payloadSha256=$null;uninstallerSha256=$null;payloadWriteOpenError=$null;uninstallerWriteOpenError=$null}
    foreach ($pair in @(@('payloadWriteOpenError',$exe),@('uninstallerWriteOpenError',$uninstaller))) {
      if (Test-Path -LiteralPath $pair[1]) { $snapshot[$pair[0]]=Get-ProductionWriteProbe $pair[1] }
    }
    # Emit probes even if a subsequent sharing violation prevents hashing.
    Write-Host (ConvertTo-Json -InputObject $snapshot -Compress)
    foreach ($pair in @(@('payloadSha256',$exe),@('uninstallerSha256',$uninstaller))) {
      if (Test-Path -LiteralPath $pair[1]) {
        Assert-Regular $pair[1]
        $snapshot[$pair[0]]=(Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
    Write-Host (ConvertTo-Json -InputObject $snapshot -Compress)
    Write-Host 'Separate passive diagnostic follows; original silent regression remains failed.'
    $diagnostic=Start-Process -FilePath $File -ArgumentList '/P' -PassThru -WindowStyle Hidden
    $observation=Invoke-DiagnosticObserver $diagnostic $File
    Write-Host (ConvertTo-Json -InputObject $observation -Compress)
  } catch { Write-Host 'Separate passive diagnostic unavailable; original regression remains failed.' }
}
function Invoke-Bounded([string]$File,[string[]]$Arguments) {
  Assert-Regular $File
  $p = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  if (!$p.WaitForExit(120000)) { throw 'Installer process timeout; runner retained for failure evidence' }
  if ($p.ExitCode -ne 0) {
    try {
      $state=[ordered]@{kind='installerQaProcessFailure';exitCode=$p.ExitCode;payloadPresent=(Test-Path -LiteralPath $exe);uninstallerPresent=(Test-Path -LiteralPath $uninstaller);registrationPresent=(Test-Path -LiteralPath $registration);startShortcutPresent=(Test-Path -LiteralPath $startShortcut);desktopShortcutPresent=(Test-Path -LiteralPath $desktopShortcut)}
      Write-Host (ConvertTo-Json -InputObject $state -Compress)
    } catch { Write-Host 'Bounded installer failure state unavailable' }
    Write-ProductionFailureDiagnostic $File $p.ExitCode
    throw "Installer exited with $($p.ExitCode)"
  }
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
  foreach ($pair in @(@($startShortcut,$Start),@($desktopShortcut,$Desktop))) {
    $exists = Test-Path -LiteralPath $pair[0]
    if ($exists -ne [bool]$pair[1]) { throw 'Shortcut choice was not preserved' }
    if ($exists) { Assert-Regular $pair[0]; if (![NearlyQaShortcut]::Matches($pair[0],$exe)) { throw 'Shortcut targets foreign executable' } }
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
function Get-GeneratedCleanupPaths([string]$InstallRoot,[string[]]$Names,[string[]]$Children) {
  $allowed=@($Names | ForEach-Object { $_; $_ -replace '\.json$','.backup.json' })
  if ($allowed.Count -ne 10 -or @($Children).Count -ne 10 -or @($Children | Sort-Object -Unique -CaseSensitive).Count -ne 10) { throw 'Only ten exact generated settings files may be cleaned' }
  foreach ($leaf in $Children) { if ($leaf -cnotin $allowed) { throw 'Unknown installation child; evidence retained' } }
  return @($allowed | ForEach-Object { Join-Path $InstallRoot $_ })
}
function Remove-GeneratedSettings {
  # Exact byte/metadata provenance was checked after the real uninstall. Never
  # recursively delete an installation, unknown files, or recovery evidence.
  Assert-NoApp; Assert-LocalPath $install; Assert-Settings $true
  foreach ($target in @($exe,$uninstaller,$registration)) { if (Test-Path -LiteralPath $target) { throw 'Installed payload still present; cannot clean fixtures' } }
  $children=@(Get-ChildItem -LiteralPath $install -Force)
  if (@($children | Where-Object { $_.PSIsContainer }).Count -ne 0) { throw 'Unexpected installation subdirectory; evidence retained' }
  $paths=Get-GeneratedCleanupPaths $install $names @($children.Name)
  foreach ($file in $paths) { Assert-Regular $file; Remove-Item -LiteralPath $file }
  [IO.Directory]::Delete($install,$false)
}
function Prepare-EmptyUiRoot {
  Assert-LocalPath $install
  if (Test-Path -LiteralPath $install) { throw 'Fresh candidate UI requires an absent empty destination' }
  $parent=Split-Path -Parent $install
  Assert-LocalPath $parent
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Assert-LocalPath $parent
}
function Get-PreflightFileTargets([string]$Root,[System.Collections.IDictionary]$Destinations,[string]$StartDirectory,[string]$DesktopShortcut) {
  $targets=@($Root,$Destinations.default,$Destinations.custom,$Destinations.drive,$StartDirectory,$DesktopShortcut)
  if ($Destinations.Contains('drive-c')) { $targets+=@($Destinations['drive-c']) }
  return $targets
}

if ($Action -eq 'preflight') {
  $fileTargets=Get-PreflightFileTargets $RunRoot $destinations $startDirectory $desktopShortcut
  foreach ($target in $fileTargets) { Assert-LocalPath $target }
  foreach ($target in @($fileTargets)+@($registration,$preferences,'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native')) { if (Test-Path -LiteralPath $target) { throw 'Preexisting Nearly state; guest is not fresh' } }
  Assert-NoApp
  if (![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'Interactive desktop unavailable; qualification cannot skip' }
  $webview = @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
  $available = $false
  foreach ($key in $webview) { if (Test-Path -LiteralPath $key) { $v=(Get-ItemProperty -LiteralPath $key).pv; if ($v -match '^\d+\.\d+\.\d+\.\d+$' -and $v -ne '0.0.0.0') { $available=$true } } }
  if (!$available) { throw 'WebView2 unavailable; no runtime download and no skipped pass' }
  return
}
if ($Action -eq 'guard-probe') {
  Assert-NoApp
  if (Test-Path -LiteralPath $RunRoot) { throw 'Guard probe must precede run-root creation' }
  if ($env:NEARLY_NSIS_READONLY_QA -cne '1' -or $env:NEARLY_NSIS_REQUIRE_PRIVATE_TEMP -cne '1' -or $env:NEARLY_NSIS_ROOT -cne (Join-Path $env:LOCALAPPDATA 'tauri\NSIS')) { throw 'Exact read-only guard probe context required' }
  $tempTestName='temporary plugin namespace uses ordinary OS access without private-ACL admission'
  $tempTestFile=Join-Path $PSScriptRoot '..\src-tauri\windows\readonly-root.test.mjs'
  if ([regex]::Matches([IO.File]::ReadAllText($tempTestFile),[regex]::Escape("test('$tempTestName'")).Count -ne 1) { throw 'Exact temporary namespace test is missing or duplicated' }
  & node --test ("--test-name-pattern=^"+[regex]::Escape($tempTestName)+'$') $tempTestFile
  if ($LASTEXITCODE -ne 0) { throw 'Read-only temporary namespace qualification failed' }
  & node --test (Join-Path $PSScriptRoot '..\src-tauri\windows\payload-native.test.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Generated same-handle payload qualification failed' }
  if ($env:QA_DESTINATION -ceq 'drive') {
    . (Join-Path $PSScriptRoot 'installer-qa-drive-diagnosis.ps1')
    Write-Host ('Read-only selected drive root: '+(ConvertTo-Json -InputObject (Get-NearlyDriveRootDiagnosis) -Depth 6 -Compress))
  }
  return
}
$planPath=Join-Path $RunRoot 'plan.json'; Assert-UnderRun $planPath
$plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 2 -or $plan.controllerSha -cne $env:GITHUB_SHA -or $plan.runRoot -cne $RunRoot -or $plan.destinationKind -cne $env:QA_DESTINATION -or $plan.installRoot -cne $destinations[$env:QA_DESTINATION] -or $plan.runId -cne $env:GITHUB_RUN_ID -or $plan.runAttempt -cne $env:GITHUB_RUN_ATTEMPT) { throw 'Owned plan marker mismatch' }
foreach ($kind in @('default','custom','drive','drive-c')) { if ($plan.destinations.$kind -cne $destinations[$kind]) { throw 'Derived destination mismatch' } }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NearlyQaShortcut {
  [ComImport,Guid("000214F9-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    [PreserveSig] int GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder target,int count,IntPtr data,uint flags);
  }
  [ComImport,Guid("0000010B-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFileRaw {
    [PreserveSig] int GetClassID(out Guid id);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string path,uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string path,[MarshalAs(UnmanagedType.Bool)] bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string path);
    [PreserveSig] int GetCurFile(out IntPtr path);
  }
  public static string ReadWide(string shortcut) {
    object link=null;
    try {
      link=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
      if(((IPersistFileRaw)link).Load(shortcut,0)!=0)throw new Exception("Wide shortcut read failed");
      var target=new StringBuilder(32768);
      if(((IShellLinkW)link).GetPath(target,target.Capacity,IntPtr.Zero,4)!=0)throw new Exception("Wide shortcut read failed");
      return target.ToString();
    } catch {throw new Exception("Wide shortcut read failed");}
    finally {
      if(link!=null&&Marshal.IsComObject(link)){
        try {Marshal.FinalReleaseComObject(link);}catch {throw new Exception("Wide shortcut release failed");}
      }
    }
  }
  public static bool TargetMatches(string expected,string actual) {
    // Compare the complete RAW4 string using the existing Windows case policy.
    // Do not normalize, resolve aliases, or fall back to matching file identity.
    return !string.IsNullOrEmpty(expected)&&!string.IsNullOrEmpty(actual)&&actual.Length<32768&&string.Equals(expected,actual,StringComparison.OrdinalIgnoreCase);
  }
  public static bool Matches(string shortcut,string expected) {return TargetMatches(expected,ReadWide(shortcut));}
}
'@
function Get-ProductionWriteProbe([string]$File) {
  if ($Action -cne 'production' -or $File -cnotin @($exe,$uninstaller)) { throw 'Exact production payload probe required' }
  Assert-Regular $File
  if ($null -eq ('NearlyQaWriteProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NearlyQaWriteProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 public static int Read(string path) {
  // OPEN_EXISTING + OPEN_REPARSE_POINT, all sharing enabled. Request write
  // access to diagnose sharing/access denial; never create, truncate or write.
  using(var handle=CreateFileW(path,0x40000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
   return handle.IsInvalid?Marshal.GetLastWin32Error():0;
  }
 }
}
'@
  }
  return [NearlyQaWriteProbe]::Read($File)
}
function Invoke-Ui([string]$Mode,[string]$Name,[string]$Lang,[int]$StartChoice,[int]$DesktopChoice,[string]$ConsentKind='Auto',[string]$ConsentDecision='Yes') {
  if ($Name -cnotmatch '\A[a-z0-9-]{1,40}\z') { throw 'Fixed UI case identity required' }
  Assert-UnderRun $Setup
  & (Join-Path $PSScriptRoot 'installer-qa-ui.ps1') -Setup $Setup -RunRoot $RunRoot -InstallRoot $install -Language $Lang -Start $StartChoice -Desktop $DesktopChoice -CaseName $Name -Mode $Mode -ConsentKind $ConsentKind -ConsentDecision $ConsentDecision
}
function New-SharedEmptyDriveFixture {
  $expectedDrive=if ($env:QA_DESTINATION -ceq 'drive-c') { $destinations['drive-c'] } else { $destinations.drive }
  if ($Action -cne 'drive' -or $install -cne $expectedDrive -or (Test-Path -LiteralPath $install)) { throw 'Exact absent owned drive fixture required' }
  # Only this app-specific leaf is created/protected. Parent/drive ACLs are read-only.
  New-Item -ItemType Directory -Path $install | Out-Null
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetOwner($sid)
  $acl.SetSecurityDescriptorSddlForm("O:$sid"+'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;AU)(A;OICI;0x1200a9;;;BU)')
  Set-Acl -LiteralPath $install -AclObject $acl
}
function Test-OwnedDriveWriteDenial {
  # Only a disposable, exact guest fixture may receive this negative-test ACL.
  $expectedDrive=if ($env:QA_DESTINATION -ceq 'drive-c') { $destinations['drive-c'] } else { $destinations.drive }
  if ($Action -cne 'drive' -or $install -cne $expectedDrive -or @(Get-ChildItem -LiteralPath $install -Force).Count -ne 0) { throw 'Exact empty generated drive fixture required' }
  Assert-UnderRun $Setup
  $original=Get-Acl -LiteralPath $install
  $denied=Get-Acl -LiteralPath $install
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::CreateFiles,[Security.AccessControl.AccessControlType]::Deny)
  $denied.AddAccessRule($rule)
  try {
    Set-Acl -LiteralPath $install -AclObject $denied
    $failed=$false
    try { [IO.File]::WriteAllBytes((Join-Path $install 'write-denial-check.tmp'),[byte[]]@(1)) } catch [UnauthorizedAccessException] { $failed=$true }
    if (!$failed) { throw 'Fixture did not deny actual file creation' }
    $p=Start-Process -FilePath $Setup -ArgumentList @('/S',('/D='+$install)) -PassThru -WindowStyle Hidden
    if (!$p.WaitForExit(120000)) { throw 'Write-denied setup timed out' }
    if ($p.ExitCode -ne 5) { throw 'Write-denied setup did not report access refusal' }
    foreach ($target in @($exe,$uninstaller,$registration,$startShortcut,$desktopShortcut)) { if (Test-Path -LiteralPath $target) { throw 'Write refusal changed installed state' } }
    if (@(Get-ChildItem -LiteralPath $install -Force).Count -ne 0) { throw 'Write refusal left unexpected files' }
  } finally {
    Set-Acl -LiteralPath $install -AclObject $original
  }
  if ((Get-Acl -LiteralPath $install).Sddl -cne $original.Sddl) { throw 'Generated fixture ACL was not restored' }
}
function Get-DirectoryIdentity([string]$Path) {
  Assert-LocalPath $Path
  if (!(Test-Path -LiteralPath $Path -PathType Container)) { throw 'Directory identity requires existing directory' }
  if (!('NearlyQaDirectoryIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NearlyQaDirectoryIdentity {
 [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {public uint Attr;public long Created;public long Accessed;public long Written;public uint Volume,HighSize,LowSize,Links,HighIndex,LowIndex;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 public static string Read(string name){using(var h=CreateFileW(name,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){Info i;if(h.IsInvalid||!GetFileInformationByHandle(h,out i)||(i.Attr&0x410)!=0x10)throw new Exception("Directory identity failed");return i.Volume.ToString("x8")+":"+i.HighIndex.ToString("x8")+i.LowIndex.ToString("x8");}}
}
'@
  }
  return [NearlyQaDirectoryIdentity]::Read($Path)
}
switch ($Action) {
  'extract' {
    $zipPath=Join-Path $RunRoot 'signed.zip'; Assert-UnderRun $zipPath
    if ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '5533c87fa789c3907165f899a0d03962a0b3ed9af228b3d484b7d746b7df0480') { throw 'Pinned ZIP mismatch' }
    $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $expected=@('Nearly_r3.1_x64-setup.exe','Nearly_r3.1_x64-setup.exe.sha256','Nearly_r3.1_x64-setup.exe.sig','signed-manifest.json')
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
      Write-Host "Production regression: choices=$($choice[0])$($choice[1]) stage=install"
      Invoke-Bounded $Setup @('/S'); Assert-Payload $ExpectedPayload '3.1.0'; Assert-Settings $true; Assert-Shortcuts $choice[0] $choice[1]
      # Reinstall is a real ordinary NSIS upgrade of an owned installed payload.
      Write-Host "Production regression: choices=$($choice[0])$($choice[1]) stage=reinstall"
      Invoke-Bounded $Setup @('/S'); Assert-Payload $ExpectedPayload '3.1.0'; Assert-Settings $true; Assert-Shortcuts $choice[0] $choice[1]
      Write-Host "Production regression: choices=$($choice[0])$($choice[1]) stage=uninstall"
      Uninstall-Owned $true
    }
    Remove-GeneratedSettings
  }
  'source' {
    Assert-UnderRun $Setup; Assert-NoApp
    if ((Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $uninstaller) -or (Test-Path -LiteralPath $registration)) { throw 'Previous case not uninstalled' }
    Prepare-EmptyUiRoot
    if (Test-Path -LiteralPath $preferences) { Remove-Item -LiteralPath $preferences -Recurse }
    Invoke-Ui 'Install' 'native-source' 'en' 0 1
    Seed-Settings
    Assert-Payload $ExpectedPayload '1.9.0'; Assert-Settings $true; Assert-Shortcuts 0 1
  }
  'ui' {
    Assert-NoApp
    if ((Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $uninstaller) -or (Test-Path -LiteralPath $registration)) { throw 'Previous UI case not uninstalled' }
    Prepare-EmptyUiRoot
    if (Test-Path -LiteralPath $preferences) { Remove-Item -LiteralPath $preferences -Recurse }
    Invoke-Ui $UiMode $CaseName $Language $Start $Desktop
    if ($UiMode -eq 'Cancel') {
      foreach ($target in @($install,$exe,$uninstaller,$registration,$preferences,$startShortcut,$desktopShortcut)) { if (Test-Path -LiteralPath $target) { throw 'Cancelled setup mutated installed state' } }
    } else {
      Seed-Settings
      Assert-Payload $ExpectedPayload '1.9.0'; Assert-Settings $true; Assert-Shortcuts $Start $Desktop
      # Reinstall the now-owned candidate without changing adjacent settings or
      # the choices selected through the real UI.
      Invoke-Bounded $Setup @('/S')
      Assert-Payload $ExpectedPayload '1.9.0'; Assert-Settings $true; Assert-Shortcuts $Start $Desktop
      Uninstall-Owned $true
      if ($env:QA_DESTINATION -cin @('default','custom','drive','drive-c')) {
        # Actual unregistered reinstall with only known retained data at any root.
        Invoke-Bounded $Setup @('/S')
        Assert-Payload $ExpectedPayload '1.9.0'; Assert-Settings $true; Assert-Shortcuts $Start $Desktop
        Uninstall-Owned $true
      }
      Remove-GeneratedSettings
    }
  }
  'drive' {
    Assert-NoApp
    foreach ($target in @($install,$registration,$startShortcut,$desktopShortcut)) { if (Test-Path -LiteralPath $target) { throw 'Drive boundary is not fresh' } }
    if (Test-Path -LiteralPath $preferences) { Remove-Item -LiteralPath $preferences -Recurse }
    $parent=Split-Path -Parent $install
    $parentAcl=(Get-Acl -LiteralPath $parent).Sddl
    $prior=@(Get-ChildItem -LiteralPath $parent -Directory -Force -Filter '.Nearly-preserved-*' | ForEach-Object Name)
    New-SharedEmptyDriveFixture
    $originalId=Get-DirectoryIdentity $install; $originalAcl=(Get-Acl -LiteralPath $install).Sddl
    Invoke-Ui 'Cancel' 'drive-ordinary-cancel' 'ja' 1 0 'None' 'Yes'
    if ((Get-DirectoryIdentity $install) -cne $originalId -or (Get-Acl -LiteralPath $install).Sddl -cne $originalAcl -or @(Get-ChildItem -LiteralPath $install -Force).Count -ne 0) { throw 'Cancel before Install changed original folder' }
    foreach ($target in @($exe,$uninstaller,$registration,$preferences,$startShortcut,$desktopShortcut)) { if (Test-Path -LiteralPath $target) { throw 'Cancelled consent changed installed state' } }
    $marker=Join-Path $install 'owned-nonempty-fixture.txt'; $markerBytes=[Text.Encoding]::UTF8.GetBytes('generated unrelated content must survive')
    [IO.File]::WriteAllBytes($marker,$markerBytes)
    Invoke-Ui 'Reject' 'drive-nonempty-rejected' 'en' 1 0 'None' 'No'
    if ((Get-DirectoryIdentity $install) -cne $originalId -or (Get-Acl -LiteralPath $install).Sddl -cne $originalAcl -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($marker)) -cne [Convert]::ToBase64String($markerBytes)) { throw 'Nonempty refusal damaged existing contents' }
    if (@(Get-ChildItem -LiteralPath $install -Force).Count -ne 1) { throw 'Nonempty refusal changed directory entries' }
    Remove-Item -LiteralPath $marker
    Test-OwnedDriveWriteDenial
    Invoke-Ui 'Drive' 'drive-ordinary-install' 'en' 1 0 'None' 'Yes'
    Assert-Payload $ExpectedPayload '1.9.0'; Assert-Shortcuts 1 0
    if ((Get-DirectoryIdentity $install) -cne $originalId -or (Get-Acl -LiteralPath $install).Sddl -cne $originalAcl) { throw 'Ordinary install replaced the folder or changed its ACL' }
    $preserved=@(Get-ChildItem -LiteralPath $parent -Directory -Force -Filter '.Nearly-preserved-*' | Where-Object Name -CNotIn $prior)
    if ($preserved.Count -ne 0) { throw 'Ordinary install unexpectedly preserved/replaced a directory' }
    Seed-Settings; Uninstall-Owned $true; Remove-GeneratedSettings
    if ((Get-Acl -LiteralPath $parent).Sddl -cne $parentAcl) { throw 'Uninstall changed parent permissions' }
    Write-Output 'Ordinary drive install, cancellation, nonempty refusal, existing identity/ACL retention and unchanged parent ACL verified.'
  }
  'launch' {
    Assert-NoApp; Assert-Regular $exe
    if ($env:NEARLY_QA_RUN_ROOT -cne $RunRoot -or $env:NEARLY_QA_SCENARIO -cnotin @('success','health-failure')) { throw 'QA scenario context missing' }
    $p=Start-Process -FilePath $exe -PassThru -WorkingDirectory $install -WindowStyle Hidden
    if ($p.Id -le 0) { throw 'Installed QA process did not launch' }
  }
  'verify' {
    Assert-Payload $ExpectedPayload $ExpectedVersion; Assert-Settings $false; Assert-Shortcuts 0 1
    $apps=@(Get-Process -Name Nearly -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $exe })
    if ($apps.Count -ne 1) { throw 'Expected exact restarted installed application process' }
    if (!$apps[0].CloseMainWindow()) { throw 'Restarted application has no closable frontend window' }
    if (!$apps[0].WaitForExit(30000)) { throw 'Restarted application did not close within deadline' }
    Assert-Payload $ExpectedPayload $ExpectedVersion; Assert-Settings $false
  }
  'uninstall' {
    Uninstall-Owned $false
    $prefs=Get-ItemProperty -LiteralPath $preferences
    if ($prefs.StartMenuShortcut -ne 0 -or $prefs.DesktopShortcut -ne 1) { throw 'Uninstall discarded independent shortcut preferences' }
  }
}
