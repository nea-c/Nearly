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
  foreach($name in @('install_root::native::tests::ordinary_inherited_namespace_is_admitted_by_production_validation','install_root::native::tests::generated_custom_root_payload_current_identity_and_namespace_guards')) {
    $log=Join-Path $env:RUNNER_TEMP ('nearly-native-admission-'+[Guid]::NewGuid().ToString('N')+'.log')
    & cargo +1.97.1 test --offline --locked --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') -- --exact $name --test-threads=1 *> $log
    $code=$LASTEXITCODE
    if((Get-Item -LiteralPath $log).Length -gt 1048576) { throw 'Bounded native test output exceeded' }
    $output=[IO.File]::ReadAllText($log)
    [Console]::Out.Write($output)
    Assert-AdmissionResult $name $code $output
  }
  Write-Host 'Both exact standard-user installation admission tests passed.'
  exit 0
}
$log=Join-Path $env:RUNNER_TEMP ('nearly-native-standard-user-'+[Guid]::NewGuid().ToString('N')+'.log')
Add-Type -Path (Join-Path $PSScriptRoot 'installer-qa-standard-user.cs')
try { $code=[NearlyQaStandardUser]::Run((Join-Path $PSHOME 'pwsh.exe'),$PSCommandPath,[string[]]@('-Guest'),$root,$log,300) }
finally { if(Test-Path -LiteralPath $log -PathType Leaf) { if((Get-Item -LiteralPath $log).Length -gt 1048576) { throw 'Bounded standard-user output exceeded' }; [Console]::Out.Write([IO.File]::ReadAllText($log)) } }
exit $code
