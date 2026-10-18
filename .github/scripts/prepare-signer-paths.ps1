$ErrorActionPreference='Stop'
if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or !$env:RUNNER_TEMP -or !$env:GITHUB_ENV) {throw 'Fresh hosted Windows runner required'}
if ($env:NEARLY_UPDATER_PRIVATE_KEY -or $env:NEARLY_UPDATER_PRIVATE_KEY_PASSWORD -or $env:RUSTFLAGS) {throw 'Unexpected secret or free-form compiler flags'}
. (Join-Path $PSScriptRoot 'windows-build-paths.ps1')
$pairs=@(Get-NearlyBuildPathMappings -Roots @(
  @{From=$env:USERPROFILE;To='/build/profile'},@{From=$env:GITHUB_WORKSPACE;To='/build/workspace'},
  @{From=$env:RUNNER_TEMP;To='/build/temp'},@{From=$env:TEMP;To='/build/os-temp'},
  @{From=$env:TMP;To='/build/os-temp'},@{From=$env:CARGO_HOME;To='/build/cargo'},@{From=$env:RUSTUP_HOME;To='/build/toolchain'}
))
$flags=@();$cflags=@('/experimental:deterministic')
foreach($pair in $pairs){$flags+="--remap-path-prefix=$($pair.From)=$($pair.To)";$cflags+="/pathmap:$($pair.From)=$($pair.To)"}
@("CARGO_ENCODED_RUSTFLAGS=$($flags -join [char]31)","CFLAGS=$($cflags -join ' ')","CARGO_TARGET_DIR=$(Join-Path $env:RUNNER_TEMP 'nearly-trusted-cargo-target')",'CARGO_BUILD_JOBS=2') | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
