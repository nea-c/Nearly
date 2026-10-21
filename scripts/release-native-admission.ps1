param([switch]$Guest)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
function Assert-ReleaseNativeContext {
  param([hashtable]$Context)
  foreach($item in @(@('GITHUB_ACTIONS','true'),@('RUNNER_OS','Windows'),@('RUNNER_ENVIRONMENT','github-hosted'),@('GITHUB_REPOSITORY','nea-c/Nearly'),@('GITHUB_EVENT_NAME','workflow_dispatch'),@('GITHUB_REF','refs/heads/main'))) {
    if($Context[$item[0]] -cne $item[1]) { throw 'Exact hosted release environment required' }
  }
  $sha=$Context.GITHUB_SHA
  if($sha -cnotmatch '\A[a-f0-9]{40}\z' -or $Context.GITHUB_WORKFLOW_SHA -cne $sha -or $Context.RELEASE_COMMIT -cne $sha -or $Context.RELEASE_MODE -cnotin @('validate','verify-signature','release') -or $Context.RELEASE_TAG -cnotmatch '\Ar[1-9][0-9]*\.[0-9]+\z' -or $Context.GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $Context.GITHUB_RUN_ATTEMPT -cnotmatch '\A[1-9][0-9]*\z') { throw 'Exact hosted release identity required' }
  if($Context.RELEASE_MODE -ceq 'validate') { if($Context.RELEASE_CONFIRM) { throw 'Validation confirmation must be empty' } }
  elseif($Context.RELEASE_CONFIRM -cne "$($Context.RELEASE_MODE) $($Context.RELEASE_TAG) $sha") { throw 'Exact release confirmation required' }
}
function Assert-AdmissionResult {
  param([string]$TestName,[int]$ExitCode,[string]$Output)
  if($ExitCode -ne 0 -or $Output -notmatch ('(?m)^test '+[regex]::Escape($TestName)+' \.\.\. ok\r?$') -or $Output -notmatch '(?m)^test result: ok\. 1 passed; 0 failed; 0 ignored;') { throw 'Exact standard-user native admission test did not pass' }
}
function Resolve-AdmissionBuild {
  param([string]$Json,[int]$ExitCode,[string]$Target)
  if($ExitCode -ne 0 -or !$Target -or ![IO.Path]::IsPathFullyQualified($Target) -or $Json.Length -gt 8388608) { throw 'Successful bounded Cargo build required' }
  $targetRoot=[IO.Path]::GetFullPath($Target).TrimEnd('\')
  $rows=@($Json -split '\r?\n' | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json -InputObject $_ -AsHashtable })
  $finished=@($rows | Where-Object { $_.reason -ceq 'build-finished' })
  $candidates=@($rows | Where-Object { $_.reason -ceq 'compiler-artifact' -and $_.target.name -ceq 'nearly' -and $_.target.kind.Count -eq 1 -and $_.target.kind[0] -ceq 'bin' -and $_.profile.test -ceq $true -and $_.executable })
  if($finished.Count -ne 1 -or $finished[0].success -cne $true -or $candidates.Count -ne 1) { throw 'Exactly one successful test harness required' }
  $binary=[IO.Path]::GetFullPath($candidates[0].executable)
  $deps=Join-Path $targetRoot 'debug\deps'
  if((Split-Path -Parent $binary) -ine $deps -or (Split-Path -Leaf $binary) -cnotmatch '\Anearly-[a-f0-9]{16}\.exe\z') { throw 'Exact Cargo test output required' }
  $paths=[Collections.Generic.List[string]]::new()
  foreach($row in $rows) { if($row.reason -ceq 'build-script-executed') { foreach($value in $row.linked_paths) {
    $path=[IO.Path]::GetFullPath(($value -replace '\A(?:native|dependency|crate|framework|all)=',''))
    if($path.StartsWith($targetRoot+'\',[StringComparison]::OrdinalIgnoreCase) -and !$paths.Contains($path)) { $paths.Add($path) }
  } } }
  foreach($path in @($deps,(Join-Path $targetRoot 'debug'))) { if(!$paths.Contains($path)) { $paths.Add($path) } }
  return @{Executable=$binary;RuntimePaths=$paths.ToArray()}
}
function Open-AdmissionBinary {
  param([string]$Path,[string]$Target)
  if(!$Path -or !$Target -or (Split-Path -Parent ([IO.Path]::GetFullPath($Path))) -ine (Join-Path ([IO.Path]::GetFullPath($Target)) 'debug\deps') -or (Split-Path -Leaf $Path) -cnotmatch '\Anearly-[a-f0-9]{16}\.exe\z') { throw 'Pinned Cargo test path required' }
  $cursor=$Path
  while($cursor) { if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse test paths refused' }; $cursor=Split-Path -Parent $cursor }
  return [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
}
function Assert-AdmissionRuntimePath {
  param([string]$Path)
  if(!$Path -or ![IO.Path]::IsPathFullyQualified($Path) -or !(Test-Path -LiteralPath $Path -PathType Container)) { throw 'Existing runtime directory required' }
  $cursor=$Path
  while($cursor) { if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse runtime paths refused' }; $cursor=Split-Path -Parent $cursor }
}
$context=@{}
foreach($name in @('GITHUB_ACTIONS','RUNNER_OS','RUNNER_ENVIRONMENT','GITHUB_REPOSITORY','GITHUB_EVENT_NAME','GITHUB_REF','GITHUB_SHA','GITHUB_WORKFLOW_SHA','RELEASE_COMMIT','RELEASE_MODE','RELEASE_TAG','RELEASE_CONFIRM','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT')) { $context[$name]=[Environment]::GetEnvironmentVariable($name) }
Assert-ReleaseNativeContext $context
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(!$env:GITHUB_WORKSPACE -or $root -cne [IO.Path]::GetFullPath((Join-Path $env:GITHUB_WORKSPACE 'source')) -or (Get-Location).ProviderPath -cne $root) { throw 'Exact reviewed release source required' }
$head=& git -C $root rev-parse HEAD
if($LASTEXITCODE -ne 0 -or $head -cne $context.RELEASE_COMMIT) { throw 'Actual source HEAD must match the exact release commit' }
foreach($path in @($PSCommandPath,$env:RUNNER_TEMP)) {
  if(!$path -or ![IO.Path]::IsPathFullyQualified($path)) { throw 'Plain hosted paths required' }
  $cursor=$path
  while($cursor) { if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse paths refused' }; $cursor=Split-Path -Parent $cursor }
}
if($Guest) {
  # Production validation independently rejects elevated tokens. These tests
  # must run, never be treated as skipped, with the verified standard token.
  $binary=$env:NEARLY_ADMISSION_EXECUTABLE
  $pin=Open-AdmissionBinary $binary $env:CARGO_TARGET_DIR
  try {
    $hash=(Get-FileHash -InputStream $pin -Algorithm SHA256).Hash.ToLowerInvariant()
    if($env:NEARLY_ADMISSION_SHA256 -cnotmatch '\A[a-f0-9]{64}\z' -or $hash -cne $env:NEARLY_ADMISSION_SHA256) { throw 'Pinned test executable changed' }
    $fixture=Join-Path $env:RUNNER_TEMP ('nearly-native-fixture-'+[Guid]::NewGuid().ToString('N'))
    if(Test-Path -LiteralPath $fixture) { throw 'Fresh test fixture required' }
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $fixture=(Get-Item -LiteralPath $fixture).FullName
    if((Get-Item -LiteralPath $fixture).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Plain test fixture required' }
    Push-Location $fixture
    try { foreach($name in @('install_root::native::tests::ordinary_inherited_namespace_is_admitted_by_production_validation','install_root::native::tests::generated_custom_root_payload_current_identity_and_namespace_guards')) {
    $log=Join-Path $env:RUNNER_TEMP ('nearly-native-admission-'+[Guid]::NewGuid().ToString('N')+'.log')
    & $binary --exact $name --test-threads=1 *> $log
    $code=$LASTEXITCODE
    if((Get-Item -LiteralPath $log).Length -gt 1048576) { throw 'Bounded native test output exceeded' }
    $output=[IO.File]::ReadAllText($log)
    [Console]::Out.Write($output)
    Assert-AdmissionResult $name $code $output
    } } finally { Pop-Location }
  } finally { $pin.Dispose() }
  Write-Host 'Both exact standard-user installation admission tests passed.'
  exit 0
}
$metadata=Join-Path $env:RUNNER_TEMP ('nearly-native-build-'+[Guid]::NewGuid().ToString('N')+'.jsonl')
& cargo +1.97.1 test --offline --locked --no-run --message-format=json --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') > $metadata
$code=$LASTEXITCODE
if((Get-Item -LiteralPath $metadata).Length -gt 8388608) { throw 'Bounded Cargo metadata exceeded' }
$build=Resolve-AdmissionBuild ([IO.File]::ReadAllText($metadata)) $code $env:CARGO_TARGET_DIR
$runtime=& rustc +1.97.1 --print target-libdir
if($LASTEXITCODE -ne 0 -or !$runtime -or ![IO.Path]::IsPathFullyQualified($runtime) -or !(Test-Path -LiteralPath $runtime -PathType Container)) { throw 'Pinned toolchain runtime path required' }
$sysroot=& rustc +1.97.1 --print sysroot
if($LASTEXITCODE -ne 0 -or !$sysroot -or [IO.Path]::GetFullPath($runtime) -ine (Join-Path ([IO.Path]::GetFullPath($sysroot)) 'lib\rustlib\x86_64-pc-windows-msvc\lib')) { throw 'Exact toolchain runtime directory required' }
foreach($path in @($build.RuntimePaths)+@($runtime)) { Assert-AdmissionRuntimePath $path }
$env:PATH=(@($build.RuntimePaths)+@($runtime)+@($env:PATH)) -join ';'
$env:NEARLY_ADMISSION_EXECUTABLE=$build.Executable
$pin=Open-AdmissionBinary $build.Executable $env:CARGO_TARGET_DIR
try {
$env:NEARLY_ADMISSION_SHA256=(Get-FileHash -InputStream $pin -Algorithm SHA256).Hash.ToLowerInvariant()
$log=Join-Path $env:RUNNER_TEMP ('nearly-native-standard-user-'+[Guid]::NewGuid().ToString('N')+'.log')
Add-Type -Path (Join-Path $PSScriptRoot 'installer-qa-standard-user.cs')
try { $code=[NearlyQaStandardUser]::Run((Join-Path $PSHOME 'pwsh.exe'),$PSCommandPath,[string[]]@('-Guest'),$root,$log,300) }
finally { if(Test-Path -LiteralPath $log -PathType Leaf) { if((Get-Item -LiteralPath $log).Length -gt 1048576) { throw 'Bounded standard-user output exceeded' }; [Console]::Out.Write([IO.File]::ReadAllText($log)) } }
} finally { $pin.Dispose() }
exit $code
