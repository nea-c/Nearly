param([Parameter(Mandatory)][string]$Source)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$null,[ref]$null)
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Normalize-JsonValue'},$true))
if($functions.Count -ne 1){throw 'Expected one pure normalizer'}
# Extract only the pure function. Never execute the guest script entrypoints.
. ([scriptblock]::Create($functions[0].Extent.Text))
foreach($pair in @(
  @('{}','{}'),
  @('{"z":{},"a":{"pins":{},"items":[]}}','{"a":{"items":[],"pins":{}},"z":{}}'),
  @('{"b":[{},[],{"z":false,"a":null}],"a":0}','{"a":0,"b":[{},[],{"a":null,"z":false}]}'),
  @('{"text":"generated-only","empty":""}','{"empty":"","text":"generated-only"}')
)){
  $actual=ConvertTo-Json -InputObject (Normalize-JsonValue ($pair[0] | ConvertFrom-Json)) -Depth 50 -Compress
  if($actual -cne $pair[1]){throw 'Pure normalization changed generated JSON content'}
}
'Pure generated JSON normalization passed'
