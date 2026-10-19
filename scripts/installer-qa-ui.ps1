param(
  [Parameter(Mandatory)][string]$Setup,
  [Parameter(Mandatory)][string]$RunRoot,
  [Parameter(Mandatory)][string]$InstallRoot,
  [Parameter(Mandatory)][ValidateSet('en','ja')][string]$Language,
  [Parameter(Mandatory)][ValidateSet(0,1)][int]$Start,
  [Parameter(Mandatory)][ValidateSet(0,1)][int]$Desktop,
  [Parameter(Mandatory)][ValidatePattern('\A[a-z0-9][a-z0-9-]{0,63}\z')][string]$CaseName,
  [ValidateSet('Install','Cancel','Reject','Drive')][string]$Mode='Install'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# These pure policy functions are AST-extracted by tests; tests never execute
# this entrypoint, load user32, start setup, or interact with a local desktop.
function Assert-UiContext([hashtable]$Context) {
  foreach ($pair in @(@('GITHUB_ACTIONS','true'),@('RUNNER_OS','Windows'),@('RUNNER_ENVIRONMENT','github-hosted'),@('GITHUB_REPOSITORY','nea-c/Nearly'),@('GITHUB_EVENT_NAME','workflow_dispatch'),@('GITHUB_REF','refs/heads/main'))) {
    if ($Context[$pair[0]] -cne $pair[1]) { throw 'Manual hosted Windows guest required' }
  }
  $sha=$Context['QA_CONTROLLER_SHA']
  if ($sha -cnotmatch '\A[a-f0-9]{40}\z' -or $Context['GITHUB_SHA'] -cne $sha -or $Context['GITHUB_WORKFLOW_SHA'] -cne $sha -or $Context['QA_CONFIRMATION'] -cne "installer-qa $sha") { throw 'Exact SHA confirmation required' }
  if ($Context['GITHUB_RUN_ID'] -cnotmatch '\A[1-9][0-9]*\z' -or $Context['GITHUB_RUN_ATTEMPT'] -cnotmatch '\A[1-9][0-9]*\z' -or $Context.ContainsKey('SYNCFILES_CONFIG_DIR')) { throw 'Unexpected run/storage context' }
  foreach ($key in @('RUNNER_TEMP','LOCALAPPDATA')) {
    $path=$Context[$key]
    if (!$path -or $path -cnotmatch '\A[A-Za-z]:\\' -or $path.Contains('/') -or $path.Substring(2).Contains(':') -or [IO.Path]::GetFullPath($path) -cne $path) { throw 'Canonical local context path required' }
  }
  return Join-Path $Context['RUNNER_TEMP'] "nearly-installer-qa-$($Context['GITHUB_RUN_ID'])-$($Context['GITHUB_RUN_ATTEMPT'])"
}
function Get-UiCaptions([string]$Name) {
  switch -CaseSensitive ($Name) {
    'en' { return @{Start='Create a Start menu shortcut';Desktop='Create a desktop shortcut';Lang='English';Reject='Choose a dedicated private writable folder on a local fixed drive, with an existing parent (path up to 176 characters). Shared, redirected, ambiguous or unrelated nonempty folders cannot be used.'} }
    'ja' { return @{Start='スタートメニューに登録する';Desktop='デスクトップショートカットを作成する';Lang='日本語';Reject='ローカル固定ドライブ上の、このユーザー専用の書き込み可能なフォルダーを選択してください。親フォルダーは既存である必要があり、パスは176文字以内にしてください。共有・転送先・不明なファイルがあるフォルダーは使用できません。'} }
    default { throw 'Unsupported UI language' }
  }
}
function Assert-UiSelection([int[]]$Actual,[int[]]$Expected) {
  if ($Actual.Count -ne 2 -or $Expected.Count -ne 2) { throw 'Two independent shortcut choices required' }
  for ($i=0;$i -lt 2;$i++) {
    if ($Actual[$i] -notin @(0,1) -or $Expected[$i] -notin @(0,1) -or $Actual[$i] -ne $Expected[$i]) { throw 'Actual checkbox state differs from requested choice' }
  }
}
$context=@{}
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) { $context[$entry.Key]=$entry.Value }
$expectedRoot=Assert-UiContext $context
if ($RunRoot -cne $expectedRoot) { throw 'Exact owned run root required' }
function Assert-UiPath([string]$Path) {
  if ($Path -cnotmatch '\A[A-Za-z]:\\' -or $Path.Contains('/') -or $Path.Substring(2).Contains(':') -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'Canonical local path required' }
  $cursor=$Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path refused' }
    }
    $parent=Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor=$parent
  }
}
function Assert-UiInput([string]$Path) {
  Assert-UiPath $Path
  if (!$Path.StartsWith($RunRoot+'\',[StringComparison]::Ordinal)) { throw 'Input outside owned run root' }
  $item=Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 67108864) { throw 'Bounded regular input required' }
}
Assert-UiPath $RunRoot
$planPath=Join-Path $RunRoot 'plan.json'
Assert-UiInput $planPath
$plan=Get-Content -LiteralPath $planPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($plan.schemaVersion -ne 2 -or $plan.controllerSha -cne $env:GITHUB_SHA -or $plan.runRoot -cne $RunRoot -or $plan.runId -cne $env:GITHUB_RUN_ID -or $plan.runAttempt -cne $env:GITHUB_RUN_ATTEMPT -or $plan.destinationKind -cnotin @('default','custom')) { throw 'Owned plan marker mismatch' }
$destinations=@{
  default=(Join-Path $env:LOCALAPPDATA 'Nearly')
  custom=(Join-Path $env:LOCALAPPDATA "Nearly Installer QA $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT\日本語 space\Nearly")
  drive="D:\Nearly QA 日本語 $env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
}
foreach ($name in @('default','custom','drive')) { if ($plan.destinations.$name -cne $destinations[$name]) { throw 'Generated destination table mismatch' } }
if ($plan.installRoot -cne $destinations[$plan.destinationKind] -or ($InstallRoot -cne $plan.installRoot -and $InstallRoot -cne $destinations.drive) -or ($Mode -in @('Reject','Drive') -and $InstallRoot -cne $destinations.drive)) { throw 'Unapproved destination for UI mode' }
Assert-UiInput $Setup
if ([IO.Path]::GetExtension($Setup) -cne '.exe') { throw 'Owned setup EXE required' }
Assert-UiPath $InstallRoot
foreach ($leaf in @('Nearly.exe','uninstall.exe')) { if (Test-Path -LiteralPath (Join-Path $InstallRoot $leaf)) { throw 'UI case requires fresh destination' } }
if ($InstallRoot -ceq $destinations.drive -and (Test-Path -LiteralPath $InstallRoot)) { throw 'Drive case requires absent generated destination' }
if (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native') { throw 'UI case requires absent installation registration' }
if (Test-Path -LiteralPath 'HKCU:\Software\local.syncfiles.native\Installer') { throw 'UI default case requires absent shortcut preferences' }
if (Get-Process -Name Nearly -ErrorAction SilentlyContinue) { throw 'Nearly already running' }
if (![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'Interactive hosted desktop unavailable; qualification cannot skip' }
$evidenceRoot=Join-Path $RunRoot 'ui-evidence'
$artifactDir=Join-Path $evidenceRoot $CaseName
Assert-UiPath $artifactDir
if (Test-Path -LiteralPath $artifactDir) { throw 'Fresh UI evidence directory required' }
New-Item -ItemType Directory -Path $artifactDir | Out-Null

# Only the exact process launched below can receive messages or be captured.
# No global keyboard/mouse input, foreground-window guessing, elevation or ACL writes.
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NearlyOwnedUi {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  public static void AssertOwner(IntPtr h, int pid) {
    uint actual; GetWindowThreadProcessId(h,out actual);
    if(h==IntPtr.Zero || actual!=(uint)pid) throw new Exception("Window is not owned by launched setup");
  }
  public static IntPtr[] Windows(int pid, IntPtr parent) {
    var found=new List<IntPtr>();
    EnumProc fn=(h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==(uint)pid && IsWindowVisible(h))found.Add(h);return true;};
    if(parent==IntPtr.Zero) EnumWindows(fn,IntPtr.Zero); else {AssertOwner(parent,pid);EnumChildWindows(parent,fn,IntPtr.Zero);}
    return found.ToArray();
  }
  public static string Class(IntPtr h,int pid) {AssertOwner(h,pid);var b=new StringBuilder(256);GetClassName(h,b,b.Capacity);return b.ToString();}
  public static IntPtr Send(IntPtr h,int pid,uint msg,IntPtr w,IntPtr l) {
    AssertOwner(h,pid);IntPtr result;
    if(SendMessageTimeout(h,msg,w,l,2,2000,out result)==IntPtr.Zero)throw new Exception("Owned control message timed out");
    return result;
  }
  public static string Text(IntPtr h,int pid) {
    int size=Send(h,pid,14,IntPtr.Zero,IntPtr.Zero).ToInt32();
    if(size<0 || size>4096)throw new Exception("Unexpected control text size");
    IntPtr buffer=Marshal.AllocHGlobal((size+1)*2);
    try {Send(h,pid,13,(IntPtr)(size+1),buffer);return Marshal.PtrToStringUni(buffer)??"";}finally{Marshal.FreeHGlobal(buffer);}
  }
  public static void SetText(IntPtr h,int pid,string value) {
    IntPtr b=Marshal.StringToHGlobalUni(value);try{Send(h,pid,12,IntPtr.Zero,b);}finally{Marshal.FreeHGlobal(b);}
  }
  public static void Click(IntPtr h,int pid) {
    AssertOwner(h,pid);if(!IsWindowVisible(h)||!IsWindowEnabled(h))throw new Exception("Control not interactable");
    if(!PostMessage(h,245,IntPtr.Zero,IntPtr.Zero))throw new Exception("Owned control click failed");
  }
  public static bool Checkbox(IntPtr h,int pid) {AssertOwner(h,pid);int type=GetWindowLong(h,-16)&15;return Class(h,pid)=="Button"&&(type==2||type==3);}
  public static void Show(IntPtr h,int pid) {
    AssertOwner(h,pid);
    // Explicit visibility avoids ShowWindow's initial STARTUPINFO override.
    // Preserve position/size/Z order; post asynchronously to the owning queue.
    if(!SetWindowPos(h,IntPtr.Zero,0,0,0,0,0x4057))throw new Exception("Owned window visibility request failed");
    SetForegroundWindow(h);
  }
  public static int[] Bounds(IntPtr h,int pid) {
    AssertOwner(h,pid);Rect r;if(!GetWindowRect(h,out r)||r.Right-r.Left<100||r.Bottom-r.Top<50||r.Right-r.Left>2400||r.Bottom-r.Top>1800)throw new Exception("Unexpected owned window bounds");
    return new int[]{r.Right-r.Left,r.Bottom-r.Top};
  }
}
'@

$captions=Get-UiCaptions $Language
$events=[Collections.Generic.List[object]]::new()
$ownedProcess=$null
$main=[IntPtr]::Zero
$languageWindow=[IntPtr]::Zero
$result='failed'
$stage='launch'
function Assert-Process {
  if (!$ownedProcess -or $ownedProcess.HasExited -or $ownedProcess.Path -ine $Setup) { throw 'Launched setup identity no longer active' }
}
function Wait-Ui([scriptblock]$Condition,[int]$Seconds=30) {
  $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-Process
    $value=& $Condition
    if ($null -ne $value -and $value -ne $false -and $value -ne [IntPtr]::Zero) { return $value }
    Start-Sleep -Milliseconds 150
  }
  throw 'Bounded owned installer UI wait timed out'
}
function Controls([IntPtr]$Parent) { Assert-Process; return [NearlyOwnedUi]::Windows($ownedProcess.Id,$Parent) }
function ById([IntPtr]$Parent,[int]$Id) { return @(Controls $Parent | Where-Object { [NearlyOwnedUi]::GetDlgCtrlID($_) -eq $Id }) }
function One-Control([object[]]$Items) { if ($Items.Count -ne 1) { $caller=(Get-PSCallStack)[1].ScriptLineNumber; throw "Expected exactly one owned visible control; count=$($Items.Count), caller=$caller" }; return [IntPtr]$Items[0] }
function Click-Id([IntPtr]$Parent,[int]$Id) { [NearlyOwnedUi]::Click((One-Control @(ById $Parent $Id)),$ownedProcess.Id) }
function Screenshot([string]$Name,[IntPtr]$Window=$main) {
  Assert-Process
  $file=$Name+'.png'
  $bounds=[NearlyOwnedUi]::Bounds($Window,$ownedProcess.Id)
  $bitmap=[Drawing.Bitmap]::new($bounds[0],$bounds[1])
  try {
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    try {
      $dc=$graphics.GetHdc()
      try { $captured=[NearlyOwnedUi]::PrintWindow($Window,$dc,0) } finally { $graphics.ReleaseHdc($dc) }
      if (!$captured) { throw 'Actual installer window capture failed' }
    } finally { $graphics.Dispose() }
    $colors=[Collections.Generic.HashSet[int]]::new()
    for ($x=5;$x -lt $bitmap.Width;$x+=17) {
      for ($y=5;$y -lt $bitmap.Height;$y+=17) { $null=$colors.Add($bitmap.GetPixel($x,$y).ToArgb()) }
    }
    if ($colors.Count -lt 3) { throw 'Blank installer screenshot; interactive desktop qualification failed' }
    $bitmap.Save((Join-Path $artifactDir $file),[Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
  $events.Add(@{stage=$Name;screenshot=$file})
}
function Shortcut-Controls {
  $all=@(Controls $main | Where-Object { [NearlyOwnedUi]::Checkbox($_,$ownedProcess.Id) })
  $a=One-Control @($all | Where-Object { [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Start })
  $b=One-Control @($all | Where-Object { [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Desktop })
  if ($all.Count -ne 2 -or $a -eq $b) { throw 'Independent localized checkbox controls missing' }
  return @($a,$b)
}
function Shortcut-States {
  $checks=Shortcut-Controls
  return @([NearlyOwnedUi]::Send($checks[0],$ownedProcess.Id,240,0,0).ToInt32(),[NearlyOwnedUi]::Send($checks[1],$ownedProcess.Id,240,0,0).ToInt32())
}
function Wait-Shortcuts {
  Wait-Ui { $all=@(Controls $main | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Button' -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Start }); if ($all.Count -eq 1) { return $true } } | Out-Null
  Shortcut-Controls | Out-Null
}
function Cancel-Setup {
  Click-Id $main 2
  # Welcome/finish implementations may exit immediately; otherwise answer the
  # owned confirmation only. IDYES=6; no arbitrary dialog receives this input.
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while (!$ownedProcess.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    try {
      foreach ($window in @(Controls ([IntPtr]::Zero) | Where-Object { $_ -ne $main })) {
        $yes=@(ById $window 6)
        if ($yes.Count -eq 1) { Screenshot 'cancel-confirmation' $window; [NearlyOwnedUi]::Click($yes[0],$ownedProcess.Id) }
      }
    } catch { if (!$ownedProcess.HasExited) { throw }; break }
    Start-Sleep -Milliseconds 150
  }
  if (!$ownedProcess.HasExited) { throw 'Owned setup cancellation timed out' }
  if ($ownedProcess.ExitCode -ne 1) { throw 'Unexpected cancelled installer exit code' }
}
try {
  $ownedProcess=Start-Process -FilePath $Setup -PassThru -WindowStyle Hidden
  if ($ownedProcess.Id -le 0) { throw 'Setup did not launch' }
  $stage='language'
  $languageWindow=Wait-Ui {
    foreach ($w in @(Controls ([IntPtr]::Zero))) { if (@(Controls $w | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'ComboBox' }).Count -eq 1) { return $w } }
  }
  [NearlyOwnedUi]::Show($languageWindow,$ownedProcess.Id)
  # Showing/activating the dialog can transiently hide or recreate its child.
  # Re-query only this owned dialog until exactly one combo is available.
  $combo=Wait-Ui {
    $matches=@(Controls $languageWindow | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'ComboBox' })
    if ($matches.Count -eq 1) { return $matches[0] }
  }
  $count=[NearlyOwnedUi]::Send($combo,$ownedProcess.Id,326,0,0).ToInt32()
  if ($count -ne 2) { throw 'Expected exact English/Japanese language list' }
  $languageIndex=-1
  for ($i=0;$i -lt $count;$i++) {
    $buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(1024)
    try {
      $length=[NearlyOwnedUi]::Send($combo,$ownedProcess.Id,329,$i,0).ToInt32()
      if ($length -le 0 -or $length -gt 255) { throw 'Unexpected language label length' }
      [NearlyOwnedUi]::Send($combo,$ownedProcess.Id,328,$i,$buffer) | Out-Null
      if ([Runtime.InteropServices.Marshal]::PtrToStringUni($buffer) -ceq $captions.Lang) { $languageIndex=$i }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  }
  if ($languageIndex -lt 0) { throw 'Required actual language label absent' }
  [NearlyOwnedUi]::Send($combo,$ownedProcess.Id,334,$languageIndex,0) | Out-Null
  if ([NearlyOwnedUi]::Send($combo,$ownedProcess.Id,327,0,0).ToInt32() -ne $languageIndex) { throw 'Language selection did not stick' }
  Screenshot 'language' $languageWindow
  Click-Id $languageWindow 1
  $main=Wait-Ui {
    foreach ($w in @(Controls ([IntPtr]::Zero))) {
      if ($w -ne $languageWindow -and [NearlyOwnedUi]::Class($w,$ownedProcess.Id) -ceq '#32770' -and @(ById $w 1).Count -eq 1) { return $w }
    }
  }
  [NearlyOwnedUi]::Show($main,$ownedProcess.Id)
  Screenshot 'welcome'
  Click-Id $main 1
  $stage='directory'
  $edit=Wait-Ui { $v=@(ById $main 1019 | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Edit' }); if ($v.Count -eq 1) { return $v[0] } }
  [NearlyOwnedUi]::SetText($edit,$ownedProcess.Id,$InstallRoot)
  if ([NearlyOwnedUi]::Text($edit,$ownedProcess.Id) -cne $InstallRoot) { throw 'Actual destination edit did not retain generated destination' }
  Screenshot 'directory'
  Click-Id $main 1
  $modal=[IntPtr]::Zero
  if ($Mode -in @('Reject','Drive')) {
    $transition=Wait-Ui {
      foreach ($w in @(Controls ([IntPtr]::Zero) | Where-Object { $_ -ne $main })) {
        if (@(Controls $w | Where-Object { [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Reject }).Count -eq 1) { return @{kind='rejected';window=$w} }
      }
      if (@(Controls $main | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Button' -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Start }).Count -eq 1) {return @{kind='accepted'}}
    }
    if ($transition.kind -eq 'rejected') { $modal=$transition.window }
    elseif ($Mode -eq 'Reject') { throw 'Unsafe drive unexpectedly accepted' }
  }
  if ($modal -ne [IntPtr]::Zero) {
    $stage='destination-rejection'
    Screenshot 'destination-rejected' $modal
    Click-Id $modal 1
    Wait-Ui { [NearlyOwnedUi]::IsWindowEnabled($main) } | Out-Null
    Cancel-Setup
    $result='rejected'
  } else {
    $stage='shortcuts'
    Wait-Shortcuts
    $defaults=@(Shortcut-States)
    Assert-UiSelection $defaults @(1,0)
    Screenshot 'shortcuts-defaults'
    # Exercise both controls independently, including restoration, even when
    # the requested final combination matches the fresh defaults.
    for ($i=0;$i -lt 2;$i++) {
      $checks=Shortcut-Controls
      [NearlyOwnedUi]::Click($checks[$i],$ownedProcess.Id)
      $expected=@($defaults);$expected[$i]=1-$defaults[$i]
      Wait-Ui { $s=Shortcut-States;if($s[0] -eq $expected[0] -and $s[1] -eq $expected[1]) {return $true} } | Out-Null
      Assert-UiSelection (Shortcut-States) $expected
      Screenshot "independent-$i"
      [NearlyOwnedUi]::Click($checks[$i],$ownedProcess.Id)
      Wait-Ui { $s=Shortcut-States;if($s[0] -eq $defaults[0] -and $s[1] -eq $defaults[1]) {return $true} } | Out-Null
    }
    $requested=@($Start,$Desktop)
    for ($i=0;$i -lt 2;$i++) {
      if ($requested[$i] -ne $defaults[$i]) {
        $checks=Shortcut-Controls
        [NearlyOwnedUi]::Click($checks[$i],$ownedProcess.Id)
        Wait-Ui { $s=Shortcut-States;if($s[$i] -eq $requested[$i]) {return $true} } | Out-Null
      }
    }
    Assert-UiSelection (Shortcut-States) $requested
    Screenshot 'shortcuts-selected'
    $events.Add(@{stage='shortcut-assertions';captions=@($captions.Start,$captions.Desktop);defaults=$defaults;selected=@(Shortcut-States);independentToggle=$true})
    Click-Id $main 3
    $edit=Wait-Ui { $v=@(ById $main 1019 | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Edit' });if($v.Count -eq 1){return $v[0]} }
    if ([NearlyOwnedUi]::Text($edit,$ownedProcess.Id) -cne $InstallRoot) { throw 'Back lost selected destination' }
    Screenshot 'directory-back'
    Click-Id $main 1
    Wait-Shortcuts
    Assert-UiSelection (Shortcut-States) $requested
    Screenshot 'shortcuts-back-return'
    if ($Mode -eq 'Cancel') { $stage='cancel'; Cancel-Setup; $result='cancelled' }
    else {
      $stage='install'
      Click-Id $main 1
      Wait-Ui {
        $next=@(ById $main 1)
        if ($next.Count -eq 1 -and [NearlyOwnedUi]::IsWindowEnabled($next[0])) {
          $text=[NearlyOwnedUi]::Text($next[0],$ownedProcess.Id)
          if (($Language -eq 'en' -and $text -match 'Finish') -or ($Language -eq 'ja' -and $text -match '完了')) {return $true}
        }
      } 120 | Out-Null
      $stage='finish'
      $run=One-Control @(Controls $main | Where-Object { [NearlyOwnedUi]::Checkbox($_,$ownedProcess.Id) })
      if ([NearlyOwnedUi]::Send($run,$ownedProcess.Id,240,0,0).ToInt32() -ne 0) { throw 'Finish unexpectedly defaults to launching application' }
      Screenshot 'finish-run-unchecked'
      $events.Add(@{stage='finish-assertions';runUnchecked=$true;backRetainedChoices=$true;destinationFromActualEdit=$true})
      Click-Id $main 1
      if (!$ownedProcess.WaitForExit(30000) -or $ownedProcess.ExitCode -ne 0) { throw 'Installer did not complete successfully' }
      $result='installed'
    }
  }
} catch {
  # On an early language-control failure retain the same owned dialog image,
  # when available. Capture failure must not replace the original test error.
  if ($stage -eq 'language' -and $languageWindow -ne [IntPtr]::Zero -and @($events | Where-Object stage -eq 'language').Count -eq 0) {
    try { Screenshot 'language' $languageWindow } catch {}
  }
  throw
} finally {
  # Deliberately emit only generated labels, known UI captions and states.
  # Never copy logs, arbitrary window text, settings, tokens, binaries or env.
  $report=[ordered]@{schemaVersion=1;case=$CaseName;language=$Language;mode=$Mode;destinationKind=$(if($InstallRoot -ceq $destinations.drive){'drive'}else{$plan.destinationKind});start=$Start;desktop=$Desktop;result=$result;lastStage=$stage;events=@($events.ToArray())}
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $artifactDir 'evidence.json') -Encoding utf8
}
