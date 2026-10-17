param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../../.github/scripts/windows-build-paths.ps1')
$mappings=@(Get-NearlyBuildPathMappings -Roots @(@{From=$Root;To='/build/fixture'},@{From=(Join-Path $Root 'child');To='/build/fixture-child'}))
@{long=Get-NearlyLongPath $Root;short=Get-NearlyShortPath $Root;mappings=$mappings}|ConvertTo-Json -Depth 5 -Compress
