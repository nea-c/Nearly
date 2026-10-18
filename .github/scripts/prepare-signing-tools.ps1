param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$true
if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or !$env:RUNNER_TEMP -or !$env:GITHUB_ENV) {throw 'Fresh hosted Windows runner required'}
if ($env:NEARLY_UPDATER_PRIVATE_KEY -or $env:NEARLY_UPDATER_PRIVATE_KEY_PASSWORD) {throw 'Prepare tools before signing secrets are present'}
$root=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
$target=[IO.Path]::GetFullPath($Destination)
if (!$target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $target)) {throw 'Fresh tool directory must stay inside runner temporary root'}
$lock=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\signing-dependencies.json') -Raw | ConvertFrom-Json
if ($lock.schemaVersion -ne 1 -or $lock.version -ne '26.04' -or $lock.archiveUrl -ne 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-x64.exe' -or $lock.bootstrapUrl -ne 'https://github.com/ip7z/7zip/releases/download/26.04/7zr.exe') {throw 'Unexpected reviewed extractor source'}
New-Item -ItemType Directory -Path $target | Out-Null
$archive=Join-Path $target 'distribution.exe'
$bootstrap=Join-Path $target '7zr.exe'
# The SFX is downloaded as inert archive data and is NEVER launched.
Invoke-WebRequest -Uri $lock.archiveUrl -OutFile $archive -TimeoutSec 120
Invoke-WebRequest -Uri $lock.bootstrapUrl -OutFile $bootstrap -TimeoutSec 120
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.archiveSha256 -or (Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.bootstrapSha256) {throw 'Extractor download identity mismatch'}
$pair=Join-Path $target 'pair'
& $bootstrap e -t7z -spd -bd -y "-o$pair" -- $archive 7z.exe 7z.dll
if ($LASTEXITCODE -ne 0) {throw 'Pinned extractor bootstrap failed'}
$actual=@(Get-ChildItem -LiteralPath $pair -Force | Sort-Object Name)
if ($actual.Count -ne 2 -or ($actual.Name -join ',') -ne '7z.dll,7z.exe' -or ($actual | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })) {throw 'Unexpected extractor output layout'}
foreach($name in @('7z.exe','7z.dll')) {if ((Get-FileHash -LiteralPath (Join-Path $pair $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.files.$name) {throw 'Extractor pair digest mismatch'}}
"NEARLY_EXTRACTOR_DIRECTORY=$pair" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
"NEARLY_UPDATER_EXTRACTOR=$(Join-Path $pair '7z.exe')" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
# No deletion/replacement or software installation; only this owned temporary tree.
