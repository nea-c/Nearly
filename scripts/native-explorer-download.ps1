$ErrorActionPreference='Stop'
$qa=[IO.File]::ReadAllText($env:NEARLY_EXPLORER_QA_CONFIG) | ConvertFrom-Json
if(-not $qa.generatedOnly){throw 'Generated-only Explorer QA configuration required'}
$qaRoot=[IO.Path]::GetFullPath($qa.root)
$qaFolder=[IO.Path]::GetFullPath($qa.folder)
if(-not $qaFolder.StartsWith($qaRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Explorer destination outside generated fixture'}
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NearlyOleQa {
 public delegate bool EnumWindowProc(IntPtr window,IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback,IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 public static IntPtr[] OwnedWindows(uint expected){var result=new System.Collections.Generic.List<IntPtr>();EnumWindows((window,parameter)=>{uint owner;GetWindowThreadProcessId(window,out owner);if(owner==expected&&IsWindowVisible(window))result.Add(window);return true;},IntPtr.Zero);return result.ToArray();}
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {public int Size;public RECT Monitor,Work;public uint Flags;}
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] public struct UNION {[FieldOffset(0)]public MOUSEINPUT mouse;[FieldOffset(0)]public KEYBDINPUT key;}
 [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type;public UNION value;}
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref POINT point);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flag);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flag);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor,ref MONITORINFO info);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] input,int size);
 public static void Mouse(uint flags){var input=new INPUT {type=0,value=new UNION{mouse=new MOUSEINPUT{flags=flags}}};if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Owned mouse input was not accepted");}
 public static void EscapeKey(uint flags){var input=new INPUT{type=1,value=new UNION{key=new KEYBDINPUT{vk=27,flags=flags}}};if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Owned Escape input was not accepted");}
 public static void Escape(){foreach(uint flags in new uint[]{0,2}){var input=new INPUT{type=1,value=new UNION{key=new KEYBDINPUT{vk=27,flags=flags}}};if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Owned Escape input was not accepted");}}
}
'@
function ShellWindows($shell){@($shell.Windows() | ForEach-Object {$_})}
function MatchFolder($window){try {[string]::Equals([IO.Path]::GetFullPath($window.Document.Folder.Self.Path),$qaFolder,[StringComparison]::OrdinalIgnoreCase)}catch {$false}}
function OwnedSource($hwnd){$ownerId=[uint32]0;[void][NearlyOleQa]::GetWindowThreadProcessId([IntPtr]$hwnd,[ref]$ownerId);if($ownerId -ne [uint32]$qa.pid -or -not [NearlyOleQa]::IsWindow([IntPtr]$hwnd)){throw 'Source window is not the owned QA process'}}
$oldDpi=[NearlyOleQa]::SetThreadDpiAwarenessContext([IntPtr](-4));if($oldDpi -eq [IntPtr]::Zero){throw 'Cannot establish physical coordinate context'}
$mouseDown=$false
$originalCursor=[NearlyOleQa+POINT]::new();[void][NearlyOleQa]::GetCursorPos([ref]$originalCursor)
try {
 $shell=New-Object -ComObject Shell.Application
 if($qa.mode -eq 'appdrag'){
  $matches=@([NearlyOleQa]::OwnedWindows([uint32]$qa.pid) | Where-Object {
   $r=[NearlyOleQa+RECT]::new();[void][NearlyOleQa]::GetWindowRect($_,[ref]$r)
   [Math]::Abs($r.Left-$qa.bounds.position.x) -le 2 -and [Math]::Abs($r.Top-$qa.bounds.position.y) -le 2 -and [Math]::Abs(($r.Right-$r.Left)-$qa.bounds.size.width) -le 2 -and [Math]::Abs(($r.Bottom-$r.Top)-$qa.bounds.size.height) -le 2
  })
  if($matches.Count -ne 1){throw 'Cannot uniquely identify owned QA source; no input sent'}
  $source=$matches[0];OwnedSource $source
  [void][NearlyOleQa]::SetForegroundWindow($source)
  if($qa.manualForeground -and [NearlyOleQa]::GetForegroundWindow() -ne $source){
   [IO.File]::WriteAllText([IO.Path]::Combine($qaRoot,'app-activation-required.json'),(@{pid=$qa.pid;sourceHwnd=[long]$source;manualActivationRequired=$true}|ConvertTo-Json -Compress))
   $activationDeadline=[DateTime]::UtcNow.AddSeconds(600)
   while([NearlyOleQa]::GetForegroundWindow() -ne $source -and [DateTime]::UtcNow -lt $activationDeadline){Start-Sleep -Milliseconds 100}
  }
  if([NearlyOleQa]::GetForegroundWindow() -ne $source){throw 'Owned QA activation refused; no app drag input sent'}
  foreach($key in @(1,16,17,18)){if([NearlyOleQa]::GetAsyncKeyState($key) -lt 0){throw 'Desktop input in use; no app drag input sent'}}
  $from=[NearlyOleQa+POINT]::new();$from.X=[int]($qa.css.x*$qa.scale);$from.Y=[int]($qa.css.y*$qa.scale)
  $to=[NearlyOleQa+POINT]::new();$to.X=[int]($qa.targetCss.x*$qa.scale);$to.Y=[int]($qa.targetCss.y*$qa.scale)
  if(-not [NearlyOleQa]::ClientToScreen($source,[ref]$from) -or -not [NearlyOleQa]::ClientToScreen($source,[ref]$to)){throw 'Owned app coordinates unavailable'}
  foreach($point in @($from,$to)){if([NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($point),2) -ne $source){throw 'Owned app source or destination covered; no input sent'}}
  [void][NearlyOleQa]::SetCursorPos($from.X,$from.Y);Start-Sleep -Milliseconds 100
  $started=[DateTime]::UtcNow;[NearlyOleQa]::Mouse(2);$mouseDown=$true
  for($i=1;$i -le 12;$i++){[void][NearlyOleQa]::SetCursorPos([int]($from.X+($to.X-$from.X)*$i/12),[int]($from.Y+($to.Y-$from.Y)*$i/12));Start-Sleep -Milliseconds 20}
  if([NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($to),2) -ne $source){[NearlyOleQa]::Escape();throw 'Owned app destination covered; gesture cancelled'}
  if($qa.cancel){[NearlyOleQa]::Escape()}
  [NearlyOleQa]::Mouse(4);$mouseDown=$false
  @{dragged=$true;sourceHwnd=[long]$source;targetHwnd=[long]$source;gestureMs=([DateTime]::UtcNow-$started).TotalMilliseconds;source=$from;target=$to} | ConvertTo-Json -Depth 4 -Compress
 } elseif($qa.mode -eq 'open'){
  $matches=@([NearlyOleQa]::OwnedWindows([uint32]$qa.pid) | Where-Object {
    $r=[NearlyOleQa+RECT]::new();[void][NearlyOleQa]::GetWindowRect($_,[ref]$r)
    [Math]::Abs($r.Left-$qa.bounds.position.x) -le 2 -and [Math]::Abs($r.Top-$qa.bounds.position.y) -le 2 -and [Math]::Abs(($r.Right-$r.Left)-$qa.bounds.size.width) -le 2 -and [Math]::Abs(($r.Bottom-$r.Top)-$qa.bounds.size.height) -le 2
  })
  if($matches.Count -ne 1){throw 'Cannot uniquely identify the owned QA window from its native bounds; no input sent'}
  $source=$matches[0];OwnedSource $source
  [void][NearlyOleQa]::SetForegroundWindow($source)
  if($qa.manualForeground){
    if([NearlyOleQa]::GetForegroundWindow() -ne $source){
      [void][NearlyOleQa]::SetWindowPos($source,[IntPtr]::Zero,0,0,0,0,0x53)
      [IO.File]::WriteAllText([IO.Path]::Combine($qaRoot,'activation-required.json'),(@{pid=$qa.pid;sourceHwnd=[long]$source;manualActivationRequired=$true}|ConvertTo-Json -Compress))
    }
    $activationDeadline=[DateTime]::UtcNow.AddSeconds(600)
    while([NearlyOleQa]::GetForegroundWindow() -ne $source -and [DateTime]::UtcNow -lt $activationDeadline){Start-Sleep -Milliseconds 100}
  }
  if([NearlyOleQa]::GetForegroundWindow() -ne $source){throw 'Normal QA window activation was not accepted; no input sent'}
  $baseline=@(ShellWindows $shell | ForEach-Object {[long]$_.HWND})
  [void]$shell.Explore($qaFolder)
  $window=$null
  for($i=0;$i -lt 100 -and $null -eq $window;$i++){$window=ShellWindows $shell | Where-Object {(MatchFolder $_) -and ([long]$_.HWND -notin $baseline)} | Select-Object -First 1;if($null -eq $window){Start-Sleep -Milliseconds 100}}
  if($null -eq $window){throw 'Could not obtain a separate owned Explorer window; existing windows preserved'}
  $explorer=[IntPtr]([long]$window.HWND)
  [IO.File]::WriteAllText($qa.openState,(@{sourceHwnd=[long]$source;explorerHwnd=[long]$explorer;baseline=$baseline;folder=$qaFolder}|ConvertTo-Json -Depth 4 -Compress))
  $monitor=[NearlyOleQa+MONITORINFO]::new();$monitor.Size=[Runtime.InteropServices.Marshal]::SizeOf($monitor)
  if(-not [NearlyOleQa]::GetMonitorInfo([NearlyOleQa]::MonitorFromWindow($source,2),[ref]$monitor)){throw 'Monitor work area unavailable'}
  $work=$monitor.Work;$width=$work.Right-$work.Left;$height=$work.Bottom-$work.Top
  [void][NearlyOleQa]::SetWindowPos($source,[IntPtr]::Zero,$work.Left+8,$work.Top+8,1000,[Math]::Min(760,$height-16),0x10)
  $sourceRect=[NearlyOleQa+RECT]::new();[void][NearlyOleQa]::GetWindowRect($source,[ref]$sourceRect)
  if($sourceRect.Right -gt $work.Right-180){[void][NearlyOleQa]::SetWindowPos($source,[IntPtr]::Zero,$work.Right-180-($sourceRect.Right-$sourceRect.Left),$sourceRect.Top,$sourceRect.Right-$sourceRect.Left,$sourceRect.Bottom-$sourceRect.Top,0x10)}
  [void][NearlyOleQa]::SetWindowPos($explorer,$source,$work.Right-[Math]::Min(780,$width),$work.Top+30,[Math]::Min(780,$width),[Math]::Min(730,$height-40),0x10)
  [void][NearlyOleQa]::SetWindowPos($source,[IntPtr]::Zero,0,0,0,0,0x13)
  [void][NearlyOleQa]::GetWindowRect($source,[ref]$sourceRect)
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
  $view=$null
  for($i=0;$i -lt 80 -and $null -eq $view;$i++){
   $root=[System.Windows.Automation.AutomationElement]::FromHandle($explorer)
   $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty,'UIItemsView')
   $view=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
   if($null -eq $view){Start-Sleep -Milliseconds 100}
  }
  if($null -eq $view){$window.Quit();throw 'Owned Explorer file view unavailable; no physical input sent'}
  # Locate an actually exposed point; geometry alone does not establish that
  # an existing browser/always-on-top window is not covering the file view.
  # Reposition only the newly created Explorer, never the covering application.
  $candidateWidth=[Math]::Min(780,$width);$candidateHeight=[Math]::Min(730,$height-40)
  $positions=@(
    @{x=$work.Right-$candidateWidth;y=$work.Top+30;h=$candidateHeight},
    @{x=[Math]::Max($work.Left+20,$sourceRect.Right-180);y=$work.Top+30;h=$candidateHeight},
    @{x=$work.Left+20;y=$sourceRect.Bottom+20;h=[Math]::Min($candidateHeight,$work.Bottom-$sourceRect.Bottom-30)},
    @{x=$work.Left+20;y=$work.Top+150;h=$candidateHeight}
  )
  $found=$false;$x=0;$y=0
  foreach($position in $positions){
    if($position.h -lt 350){continue}
    if(-not [NearlyOleQa]::SetWindowPos($explorer,$source,[int]$position.x,[int]$position.y,[int]$candidateWidth,[int]$position.h,0x10)){throw 'Owned Explorer positioning failed'}
    [void][NearlyOleQa]::SetWindowPos($source,[IntPtr]::Zero,0,0,0,0,0x13)
    Start-Sleep -Milliseconds 120
    $bounds=$view.Current.BoundingRectangle
    if($bounds.Width -lt 100 -or $bounds.Height -lt 100){continue}
    foreach($rx in @(0.12,0.5,0.88)){
      foreach($ry in @(0.2,0.5,0.8)){
        $candidate=[NearlyOleQa+POINT]::new();$candidate.X=[int]($bounds.Left+$bounds.Width*$rx);$candidate.Y=[int]($bounds.Top+$bounds.Height*$ry)
        if([NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($candidate),2) -eq $explorer){$x=$candidate.X;$y=$candidate.Y;$found=$true;break}
      }
      if($found){break}
    }
    if($found){break}
  }
  if(-not $found){$window.Quit();throw 'No exposed owned Explorer file view after ordinary positioning; manual window visibility is required and no input was sent'}
  @{sourceHwnd=[long]$source;explorerHwnd=[long]$explorer;baseline=$baseline;target=@{x=[int]$x;y=[int]$y};sourceRect=$sourceRect;view=@{left=$bounds.Left;top=$bounds.Top;width=$bounds.Width;height=$bounds.Height};folder=$qaFolder} | ConvertTo-Json -Depth 6 -Compress
 } elseif($qa.mode -eq 'drag'){
  OwnedSource $qa.sourceHwnd
  $window=ShellWindows $shell | Where-Object {([long]$_.HWND -eq [long]$qa.explorerHwnd) -and (MatchFolder $_)} | Select-Object -First 1
  if($null -eq $window -or [long]$qa.explorerHwnd -in @($qa.baseline)){throw 'Explorer ownership or destination changed; no drag'}
  # Refresh only the two owned windows' ordinary z-order immediately before
  # hit-testing. Activating the source after initial setup may expose another
  # application above the receiving window; never release a drop there.
  [void][NearlyOleQa]::SetWindowPos([IntPtr]$qa.explorerHwnd,[IntPtr]::Zero,0,0,0,0,0x13)
  [void][NearlyOleQa]::SetWindowPos([IntPtr]$qa.sourceHwnd,[IntPtr]::Zero,0,0,0,0,0x13)
  foreach($key in @(1,16,17,18)){if([NearlyOleQa]::GetAsyncKeyState($key) -lt 0){throw 'Desktop input is in use; owned test did not take control'}}
  $point=[NearlyOleQa+POINT]::new();$point.X=[int]($qa.css.x*$qa.scale);$point.Y=[int]($qa.css.y*$qa.scale)
  if(-not [NearlyOleQa]::ClientToScreen([IntPtr]$qa.sourceHwnd,[ref]$point)){throw 'Source physical position unavailable'}
  $foreground=[long][NearlyOleQa]::GetForegroundWindow()
  if($foreground -notin @([long]$qa.sourceHwnd,[long]$qa.explorerHwnd)){throw 'Another application is active; no test input sent'}
  $hit=[NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($point),2)
  if([long]$hit -ne [long]$qa.sourceHwnd){throw 'Source item is covered; no test input sent'}
  $targetPoint=[NearlyOleQa+POINT]::new();$targetPoint.X=[int]$qa.target.x;$targetPoint.Y=[int]$qa.target.y
  $targetRoot=[NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($targetPoint),2)
  if([long]$targetRoot -ne [long]$qa.explorerHwnd){throw ('Owned Explorer target is covered; no input sent. expected='+$qa.explorerHwnd+' actual='+[long]$targetRoot)}
  [void][NearlyOleQa]::SetCursorPos($point.X,$point.Y);Start-Sleep -Milliseconds 100
  $gestureStarted=[DateTime]::UtcNow
  [NearlyOleQa]::Mouse(2);$mouseDown=$true
  [IO.File]::WriteAllText($qa.downSignal,'owned-down')
  $steps=if($qa.immediate){8}else{25};$stepMs=if($qa.immediate){15}else{25}
  for($i=1;$i -le $steps;$i++){[void][NearlyOleQa]::SetCursorPos([int]($point.X+($qa.target.x-$point.X)*$i/$steps),[int]($point.Y+($qa.target.y-$point.Y)*$i/$steps));Start-Sleep -Milliseconds $stepMs}
  if([long][NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($targetPoint),2) -ne [long]$qa.explorerHwnd){[NearlyOleQa]::Escape();throw 'Owned Explorer target became covered; drag cancelled before release'}
  [IO.File]::WriteAllText($qa.heldSignal,'owned-held-over-explorer')
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while(-not $qa.immediate -and -not [IO.File]::Exists($qa.releaseSignal)){if([DateTime]::UtcNow -gt $deadline){throw 'Owned drag metadata/drop release deadline expired'};Start-Sleep -Milliseconds 10}
  $escapeDownObserved=$false;$escapeHoldMs=0
  if($qa.cancel){
   if([long][NearlyOleQa]::GetForegroundWindow() -notin @([long]$qa.sourceHwnd,[long]$qa.explorerHwnd)){throw 'Unexpected foreground before owned Escape; no key sent'}
   if([long][NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($targetPoint),2) -ne [long]$qa.explorerHwnd){throw 'Owned Escape destination covered; no key sent'}
   [NearlyOleQa]::EscapeKey(0)
   try{
    Start-Sleep -Milliseconds 20;$escapeDownObserved=[NearlyOleQa]::GetAsyncKeyState(27) -lt 0
    if(-not $escapeDownObserved){throw 'Owned Escape key-down state not observed'}
    for($hold=0;$hold -lt 24;$hold++){
     if([long][NearlyOleQa]::GetForegroundWindow() -notin @([long]$qa.sourceHwnd,[long]$qa.explorerHwnd)){throw 'Foreground changed during owned Escape'}
     Start-Sleep -Milliseconds 50
    }
    $escapeHoldMs=1200
   }finally{[NearlyOleQa]::EscapeKey(2)}
  }
  if([long][NearlyOleQa]::GetAncestor([NearlyOleQa]::WindowFromPoint($targetPoint),2) -ne [long]$qa.explorerHwnd){[NearlyOleQa]::Escape();throw 'Owned Explorer target became covered before release; drag cancelled'}
  [NearlyOleQa]::Mouse(4);$mouseDown=$false
  @{escapeDownObserved=$escapeDownObserved;escapeHoldMs=$escapeHoldMs;originalCursor=@{x=$originalCursor.X;y=$originalCursor.Y};releaseUtc=[DateTime]::UtcNow.ToString('o');immediate=[bool]$qa.immediate;gestureMs=([DateTime]::UtcNow-$gestureStarted).TotalMilliseconds;dragged=$true;cancelled=[bool]$qa.cancel;sourceHwnd=$qa.sourceHwnd;explorerHwnd=$qa.explorerHwnd;source=@{x=$point.X;y=$point.Y};target=$qa.target} | ConvertTo-Json -Depth 4 -Compress
 } elseif($qa.mode -eq 'close'){
  $window=ShellWindows $shell | Where-Object {([long]$_.HWND -eq [long]$qa.explorerHwnd) -and (MatchFolder $_)} | Select-Object -First 1
  if($null -ne $window){if([long]$qa.explorerHwnd -in @($qa.baseline)){throw 'Refuse closing a baseline Explorer window'};$window.Quit()}
  elseif([NearlyOleQa]::IsWindow([IntPtr]$qa.explorerHwnd)){throw 'Explorer destination changed; window preserved'}
  for($i=0;$i -lt 30 -and [NearlyOleQa]::IsWindow([IntPtr]$qa.explorerHwnd);$i++){Start-Sleep -Milliseconds 100}
  if([NearlyOleQa]::IsWindow([IntPtr]$qa.explorerHwnd)){throw 'Could not confirm owned Explorer window closed'}
  @{closed=$true;explorerHwnd=$qa.explorerHwnd} | ConvertTo-Json -Compress
 } else {throw 'Unsupported owned Explorer QA mode'}
} finally {
 if($mouseDown){[NearlyOleQa]::Mouse(4)}
 # Leave the pointer at the release point. Restoring it here can relocate an
 # unfinished OLE drop while a synchronous target awaits metadata.
 [void][NearlyOleQa]::SetThreadDpiAwarenessContext($oldDpi)
}
