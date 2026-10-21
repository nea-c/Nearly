import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unpackSettings} from '../scripts/storage-fixture.mjs';
const qa = await import('../scripts/installer-qa.mjs').catch(() => ({}));
const sha='a'.repeat(40);
test('unregistered retained-data reinstall explicitly restores the selected destination as the final NSIS argument',async()=>{
 const source=await fs.readFile(new URL('../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
 const branch=source.slice(source.indexOf('# Actual unregistered reinstall'),source.indexOf('Remove-GeneratedSettings',source.indexOf('# Actual unregistered reinstall')));
 assert.match(branch,/Invoke-Bounded \$Setup @\('\/S',\('\/D='\+\$install\)\)/);
 assert.match(branch,/Assert-Payload \$ExpectedPayload/);
});
const env=()=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RUNNER_OS:'Windows',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:'D:\\a\\_temp',LOCALAPPDATA:['C:','Users','runneradmin','AppData','Local'].join(String.fromCharCode(92)),QA_CONTROLLER_SHA:sha,QA_CONFIRMATION:`installer-qa ${sha}`});
test('dedicated private-directory branch runs only exact manually confirmed hosted guest',()=>{
 const e={...env(),GITHUB_REF:'refs/heads/codex/private-install-directory'};
 assert.equal(qa.validateContext(e,'win32').controllerSha,sha);
 for(const ref of ['refs/heads/codex/other','refs/pull/1/merge','refs/heads/codex/private-install-directory-extra'])assert.throws(()=>qa.validateContext({...e,GITHUB_REF:ref},'win32'));
 const p=qa.createPlan(qa.validateContext(e,'win32'),'drive');assert.equal(p.installRoot,p.destinations.drive);assert.equal(qa.validatePlan(p,qa.validateContext(e,'win32'),'drive'),true);
});
test('standard-user preflight fails closed before dependencies or guest mutations',async()=>{
 assert.equal(typeof qa.preflight,'function');await assert.rejects(()=>qa.preflight({...env(),GITHUB_ACTIONS:'false'}));
  assert.equal(typeof qa.guardProbe,'function');await assert.rejects(()=>qa.guardProbe({...env(),GITHUB_ACTIONS:'false'}));
 const workflow=await fs.readFile(new URL('../.github/workflows/installer-qa-windows.yml',import.meta.url),'utf8');
 const early=workflow.indexOf('node scripts/installer-qa.mjs preflight');assert.ok(early>0);assert.ok(early<workflow.indexOf('Prepare pinned cached NSIS tools'));
  const probe=workflow.indexOf('node scripts/installer-qa.mjs guard-probe');assert.ok(probe>workflow.indexOf('Prepare pinned cached NSIS tools'));assert.ok(probe<workflow.indexOf('Prepare locked build dependencies'));
});
test('shared drive fixture applies permissions only to its exact new app leaf; identity ABI is read-only',{skip:process.platform!=='win32'},async()=>{
 const source=await fs.readFile(new URL('../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
 const code=source.match(/function Get-DirectoryIdentity[\s\S]*?Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 assert.match(code,/Pack=4/);assert.doesNotMatch(code,/SetSecurity|SetFile|Delete|MoveFile|CreateDirectory/);
 const parseScript=`$ErrorActionPreference='Stop'\n$source=[IO.File]::ReadAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))).toString('base64')}')))\n`+String.raw`
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$fn=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'New-SharedEmptyDriveFixture'},$true)
if(!$fn){throw 'Fixture function missing'}
. ([scriptblock]::Create($fn.Extent.Text))
$script:created=@();$script:protected=@();$script:exists=$false
function Test-Path {param([string]$LiteralPath) return $script:exists}
function New-Item {param($ItemType,$Path) $script:created+=@($Path)}
function Set-Acl {param($LiteralPath,$AclObject) $script:protected+=@($LiteralPath);if($AclObject.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Wrong fixture owner'}}
$Action='drive';$destinations=@{drive='D:Nearly QA generated'};$install=$destinations.drive
New-SharedEmptyDriveFixture
if($script:created.Count -ne 1 -or $script:protected.Count -ne 1 -or $script:protected[0] -cne $install -or $script:created[0] -cne $install){throw 'Permission scope escaped app leaf'}
foreach($invalid in @('action','target','exists')){
 $Action='drive';$install=$destinations.drive;$script:exists=$false
 switch($invalid){'action'{$Action='production'}'target'{$install='D:'}'exists'{$script:exists=$true}}
 $rejected=$false;try{New-SharedEmptyDriveFixture}catch{$rejected=$true};if(!$rejected){throw 'Unsafe fixture target accepted'}
}
if($script:created.Count -ne 1 -or $script:protected.Count -ne 1){throw 'Rejected scope mutated fixture'}
`+`\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(code).toString('base64')}')))\n`+String.raw`
$type=[NearlyQaDirectoryIdentity].GetNestedType('Info',[Reflection.BindingFlags]::NonPublic)
if([Runtime.InteropServices.Marshal]::SizeOf([Activator]::CreateInstance($type)) -ne 52){throw 'BY_HANDLE_FILE_INFORMATION ABI mismatch'}
'Exact leaf ACL mock and read-only directory identity ABI passed'
`;
 // This D-leaf mock has its own explicit context, independent of the outer CI destination.
 const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parseScript,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,QA_DESTINATION:'drive'}});assert.equal(r.status,0,r.stderr||r.error?.message);
});
test('qualification wide shortcut reader preserves Unicode and ordinal case policy without accepting other paths',{skip:process.platform!=='win32'},async()=>{
  const source=await fs.readFile(new URL('../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
  let csharp=source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];assert.ok(csharp,'Wide reader missing');
  assert.match(csharp,/000214F9-0000-0000-C000-000000000046/);assert.match(csharp,/\.Load\(shortcut,0\)!=0/);assert.match(csharp,/StringBuilder\(32768\)/);assert.match(csharp,/GetPath\(target,target\.Capacity,IntPtr\.Zero,4\)!=0/);assert.match(csharp,/finally/);
  assert.ok(source.indexOf('Add-Type -TypeDefinition')>source.indexOf("throw 'Owned plan marker mismatch'"));
  const method=/public static string ReadWide\(string shortcut\) \{[\s\S]*?\r?\n  \}/;assert.match(csharp,method);
  csharp=csharp.replace(method,'public static string ReadWide(string shortcut){throw new Exception("COM disabled in pure model");}');
  assert.doesNotMatch(csharp,/Activator\.CreateInstance|\.Load\(shortcut|FinalReleaseComObject|DllImport/);
  const script=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString('base64')}')))\n`+String.raw`
$expected='C:\generated\日本語 space\Nearly\Nearly.exe'
foreach($actual in @($expected,'c:\GENERATED\日本語 SPACE\nearly\NEARLY.EXE')){if(![NearlyQaShortcut]::TargetMatches($expected,$actual)){throw 'Exact Unicode/case path rejected'}}
foreach($actual in @('C:\generated\日本語 space\Other\Nearly.exe','C:\genera~1\NIHONG~1\Nearly\Nearly.exe','Nearly.exe','.\Nearly.exe','C:\generated\日本語 space\Nearly\..\Nearly\Nearly.exe')){if([NearlyQaShortcut]::TargetMatches($expected,$actual)){throw 'Foreign or alias path accepted'}}
'Pure wide shortcut target comparison passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Pure wide shortcut target comparison passed/);
});
test('wide qualification rejects every nonzero Load/GetPath HRESULT using managed fake COM interfaces',{skip:process.platform!=='win32'},async()=>{
  const source=await fs.readFile(new URL('../scripts/installer-qa-guest.ps1',import.meta.url),'utf8');
  let csharp=source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];assert.ok(csharp);
  const persist=csharp.match(/interface IPersistFileRaw \{([\s\S]*?)\n  \}/)?.[1];assert.ok(persist);
  assert.deepEqual([...persist.matchAll(/\[PreserveSig\] int ([A-Za-z]+)\(/g)].map(match=>match[1]),['GetClassID','IsDirty','Load','Save','SaveCompleted','GetCurFile']);
  csharp=csharp.replaceAll('[ComImport,Guid(','[Guid(');
  const factory=/link=Activator\.CreateInstance\([^;]+\);/;assert.match(csharp,factory);csharp=csharp.replace(factory,'link=new Fake();');
  csharp=csharp.replace('public static class NearlyQaShortcut {',`public static class NearlyQaShortcut {
  public static int LoadCode=0,PathCode=0,PathCalls=0;public static bool Empty=false;
  sealed class Fake:IPersistFileRaw,IShellLinkW {
    public int GetClassID(out Guid id){throw new Exception("Unmodeled method");}
    public int IsDirty(){throw new Exception("Unmodeled method");}
    public int Load(string path,uint mode){if(path!="inert.lnk"||mode!=0)throw new Exception("Unexpected load mode");return LoadCode;}
    public int Save(string path,bool remember){throw new Exception("Mutation forbidden");}
    public int SaveCompleted(string path){throw new Exception("Mutation forbidden");}
    public int GetCurFile(out IntPtr path){throw new Exception("Unmodeled method");}
    public int GetPath(StringBuilder target,int count,IntPtr data,uint flags){if(count!=32768||data!=IntPtr.Zero||flags!=4)throw new Exception("Unexpected wide read mode");PathCalls++;if(!Empty)target.Append(@"C:\\generated\\日本語 space\\Nearly.exe");return PathCode;}
  }`);
  assert.doesNotMatch(csharp,/ComImport|Activator\.CreateInstance|DllImport/);
  const script=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString('base64')}')))\n`+String.raw`
$expected='C:\generated\日本語 space\Nearly.exe'
foreach($code in @(-2147467259,1)){
 [NearlyQaShortcut]::LoadCode=$code;[NearlyQaShortcut]::PathCalls=0
 $rejected=$false;try{[NearlyQaShortcut]::Matches('inert.lnk',$expected)|Out-Null}catch{$rejected=$_.Exception.GetBaseException().Message -ceq 'Wide shortcut read failed'}
 if(!$rejected -or [NearlyQaShortcut]::PathCalls -ne 0){throw 'Nonzero Load HRESULT accepted'}
}
[NearlyQaShortcut]::LoadCode=0
foreach($code in @(-2147467259,1)){
 [NearlyQaShortcut]::PathCode=$code;[NearlyQaShortcut]::Empty=$true
 $rejected=$false;try{[NearlyQaShortcut]::Matches('inert.lnk',$expected)|Out-Null}catch{$rejected=$_.Exception.GetBaseException().Message -ceq 'Wide shortcut read failed'}
 if(!$rejected){throw 'Nonzero GetPath HRESULT accepted'}
}
[NearlyQaShortcut]::PathCode=0
if([NearlyQaShortcut]::Matches('inert.lnk',$expected)){throw 'Empty successful read accepted'}
[NearlyQaShortcut]::Empty=$false
if(![NearlyQaShortcut]::Matches('inert.lnk',$expected)){throw 'Exact zero HRESULT Unicode target rejected'}
'Managed HRESULT failure model passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Managed HRESULT failure model passed/);
});

test('shortcut qualification checks regular no-reparse input before activating the wide reader',{skip:process.platform!=='win32'},()=>{
  const script=String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
public static class NearlyQaShortcut {
 public static int Activations=0;public static bool Guarded=false,Match=true;
 public static bool Matches(string shortcut,string expected){if(!Guarded)throw new Exception("Reader activated before file guard");Guarded=false;Activations++;return Match;}
}
'@
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_TEST_SOURCE,[ref]$null,[ref]$null)
$guard=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-Regular'},$true)
if($guard.Count -ne 1 -or $guard[0].Extent.Text -notmatch 'Assert-LocalPath \$Path'){throw 'Actual regular-file guard lost ancestry validation'}
$fn=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-Shortcuts'},$true)
Invoke-Expression $fn[0].Extent.Text
$startShortcut='generated-start';$desktopShortcut='generated-desktop';$exe='generated-exe';$preferences='generated-prefs';$script:deny=$false
function Test-Path {return $true}
function New-Object {throw 'COM activation disabled in inert test'}
function Assert-Regular {if($script:deny){throw 'Regular/reparse guard refused'};[NearlyQaShortcut]::Guarded=$true}
function Get-ItemProperty {return [pscustomobject]@{StartMenuShortcut=1;DesktopShortcut=1}}
Assert-Shortcuts 1 1
if([NearlyQaShortcut]::Activations -ne 2){throw 'Both existing shortcuts not read'}
$script:deny=$true;$before=[NearlyQaShortcut]::Activations;$rejected=$false;try{Assert-Shortcuts 1 1}catch{$rejected=$true}
if(!$rejected -or [NearlyQaShortcut]::Activations -ne $before){throw 'Refused file reached COM reader'}
$script:deny=$false;[NearlyQaShortcut]::Match=$false;$rejected=$false;try{Assert-Shortcuts 1 1}catch{$rejected=$true}
if(!$rejected){throw 'Foreign wide target accepted'}
'Guarded inert wide-reader activation passed'
`;
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,QA_TEST_SOURCE:fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/Guarded inert wide-reader activation passed/);
});

test('guest JSON comparison normalizes empty objects without running a guest action',{skip:process.platform!=='win32'},()=>{
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./installer-qa-normalize.ps1',import.meta.url)),'-Source',fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  assert.match(r.stdout,/Pure generated JSON normalization passed/);
});

test('guest cleanup selects only exact generated settings and refuses foreign children without filesystem mutation',{skip:process.platform!=='win32'},()=>{
  const script=`$ErrorActionPreference='Stop'
  $ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_TEST_SOURCE,[ref]$null,[ref]$null)
  $function=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-GeneratedCleanupPaths'},$true))
  if($function.Count -ne 1){throw 'Pure cleanup selector missing'}
  . ([scriptblock]::Create($function[0].Extent.Text))
  $names=@('settings.json','history.json','bookmarks.json','sync-profiles.json','connections.json')
  $children=@($names | ForEach-Object { $_; $_ -replace '\\.json$','.backup.json' })
  $paths=@(Get-GeneratedCleanupPaths 'C:\\qa-owned' $names $children)
  if($paths.Count -ne 10 -or $paths[0] -cne 'C:\\qa-owned\\settings.json'){throw 'Unexpected cleanup selection'}
  foreach($bad in @(@($children[0..8]),@($children[0..8])+@('foreign.txt'),@($children[0..8])+@('..\\foreign.json'),@($children[0..8])+@($children[0]))){
    $refused=$false
    try { Get-GeneratedCleanupPaths 'C:\\qa-owned' $names $bad | Out-Null } catch { $refused=$true }
    if(!$refused){throw 'Foreign or incomplete cleanup was accepted'}
  }
  'Pure cleanup selection passed'`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QA_TEST_SOURCE:fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Pure cleanup selection passed/);
});

test('preflight validates filesystem ancestry separately from registry freshness',{skip:process.platform!=='win32'},()=>{
  const script=`$ErrorActionPreference='Stop'
  $ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_TEST_SOURCE,[ref]$null,[ref]$null)
  $function=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PreflightFileTargets'},$true))
  if($function.Count -ne 1){throw 'Pure preflight selector missing'}
  . ([scriptblock]::Create($function[0].Extent.Text))
  $targets=@(Get-PreflightFileTargets 'D:\\temp\\owned' @{default='C:\\local\\Nearly';custom='C:\\local\\custom';drive='D:\\owned'} 'C:\\programs\\Nearly' 'C:\\desktop\\Nearly.lnk')
  if($targets.Count -ne 6){throw 'Missing filesystem preflight target'}
  foreach($target in $targets){if($target -cnotmatch '\\A[A-Za-z]:\\\\'){throw 'Non-filesystem target reached local path validation'}}
  $source=[IO.File]::ReadAllText($env:QA_TEST_SOURCE)
  if($source -notmatch 'foreach \\($target in $fileTargets\\) \\{ Assert-LocalPath $target \\}'.Replace('$','\\$')){throw 'Filesystem validator must use only classified file targets'}
  'Pure preflight classification passed'`;
  const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,QA_TEST_SOURCE:fileURLToPath(new URL('../scripts/installer-qa-guest.ps1',import.meta.url))},encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(r.status,0,r.stderr||r.error?.message);assert.match(r.stdout,/Pure preflight classification passed/);
});
test('fixture copy excludes generated roots while retaining dependency distribution files',()=>{
  assert.equal(typeof qa.copyFixturePath,'function');
  for(const name of ['','src/app.ts','node_modules/vite/dist/node/cli.js','node_modules/example/build/index.js','src-tauri/vendor/example/target.rs'])assert.equal(qa.copyFixturePath(name),true,name);
  for(const name of ['.git/config','dist/index.html','build/Nearly.exe','.test-build/api.js','test-results/report.json','src-tauri/target/release/Nearly.exe','.codex/config.toml'])assert.equal(qa.copyFixturePath(name),false,name);
  assert.equal(qa.copyFixturePath('node_modules\\vite\\dist\\node\\cli.js'),true);
  assert.equal(qa.copyFixturePath('src-tauri\\target\\release\\Nearly.exe'),false);
});
test('manual controller SHA, hosted Windows and explicit confirmation are mandatory',()=>{
  assert.equal(typeof qa.validateContext,'function');
  assert.equal(qa.validateContext(env(),'win32').controllerSha,sha);
  for(const key of Object.keys(env())){const e=env();delete e[key];assert.throws(()=>qa.validateContext(e,'win32'),undefined,key);}
  for(const [key,value]of [['GITHUB_SHA','b'.repeat(40)],['GITHUB_EVENT_NAME','push'],['RUNNER_ENVIRONMENT','self-hosted'],['QA_CONFIRMATION',`installer-qa ${sha}\n`],['RUNNER_TEMP','D:\\a\\..\\temp'],['RUNNER_TEMP','D:\\a:alternate'],['SYNCFILES_CONFIG_DIR',''],['GITHUB_RUN_ID','01']])assert.throws(()=>qa.validateContext({...env(),[key]:value},'win32'));
  assert.throws(()=>qa.validateContext(env(),'linux'));
});
test('plan fixes source provenance and refuses path overrides',()=>{
  assert.equal(typeof qa.validatePlan,'function');
  const c=qa.validateContext(env(),'win32'),p=qa.createPlan(c);
  assert.equal(p.runId,'123');assert.equal(p.runAttempt,'1');
  assert.equal(qa.validatePlan(p,c),true);
  for(const [key,value]of [['runRoot','D:\\foreign'],['sourceVersion','2.0.0'],['targetVersion','3.0.0'],['artifactId','1'],['installerSha256','0'.repeat(64)],['runAttempt','2']])assert.throws(()=>qa.validatePlan({...p,[key]:value},c));
  assert.throws(()=>qa.validatePlan({...p,extra:true},c));
});

test('destination selection derives exact guest-owned Unicode paths and rejects overrides',()=>{
  const c=qa.validateContext(env(),'win32');
  for(const kind of ['default','custom','drive']){
    const p=qa.createPlan(c,kind);
    assert.equal(p.schemaVersion,2);assert.equal(p.destinationKind,kind);
    assert.equal(p.installRoot,p.destinations[kind]);
    assert.equal(qa.validatePlan(p,c,kind),true);
    assert.throws(()=>qa.validatePlan({...p,destinations:{...p.destinations,custom:'D:\\foreign'}},c,kind));
    assert.throws(()=>qa.validatePlan({...p,installRoot:p.destinations[kind==='drive'?'default':'drive']},c,kind));
  }
  const p=qa.createPlan(c,'custom');
  assert.match(p.installRoot,/日本語 space/);assert.match(p.destinations.drive,/^D:\\/);
  for(const kind of [undefined,'','CUSTOM','custom\n'])assert.throws(()=>qa.validateDestination(kind));
});

test('explicit C-root coverage preserves the D-root target and refuses cross-root plans',()=>{
  const c=qa.validateContext(env(),'win32'),p=qa.createPlan(c,'drive-c');
  assert.equal(p.installRoot,'C:\\Nearly QA 日本語 123-1');
  assert.equal(p.destinations.drive,'D:\\Nearly QA 日本語 123-1');
  assert.equal(p.destinationKind,'drive-c');assert.equal(qa.validatePlan(p,c,'drive-c'),true);
  assert.throws(()=>qa.validatePlan({...p,installRoot:p.destinations.drive},c,'drive-c'));
  assert.throws(()=>qa.validatePlan(p,c,'drive'));
  for(const kind of ['drive-e','DRIVE-C','drive-c\n','C:'])assert.throws(()=>qa.validateDestination(kind));
  assert.match(qa.formatSummary('health-failure','drive-c'),/drive-c/);
});

test('UI qualification covers every independent checkbox pair in both actual languages',()=>{
  const cases=qa.uiCases();
  assert.equal(cases.length,8);
  assert.deepEqual(new Set(cases.map(c=>`${c.language}:${c.start}:${c.desktop}`)),new Set(['en:0:0','en:0:1','en:1:0','en:1:1','ja:0:0','ja:0:1','ja:1:0','ja:1:1']));
  assert.equal(new Set(cases.map(c=>c.name)).size,8);
});
test('a guest selects exactly one explicit scenario and reports only that lifecycle case',()=>{
  assert.equal(typeof qa.validateScenario,'function');
  for(const scenario of ['success','health-failure'])assert.equal(qa.validateScenario(scenario),scenario);
  for(const scenario of [undefined,null,'','both','success,health-failure','SUCCESS','success\n',['success']])assert.throws(()=>qa.validateScenario(scenario));
  assert.match(qa.formatSummary('success'),/native update\/restart passed/);
  assert.doesNotMatch(qa.formatSummary('success'),/rollback passed/);
  assert.doesNotMatch(qa.formatSummary('success'),/signed production setup\/uninstall/);
  assert.match(qa.formatSummary('health-failure'),/deliberate failed-health rollback passed/);
  assert.doesNotMatch(qa.formatSummary('health-failure'),/update\/restart passed/);
  assert.throws(()=>qa.formatSummary('both'));
});
test('sequential fixture builds reuse dependencies and retain distinct setup snapshots',()=>{
  assert.equal(typeof qa.fixtureBuildPaths,'function');
  const p=qa.createPlan(qa.validateContext(env(),'win32'));
  const source=qa.fixtureBuildPaths(p,'1.9.0'),target=qa.fixtureBuildPaths(p,'2.0.0');
  assert.equal(source.targetDir,target.targetDir);
  assert.notEqual(source.sourceDir,target.sourceDir);assert.notEqual(source.setupPath,target.setupPath);
  assert.match(source.setupPath,/Nearly_1\.9\.0_x64-setup\.exe$/);
  assert.match(target.setupPath,/Nearly_2\.0\.0_x64-setup\.exe$/);
  assert.throws(()=>qa.fixtureBuildPaths(p,'3.0.0'));
});
test('historical artifact checks reject expiration and mismatched run/digest without network',()=>{
  assert.equal(typeof qa.validatePinnedArtifact,'function');
  const artifact={id:12230567816,name:'nearly-signed-39288652319-1',expired:false,size_in_bytes:100,digest:'sha256:5533c87fa789c3907165f899a0d03962a0b3ed9af228b3d484b7d746b7df0480',workflow_run:{id:39288652319,repository_id:123,head_repository_id:123,head_branch:'main',head_sha:'0dd697f2d832ec9fd07e9278559e18819b65bd3a'}};
  assert.equal(qa.validatePinnedArtifact(artifact,123),true);
  for(const change of [{expired:true},{digest:'sha256:'+'0'.repeat(64)},{id:12158897824},{workflow_run:{...artifact.workflow_run,head_sha:'0'.repeat(40)}}])assert.throws(()=>qa.validatePinnedArtifact({...artifact,...change},123));
});
test('fixture key stays in memory and generated minisign proof verifies exact bytes',()=>{
  assert.equal(typeof qa.createFixtureSigner,'function');
  const signer=qa.createFixtureSigner(),bytes=Buffer.alloc(128);bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.writeUInt32LE(0x4550,64);bytes.writeUInt16LE(0x14c,68);
  assert.equal(signer.publicRaw.subarray(0,10).toString(),'Edqa-only!');
  assert.deepEqual(Object.keys(signer).sort(),['publicRaw','sign']);
  const proof=signer.sign(bytes,'f'.repeat(64));
  assert.equal(qa.verifyFixture(bytes,proof,signer.publicRaw,'f'.repeat(64)),true);
  const changed=Buffer.from(bytes);changed[100]=1;
  assert.throws(()=>qa.verifyFixture(changed,proof,signer.publicRaw,'f'.repeat(64)));
  assert.throws(()=>qa.verifyFixture(bytes,proof,signer.publicRaw,'e'.repeat(64)));
});
test('five settings fixtures carry complete manifests and generated offline data only',()=>{
  assert.equal(typeof qa.settingsFixture,'function');
  const files=qa.settingsFixture(),aggregate=unpackSettings(files);
  assert.deepEqual(aggregate.connections.profiles,[]);assert.deepEqual(aggregate.trust.pins,{});
  assert.equal(aggregate.appearance.theme,'dark');assert.equal(aggregate.appearance.language,'en');
  assert.equal(Object.keys(files).length,5);
  for(const bytes of Object.values(files))assert.equal(JSON.parse(bytes).metadata.installerQa,'generated-offline-fixture');
  assert.throws(()=>unpackSettings({...files,'history.json':files['history.json']+' '}),/manifest/);
});
test('bounded outcome validation rejects timeouts, wrong version and failed recovery',()=>{
  assert.equal(typeof qa.validateOutcome,'function');
  assert.equal(qa.validateOutcome({schemaVersion:2,destinationKind:'default',scenario:'success',phase:'succeeded',version:'2.0.0'},'success'),true);
  assert.equal(qa.validateOutcome({schemaVersion:2,destinationKind:'custom',scenario:'health-failure',phase:'rolledBack',version:'1.9.0'},'health-failure','custom'),true);
  assert.throws(()=>qa.validateOutcome({schemaVersion:2,destinationKind:'default',scenario:'success',phase:'succeeded',version:'2.0.0'},'success','custom'));
  assert.throws(()=>qa.validateOutcome({schemaVersion:2,destinationKind:'custom',scenario:'success',phase:'succeeded',version:'2.0.0',error:'failed'},'success','custom'));
  for(const o of [null,{}, {schemaVersion:1,scenario:'success',phase:'failed',version:'2.0.0'}, {schemaVersion:1,scenario:'health-failure',phase:'succeeded',version:'2.0.0'}])assert.throws(()=>qa.validateOutcome(o,'success'));
});
test('wait deadline fails closed with inert injected clock and no setup execution',async()=>{
  assert.equal(typeof qa.waitForOutcome,'function');let now=0;
  await assert.rejects(qa.waitForOutcome('unused','success',{timeoutMs:30,now:()=>now,sleep:async()=>{now+=10;},read:async()=>{throw Object.assign(Error(),{code:'ENOENT'});}}),/timed out/);
  await assert.rejects(qa.waitForOutcome('unused','success',{timeoutMs:30,read:async()=>Buffer.alloc(9000)}),/bounded/);
});
test('QA trace decoding accepts fixed fields and never returns credential or unknown values',()=>{
  assert.equal(typeof qa.decodeQaTrace,'function');
  const row={event:'startup',code:'source',version:'1.9.0',pid:42};
  const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
  assert.deepEqual(qa.decodeQaTrace(encode(row),42),[row]);
  for(const change of [{event:'ghp_exampleCredential'},{code:'a'.repeat(64)},{token:'secret'},{path:'C:\\secret'},{version:'3.0.0'},{pid:0},{pid:4294967296},{pid:43},{event:'unknownEvent'},{code:'unknownCode'}])assert.throws(()=>qa.decodeQaTrace(encode({...row,...change}),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from('{"event":"startup","event":"frontendReady","version":"1.9.0","pid":42}\n'),42));
});
test('QA trace bounds and incomplete final-line handling fail closed',()=>{
  const row=JSON.stringify({event:'startup',version:'2.0.0',pid:42});
  assert.deepEqual(qa.decodeQaTrace(Buffer.from(row+'\n{"event":"start'),42),[JSON.parse(row)]);
  assert.deepEqual(qa.decodeQaTrace(Buffer.from(row),42),[JSON.parse(row)]);
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{"event":"start\n'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\nnotJson'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{"event" false'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{"token":"secret'),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.alloc(16385),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from((row+'\n').repeat(65)),42));
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(row+'\n{}\n'),42));
});
test('QA file-user hints accept four fixed codes and reject raw process, service and path names',()=>{
  for(const code of ['scannerHint','webviewHint','childIdentityMismatch','unknown']){
    const row={event:'fileUserHint',code,version:'2.0.0',pid:42};
    assert.deepEqual(qa.decodeQaTrace(Buffer.from(JSON.stringify(row)+'\n'),42),[row]);
  }
  for(const code of ['MsMpEng','WinDefend','msedgewebview2','C:\\Windows\\System32\\scanner.exe','scanner.exe','scannerHint\n','a'.repeat(65)]){
    assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event:'fileUserHint',code,version:'2.0.0',pid:42})+'\n'),42));
  }
  assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event:'fileUserHint',code:'scannerHint',version:'2.0.0',pid:42,process:'scanner.exe'})+'\n'),42));
});
test('QA peer and supervisor diagnostics accept only their fixed event-specific codes',()=>{
  const mapping={peerObservation:['pathQueryFailed','exitAfterPathFailure','pathFailureStillLive','identityQueryFailed'],supervisorError:['parent','commit','child','worker','fileUsers','idle','tuple','exitRequest']};
  for(const [event,codes]of Object.entries(mapping))for(const code of codes){
    const row={event,code,version:'2.0.0',pid:42};
    assert.deepEqual(qa.decodeQaTrace(Buffer.from(JSON.stringify(row)+'\n'),42),[row]);
  }
  for(const [event,code]of [['peerObservation','parent'],['supervisorError','pathQueryFailed'],['supervisorError','pathFailureStillLive'],['supervisorError','identityQueryFailed'],['peerObservation','unknown'],['supervisorError','ERROR_ACCESS_DENIED'],['supervisorError','C:\\private\\Nearly.exe'],['peerObservation','app.exe'],['supervisorError','a'.repeat(65)]]){
    assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event,code,version:'2.0.0',pid:42})+'\n'),42));
  }
});

test('file-user observation stages and retained-peer failures remain fixed diagnostics only',()=>{
  const mapping={fileUserObservation:['peerPrecheckFailed','rootVerificationFailed','rmStartFailed','rmRegisterFailed','rmFirstFailed','rmListFailed','rmCapacityInvalid','rmListExhausted','rmListGrowth','supervisorIdentityFailed'],peerObservation:['identityMismatch','waitFailed','pathMismatch','exitQueryFailed','stillActiveAfterSignal']};
  for(const [event,codes]of Object.entries(mapping))for(const code of codes){
    const row={event,code,version:'1.9.0',pid:42};
    assert.deepEqual(qa.decodeQaTrace(Buffer.from(JSON.stringify(row)+'\n'),42),[row]);
  }
  for(const [event,code]of [['fileUserObservation','C:\\private\\app.exe'],['fileUserObservation','RmStartSession error5'],['fileUserObservation','identityMismatch'],['peerObservation','rmListGrowth'],['fileUserObservation','scanner.exe'],['fileUserObservation','rmListGrowth\n']])assert.throws(()=>qa.decodeQaTrace(Buffer.from(JSON.stringify({event,code,version:'1.9.0',pid:42})+'\n'),42));
});
test('QA trace collection reads at most eight exact PID files with a fixed size limit',async()=>{
  assert.equal(typeof qa.collectQaTraces,'function');
  const files=['authorization.json','qa-trace-0.jsonl','qa-trace-01.jsonl','qa-trace-4294967296.jsonl','qa-trace-42.jsonl\n','../qa-trace-42.jsonl',...Array.from({length:10},(_,i)=>`qa-trace-${i+1}.jsonl`)];
  const read=[];
  const records=await qa.collectQaTraces('owned-root',{list:async()=>files,read:async(file,limit)=>{read.push({file,limit});const pid=Number(/qa-trace-([0-9]+)\.jsonl$/.exec(file)[1]);return Buffer.from(JSON.stringify({event:'startup',version:'1.9.0',pid})+'\n');}});
  assert.equal(records.length,8);assert.equal(read.length,8);assert.ok(read.every(r=>r.limit===16384));
  const rejected=await qa.collectQaTraces('owned-root',{list:async()=>['qa-trace-42.jsonl'],read:async()=>Buffer.from('{"token":"neverLogThis"}\n')});
  assert.deepEqual(rejected,[]);
  let unexpectedReads=0;
  assert.deepEqual(await qa.collectQaTraces('owned-root',{list:async()=>['qa-trace-42.jsonl\n','authorization.json','../qa-trace-42.jsonl','qa-trace-042.jsonl'],read:async()=>{unexpectedReads++;throw Error('must not read');}}),[]);
  assert.equal(unexpectedReads,0);
});
const traceRow=(pid,version,event,code)=>({pid,version,event,code});
function causalFixture(scenario='health-failure'){
  const helper=(event,code)=>traceRow(20,'1.9.0',event,code),target=(event,code)=>traceRow(30,'2.0.0',event,code),restored=(event,code)=>traceRow(40,'1.9.0',event,code);
  const common=[helper('helper','started'),helper('supervisorPhase','AwaitingHealth'),helper('supervisorAction','LaunchNew')];
  return scenario==='health-failure'?[...common,helper('supervisorChild','LiveUnhealthy'),helper('supervisorAction','RequestChildExit'),helper('supervisorChild','Exited'),helper('supervisorPhase','Restoring'),helper('supervisorPhase','Restored'),helper('supervisorAction','RestartOld'),helper('restoration','verified'),helper('restoration','restartIssued'),helper('helper','succeeded'),target('bootstrap','target'),restored('bootstrap','source'),restored('marker','existing'),restored('restoration','confirmed'),restored('outcome','rolledBack')]:[...common,helper('supervisorPhase','Succeeded'),helper('helper','succeeded'),target('runtime','succeeded'),target('bootstrap','target'),target('outcome','succeeded')];
}
test('causal health proof requires the unhealthy target, cooperative child exit and restored source in distinct PID groups',()=>{
  const records=causalFixture(),proof=qa.validateCausalProof(records,'health-failure');
  assert.deepEqual(proof,{schemaVersion:1,scenario:'health-failure',proof:'health-failure-after-target-bootstrap',helperPid:20,targetPid:30,restoredPid:40});
  assert.deepEqual(qa.validateCausalProof([...records,traceRow(10,'1.9.0','bootstrap','source'),traceRow(10,'1.9.0','marker','created'),traceRow(50,'1.9.0','startup','helper')],'health-failure'),proof);
  for(let i=0;i<records.length;i++)assert.throws(()=>qa.validateCausalProof(records.filter((_,index)=>index!==i),'health-failure'),undefined,`missing ${records[i].event}:${records[i].code}`);
  const preHealth=records.filter(row=>!['AwaitingHealth','LaunchNew','LiveUnhealthy','RequestChildExit','Exited'].includes(row.code));
  assert.throws(()=>qa.validateCausalProof(preHealth,'health-failure'));
  for(const change of [rows=>rows.map(row=>row.pid===30?{...row,version:'1.9.0'}:row),rows=>rows.map(row=>row.pid===40?{...row,pid:20}:row),rows=>{[rows[3],rows[4]]=[rows[4],rows[3]];return rows;},rows=>[...rows,traceRow(20,'1.9.0','supervisorChild','LiveHealthy')],rows=>[...rows,traceRow(20,'1.9.0','supervisorPhase','Succeeded')],rows=>[...rows,traceRow(20,'1.9.0','supervisorAction','ManualRepair')],rows=>[...rows,{...rows[0],code:'unknown'}]])assert.throws(()=>qa.validateCausalProof(change([...records]),'health-failure'));
  const prematureRestore=[...records];[prematureRestore[5],prematureRestore[6]]=[prematureRestore[6],prematureRestore[5]];assert.throws(()=>qa.validateCausalProof(prematureRestore,'health-failure'));
});
test('causal success proof requires durable helper success and target runtime/outcome without assuming cross-file timing',()=>{
  const records=causalFixture('success');
  assert.deepEqual(qa.validateCausalProof(records,'success'),{schemaVersion:1,scenario:'success',proof:'native-success-after-target-bootstrap',helperPid:20,targetPid:30});
  for(let i=0;i<records.length;i++)assert.throws(()=>qa.validateCausalProof(records.filter((_,index)=>index!==i),'success'));
  assert.throws(()=>qa.validateCausalProof(causalFixture(),'success'));
  assert.throws(()=>qa.validateCausalProof(records.map(row=>row.pid===30?{...row,pid:20}:row),'success'));
  assert.throws(()=>qa.validateCausalProof([...records,traceRow(21,'1.9.0','helper','started')],'success'));
});
test('strict trace reading rejects truncation, unknown/missing codes, mixed versions, mismatched file PID and all I/O failures',async()=>{
  const row=traceRow(42,'1.9.0','helper','started'),encode=rows=>Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const readCalls=[];
  assert.deepEqual(await qa.collectStrictQaTraces('owned-root',{list:async()=>['authorization.json','qa-trace-42.jsonl'],read:async(file,limit)=>{readCalls.push({file,limit});return encode([row]);}}),[row]);
  assert.equal(readCalls[0].limit,16384);
  const maximum=await qa.collectStrictQaTraces('owned-root',{list:async()=>Array.from({length:8},(_,i)=>`qa-trace-${i+1}.jsonl`),read:async file=>{const pid=Number(/qa-trace-([0-9]+)\.jsonl$/.exec(file)[1]);return encode(Array.from({length:64},()=>({...row,pid})));}});
  assert.equal(maximum.length,512);
  for(const bytes of [Buffer.from(JSON.stringify(row)),Buffer.from(JSON.stringify(row)+'\n{"event":"help'),encode([{...row,code:undefined}]),encode([{...row,code:'unknown'}]),encode([{...row,pid:43}]),encode([row,{...row,version:'2.0.0'}]),encode(Array.from({length:65},()=>row)),Buffer.alloc(16385),Buffer.from('\n')])await assert.rejects(qa.collectStrictQaTraces('owned-root',{list:async()=>['qa-trace-42.jsonl'],read:async()=>bytes}));
  const fixedFailure=error=>{assert.equal(error.message,'QA causal trace unavailable');assert.doesNotMatch(error.message,/sentinel-private-path|sentinel-token/);return true;};
  await assert.rejects(qa.collectStrictQaTraces('owned-root',{list:async()=>{throw Error('C:\\sentinel-private-path\\sentinel-token');}}),fixedFailure);
  await assert.rejects(qa.collectStrictQaTraces('owned-root',{list:async()=>['qa-trace-42.jsonl'],read:async()=>{throw Error('C:\\sentinel-private-path\\sentinel-token');}}),fixedFailure);
});
test('strict trace inventory fails on overflow or suspicious names before any read, without slicing or swallowing',async()=>{
  let reads=0;
  for(const names of [[],Array.from({length:9},(_,i)=>`qa-trace-${i+1}.jsonl`),['../qa-trace-42.jsonl'],['qa-trace-042.jsonl'],['qa-trace-42.jsonl\n'],['qa-trace-4294967296.jsonl'],['qa-trace-42.jsonl','qa-trace-42.jsonl']])await assert.rejects(qa.collectStrictQaTraces('owned-root',{list:async()=>names,read:async()=>{reads++;return Buffer.alloc(0);}}));
  assert.equal(reads,0);
});

test('workflow remains manual, read-only and uploads only validated public evidence',async()=>{
  const text=await fs.readFile(new URL('../.github/workflows/installer-qa-windows.yml',import.meta.url),'utf8');
  assert.match(text,/workflow_dispatch:/);assert.match(text,/controller_sha:/);assert.match(text,/confirmation:/);
  assert.doesNotMatch(text,/secrets\.|contents: write|actions: write|pull_request:|push:/);
  assert.match(text,/upload-artifact@[a-f0-9]{40}/);assert.match(text,/public-evidence/);
  assert.match(text,/installer-qa-evidence\.mjs/);
  assert.match(text,/github\.workflow_sha/);assert.match(text,/installer-qa\.mjs \$env:QA_COMMAND/);
  assert.match(text,/QA_COMMAND: \$\{\{ matrix\.phase == 'production' && 'production' \|\| 'run' \}\}/);
  assert.match(text,/fail-fast: false/);assert.match(text,/scenario: \[success, health-failure\]/);
  assert.match(text,/QA_SCENARIO: \$\{\{ matrix\.scenario \}\}/);
  const destinations=/destination: \$\{\{ fromJSON\(inputs\.root_coverage_only && '([^']+)' \|\| '([^']+)'\) \}\}/.exec(text);
  assert.ok(destinations);assert.deepEqual(JSON.parse(destinations[1]),['drive-c']);assert.deepEqual(JSON.parse(destinations[2]),['default','custom','drive']);
  const included=/include: \$\{\{ fromJSON\(inputs\.root_coverage_only && '([^']+)' \|\| '([^']+)'\) \}\}/.exec(text);
  assert.ok(included);assert.deepEqual(JSON.parse(included[1]),[]);assert.deepEqual(JSON.parse(included[2]),[{phase:'production',scenario:'success',destination:'default'}]);
  assert.match(text,/root_coverage_only:[\s\S]*?type: boolean\s+default: false/);
  assert.match(text,/QA_DESTINATION: \$\{\{ matrix\.destination \}\}/);
});

test('production regression is independent and fails closed without blocking candidate qualification',async()=>{
  assert.equal(typeof qa.production,'function');await assert.rejects(()=>qa.production({...env(),GITHUB_ACTIONS:'false'}));
  const source=await fs.readFile(new URL('../scripts/installer-qa.mjs',import.meta.url),'utf8');
  const candidate=source.slice(source.indexOf('export async function run('),source.indexOf('if(process.argv[1]'));
  assert.doesNotMatch(candidate,/downloadSigned|historicalFailure|ps\('production'/);
  const production=source.slice(source.indexOf('export async function production('),source.indexOf('export async function run('));
  assert.match(production,/verifySignedBundle/);assert.match(production,/await ps\('production'/);assert.match(production,/passed:false/);assert.match(production,/throw error/);
  const workflow=await fs.readFile(new URL('../.github/workflows/installer-qa-windows.yml',import.meta.url),'utf8');
  assert.match(workflow,/phase: \[candidate\]/);assert.match(workflow,/"phase":"production"/);assert.match(workflow,/QA_COMMAND:/);assert.match(workflow,/if: matrix\.phase != 'production'/);
});
