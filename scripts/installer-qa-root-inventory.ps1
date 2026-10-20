# Definitions only. The exactly confirmed hosted diagnosis job explicitly calls
# the OS reader; unit tests load only the pure functions with mocked metadata.
function Assert-NearlyInventorySid([string]$Sid) {
  if (!$Sid -or $Sid.Length -gt 184 -or $Sid -cnotmatch '\AS-1-[0-9]+(?:-[0-9]+){1,15}\z') { throw 'Invalid bounded SID' }
  $parsed=[Security.Principal.SecurityIdentifier]::new($Sid)
  if ($parsed.Value -cne $Sid) { throw 'Noncanonical SID' }
}

function Get-NearlyInventoryPrincipalClass([string]$Sid,[string]$CurrentUserSid) {
  Assert-NearlyInventorySid $Sid
  if ($Sid -ceq $CurrentUserSid) { return 'current-user' }
  switch -CaseSensitive ($Sid) {
    'S-1-5-18' { return 'system' }
    'S-1-5-32-544' { return 'administrators' }
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' { return 'trusted-installer' }
    'S-1-3-0' { return 'creator-owner' }
    'S-1-1-0' { return 'everyone' }
    'S-1-5-11' { return 'authenticated-users' }
    'S-1-5-32-545' { return 'users' }
    default { return 'other' }
  }
}

function ConvertTo-NearlyRootEvidence([string]$Root,$Metadata,[string]$CurrentUserSid) {
  if ($Root -cnotmatch '\A[A-Z]:\\\z' -or $null -eq $Metadata -or $Metadata.DriveType -cne 'Fixed' -or $Metadata.Ready -isnot [bool] -or !$Metadata.Ready) { throw 'Existing fixed root metadata required' }
  Assert-NearlyInventorySid $Metadata.OwnerSid
  if ($Metadata.Format -isnot [string] -or $Metadata.Format -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}\z') { throw 'Invalid bounded volume format' }
  if ($Metadata.Attributes -isnot [int] -and $Metadata.Attributes -isnot [long]) { throw 'Numeric root attributes required' }
  if ($Metadata.Attributes -lt 0 -or $Metadata.Attributes -gt 2147483647 -or ($Metadata.Attributes -band 16) -eq 0) { throw 'Directory attributes required' }
  if ($null -eq $Metadata.Rules -or @($Metadata.Rules).Count -gt 64) { throw 'ACL rule bound exceeded or missing' }
  $aces=[Collections.Generic.List[object]]::new()
  foreach ($rule in $Metadata.Rules) {
    if ($null -eq $rule -or $rule.Type -cnotin @('Allow','Deny')) { throw 'Invalid access rule type' }
    foreach ($field in @('Mask','Inheritance','Propagation')) {
      if ($rule.$field -isnot [int] -and $rule.$field -isnot [long] -and $rule.$field -isnot [uint32]) { throw 'Numeric ACL fields required' }
    }
    if ($rule.Mask -lt 0 -or $rule.Mask -gt 4294967295 -or $rule.Inheritance -lt 0 -or $rule.Inheritance -gt 3 -or $rule.Propagation -lt 0 -or $rule.Propagation -gt 3) { throw 'ACL numeric bound exceeded' }
    $principal=Get-NearlyInventoryPrincipalClass $rule.Sid $CurrentUserSid
    $aces.Add([ordered]@{principal=$principal;mask=[long]$rule.Mask;type=$rule.Type;inheritance=[int]$rule.Inheritance;propagation=[int]$rule.Propagation})
  }
  $ownerClass=Get-NearlyInventoryPrincipalClass $Metadata.OwnerSid $CurrentUserSid
  # This is diagnostic classification only; it does not admit an install root
  # or change any production ACL, namespace or ownership policy.
  return [pscustomobject][ordered]@{root=$Root;state='available';format=$Metadata.Format;attributes=[long]$Metadata.Attributes;ownerSid=$Metadata.OwnerSid;ownerClass=$ownerClass;currentUserOwner=($ownerClass -ceq 'current-user');trustedOwner=($ownerClass -cin @('current-user','system','administrators','trusted-installer'));aces=@($aces.ToArray())}
}

function Get-NearlyRootInventory {
  param([AllowEmptyCollection()][string[]]$Roots,[string]$CurrentUserSid,[scriptblock]$ReadMetadata)
  Assert-NearlyInventorySid $CurrentUserSid
  if ($null -eq $Roots -or $Roots.Count -lt 1 -or $Roots.Count -gt 26 -or $null -eq $ReadMetadata) { throw 'Bounded root scope and reader required' }
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($root in $Roots) {
    if ($root -cnotmatch '\A[A-Z]:\\\z' -or !$seen.Add($root)) { throw 'Unique canonical drive roots only' }
  }
  $records=[Collections.Generic.List[object]]::new();$complete=$true
  foreach ($root in $Roots) {
    try {
      $metadata=& $ReadMetadata $root
      $records.Add((ConvertTo-NearlyRootEvidence $root $metadata $CurrentUserSid))
    } catch {
      # Never emit exception messages, account names or malformed SID input.
      $complete=$false;$records.Add([pscustomobject]@{root=$root;state='unavailable'})
    }
  }
  return [pscustomobject][ordered]@{schemaVersion=1;kind='installerQaRootInventory';diagnosticOnly=$true;complete=$complete;roots=@($records.ToArray())}
}

function Read-NearlyHostedRootMetadata([string]$Root) {
  if ($Root -cnotmatch '\A[A-Z]:\\\z') { throw 'Drive root required' }
  $drive=[IO.DriveInfo]::new($Root)
  if ($drive.DriveType -ne [IO.DriveType]::Fixed -or !$drive.IsReady) { throw 'Existing fixed drive required' }
  $item=Get-Item -LiteralPath $Root -Force -ErrorAction Stop
  $acl=Get-Acl -LiteralPath $Root -ErrorAction Stop
  $ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if ($rules.Count -gt 64) { throw 'Root ACL exceeds evidence bound' }
  $records=[Collections.Generic.List[object]]::new()
  foreach ($rule in $rules) {
    $records.Add([pscustomobject]@{Sid=$rule.IdentityReference.Value;Mask=([long]$rule.FileSystemRights -band 4294967295L);Type=$rule.AccessControlType.ToString();Inheritance=[int]$rule.InheritanceFlags;Propagation=[int]$rule.PropagationFlags})
  }
  return [pscustomobject]@{DriveType='Fixed';Ready=$true;Format=$drive.DriveFormat;Attributes=[long]$item.Attributes;OwnerSid=$ownerSid;Rules=@($records.ToArray())}
}

function Get-NearlyHostedRootInventory {
  # No default OS reads occur when this definitions-only file is dot-sourced.
  # The workflow validates exact SHA/manual confirmation before this call.
  $roots=[Collections.Generic.List[string]]::new()
  foreach ($drive in [IO.DriveInfo]::GetDrives()) {
    if ($drive.DriveType -eq [IO.DriveType]::Fixed) {
      if (!$drive.IsReady -or $drive.Name -cnotmatch '\A[A-Z]:\\\z' -or $roots.Count -ge 26) { throw 'Incomplete fixed-drive enumeration' }
      $roots.Add($drive.Name)
    }
  }
  $currentUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  return Get-NearlyRootInventory -Roots @($roots.ToArray()) -CurrentUserSid $currentUserSid -ReadMetadata {param($root)Read-NearlyHostedRootMetadata $root}
}
