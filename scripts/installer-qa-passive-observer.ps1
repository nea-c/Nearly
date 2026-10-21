# Definitions only. The guarded hosted guest owns process launch and policy.
# This observer never starts, stops, clicks, focuses or changes a process/window.
function Get-NearlyPassiveClassification([string]$Text) {
  switch -CaseSensitive ($Text) {
    'Setup could not replace Nearly.exe. Close Nearly and try again. Your settings have not been removed.' { return 'payload-write' }
    'Setup could not finish per-user registration. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.' { return 'registration' }
    'Setup could not finish shortcut preferences. Settings remain beside Nearly.exe. Open Nearly directly or retry Setup; automatic restart was skipped.' { return 'shortcuts' }
    default { return 'unknown' }
  }
}

function Initialize-NearlyPassiveObserverNative {
  if ($null -ne ('NearlyPassiveObserverNative' -as [type])) { return }
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NearlyPassiveObserverNative {
  public sealed class Sample {
    public string[] Texts=new string[0];
    public int WindowCount,StatusCount,ErrorCode;
    public bool Truncated;
  }
  delegate bool EnumProc(IntPtr window,IntPtr unused);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(EnumProc callback,IntPtr unused);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumChildWindows(IntPtr window,EnumProc callback,IntPtr unused);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int count);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint milliseconds,out IntPtr result);
  static bool Owned(IntPtr window,int pid) {
    uint actual;GetWindowThreadProcessId(window,out actual);
    return window!=IntPtr.Zero&&actual==(uint)pid;
  }
  static string ReadStatus(IntPtr window,int pid) {
    // WM_GETTEXT[LENGTH] only; no input messages or remote writes.
    IntPtr length;
    if(!Owned(window,pid)||SendMessageTimeout(window,14,IntPtr.Zero,IntPtr.Zero,3,25,out length)==IntPtr.Zero)return null;
    long count=length.ToInt64();
    if(count<0||count>4096)return null;
    IntPtr buffer=Marshal.AllocHGlobal(((int)count+1)*2);
    try {
      IntPtr copied;
      if(!Owned(window,pid)||SendMessageTimeout(window,13,(IntPtr)(count+1),buffer,3,25,out copied)==IntPtr.Zero)return null;
      long used=copied.ToInt64();
      if(used<0||used>count)return null;
      return Marshal.PtrToStringUni(buffer,(int)used);
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  public static Sample Read(int pid) {
    if(pid<=0)throw new ArgumentOutOfRangeException("pid");
    var sample=new Sample();var texts=new List<string>();int children=0;
    // Include hidden owned windows: a hidden /P launch must remain observable.
    EnumProc top=(window,unused)=>{
      if(!Owned(window,pid))return true;
      if(sample.WindowCount>=64){sample.Truncated=true;return false;}
      sample.WindowCount++;
      EnumProc child=(control,ignored)=>{
        if(++children>256||sample.StatusCount>=4){sample.Truncated=true;return false;}
        if(!Owned(control,pid)||GetDlgCtrlID(control)!=1006)return true;
        var name=new StringBuilder(128);
        if(GetClassName(control,name,name.Capacity)==0||name.ToString()!="Static")return true;
        sample.StatusCount++;
        string text=ReadStatus(control,pid);
        if(text!=null)texts.Add(text);
        return true;
      };
      if(!EnumChildWindows(window,child,IntPtr.Zero)&&!sample.Truncated)sample.ErrorCode=Marshal.GetLastWin32Error();
      return !sample.Truncated;
    };
    if(!EnumWindows(top,IntPtr.Zero)&&!sample.Truncated)sample.ErrorCode=Marshal.GetLastWin32Error();
    sample.Texts=texts.ToArray();return sample;
  }
}
'@
}

function Watch-NearlyPassiveInstaller {
  param(
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$OwnedProcessId,
    [Parameter(Mandatory)][string]$ExpectedImage,
    [Parameter(Mandatory)][ValidateRange(1,9223372036854775807)][long]$ExpectedStartTimeUtcTicks,
    [ValidateRange(1,120)][int]$TimeoutSeconds=30
  )
  if ($ExpectedImage -cnotmatch '\A[A-Za-z]:\\' -or [IO.Path]::GetFullPath($ExpectedImage) -cne $ExpectedImage) { throw 'Exact canonical owned image required' }
  $record=[ordered]@{schemaVersion=1;kind='installerQaPassiveObservation';observation='unknown';state='unavailable';exited=$false;exitCode=$null;timedOut=$false;windowsInspected=0;statusControlsInspected=0;sampleCount=0;nativeError=0;nativeTruncated=$false}
  $process=$null
  try {
    # Retain this Process instance, including its exit-query handle, throughout
    # observation. Verify image and creation time before inspecting any HWND.
    $process=Get-Process -Id $OwnedProcessId -ErrorAction Stop
    if ($process.Path -ine $ExpectedImage -or $process.StartTime.ToUniversalTime().Ticks -ne $ExpectedStartTimeUtcTicks) { $record.state='identity-mismatch';return [pscustomobject]$record }
    if ($process.HasExited) { $record.state='exited';$record.exited=$true;$record.exitCode=[int]$process.ExitCode;return [pscustomobject]$record }
    Initialize-NearlyPassiveObserverNative
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt ($TimeoutSeconds*1000)) {
      $iteration=$clock.ElapsedMilliseconds
      $process.Refresh()
      if ($process.HasExited) { $record.state='exited';$record.exited=$true;$record.exitCode=[int]$process.ExitCode;return [pscustomobject]$record }
      if ($process.Path -ine $ExpectedImage -or $process.StartTime.ToUniversalTime().Ticks -ne $ExpectedStartTimeUtcTicks) { $record.state='identity-mismatch';return [pscustomobject]$record }
      $sample=[NearlyPassiveObserverNative]::Read($OwnedProcessId)
      $record.sampleCount++
      $record.windowsInspected=[Math]::Max($record.windowsInspected,[Math]::Min(64,$sample.WindowCount))
      $record.statusControlsInspected=[Math]::Max($record.statusControlsInspected,[Math]::Min(4,$sample.StatusCount))
      $record.nativeError=[int]$sample.ErrorCode
      $record.nativeTruncated=$record.nativeTruncated -or $sample.Truncated
      foreach ($text in $sample.Texts) {
        $classification=Get-NearlyPassiveClassification $text
        if ($classification -cne 'unknown') {
          $record.observation=$classification;$record.state='abort-observed'
          # The abort classification is already proven; an optional exit query
          # racing process teardown must not discard that observation.
          try {
            $process.Refresh()
            if ($process.HasExited) { $record.exited=$true;$record.exitCode=[int]$process.ExitCode }
          } catch {}
          return [pscustomobject]$record
        }
      }
      $remaining=($TimeoutSeconds*1000)-$clock.ElapsedMilliseconds
      $pause=[Math]::Min(250-($clock.ElapsedMilliseconds-$iteration),$remaining)
      if ($pause -gt 0) { [Threading.Thread]::Sleep([int]$pause) }
    }
    $record.state='timeout';$record.timedOut=$true
  } catch {
    # No exception messages: native/process errors can contain arbitrary paths.
    $record.state='unavailable'
  } finally {
    if ($null -ne $process) { $process.Dispose() }
  }
  return [pscustomobject]$record
}
