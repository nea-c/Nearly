param(
  [Parameter(Mandatory)][string]$GuestScript,
  [Parameter(Mandatory)][string]$GuestArgumentsBase64,
  [ValidateRange(1,600)][int]$TimeoutSeconds=300
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Compile/model tests read the C# file directly. They never invoke this wrapper.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_REPOSITORY -cne 'nea-c/Nearly' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cnotin @('refs/heads/main','refs/heads/codex/private-install-directory') -or $env:QA_CONTROLLER_SHA -cnotmatch '\A[a-f0-9]{40}\z' -or $env:GITHUB_SHA -cne $env:QA_CONTROLLER_SHA -or $env:GITHUB_WORKFLOW_SHA -cne $env:QA_CONTROLLER_SHA -or $env:QA_CONFIRMATION -cne "installer-qa $env:QA_CONTROLLER_SHA" -or $env:GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '\A[1-9][0-9]*\z') { throw 'Exact hosted QA authorization required' }
$expectedGuest=Join-Path $PSScriptRoot 'installer-qa-guest.ps1'
if ([IO.Path]::GetFullPath($GuestScript) -cne $expectedGuest -or !(Test-Path -LiteralPath $GuestScript -PathType Leaf)) { throw 'Exact reviewed guest script required' }
foreach ($path in @($GuestScript,$env:RUNNER_TEMP)) {
  $cursor=$path
  while ($cursor) {
    if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Launcher paths must be plain local paths' }
    $cursor=Split-Path -Parent $cursor
  }
}
if (!$env:RUNNER_TEMP -or ![IO.Path]::IsPathFullyQualified($env:RUNNER_TEMP) -or $GuestArgumentsBase64.Length -gt 65536) { throw 'Bounded hosted arguments required' }
$decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($GuestArgumentsBase64))
$arguments=ConvertFrom-Json -InputObject $decoded -NoEnumerate
if ($arguments -isnot [array] -or $arguments.Count -gt 64 -or @($arguments | Where-Object { $_ -isnot [string] -or $_.Contains([char]0) -or $_.Length -gt 8192 }).Count) { throw 'Exact string argument array required' }
# The guest independently checks its action, run identity, paths and QA marker.
# A separate log avoids leaking inherited controller pipes into long-lived app
# descendants; preflight still observes an absent run root.
$log=Join-Path $env:RUNNER_TEMP ('nearly-standard-user-'+[Guid]::NewGuid().ToString('N')+'.log')
Add-Type -Path (Join-Path $PSScriptRoot 'installer-qa-standard-user.cs')
try {
  $code=[NearlyQaStandardUser]::Run((Join-Path $PSHOME 'pwsh.exe'),$GuestScript,[string[]]$arguments,(Get-Location).ProviderPath,$log,$TimeoutSeconds)
} finally {
  if (Test-Path -LiteralPath $log -PathType Leaf) {
    $stream=[IO.File]::Open($log,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try { $reader=[IO.StreamReader]::new($stream); $buffer=[char[]]::new(1048577); $count=$reader.ReadBlock($buffer,0,$buffer.Length); if ($count -gt 1048576) { throw 'Bounded guest log exceeded' }; [Console]::Out.Write([string]::new($buffer,0,$count)) } finally { $stream.Dispose() }
  }
}
exit $code
