# Definitions only. The already-authorized hosted guest invokes this explicitly.
# Diagnosis is evidence, never an installation-policy bypass or qualification.
function Get-NearlyDrivePrincipalClass([string]$Sid,[string]$CurrentSid) {
  if ($CurrentSid -cmatch '\AS-1-5-21-(?:[0-9]+-){3}[0-9]+\z' -and $Sid -ceq $CurrentSid) { return 'currentUser' }
  switch -CaseSensitive ($Sid) {
    'S-1-5-18' { return 'system' }
    'S-1-5-32-544' { return 'admin' }
    'S-1-3-0' { return 'creatorOwner' }
    'S-1-3-4' { return 'ownerRights' }
    'S-1-1-0' { return 'everyone' }
    'S-1-5-11' { return 'authenticatedUsers' }
    'S-1-5-32-545' { return 'builtinUsers' }
  }
  if ($Sid -cmatch '\AS-1-15-2(?:-[0-9]+)+\z') { return 'appContainer' }
  if ($Sid -cmatch '\AS-1-5-21-(?:[0-9]+-){3}[0-9]+\z') { return 'otherAccount' }
  return 'other'
}

function Read-NearlyDriveRootMetadata {
  param([Parameter(Mandatory)][ValidateSet('D:\')][string]$Root)
  $data=[ordered]@{driveMetadataAvailable=$false;driveType=0;format='';attributesAvailable=$false;attributes=0;securityAvailable=$false;ownerSid='';currentSid='';rules=@()}
  try {
    $drive=[IO.DriveInfo]::new($Root)
    $data.driveType=[int]$drive.DriveType
    $data.format=$drive.DriveFormat
    $data.driveMetadataAvailable=$true
  } catch {}
  try {
    $item=Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    $data.attributes=[int64]$item.Attributes
    $data.attributesAvailable=$true
  } catch {}
  try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $data.currentSid=$identity.User.Value } finally { $identity.Dispose() }
  } catch {}
  try {
    $acl=Get-Acl -LiteralPath $Root -ErrorAction Stop
    $data.ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $rules=[Collections.Generic.List[object]]::new()
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      $rules.Add([pscustomobject]@{sid=$rule.IdentityReference.Value;mask=[int64]$rule.FileSystemRights;type=[int]$rule.AccessControlType;inherited=[bool]$rule.IsInherited;inheritance=[int]$rule.InheritanceFlags;propagation=[int]$rule.PropagationFlags})
      if ($rules.Count -eq 65) { break }
    }
    $data.rules=$rules.ToArray()
    $data.securityAvailable=$true
  } catch {}
  return [pscustomobject]$data
}

function Get-NearlyDriveRootDiagnosis {
  param([scriptblock]$Provider={param($Root) Read-NearlyDriveRootMetadata -Root $Root})
  $result=[ordered]@{schemaVersion=1;kind='installerQaDriveRootDiagnosis';driveMetadataAvailable=$false;driveType='unknown';fixed=$false;fileSystemFormat='other';attributesAvailable=$false;reparsePoint=$false;securityAvailable=$false;ownerPrincipalClass='other';rules=@();aclOverflow=$false;ruleDataInvalid=$false}
  # No input controls the inspected path. Test providers receive this literal
  # root, and no mocked test invokes the default OS reader.
  try { $raw=& $Provider 'D:\' } catch { return [pscustomobject]$result }
  try {
    if ($raw.driveMetadataAvailable -eq $true) {
      $result.driveType=switch ([int]$raw.driveType) { 1 {'noRoot'} 2 {'removable'} 3 {'fixed'} 4 {'network'} 5 {'cdRom'} 6 {'ram'} default {'unknown'} }
      $result.fixed=$result.driveType -ceq 'fixed'
      $result.fileSystemFormat=switch -CaseSensitive ([string]$raw.format) { 'NTFS' {'NTFS'} 'ReFS' {'ReFS'} default {'other'} }
      $result.driveMetadataAvailable=$true
    }
  } catch {}
  try {
    if ($raw.attributesAvailable -eq $true) { $result.reparsePoint=([int64]$raw.attributes -band 0x400) -ne 0; $result.attributesAvailable=$true }
  } catch {}
  try {
    if ($raw.securityAvailable -eq $true) {
      $result.ownerPrincipalClass=Get-NearlyDrivePrincipalClass ([string]$raw.ownerSid) ([string]$raw.currentSid)
      $rules=[Collections.Generic.List[object]]::new()
      $seen=0
      foreach ($rule in $raw.rules) {
        $seen++
        if ($seen -gt 64) { $result.aclOverflow=$true; break }
        try {
          $inheritance=[int]$rule.inheritance; $propagation=[int]$rule.propagation
          if ($inheritance -lt 0 -or $inheritance -gt 3 -or $propagation -lt 0 -or $propagation -gt 3) { throw 'Invalid flag range' }
          $rules.Add([pscustomobject][ordered]@{principalClass=(Get-NearlyDrivePrincipalClass ([string]$rule.sid) ([string]$raw.currentSid));mask=[uint32]([int64]$rule.mask -band 4294967295L);accessType=$(switch ([int]$rule.type) { 0 {'allow'} 1 {'deny'} default {'other'} });inherited=[bool]$rule.inherited;inheritanceFlags=$inheritance;propagationFlags=$propagation})
        } catch { $result.ruleDataInvalid=$true }
      }
      $result.rules=@($rules.ToArray())
      $result.securityAvailable=$true
    }
  } catch { $result.ruleDataInvalid=$true }
  return [pscustomobject]$result
}
