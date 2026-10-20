param(
  [Parameter(Mandatory)][string]$Setup,
  [Parameter(Mandatory)][string]$RunRoot,
  [Parameter(Mandatory)][string]$InstallRoot,
  [Parameter(Mandatory)][ValidateSet('en','ja')][string]$Language,
  [Parameter(Mandatory)][ValidateSet(0,1)][int]$Start,
  [Parameter(Mandatory)][ValidateSet(0,1)][int]$Desktop,
  [Parameter(Mandatory)][ValidatePattern('\A[a-z0-9][a-z0-9-]{0,63}\z')][string]$CaseName,
  [ValidateSet('Install','Cancel','Reject','Drive')][string]$Mode='Install',
  [ValidateSet('Auto','None','New','Existing')][string]$ConsentKind='Auto',
  [ValidateSet('Yes','No')][string]$ConsentDecision='Yes',
  [ValidateSet('Click','Command')][string]$NavigationMode='Command'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# These pure policy functions are AST-extracted by tests; tests never execute
# this entrypoint, load user32, start setup, or interact with a local desktop.
function Assert-UiContext([hashtable]$Context) {
  foreach ($pair in @(@('GITHUB_ACTIONS','true'),@('RUNNER_OS','Windows'),@('RUNNER_ENVIRONMENT','github-hosted'),@('GITHUB_REPOSITORY','nea-c/Nearly'),@('GITHUB_EVENT_NAME','workflow_dispatch'))) {
    if ($Context[$pair[0]] -cne $pair[1]) { throw 'Manual hosted Windows guest required' }
  }
  if ($Context['GITHUB_REF'] -cnotin @('refs/heads/main','refs/heads/codex/private-install-directory')) { throw 'Reviewed QA branch required' }
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
    'en' { return @{Start='Create a Start menu shortcut';Desktop='Create a desktop shortcut';Lang='English';Reject='Choose a dedicated private writable folder on a local fixed drive, with an existing parent (path up to 176 characters). Shared, redirected, ambiguous or unrelated nonempty folders cannot be used.';ProtectNew='Install Nearly.exe in:$\r$\n$INSTDIR$\r$\n$\r$\nAfter you click Install, create this folder so only your account, Administrators and SYSTEM can change it. Other users will not have access. The drive and other folders are not changed. Continue?';ProtectExisting='Install Nearly.exe in:$\r$\n$INSTDIR$\r$\n$\r$\nThis folder is empty but other users can change it. After you click Install, preserve the empty original at:$\r$\n$NearlyPreservedRoot$\r$\nThen create a dedicated replacement for your account, Administrators and SYSTEM. Other users will not have access. No existing files or drive permissions are changed. The preserved empty folder is kept for you to review. Continue?'} }
    'ja' { return @{Start='スタートメニューに登録する';Desktop='デスクトップショートカットを作成する';Lang='日本語';Reject='ローカル固定ドライブ上の、このユーザー専用の書き込み可能なフォルダーを選択してください。親フォルダーは既存である必要があり、パスは176文字以内にしてください。共有・転送先・不明なファイルがあるフォルダーは使用できません。';ProtectNew='Nearly.exe のインストール先:$\r$\n$INSTDIR$\r$\n$\r$\n［インストール］を押した後、このフォルダーを現在のユーザー・管理者・SYSTEMだけが変更できる専用フォルダーとして作成します。他のユーザーはアクセスできません。ドライブ全体や他のフォルダーは変更しません。続けますか？';ProtectExisting='Nearly.exe のインストール先:$\r$\n$INSTDIR$\r$\n$\r$\nこの空フォルダーは他のユーザーも変更できます。［インストール］を押した後、元の空フォルダーを次の場所へ退避します:$\r$\n$NearlyPreservedRoot$\r$\nその後、現在のユーザー・管理者・SYSTEMだけの専用フォルダーを作り直します。他のユーザーはアクセスできません。既存ファイルやドライブ全体の権限は変更しません。退避した空フォルダーは確認用に残します。続けますか？'} }
    default { throw 'Unsupported UI language' }
  }
}
function Get-ProtectionSpec([string]$Text,[string]$Target,[string]$Name) {
  $labels=Get-UiCaptions $Name
  $new=$labels.ProtectNew.Replace('$\r$\n',"`r`n").Replace('$INSTDIR',$Target)
  if ($Text -ceq $new) { return @{kind='New';targetChecked=$true;scopeChecked=$true} }
  $empty=$labels.ProtectExisting.Replace('$\r$\n',"`r`n").Replace('$INSTDIR',$Target)
  $parent=Split-Path -Parent $Target
  $sibling=[regex]::Escape((Join-Path $parent '.Nearly-preserved-'))+'[a-f0-9]{32}'
  $pattern='\A'+[regex]::Escape($empty).Replace([regex]::Escape('$NearlyPreservedRoot'),$sibling)+'\z'
  if ([regex]::IsMatch($Text,$pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)) { return @{kind='Existing';targetChecked=$true;scopeChecked=$true} }
}
function Assert-ConsentTransition([string]$Actual,[string]$Expected,[string]$Decision,[bool]$Returning) {
  if ($Actual -notin @('None','New','Existing') -or $Expected -notin @('Auto','None','New','Existing') -or $Decision -notin @('Yes','No')) { throw 'Unsupported consent transition' }
  if ($Returning -and $Actual -ne 'None') { throw 'Back navigation asked for consent again' }
  if (!$Returning -and $Expected -ne 'Auto' -and $Actual -cne $Expected) { throw 'Actual protection plan differs from requested case' }
  if (!$Returning -and $Decision -eq 'No' -and $Actual -eq 'None') { throw 'Consent refusal requires an observed protection dialog' }
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
if ($plan.schemaVersion -ne 2 -or $plan.controllerSha -cne $env:GITHUB_SHA -or $plan.runRoot -cne $RunRoot -or $plan.runId -cne $env:GITHUB_RUN_ID -or $plan.runAttempt -cne $env:GITHUB_RUN_ATTEMPT -or $plan.destinationKind -cnotin @('default','custom','drive')) { throw 'Owned plan marker mismatch' }
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

if (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native') { throw 'UI case requires absent installation registration' }
if (Test-Path -LiteralPath 'HKCU:\Software\local.syncfiles.native\Installer') { throw 'UI default case requires absent shortcut preferences' }
if (Get-Process -Name Nearly -ErrorAction SilentlyContinue) { throw 'Nearly already running' }
if (![Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) { throw 'Interactive hosted desktop unavailable; qualification cannot skip' }
$initialRootPresent=Test-Path -LiteralPath $InstallRoot
$initialPreservedSiblings=@(Get-ChildItem -LiteralPath (Split-Path -Parent $InstallRoot) -Force | Where-Object { $_.Name -cmatch '\A\.Nearly-preserved-[a-f0-9]{32}\z' } | Select-Object -ExpandProperty Name | Sort-Object)
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
  public sealed class WindowChangedException : Exception {
    public WindowChangedException(int expected,uint actual):base("Owned window changed; expected PID="+expected+", observed PID="+actual){}
  }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
    public int Size, Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect;
  }
  public static void AssertOwner(IntPtr h, int pid) {
    uint actual; GetWindowThreadProcessId(h,out actual);
    if(h==IntPtr.Zero || actual!=(uint)pid) throw new WindowChangedException(pid,actual);
  }
  public static IntPtr[] Windows(int pid, IntPtr parent) {
    var found=new List<IntPtr>();
    EnumProc fn=(h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==(uint)pid && IsWindowVisible(h))found.Add(h);return true;};
    if(parent==IntPtr.Zero) EnumWindows(fn,IntPtr.Zero); else {AssertOwner(parent,pid);EnumChildWindows(parent,fn,IntPtr.Zero);}
    return found.ToArray();
  }
  public static string Class(IntPtr h,int pid) {AssertOwner(h,pid);var b=new StringBuilder(256);GetClassName(h,b,b.Capacity);return b.ToString();}
  public static IntPtr Parent(IntPtr h,int pid) {AssertOwner(h,pid);return GetParent(h);}
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
  public static void Command(IntPtr parent,IntPtr button,int pid,int id) {
    AssertOwner(parent,pid);AssertOwner(button,pid);
    if((id!=1&&id!=2&&id!=3&&id!=6&&id!=7)||GetParent(button)!=parent||GetDlgCtrlID(button)!=id||
       !IsWindowVisible(parent)||!IsWindowEnabled(parent)||!IsWindowVisible(button)||!IsWindowEnabled(button))
      throw new Exception("Owned direct dialog button required");
    // Send an ordinary BN_CLICKED notification through the exact parent only.
    // This avoids guessing focus or attaching input queues; no global input.
    if(!PostMessage(parent,273,(IntPtr)id,button))throw new Exception("Owned dialog command failed");
  }
  public static void ClickDirect(IntPtr parent,IntPtr button,int pid,int id) {
    AssertOwner(parent,pid);AssertOwner(button,pid);
    if((id!=1&&id!=2)||GetParent(button)!=parent||GetDlgCtrlID(button)!=id||Class(button,pid)!="Button"||
       !IsWindowVisible(parent)||!IsWindowEnabled(parent)||!IsWindowVisible(button)||!IsWindowEnabled(button))
      throw new Exception("Owned direct rejection button required");
    Click(button,pid);
  }
  public static bool DefaultButton(IntPtr h,int pid) {AssertOwner(h,pid);return Class(h,pid)=="Button"&&(GetWindowLong(h,-16)&15)==1;}
  public static void ClickConsent(IntPtr parent,IntPtr button,int pid,int id) {
    AssertOwner(parent,pid);AssertOwner(button,pid);
    if((id!=6&&id!=7)||GetParent(button)!=parent||GetDlgCtrlID(button)!=id||Class(button,pid)!="Button"||!IsWindowEnabled(parent))throw new Exception("Owned direct consent button required");
    Click(button,pid);
  }
  public static bool[] Activation(IntPtr h,int pid) {
    AssertOwner(h,pid);uint actual;uint thread=GetWindowThreadProcessId(h,out actual);
    var info=new GuiThreadInfo();info.Size=Marshal.SizeOf(typeof(GuiThreadInfo));
    if(!GetGUIThreadInfo(thread,ref info))throw new Exception("Owned activation observation unavailable");
    return new[]{info.Active==h,GetForegroundWindow()==h};
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
    # Conditions only inspect controls. A page transition can destroy a child
    # between enumeration and metadata access. Re-enumerate on that typed race;
    # input methods still require ownership and propagate failures normally.
    try { $value=& $Condition }
    catch {
      if ($_.Exception.GetBaseException() -isnot [NearlyOwnedUi+WindowChangedException]) { throw }
      $value=$null
    }
    # PowerShell converts boxed IntPtr.Zero to true when comparing a Boolean.
    # Keep the result kinds separate so true is accepted and a zero HWND is not.
    $ready=if ($null -eq $value) { $false }
      elseif ($value -is [bool]) { $value }
      elseif ($value -is [IntPtr]) { $value -ne [IntPtr]::Zero }
      elseif ($value -is [hashtable]) { $true }
      else { throw 'Unsupported owned UI wait result type' }
    if ($ready) { return $value }
    Start-Sleep -Milliseconds 150
  }
  throw 'Bounded owned installer UI wait timed out'
}
function Controls([IntPtr]$Parent) { Assert-Process; return [NearlyOwnedUi]::Windows($ownedProcess.Id,$Parent) }
function ById([IntPtr]$Parent,[int]$Id) { return @(Controls $Parent | Where-Object { [NearlyOwnedUi]::GetDlgCtrlID($_) -eq $Id }) }
function One-Control([object[]]$Items) { if ($Items.Count -ne 1) { $caller=(Get-PSCallStack)[1].ScriptLineNumber; throw "Expected exactly one owned visible control; count=$($Items.Count), caller=$caller" }; return [IntPtr]$Items[0] }
function Click-Id([IntPtr]$Parent,[int]$Id) {
  $button=One-Control @(ById $Parent $Id)
  if ($NavigationMode -ceq 'Command') { [NearlyOwnedUi]::Command($Parent,$button,$ownedProcess.Id,$Id) }
  else { [NearlyOwnedUi]::Click($button,$ownedProcess.Id) }
}
function Set-VerifiedDirectorySelection([IntPtr]$Edit) {
  # The default edit can already contain the exact target. Avoid sending a
  # redundant WM_SETTEXT, but always read back the owned control afterwards.
  if ([NearlyOwnedUi]::Text($Edit,$ownedProcess.Id) -cne $InstallRoot) {
    [NearlyOwnedUi]::SetText($Edit,$ownedProcess.Id,$InstallRoot)
  }
  if ([NearlyOwnedUi]::Text($Edit,$ownedProcess.Id) -cne $InstallRoot) { throw 'Actual destination edit did not retain generated destination' }
}
function Get-RejectionButton([IntPtr]$Window) {
  if (@(Controls ([IntPtr]::Zero) | Where-Object { $_ -eq $Window }).Count -ne 1 -or [NearlyOwnedUi]::Class($Window,$ownedProcess.Id) -cne '#32770') { return }
  $children=@(Controls $Window)
  $message=@($children | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Static' -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Reject })
  if ($message.Count -ne 1) { return }
  $buttons=@($children | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Button' -and [NearlyOwnedUi]::IsWindowVisible($_) -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -cin @('OK','&OK') })
  if ($buttons.Count -ne 1) { return }
  $button=[IntPtr]$buttons[0]
  $id=[NearlyOwnedUi]::GetDlgCtrlID($button)
  if ($id -notin @(1,2) -or [NearlyOwnedUi]::Parent($button,$ownedProcess.Id) -ne $Window -or ![NearlyOwnedUi]::IsWindowEnabled($button)) { return }
  return @{button=$button;id=$id}
}
function Dismiss-Rejection([IntPtr]$Window) {
  $caller=(Get-PSCallStack)[1].ScriptLineNumber
  try {
    Wait-Ui { Get-RejectionButton $Window } | Out-Null
    Write-Host ('QA UI rejection modal controls: '+(ConvertTo-Json -InputObject @(Failure-ControlSnapshot $Window) -Depth 3 -Compress))
    # Re-read after diagnostics; input still checks the current exact direct
    # parent and actual ID rather than assuming MessageBox uses IDOK=1.
    $target=Wait-Ui { Get-RejectionButton $Window }
    Write-UiObservation 'before-reject-ok'
    if ($NavigationMode -ceq 'Command') { [NearlyOwnedUi]::Command($Window,$target.button,$ownedProcess.Id,$target.id) }
    else { [NearlyOwnedUi]::ClickDirect($Window,$target.button,$ownedProcess.Id,$target.id) }
    Wait-Ui {
      $remaining=@(Controls ([IntPtr]::Zero) | Where-Object { $_ -eq $Window })
      # Never query ownership of the already-destroyed modal HWND.
      return $remaining.Count -eq 0 -and [NearlyOwnedUi]::Class($main,$ownedProcess.Id) -ceq '#32770' -and [NearlyOwnedUi]::IsWindowEnabled($main)
    } | Out-Null
    Write-UiObservation 'after-reject-ok'
  } catch {
    $inputLine=$_.InvocationInfo.ScriptLineNumber
    try { Write-Host ('QA UI rejection failure controls: '+(ConvertTo-Json -InputObject @(Failure-ControlSnapshot $Window) -Depth 3 -Compress)) } catch {}
    throw "Known rejection dialog dismissal failed; caller=$caller, inputLine=$inputLine"
  }
}
function Get-ProtectionDialog([IntPtr]$Window) {
  # Pinned MUI2 Directory.nsh uses Caption " ": Ui.c appends that single
  # ASCII space to the main title; MessageBox uses the base g_caption alone.
  if ([NearlyOwnedUi]::Class($Window,$ownedProcess.Id) -cne '#32770' -or ([NearlyOwnedUi]::Text($Window,$ownedProcess.Id)+' ') -cne [NearlyOwnedUi]::Text($main,$ownedProcess.Id)) { return }
  $children=@(Controls $Window)
  $specs=@($children | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Static' } | ForEach-Object { Get-ProtectionSpec ([NearlyOwnedUi]::Text($_,$ownedProcess.Id)) $InstallRoot $Language })
  if ($specs.Count -ne 1) { return }
  $buttons=@($children | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Button' })
  if ($buttons.Count -ne 2) { return }
  $yes=@($buttons | Where-Object { [NearlyOwnedUi]::GetDlgCtrlID($_) -eq 6 -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -cin @('Yes','&Yes','はい','はい(&Y)') })
  $no=@($buttons | Where-Object { [NearlyOwnedUi]::GetDlgCtrlID($_) -eq 7 -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -cin @('No','&No','いいえ','いいえ(&N)') })
  if ($yes.Count -ne 1 -or $no.Count -ne 1) { return }
  foreach ($button in @($yes[0],$no[0])) { if ([NearlyOwnedUi]::Parent($button,$ownedProcess.Id) -ne $Window -or ![NearlyOwnedUi]::IsWindowVisible($button) -or ![NearlyOwnedUi]::IsWindowEnabled($button)) { return } }
  if (![NearlyOwnedUi]::DefaultButton($no[0],$ownedProcess.Id) -or [NearlyOwnedUi]::DefaultButton($yes[0],$ownedProcess.Id)) { throw 'Protection must default to No' }
  return @{kind=$specs[0].kind;window=$Window;yes=$yes[0];no=$no[0];defaultNo=$true}
}
function Get-CandidatePolicyDiagnostic([string]$Text) {
  if ($Text -ceq 'NEARLY_QA_POLICY_HELPER') { return 'helper-namespace' }
  if ($Text -cmatch '\ANEARLY_QA_POLICY_EXIT=(-?[0-9]{1,10}|error|timeout)\z') { return 'helper-exit-'+$Matches[1] }
}
function Wait-DirectoryTransition {
  return Wait-Ui {
    foreach ($window in @(Controls ([IntPtr]::Zero) | Where-Object { $_ -ne $main })) {
      foreach ($control in @(Controls $window)) {
        if ([NearlyOwnedUi]::Class($control,$ownedProcess.Id) -ceq 'Static') {
          $code=Get-CandidatePolicyDiagnostic ([NearlyOwnedUi]::Text($control,$ownedProcess.Id))
          if ($code) { return @{kind='Diagnostic';window=$window;code=$code} }
        }
      }
      $protection=Get-ProtectionDialog $window
      if ($null -ne $protection) { return $protection }
      if ($null -ne (Get-RejectionButton $window)) { return @{kind='Reject';window=$window} }
    }
    if (@(Controls $main | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Button' -and [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Start }).Count -eq 1) { return @{kind='None'} }
  }
}
function Answer-Protection([hashtable]$Dialog,[ValidateSet('Yes','No')][string]$Decision) {
  # Re-query immediately before input, and never log the helper's nonce/path.
  $current=Get-ProtectionDialog $Dialog.window
  if ($null -eq $current -or $current.kind -cne $Dialog.kind) { throw 'Protection dialog changed before explicit choice' }
  Assert-NoInstallMutation
  Screenshot ('protection-'+$current.kind.ToLowerInvariant()+'-'+$Decision.ToLowerInvariant()) $current.window
  $events.Add(@{stage='protection-consent';kind=$current.kind;decision=$Decision;defaultNo=$current.defaultNo;targetChecked=$true;scopeChecked=$true;beforeInstall=$true})
  $id=if ($Decision -eq 'Yes') {6}else{7}
  $button=if ($Decision -eq 'Yes') {$current.yes}else{$current.no}
  if ($NavigationMode -ceq 'Command') { [NearlyOwnedUi]::Command($current.window,$button,$ownedProcess.Id,$id) }
  else { [NearlyOwnedUi]::ClickConsent($current.window,$button,$ownedProcess.Id,$id) }
  Wait-Ui { return @(Controls ([IntPtr]::Zero) | Where-Object {$_ -eq $current.window}).Count -eq 0 -and [NearlyOwnedUi]::IsWindowEnabled($main) } | Out-Null
  Assert-NoInstallMutation
}
function Assert-NoInstallMutation {
  foreach ($target in @((Join-Path $InstallRoot 'Nearly.exe'),(Join-Path $InstallRoot 'uninstall.exe'),'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native','HKCU:\Software\local.syncfiles.native\Installer')) { if (Test-Path -LiteralPath $target) { throw 'Directory navigation or consent mutated installed state' } }
  if ((Test-Path -LiteralPath $InstallRoot) -ne $initialRootPresent) { throw 'Consent changed destination presence before Install' }
  $siblings=@(Get-ChildItem -LiteralPath (Split-Path -Parent $InstallRoot) -Force | Where-Object { $_.Name -cmatch '\A\.Nearly-preserved-[a-f0-9]{32}\z' } | Select-Object -ExpandProperty Name | Sort-Object)
  if (($initialPreservedSiblings -join [char]0) -cne ($siblings -join [char]0)) { throw 'Consent preserved a folder before Install' }
}

function Write-UiObservation([string]$Point) {
  try {
    $active=[NearlyOwnedUi]::Activation($main,$ownedProcess.Id)
    $checks=@(Controls $main | Where-Object { [NearlyOwnedUi]::Checkbox($_,$ownedProcess.Id) })
    $shortcuts=@($checks | Where-Object { [NearlyOwnedUi]::Text($_,$ownedProcess.Id) -ceq $captions.Start }).Count -eq 1
    $next=@(ById $main 1)
    $nextEnabled=$next.Count -eq 1 -and [NearlyOwnedUi]::IsWindowEnabled($next[0])
    $modals=@(Controls ([IntPtr]::Zero) | Where-Object { $_ -ne $main }).Count
    $record=[ordered]@{point=$Point;navigation=$NavigationMode;active=$active[0];foreground=$active[1];shortcuts=$shortcuts;nextEnabled=$nextEnabled;ownedOtherWindows=$modals;payloadPresent=(Test-Path -LiteralPath (Join-Path $InstallRoot 'Nearly.exe'));uninstallerPresent=(Test-Path -LiteralPath (Join-Path $InstallRoot 'uninstall.exe'));registrationPresent=(Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.syncfiles.native')}
    Write-Host ('QA UI transition observation: '+(ConvertTo-Json -InputObject $record -Compress))
  } catch { Write-Host 'QA UI transition observation unavailable' }
}
function Failure-ControlSnapshot([IntPtr]$Window) {
  $entries=[Collections.Generic.List[object]]::new()
  foreach ($control in @(Controls $Window | Select-Object -First 64)) {
    try {
      $class=[NearlyOwnedUi]::Class($control,$ownedProcess.Id)
      $kind=switch -CaseSensitive ($class) {'Button' {'button'} 'Edit' {'edit'} 'ComboBox' {'combo'} 'Static' {'static'} '#32770' {'dialog'} default {'other'}}
      $id=[NearlyOwnedUi]::GetDlgCtrlID($control)
      if ($id -lt -1 -or $id -gt 65535) { $id=$null }
      $entries.Add(@{kind=$kind;id=$id;enabled=[NearlyOwnedUi]::IsWindowEnabled($control)})
    } catch {
      if ($_.Exception.GetBaseException() -isnot [NearlyOwnedUi+WindowChangedException]) { throw }
    }
  }
  return @($entries.ToArray())
}
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
function Test-InstallTransition {
  $progress=@(Controls $main | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'msctls_progress32' })
  if ($progress.Count -eq 1) { return $true }
  $next=@(ById $main 1)
  if ($next.Count -eq 1 -and [NearlyOwnedUi]::IsWindowEnabled($next[0])) {
    $text=[NearlyOwnedUi]::Text($next[0],$ownedProcess.Id)
    if (($Language -eq 'en' -and $text -match 'Finish') -or ($Language -eq 'ja' -and $text -match '完了')) { return $true }
  }
  return $false
}
function Get-InstallNavigation {
  $next=@(ById $main 1)
  if ($next.Count -ne 1 -or ![NearlyOwnedUi]::IsWindowEnabled($next[0])) { return }
  $text=[NearlyOwnedUi]::Text($next[0],$ownedProcess.Id)
  if (($Language -eq 'en' -and $text -match 'Finish') -or ($Language -eq 'ja' -and $text -match '完了')) { return @{kind='finish'} }
  $progress=@(Controls $main | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'msctls_progress32' })
  if ($progress.Count -eq 1 -and (($Language -eq 'en' -and $text -match 'Next') -or ($Language -eq 'ja' -and $text -match '次へ'))) { return @{kind='next'} }
}
function Cancel-Setup([ValidateSet(1,5)][int]$ExpectedExitCode=1) {
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
  if ($ownedProcess.ExitCode -ne $ExpectedExitCode) { throw 'Unexpected cancelled installer exit code' }
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
  Set-VerifiedDirectorySelection $edit
  Screenshot 'directory'
  Click-Id $main 1
  $transition=Wait-DirectoryTransition
  if ($transition.kind -eq 'Diagnostic') {
    Screenshot 'destination-rejected' $transition.window
    throw "Candidate policy diagnostic: $($transition.code)"
  }
  if ($transition.kind -eq 'Reject') {
    Screenshot 'destination-rejected' $transition.window
    if ($Mode -ne 'Reject') { throw 'Destination unexpectedly rejected' }
    $stage='destination-rejection'
    Dismiss-Rejection $transition.window
    Assert-NoInstallMutation
    Write-UiObservation 'before-reject-cancel'
    Cancel-Setup -ExpectedExitCode 5
    $result='rejected'
  } else {
    if ($Mode -eq 'Reject') { throw 'Nonempty destination unexpectedly accepted or offered protection' }
    Assert-ConsentTransition $transition.kind $ConsentKind $ConsentDecision $false
    if ($transition.kind -in @('New','Existing')) { Answer-Protection $transition $ConsentDecision }
    if ($ConsentDecision -eq 'No') {
      $stage='protection-refused'
      $edit=Wait-Ui { $v=@(ById $main 1019 | Where-Object { [NearlyOwnedUi]::Class($_,$ownedProcess.Id) -ceq 'Edit' });if($v.Count -eq 1){return $v[0]} }
      if ([NearlyOwnedUi]::Text($edit,$ownedProcess.Id) -cne $InstallRoot) { throw 'Consent refusal lost destination' }
      Assert-NoInstallMutation
      Cancel-Setup
      $result='cancelled'
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
    $returnTransition=Wait-DirectoryTransition
    Assert-ConsentTransition $returnTransition.kind 'Auto' 'Yes' $true
    Assert-NoInstallMutation
    $events.Add(@{stage='protection-back-retained';noReprompt=$true;beforeInstall=$true})
    Wait-Shortcuts
    Assert-UiSelection (Shortcut-States) $requested
    Screenshot 'shortcuts-back-return'
    if ($Mode -eq 'Cancel') { $stage='cancel'; Cancel-Setup; $result='cancelled' }
    else {
      $stage='install'
      Write-UiObservation 'before-install'
      Click-Id $main 1
      # Observe actual departure separately from completion. A queued BM_CLICK
      # does not itself prove that the installer entered its installation page.
      Wait-Ui { Test-InstallTransition } | Out-Null
      Write-UiObservation 'after-install-transition'
      $completion=Wait-Ui { Get-InstallNavigation } 120
      if ($completion.kind -ceq 'next') {
        # NOAUTOCLOSE deliberately leaves a completed InstFiles page visible.
        # Advance its actual enabled Next button once before awaiting Finish.
        Screenshot 'install-complete'
        Click-Id $main 1
      }
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
  }
} catch {
  # Preserve only owned-window pixels and bounded numeric/known-kind metadata.
  # Never read arbitrary captions or let diagnostics replace the original error.
  $failureWindow=if ($main -ne [IntPtr]::Zero) { $main } else { $languageWindow }
  if ($main -ne [IntPtr]::Zero) { Write-UiObservation 'failure' }
  if ($failureWindow -ne [IntPtr]::Zero) {
    try { Write-Host ('QA UI failure controls: '+(ConvertTo-Json -InputObject @(Failure-ControlSnapshot $failureWindow) -Depth 3 -Compress)) } catch {}
    try { Screenshot 'failure' $failureWindow } catch {}
  }
  throw
} finally {
  # Deliberately emit only generated labels, known UI captions and states.
  # Never copy logs, arbitrary window text, settings, tokens, binaries or env.
  $report=[ordered]@{schemaVersion=1;case=$CaseName;language=$Language;mode=$Mode;destinationKind=$(if($InstallRoot -ceq $destinations.drive){'drive'}else{$plan.destinationKind});start=$Start;desktop=$Desktop;result=$result;lastStage=$stage;events=@($events.ToArray())}
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $artifactDir 'evidence.json') -Encoding utf8
}
