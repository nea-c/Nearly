# Read-only closure probe. Never shuts down or restarts any process.
$ErrorActionPreference='Stop'
$maintenanceSpec=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$maintenanceRoot=[IO.Path]::GetFullPath([string]$maintenanceSpec.directory)
$imagePaths=@(Get-ChildItem -LiteralPath $maintenanceRoot -File -ErrorAction Stop | Where-Object {$_.Extension -ieq '.exe'} | ForEach-Object {$_.FullName})
if($imagePaths.Count -eq 0 -or $imagePaths.Count -gt 2048){throw 'Cannot establish the image resource set'}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class NearlyStorageWriters {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {public int Id;public System.Runtime.InteropServices.ComTypes.FILETIME Started;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct ProcessInfo {
  public UniqueProcess Process;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string Name;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string Service;
  public uint Type,Status,Session;
  [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
 }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern uint RmStartSession(out uint session,uint flags,StringBuilder key);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern uint RmRegisterResources(uint session,uint files,string[] paths,uint apps,IntPtr processes,uint services,IntPtr names);
 [DllImport("rstrtmgr.dll")] static extern uint RmGetList(uint session,out uint needed,ref uint count,[In,Out] ProcessInfo[] processes,out uint reasons);
 [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint session);
 public static int[] Inspect(string[] images) {
  uint session;var error=RmStartSession(out session,0,new StringBuilder(33));if(error!=0)throw new Exception("Resource session unavailable");
  try {
   error=RmRegisterResources(session,(uint)images.Length,images,0,IntPtr.Zero,0,IntPtr.Zero);if(error!=0)throw new Exception("Image registration unavailable");
   uint needed=0,count=0,reasons;error=RmGetList(session,out needed,ref count,null,out reasons);
   for(int attempt=0;attempt<3;attempt++) {
    if(error==0&&needed==0)return new int[0];
    if(error!=234||needed==0||needed>8192)throw new Exception("Image user list unavailable");
    var entries=new ProcessInfo[needed];count=needed;error=RmGetList(session,out needed,ref count,entries,out reasons);
    if(error==0){var ids=new int[count];for(int i=0;i<count;i++)ids[i]=entries[i].Process.Id;return ids;}
   }
   throw new Exception("Image users did not stabilize");
  } finally {RmEndSession(session);}
 }
}
'@
$writerIds=[Collections.Generic.HashSet[int]]::new()
foreach($writerId in [NearlyStorageWriters]::Inspect([string[]]$imagePaths)){[void]$writerIds.Add($writerId)}
# Preserve the conservative global guard for ordinary Nearly copies elsewhere.
foreach($process in @(Get-Process -Name 'Nearly*' -ErrorAction SilentlyContinue)){[void]$writerIds.Add($process.Id)}
# Accessible process paths also cover renamed images if process state changes
# during the resource query. Unknown/unavailable RM results already fail closed.
foreach($process in @(Get-Process)) {
 try {$image=$process.Path;if($image -and [string]::Equals([IO.Path]::GetDirectoryName($image),$maintenanceRoot,[StringComparison]::OrdinalIgnoreCase)){[void]$writerIds.Add($process.Id)}}catch{}
}
@($writerIds | ForEach-Object {@{pid=$_}}) | ConvertTo-Json -Compress
