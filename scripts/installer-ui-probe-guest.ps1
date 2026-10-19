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
function New-ProbeGate([string]$Stage,[string]$Event) {
  if ($Stage -cnotin @('context','fixture','payload','registration','preferences','start-link','desktop-link','desktop-path','desktop-leaf','wide-reader','wsh-reader','identity-reader') -or $Event -cnotin @('start','finished','verified','failure')) { throw 'Unsupported mock diagnostic gate' }
  return [ordered]@{stage=$Stage;event=$Event}
}
function Write-ProbeGate([string]$Stage,[string]$Event) {
  $script:gate=$Stage
  Write-Host ('Mock gate: '+(ConvertTo-Json -InputObject (New-ProbeGate $Stage $Event) -Compress))
}
$script:gate='context'
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
function Assert-MockBytes([byte[]]$Bytes) {
  $expected=[Text.Encoding]::UTF8.GetBytes('non-executable generated shell-link control')
  if ($Bytes.Length -ne 43 -or [Convert]::ToBase64String($Bytes) -cne [Convert]::ToBase64String($expected)) { throw 'Invalid exact plain-text mock fixture' }
}
function Assert-MockFixture {
  Assert-Regular $mock 43
  Assert-MockBytes ([IO.File]::ReadAllBytes($mock))
}
function Get-ShortcutPathObservation([string]$Path) {
  $record=[ordered]@{absoluteLocal=$false;canonicalExact=$false;hasForwardSlash=$false;hasExtraColon=$false;exists=$false;leafRegular=$false;leafReparse=$false;ancestorsSafe=$false;lengthPositive=$false;lengthBounded=$false}
  try {
    $record.absoluteLocal=[bool]($Path -cmatch '\A[A-Za-z]:\\')
    $record.hasForwardSlash=[bool]$Path.Contains('/')
    $record.hasExtraColon=[bool]($Path.Length -ge 2 -and $Path.Substring(2).Contains(':'))
    $record.canonicalExact=[bool]([IO.Path]::GetFullPath($Path) -ceq $Path)
  } catch { return $record }
  if (!$record.absoluteLocal -or !$record.canonicalExact -or $record.hasForwardSlash -or $record.hasExtraColon) { return $record }
  try {
    $record.exists=[bool](Test-Path -LiteralPath $Path)
    if ($record.exists) {
      $item=Get-Item -LiteralPath $Path -Force
      $record.leafRegular=[bool](!$item.PSIsContainer)
      $record.leafReparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
      [long]$length=$item.Length
      $record.lengthPositive=[bool]($length -gt 0)
      $record.lengthBounded=[bool]($length -le 67108864)
    }
  } catch {}
  try {
    $safe=$true;$cursor=$Path
    while ($cursor) {
      if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { $safe=$false;break }
      $parent=Split-Path -Parent $cursor
      if ($parent -eq $cursor) { break };$cursor=$parent
    }
    $record.ancestorsSafe=[bool]$safe
  } catch {}
  return $record
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
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class NearlyProbeShortcut {
  [ComImport,Guid("000214F9-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    [PreserveSig] int GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,int count,IntPtr data,uint flags);
  }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes;public FILETIME Creation,Access,Write;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out Info info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
  public static string ReadWide(string shortcut) {
    object link=null;
    try {
      link=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
      ((IPersistFile)link).Load(shortcut,0);
      var path=new StringBuilder(32768);
      if(((IShellLinkW)link).GetPath(path,path.Capacity,IntPtr.Zero,4)!=0)throw new Exception("Wide shortcut read failed");
      return path.ToString();
    } catch {throw new Exception("Wide shortcut read failed");}
    finally {if(link!=null&&Marshal.IsComObject(link))Marshal.FinalReleaseComObject(link);}
  }
  static bool LocalPath(string path) {
    if(string.IsNullOrEmpty(path)||path.Length<4||!char.IsLetter(path[0])||path[1]!=':'||path[2]!='\\'||path.IndexOf('/',0)>=0||path.IndexOf(':',2)>=0)return false;
    foreach(var part in path.Substring(3).Split('\\'))if(part.Length==0||part=="."||part==".."||part.EndsWith(" ")||part.EndsWith("."))return false;
    return true;
  }
  static bool SameFile(string expected,string observed) {
    if(!LocalPath(expected)||!LocalPath(observed))return false;
    IntPtr a=(IntPtr)(-1),b=(IntPtr)(-1);
    try {
      // Query existing files only, without following a reparse-point leaf.
      a=CreateFileW(expected,0x80,7,IntPtr.Zero,3,0x200000,IntPtr.Zero);
      b=CreateFileW(observed,0x80,7,IntPtr.Zero,3,0x200000,IntPtr.Zero);
      if(a==(IntPtr)(-1)||b==(IntPtr)(-1))return false;
      Info x,y;
      return GetFileInformationByHandle(a,out x)&&GetFileInformationByHandle(b,out y)&&(x.Attributes&0x410)==0&&(y.Attributes&0x410)==0&&x.Volume==y.Volume&&x.IndexHigh==y.IndexHigh&&x.IndexLow==y.IndexLow;
    } catch {return false;}
    finally {if(a!=(IntPtr)(-1))CloseHandle(a);if(b!=(IntPtr)(-1))CloseHandle(b);}
  }
  public static bool[] Compare(string expected,string wide,string wsh) {
    return new[]{string.Equals(wide,expected,StringComparison.Ordinal),string.Equals(wsh,expected,StringComparison.Ordinal),string.Equals(wide,wsh,StringComparison.Ordinal),SameFile(expected,wide),SameFile(expected,wsh)};
  }
}
'@
function Observe-Shortcut {
  $wide='';$wsh='';$wideAvailable=$false;$wshAvailable=$false;$shell=$null;$link=$null
  Write-ProbeGate 'wide-reader' 'start'
  try { $wide=[NearlyProbeShortcut]::ReadWide($desktopShortcut);$wideAvailable=$true } catch {}
  Write-ProbeGate 'wide-reader' 'finished'
  Write-ProbeGate 'wsh-reader' 'start'
  try { $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($desktopShortcut);$wsh=$link.TargetPath;$wshAvailable=$true } catch {}
  finally { foreach ($com in @($link,$shell)) { if ($null -ne $com -and [Runtime.InteropServices.Marshal]::IsComObject($com)) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com) } catch {} } } }
  Write-ProbeGate 'wsh-reader' 'finished'
  Write-ProbeGate 'identity-reader' 'start'
  $checks=[NearlyProbeShortcut]::Compare($exe,$wide,$wsh)
  $record=[ordered]@{wideAvailable=$wideAvailable;wshAvailable=$wshAvailable;wideMatchesExpected=$checks[0];wshMatchesExpected=$checks[1];readersMatch=$checks[2];wideIdentityMatchesExpected=$checks[3];wshIdentityMatchesExpected=$checks[4]}
  Write-Host ('Mock shortcut: '+(ConvertTo-Json -InputObject $record -Compress))
  if (!$wideAvailable -or !$checks[0] -or !$checks[3]) { throw 'Wide mock shortcut target or file identity differs' }
  Write-ProbeGate 'identity-reader' 'verified'
}
function Assert-NoApp {
  if (@(Get-Process -Name Nearly -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Mock image must never launch' }
}
function Assert-Choices([bool]$Installed=$true) {
  Write-ProbeGate 'preferences' 'start'
  $prefs=Get-ItemProperty -LiteralPath $preferences
  $expectedDesktop=if ($Boundary) { 0 } else { 1 }
  if ($prefs.StartMenuShortcut -ne 0 -or $prefs.DesktopShortcut -ne $expectedDesktop) { throw 'Mock shortcut choices changed' }
  Write-ProbeGate 'preferences' 'verified'
  Write-ProbeGate 'start-link' 'start'
  Assert-Path $startShortcut;if (Test-Path -LiteralPath $startShortcut) { throw 'Unselected mock shortcut exists' }
  Write-ProbeGate 'start-link' 'verified'
  Write-ProbeGate 'desktop-path' 'start'
  Write-Host ('Mock shortcut path: '+(ConvertTo-Json -InputObject (Get-ShortcutPathObservation $desktopShortcut) -Compress))
  Assert-Path $desktopShortcut
  Write-ProbeGate 'desktop-path' 'verified'
  Write-ProbeGate 'desktop-leaf' 'start'
  if ($Installed -and $expectedDesktop -eq 1) { Assert-Regular $desktopShortcut;Write-ProbeGate 'desktop-leaf' 'verified';Observe-Shortcut }
  elseif (Test-Path -LiteralPath $desktopShortcut) { throw 'Removed or unselected mock shortcut exists' }
  else { Write-ProbeGate 'desktop-leaf' 'verified' }
}
function Assert-Installed {
  Write-ProbeGate 'payload' 'start'
  Assert-NoApp
  foreach ($file in @($exe,$uninstaller)) { Assert-Regular $file }
  if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $mock -Algorithm SHA256).Hash) { throw 'Installed mock bytes differ' }
  Write-ProbeGate 'payload' 'verified'
  Write-ProbeGate 'registration' 'start'
  $r=Get-ItemProperty -LiteralPath $registration
  if ($r.NearlyOwner -cne 'local.syncfiles.native' -or $r.NearlyInternalVersion -cne '1.9.0' -or $r.DisplayVersion -cne 'r1.9' -or $r.InstallLocation -ine $install -or $r.UninstallString -cne ('"'+$uninstaller+'"')) { throw 'Owned mock registration changed' }
  Write-ProbeGate 'registration' 'verified'
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
      Assert-MockFixture
      Assert-Installed
    }
    Write-ProbeEvent 'boundary' 'verified' 0
  } catch {
    Write-ProbeGate $script:gate 'failure'
    Write-ProbeEvent 'boundary' 'failure'
    throw 'Mock boundary postconditions failed'
  }
  return
}
$script:phase='installed'
try {
  Write-ProbeEvent 'installed' 'start'
  Write-ProbeGate 'fixture' 'start'
  Assert-Regular $setup; Assert-MockFixture
  Write-ProbeGate 'fixture' 'verified'
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
  Assert-NoApp; Assert-Path $install; Assert-Settings; Assert-Choices $false
  if (!(Test-Path -LiteralPath $install) -or (Get-Item -LiteralPath $install -Force).CreationTimeUtc.Ticks -ne $originalCreated -or $hashes.Count -ne 10) { throw 'Original settings root was not preserved' }
  Write-ProbeEvent 'verify' 'verified' 0
  Write-ProbeEvent 'complete' 'verified' 0
} catch {
  Write-ProbeGate $script:gate 'failure'
  Write-ProbeEvent $script:phase 'failure'
  throw 'Mock lifecycle diagnostic failed; inspect fixed phase/exit records'
}
