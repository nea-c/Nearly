param([Parameter(Mandatory=$true)][string]$SourceRoot)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or !$env:RUNNER_TEMP -or !$env:GITHUB_ENV -or !$env:LOCALAPPDATA) { throw 'Use an ephemeral GitHub Windows runner.' }
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$temporary = Join-Path $env:RUNNER_TEMP 'nearly-nsis-tools'
$destination = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
if ((Test-Path -LiteralPath $temporary) -or (Test-Path -LiteralPath $destination)) { throw 'Unexpected preexisting NSIS tool directory; preserve and inspect it.' }
New-Item -ItemType Directory -Path $temporary | Out-Null

# These are the exact upstream Tauri CLI 2.12.3 tool payloads, not an installer.
$zip = Join-Path $temporary 'nsis.zip'
$plugin = Join-Path $temporary 'nsis_tauri_utils.dll'
Invoke-WebRequest -Uri 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip' -OutFile $zip -TimeoutSec 120
Invoke-WebRequest -Uri 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll' -OutFile $plugin -TimeoutSec 120
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8') { throw 'NSIS archive checksum mismatch.' }
if ((Get-FileHash -LiteralPath $plugin -Algorithm SHA256).Hash.ToLowerInvariant() -ne '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709') { throw 'NSIS plugin checksum mismatch.' }
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $temporary 'expanded')
New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
$expanded = (Resolve-Path -LiteralPath (Join-Path $temporary 'expanded\nsis-3.13')).Path
$temporaryRoot = (Resolve-Path -LiteralPath $temporary).Path.TrimEnd('\') + '\'
$localRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
$destination = [IO.Path]::GetFullPath($destination)
if (!$expanded.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or !$destination.StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved tool paths escape the intended runner directories.' }
Move-Item -LiteralPath $expanded -Destination $destination
$pluginDirectory = Join-Path $destination 'Plugins\x86-unicode\additional'
New-Item -ItemType Directory -Path $pluginDirectory -Force | Out-Null
Copy-Item -LiteralPath $plugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')
# Preserve the existing fail-closed full cached-tool contract before any bundling.
Push-Location -LiteralPath $source
try { node --input-type=module -e "import {requireCachedTools} from './scripts/build-installer.mjs'; await requireCachedTools(process.env.LOCALAPPDATA);" }
finally { Pop-Location }

. (Join-Path $PSScriptRoot 'windows-build-paths.ps1')
foreach($requiredRoot in @($env:USERPROFILE,$env:GITHUB_WORKSPACE,$env:RUNNER_TEMP)) {
  if (!$requiredRoot) {throw 'Required hosted build root is missing'}
}
$prefixes = @(Get-NearlyBuildPathMappings -Roots @(
  @{From=$env:USERPROFILE;To='/build/profile'},
  @{From=$env:GITHUB_WORKSPACE;To='/build/workspace'},
  @{From=$env:RUNNER_TEMP;To='/build/temp'},
  @{From=$env:TEMP;To='/build/os-temp'},
  @{From=$env:TMP;To='/build/os-temp'},
  @{From=$env:CARGO_HOME;To='/build/cargo'},
  @{From=$env:RUSTUP_HOME;To='/build/toolchain'}
))
$flags = @()
if ($env:CARGO_ENCODED_RUSTFLAGS) { $flags += $env:CARGO_ENCODED_RUSTFLAGS.Split([char]31) }
elseif ($env:RUSTFLAGS) { throw 'Unexpected free-form RUSTFLAGS; review rather than reparse shell quoting.' }
$cflags = @($env:CFLAGS, '/experimental:deterministic')
foreach ($pair in $prefixes) {
  $flags += "--remap-path-prefix=$($pair.From)=$($pair.To)"
  $cflags += "/pathmap:$($pair.From)=$($pair.To)"
}
@(
  "CARGO_ENCODED_RUSTFLAGS=$($flags -join [char]31)",
  "CFLAGS=$($cflags -join ' ')",
  "CARGO_TARGET_DIR=$(Join-Path $env:RUNNER_TEMP 'nearly-cargo-target')",
  'CARGO_BUILD_JOBS=2'
) | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
