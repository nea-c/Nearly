# Metadata-only Windows aliases: no credentials, permissions or filesystem contents are changed.
if (-not ('NearlyBuildPathNames' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NearlyBuildPathNames {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathNameW(string path, StringBuilder value, uint capacity);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetLongPathNameW(string path, StringBuilder value, uint capacity);
}
'@
}
function Get-NearlyShortPath([string]$Value) {
  $buffer=New-Object Text.StringBuilder 32768
  $size=[NearlyBuildPathNames]::GetShortPathNameW($Value,$buffer,32768)
  if (!$size -or $size -ge 32768) {throw 'Cannot resolve a build-root short alias'}
  $buffer.ToString()
}
function Get-NearlyLongPath([string]$Value) {
  $buffer=New-Object Text.StringBuilder 32768
  $size=[NearlyBuildPathNames]::GetLongPathNameW($Value,$buffer,32768)
  if (!$size -or $size -ge 32768) {throw 'Cannot resolve a build-root long alias'}
  $buffer.ToString()
}
function Get-NearlyBuildPathMappings([object[]]$Roots) {
  $seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $result=New-Object 'System.Collections.Generic.List[object]'
  foreach($pair in $Roots) {
    if (!$pair.From) {continue}
    if ($pair.From -notmatch '^[A-Za-z]:[\\/]' -or $pair.From -match '[\s=\x00-\x1f]' -or $pair.To -notmatch '^/build/[a-z-]+$') {throw 'Unsafe or unsupported build root'}
    $full=[IO.Path]::GetFullPath($pair.From).TrimEnd('\','/')
    if (!(Test-Path -LiteralPath $full -PathType Container)) {throw 'Build root is not an existing directory'}
    foreach($alias in @($pair.From.TrimEnd('\','/'),$full,(Get-NearlyLongPath $full),(Get-NearlyShortPath $full))) {
      foreach($variant in @($alias,$alias.Replace('\','/'))) {
        # Earlier primary roots win when TEMP/TMP name an already mapped directory.
        if($seen.Add($variant)) {$result.Add(@{From=$variant;To=$pair.To})}
      }
    }
  }
  # rustc applies later matching mappings first; keep more specific roots last.
  $result | Sort-Object @{Expression={$_.From.Length}}, @{Expression={$_.From}}
}
