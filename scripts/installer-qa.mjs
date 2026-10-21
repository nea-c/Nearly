// Manual hosted-guest qualification only. Importing this module has no effects.
import {qaBinaryMarker} from './production-build-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {validateArtifact,verifySignedBundle,regular,canonical} from '../.github/scripts/signed-release-contract.mjs';
import {loadTrustedPublicKey} from '../.github/scripts/release-trust.mjs';
import {verifyUpdaterProof} from '../.github/scripts/updater-proof.mjs';
import {packSettings,names as settingsNames} from './storage-fixture.mjs';
import {requireCachedTools} from './build-installer.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(r,v)=>typeof v==='string'&&r.exec(v)?.[0]===v;
const fail=m=>{throw Error(m);};
export const SOURCE=Object.freeze({sourceCommit:'0dd697f2d832ec9fd07e9278559e18819b65bd3a',artifactId:'12230567816',sourceRunId:'39288652319',sourceRunAttempt:'1',zipSha256:'5533c87fa789c3907165f899a0d03962a0b3ed9af228b3d484b7d746b7df0480',installerSha256:'fc65ec21d586227172f2d8f99ce055e2b2c394db675c59444f47129cae5551dc',manifestHash:'75796ed00c47a2d1b93d734a471cf81b0a52d30c87940381ca7b2b35dd713bcc'});
export const PRODUCTION_RELEASE=Object.freeze({id:417869306,tag:'r3.1',assets:Object.freeze([
 Object.freeze({id:657779184,name:'Nearly_r3.1_x64-setup.exe',bytes:5896024,sha256:SOURCE.installerSha256}),
 Object.freeze({id:657779209,name:'Nearly_r3.1_x64-setup.exe.sha256',bytes:92,sha256:'16ccd21421c70440f229a3da70b0e934626ecaf90836061a396e8bdda2079199'}),
 Object.freeze({id:657779229,name:'Nearly_r3.1_x64-setup.exe.sig',bytes:528,sha256:'43473c441f9a7e4b34f6115d466c5e56c4681dbc5280616d4e1e58ed2642ff76'}),
])});
export function validateProductionRelease(release,commit){
 if(release?.id!==PRODUCTION_RELEASE.id||release.tag_name!==PRODUCTION_RELEASE.tag||release.draft!==false||release.prerelease!==false||commit?.sha!==SOURCE.sourceCommit||!Array.isArray(release.assets)||release.assets.length!==3)fail('Historical release identity mismatch; no alternate source');
 for(const expected of PRODUCTION_RELEASE.assets){
  const found=release.assets.filter(a=>a.name===expected.name);
  if(found.length!==1||found[0].id!==expected.id||found[0].size!==expected.bytes||found[0].digest!=='sha256:'+expected.sha256||found[0].state!=='uploaded'||found[0].browser_download_url!==`https://github.com/nea-c/Nearly/releases/download/r3.1/${expected.name}`)fail('Historical release asset mismatch; no alternate source');
 }
 return PRODUCTION_RELEASE.assets;
}
function canonicalWindows(value){
  if(typeof value!=='string'||!exact(/[A-Za-z]:\\[^\x00-\x1f<>"|?*]+/,value)||value.slice(2).includes(':')||value.includes('/')||value.split('\\').some(x=>x==='.'||x==='..'||/[. ]$/.test(x))||path.win32.normalize(value)!==value)fail('Canonical local Windows path required');
  return value;
}
export function validateContext(e,platform=process.platform){
  const fixed={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',RUNNER_OS:'Windows',RUNNER_ENVIRONMENT:'github-hosted'};
  if(platform!=='win32'||Object.hasOwn(e,'SYNCFILES_CONFIG_DIR')||Object.entries(fixed).some(([k,v])=>e[k]!==v))fail('Manual fresh GitHub-hosted Windows guest required');
  if(!['refs/heads/main','refs/heads/codex/private-install-directory'].includes(e.GITHUB_REF))fail('Reviewed QA branch required');
  const sha=e.QA_CONTROLLER_SHA;
  if(!exact(/[a-f0-9]{40}/,sha)||e.GITHUB_SHA!==sha||e.GITHUB_WORKFLOW_SHA!==sha||e.QA_CONFIRMATION!==`installer-qa ${sha}`)fail('Exact controller SHA and installer-qa confirmation required');
  for(const k of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])if(!exact(/[1-9][0-9]*/,e[k])||!Number.isSafeInteger(Number(e[k])))fail('Canonical run identity required');
  return Object.freeze({controllerSha:sha,runId:e.GITHUB_RUN_ID,runAttempt:e.GITHUB_RUN_ATTEMPT,runnerTemp:canonicalWindows(e.RUNNER_TEMP),localAppData:canonicalWindows(e.LOCALAPPDATA)});
}
export function validateDestination(value){if(!['default','custom','drive','drive-c'].includes(value))fail('Select exactly one QA_DESTINATION for this fresh guest');return value;}
export function createPlan(c,destinationKind='default'){
  validateDestination(destinationKind);
  const leaf=`Nearly Installer QA ${c.runId}-${c.runAttempt}`,destinations={default:path.win32.join(c.localAppData,'Nearly'),custom:path.win32.join(c.localAppData,leaf,'日本語 space','Nearly'),drive:path.win32.join('D:\\',`Nearly QA 日本語 ${c.runId}-${c.runAttempt}`)};
  destinations['drive-c']=path.win32.join('C:\\',path.win32.basename(destinations.drive));
  return {schemaVersion:2,controllerSha:c.controllerSha,runId:c.runId,runAttempt:c.runAttempt,runRoot:path.win32.join(c.runnerTemp,`nearly-installer-qa-${c.runId}-${c.runAttempt}`),destinationKind,destinations,installRoot:destinations[destinationKind],sourceVersion:'1.9.0',targetVersion:'2.0.0',...SOURCE};
}
export function validatePlan(p,c,destinationKind='default'){
  const wanted=createPlan(c,destinationKind);
  if(!p||JSON.stringify(Object.keys(p).sort())!==JSON.stringify(Object.keys(wanted).sort())||Object.entries(wanted).some(([k,v])=>JSON.stringify(p[k])!==JSON.stringify(v)))fail('QA plan/provenance/path mismatch');
  return true;
}
export function uiCases(){return ['en','ja'].flatMap(language=>[0,1].flatMap(start=>[0,1].map(desktop=>({name:`${language}-${start}-${desktop}`,language,start,desktop}))));}
export function validateScenario(scenario){
  if(!['success','health-failure'].includes(scenario))fail('Select exactly one QA_SCENARIO for this fresh guest');
  return scenario;
}
export function formatSummary(scenario,destination='default'){
  validateScenario(scenario);
  validateDestination(destination);
  const lifecycle=scenario==='success'?'native update/restart':'deliberate failed-health rollback';
  return `Candidate installer QA (${scenario}, ${destination}): eight English/Japanese UI choices, cancellation/back navigation and ${lifecycle} passed. Fixture executables remain on this ephemeral runner. Signed-production regression is reported by its separate job.\n`;
}
export function createFixtureSigner(){
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const raw=Buffer.concat([Buffer.from('Edqa-only!'),publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
  // The private KeyObject lives only in this closure: never exported, serialized,
  // inherited by children, written to disk, uploaded, or placed in an environment.
  return Object.freeze({publicRaw:raw,sign(installer,payloadSha256){
    const comment=`version:2.0.0\tfile:Nearly_r2.0_x64-setup.exe\tpayload-sha256:${payloadSha256}\tupdater-protocol:3`;
    const sig=sign(null,installer,privateKey),record=Buffer.concat([raw.subarray(0,10),sig]);
    const global=sign(null,Buffer.concat([sig,Buffer.from(comment)]),privateKey);
    const proof=Buffer.from(`untrusted comment: ephemeral installer QA fixture\n${record.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
    const result=Buffer.from(proof);verifyFixture(installer,result,raw,payloadSha256);return result;
  }});
}
export function verifyFixture(bytes,proof,key,payloadSha256){return verifyUpdaterProof(bytes,proof,key,{version:'2.0.0',file:'Nearly_r2.0_x64-setup.exe',payloadSha256});}
export function validateOutcome(o,scenario,destination='default'){
  validateDestination(destination);
  if(!['success','health-failure'].includes(scenario)||!o||o.schemaVersion!==2||o.destinationKind!==destination||o.scenario!==scenario||o.phase!==(scenario==='success'?'succeeded':'rolledBack')||o.version!==(scenario==='success'?'2.0.0':'1.9.0')||o.error!==undefined)fail('QA outcome did not prove expected success/recovery');
  return true;
}
export async function waitForOutcome(file,scenario,{destination='default',timeoutMs=180000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),read=f=>regular(f,8192)}={}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>300000)fail('Invalid outcome deadline');
  const deadline=now()+timeoutMs;
  while(now()<deadline){
    try{const bytes=await read(file);if(bytes.length>8192)fail('Outcome exceeds bounded limit');const o=JSON.parse(bytes);validateOutcome(o,scenario,destination);return o;}
    catch(e){if(e.code!=='ENOENT')throw e;}
    await sleep(500);
  }
  fail(`QA ${scenario} timed out; no skipped pass`);
}
const TRACE_CODES=Object.freeze({
  startup:['source','target','helper'],bootstrap:['source','target'],marker:['created','existing','invalid'],fixture:['staging','ready'],handoff:['failed','returned'],
  runtime:['idle','waitingForUi','checking','awaitingSuccess','succeeded','recoveryRequired'],
  runtimeError:['supervisorAuthenticationFailed','liveSupervisorMissing','restartInterrupted','supervisorEvidenceLost','runtimeUnavailable','probationReleaseFailed','healthShutdownBusy','supervisorHealthTimeout','transactionUnavailable','unsupportedPlatform','invalidHealthArguments','other'],
  exit:['requested','sealed','idleSignalled','issued'],idle:['attested'],helper:['started','succeeded','failed'],
  nativeError:['Disabled','Invalid','Unsafe','Busy','Missing','Io','Protection','Uncertain'],
  supervisorPhase:['Prepared','Armed','Staging','CandidatesVerified','Applying','AwaitingHealth','Succeeded','Restoring','Restored','ManualRepair'],
  supervisorAction:['StartStaging','VerifyCandidates','ApplyImage','ApplyUninstaller','ApplyRegistration','RestoreImage','RestoreUninstaller','RestoreRegistration','LaunchNew','RequestChildExit','RestartOld','Complete','ManualRepair'],
  supervisorChild:['NotStarted','LiveUnhealthy','LiveHealthy','Exited','Uncertain'],
  supervisorBlock:['rootLeaseInvalid','snapshotsChanged','settingsChanged','otherFileUsers','workerUncertain','childUncertain','childNotIdle','childExitTimedOut'],
  fileUserHint:['scannerHint','webviewHint','childIdentityMismatch','unknown'],
  peerObservation:['pathQueryFailed','exitAfterPathFailure','pathFailureStillLive','identityQueryFailed','identityMismatch','waitFailed','pathMismatch','exitQueryFailed','stillActiveAfterSignal'],
  fileUserObservation:['peerPrecheckFailed','rootVerificationFailed','rmStartFailed','rmRegisterFailed','rmFirstFailed','rmListFailed','rmCapacityInvalid','rmListExhausted','rmListGrowth','supervisorIdentityFailed'],
  supervisorError:['parent','commit','child','worker','fileUsers','idle','tuple','exitRequest'],
  restoration:['verified','restartIssued','confirmed','rejected'],outcome:['succeeded','rolledBack','failed','writeFailed'],
});
const tracePid=p=>Number.isInteger(p)&&p>0&&p<=0xffffffff;
function incompleteTraceTail(line){
  // Recognize only a prefix of the native flat JSON record grammar. An invalid
  // complete line or a credential/unknown-key tail is never treated as a crash.
  let i=0;const seen=new Set(),fields=['event','code','version','pid'];
  const skip=()=>{while(line[i]===' ')i++;};
  const string=()=>{
    if(line[i++]!=='"')return null;
    let value='';while(i<line.length){const ch=line[i++];if(ch==='"')return {value,complete:true};if(!/[\x20-\x7e]/.test(ch)||ch==='\\')return null;value+=ch;}
    return {value,complete:false};
  };
  skip();if(line[i++]!=='{')return false;
  while(true){
    skip();if(i===line.length)return true;
    const key=string();if(!key)return false;
    if(!key.complete)return fields.some(f=>!seen.has(f)&&f.startsWith(key.value));
    if(!fields.includes(key.value)||seen.has(key.value))return false;seen.add(key.value);
    skip();if(i===line.length)return true;if(line[i++]!==':')return false;
    skip();if(i===line.length)return true;
    if(key.value==='pid'){
      const start=i;while(/[0-9]/.test(line[i]??''))i++;
      const digits=line.slice(start,i);if(!/^[1-9][0-9]*$/.test(digits)||!tracePid(Number(digits)))return false;
    }else{
      const value=string();if(!value)return false;
      const allowed=key.value==='event'?Object.keys(TRACE_CODES):key.value==='version'?['1.9.0','2.0.0']:Object.values(TRACE_CODES).flat();
      if(!value.complete)return allowed.some(v=>v.startsWith(value.value));
      if(!allowed.includes(value.value))return false;
    }
    skip();if(i===line.length)return true;
    if(line[i++]!==',')return false;
  }
}
export function decodeQaTrace(bytes,expectedPid){
  if(!Buffer.isBuffer(bytes)||bytes.length>16384||!tracePid(expectedPid))fail('Invalid bounded QA trace');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),lines=text.split('\n'),records=[];
  if(lines.at(-1)==='')lines.pop();
  if(lines.length>64)fail('Invalid bounded QA trace');
  for(let i=0;i<lines.length;i++){
    const line=lines[i];let value;
    try{value=JSON.parse(line);}catch{
      if(i===lines.length-1&&!text.endsWith('\n')&&incompleteTraceTail(line))break;
      fail('Invalid bounded QA trace');
    }
    const keys=value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value):[];
    // Accepted values need no JSON escapes; refusing escapes also makes the key
    // count below detect duplicate fields without logging or retaining raw text.
    if(line.includes('\\')||(line.match(/"[^"\\]*"\s*:/g)||[]).length!==keys.length||keys.length<3||keys.length>4||keys.some(k=>!['event','code','version','pid'].includes(k))||!Object.hasOwn(value,'event')||!Object.hasOwn(value,'version')||!Object.hasOwn(value,'pid'))fail('Invalid bounded QA trace');
    if(!exact(/[a-z][A-Za-z0-9]{0,63}/,value.event)||!Object.hasOwn(TRACE_CODES,value.event)||!['1.9.0','2.0.0'].includes(value.version)||!tracePid(value.pid)||value.pid!==expectedPid)fail('Invalid bounded QA trace');
    if(Object.hasOwn(value,'code')&&(!exact(/[A-Za-z][A-Za-z0-9]{0,63}/,value.code)||!TRACE_CODES[value.event].includes(value.code)))fail('Invalid bounded QA trace');
    records.push({event:value.event,...(value.code===undefined?{}:{code:value.code}),version:value.version,pid:value.pid});
  }
  return records;
}
export async function collectQaTraces(runRoot,{list=dir=>fs.readdir(dir),read=regular}={}){
  const records=[];
  try{
    const files=(await list(runRoot)).filter(name=>{
      const match=typeof name==='string'&&/^qa-trace-([1-9][0-9]*)\.jsonl$/.exec(name);
      return match&&match[0]===name&&tracePid(Number(match[1]));
    }).sort().slice(0,8);
    for(const name of files){
      try{const pid=Number(/^qa-trace-([1-9][0-9]*)\.jsonl$/.exec(name)[1]);records.push(...decodeQaTrace(await read(path.join(runRoot,name),16384),pid));}
      catch{/* A malformed/unavailable trace never hides the original QA failure. */}
    }
  }catch{/* Diagnostic discovery is best effort; never print raw errors/paths. */}
  return records;
}
function strictTraceNames(entries){
  if(!Array.isArray(entries)||entries.length>512||entries.some(name=>typeof name!=='string'))fail('Invalid strict QA trace inventory');
  const files=entries.filter(name=>name.toLowerCase().includes('qa-trace-'));
  if(files.length<1||files.length>8||new Set(files).size!==files.length)fail('Invalid strict QA trace inventory');
  for(const name of files){const match=/^qa-trace-([1-9][0-9]*)\.jsonl$/.exec(name);if(!match||match[0]!==name||!tracePid(Number(match[1])))fail('Invalid strict QA trace inventory');}
  return files.sort();
}
async function listStrictTraceDirectory(dir){
  // The context derives the owned root. Recheck every directory component so
  // an ancestor junction cannot redirect an otherwise regular trace filename.
  const absolute=path.resolve(dir);let current=path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('Unsafe strict QA trace directory');
  }
  return fs.readdir(absolute);
}
function strictTraceGroups(records){
  if(!Array.isArray(records)||records.length<1||records.length>512)fail('Invalid strict QA trace records');
  const groups=new Map();
  for(const row of records){
    if(!row||typeof row!=='object'||JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['code','event','pid','version'])||typeof row.event!=='string'||typeof row.code!=='string'||!tracePid(row.pid)||!['1.9.0','2.0.0'].includes(row.version)||!Object.hasOwn(TRACE_CODES,row.event)||!TRACE_CODES[row.event].includes(row.code))fail('Invalid strict QA trace records');
    const group=groups.get(row.pid)??[];
    if(group.length>=64||(group.length&&group[0].version!==row.version))fail('Invalid strict QA trace PID group');
    group.push(row);groups.set(row.pid,group);
  }
  if(groups.size>8)fail('Invalid strict QA trace PID count');
  return groups;
}
export async function collectStrictQaTraces(runRoot,{list=listStrictTraceDirectory,read=regular}={}){
  // Qualification evidence is separate from best-effort diagnostics. No tail
  // recovery, truncation, skipped file, or swallowed I/O failure is permitted.
  let files;
  try{files=strictTraceNames(await list(runRoot));}catch{fail('QA causal trace unavailable');}
  const records=[];
  for(const name of files){
    const pid=Number(/^qa-trace-([1-9][0-9]*)\.jsonl$/.exec(name)[1]);let bytes;
    try{bytes=await read(path.join(runRoot,name),16384);}catch{fail('QA causal trace unavailable');}
    if(!Buffer.isBuffer(bytes)||bytes.length<2||bytes.length>16384||bytes.at(-1)!==10)fail('Strict QA trace must be bounded and complete');
    const group=decodeQaTrace(bytes,pid);strictTraceGroups(group);records.push(...group);
  }
  strictTraceGroups(records);return records;
}
const matchesTrace=(row,[event,code])=>row.event===event&&row.code===code;
function hasOrderedTrace(rows,sequence){let next=0;for(const row of rows)if(next<sequence.length&&matchesTrace(row,sequence[next]))next++;return next===sequence.length;}
export function validateCausalProof(records,scenario){
  validateScenario(scenario);const groups=strictTraceGroups(records),all=[...groups.values()];
  const role=(version,event,code)=>{
    const found=all.filter(rows=>rows[0].version===version&&rows.some(row=>matchesTrace(row,[event,code])));
    if(found.length!==1)fail('QA causal proof role missing or ambiguous');return found[0];
  };
  if(records.some(row=>matchesTrace(row,['helper','failed'])||matchesTrace(row,['supervisorAction','ManualRepair'])||matchesTrace(row,['supervisorPhase','ManualRepair'])||matchesTrace(row,['outcome','failed'])||matchesTrace(row,['outcome','writeFailed'])||matchesTrace(row,['restoration','rejected'])))fail('QA causal proof contains a terminal failure');
  const helper=role('1.9.0','helper','started'),target=role('2.0.0','bootstrap','target');
  const helperPid=helper[0].pid,targetPid=target[0].pid;
  if(helperPid===targetPid)fail('QA causal proof process roles overlap');
  const beginning=[['helper','started'],['supervisorPhase','AwaitingHealth'],['supervisorAction','LaunchNew']];
  if(scenario==='health-failure'){
    if(records.some(row=>matchesTrace(row,['supervisorChild','LiveHealthy'])||matchesTrace(row,['supervisorPhase','Succeeded'])||matchesTrace(row,['runtime','succeeded'])||matchesTrace(row,['outcome','succeeded'])))fail('Health-failure QA trace contains success');
    // The native loop observes Exited before next_action publishes Restoring:
    // a live child requests cooperative exit and cannot authorize restoration.
    const sequence=[...beginning,['supervisorChild','LiveUnhealthy'],['supervisorAction','RequestChildExit'],['supervisorChild','Exited'],['supervisorPhase','Restoring'],['supervisorPhase','Restored'],['supervisorAction','RestartOld'],['restoration','verified'],['restoration','restartIssued'],['helper','succeeded']];
    const restored=role('1.9.0','marker','existing'),restoredPid=restored[0].pid;
    if(restoredPid===helperPid||restoredPid===targetPid||!hasOrderedTrace(helper,sequence)||!hasOrderedTrace(restored,[['bootstrap','source'],['marker','existing'],['restoration','confirmed'],['outcome','rolledBack']]))fail('Health-failure QA lacks post-health rollback proof');
    return {schemaVersion:1,scenario,proof:'health-failure-after-target-bootstrap',helperPid,targetPid,restoredPid};
  }
  if(!hasOrderedTrace(helper,[...beginning,['supervisorPhase','Succeeded'],['helper','succeeded']])||!hasOrderedTrace(target,[['runtime','succeeded'],['outcome','succeeded']])||!hasOrderedTrace(target,[['bootstrap','target'],['outcome','succeeded']])||records.some(row=>matchesTrace(row,['supervisorPhase','Restoring'])||matchesTrace(row,['supervisorPhase','Restored'])||matchesTrace(row,['outcome','rolledBack'])))fail('Success QA lacks durable helper and target proof');
  return {schemaVersion:1,scenario,proof:'native-success-after-target-bootstrap',helperPid,targetPid};
}
async function closedQaTraces(runRoot,env){
  let names;
  try{names=strictTraceNames(await listStrictTraceDirectory(runRoot));}catch{fail('QA causal trace unavailable');}
  const pids=names.map(name=>Number(/^qa-trace-([1-9][0-9]*)\.jsonl$/.exec(name)[1]));
  // Read-only lookups of these exact bounded trace PIDs only. Never enumerate
  // unrelated processes or terminate a writer to manufacture complete evidence.
  const script=`$ErrorActionPreference='Stop'; $tracePids=@(${pids.join(',')}); $deadline=[DateTime]::UtcNow.AddSeconds(15); do { $live=$false; foreach($tracePid in $tracePids) { try { $null=Get-Process -Id $tracePid -ErrorAction Stop; $live=$true } catch { if($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw 'QA trace process observation failed' } } }; if(!$live) { exit 0 }; Start-Sleep -Milliseconds 250 } while([DateTime]::UtcNow -lt $deadline); throw 'QA trace writer did not exit'`;
  await execute('pwsh',['-NoProfile','-NonInteractive','-Command',script],{env,timeoutMs:20000});
  const records=await collectStrictQaTraces(runRoot),observed=[...new Set(records.map(row=>row.pid))];
  if(observed.length!==pids.length||observed.some(pid=>!pids.includes(pid)))fail('QA trace PID inventory changed after writer observation');
  return records;
}
async function execute(command,args,{cwd=root,env=process.env,timeoutMs=600000,capture=false}={}){
  return new Promise((resolve,reject)=>{
    let output='',settled=false;
    const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:capture?['ignore','pipe','pipe']:'inherit'});
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(output.trim());};
    const timer=setTimeout(()=>{child.kill();finish(Error('Bounded QA child process timed out; runner will retain evidence'));},timeoutMs);
    if(capture)for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;if(output.length>32768){child.kill();finish(Error('Bounded QA command output exceeded'));}});
    child.once('error',finish);child.once('exit',(code,signal)=>finish(code===0?null:Error(`QA child failed (${signal??code})`)));
  });
}
const sourceRequest={repository:'nea-c/Nearly',commit:SOURCE.sourceCommit,tag:'r3.1',version:'3.1.0',workflowCommit:SOURCE.sourceCommit,runId:SOURCE.sourceRunId,runAttempt:SOURCE.sourceRunAttempt,mode:'release'};
export function validatePinnedArtifact(artifact,repositoryId){return validateArtifact(artifact,sourceRequest,{id:SOURCE.artifactId,role:'signed',digest:SOURCE.zipSha256,repositoryId});}
async function api(suffix,token){const response=await fetch(`https://api.github.com/repos/nea-c/Nearly${suffix}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok){const error=Error(`Pinned GitHub source unavailable (HTTP ${response.status}; no fallback)`);if([404,410].includes(response.status))error.code='PINNED_SOURCE_UNAVAILABLE';throw error;}return response.json();}
export async function readProductionAsset(asset,token,transport=fetch){
  if(!token||!PRODUCTION_RELEASE.assets.some(a=>a.id===asset?.id&&a.name===asset.name&&a.bytes===asset.bytes&&a.sha256===asset.sha256))fail('Exact historical asset and read-only authentication required');
  let response=await transport(`https://api.github.com/repos/nea-c/Nearly/releases/assets/${asset.id}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/octet-stream','X-GitHub-Api-Version':'2022-11-28'},redirect:'manual',signal:AbortSignal.timeout(60000)});
  if(response.status===302){
    let location;try{location=new URL(response.headers.get('location'));}catch{fail('Historical asset redirect invalid');}
    if(location.protocol!=='https:'||location.username||location.password||location.hostname!=='release-assets.githubusercontent.com')fail('Historical asset redirect refused');
    // GitHub's API token never reaches the release object storage host.
    response=await transport(location.href,{redirect:'error',signal:AbortSignal.timeout(120000)});
  }
  if(response.status!==200||!response.body)fail('Historical release asset unavailable; no alternate source');
  const length=response.headers.get('content-length');
  if(length!==null&&Number(length)!==asset.bytes)fail('Historical asset length mismatch');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>asset.bytes)fail('Historical asset exceeds exact bound');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(size!==asset.bytes||hash(bytes)!==asset.sha256)fail('Historical asset bytes mismatch');
  return bytes;
}
async function downloadProductionRelease(p,token){
  // The original signed manifest was pinned before the Actions ZIP expired.
  // Retain its exact bytes and all existing signature/provenance validation.
  const manifest=await regular(path.join(root,'tests/fixtures/installer-qa-r31-signed-manifest.json'),131072);
  if(hash(manifest)!==SOURCE.manifestHash)fail('Historical manifest pin mismatch');
  const [release,commit]=await Promise.all([api(`/releases/${PRODUCTION_RELEASE.id}`,token),api('/commits/r3.1',token)]);
  const assets=validateProductionRelease(release,commit),signed=path.join(p.runRoot,'signed');
  await fs.mkdir(signed);
  for(const asset of assets)await fs.writeFile(path.join(signed,asset.name),await readProductionAsset(asset,token),{flag:'wx'});
  await fs.writeFile(path.join(signed,'signed-manifest.json'),manifest,{flag:'wx'});
}
function cleanChildEnv(e){const result={...e};for(const key of Object.keys(result))if(/^(?:GH_TOKEN|GITHUB_TOKEN|TAURI_(?:SIGNING_|PRIVATE_KEY|WINDOWS_CERTIFICATE)|NEARLY_QA_)/.test(key))delete result[key];return result;}
export function fixtureBuildPaths(p,version){
  if(![p.sourceVersion,p.targetVersion].includes(version))fail('Unexpected fixture build version');
  return {sourceDir:path.win32.join(p.runRoot,`source-${version}`),targetDir:path.win32.join(p.runRoot,'build-target'),setupPath:path.win32.join(p.runRoot,'fixture-installers',`Nearly_${version}_x64-setup.exe`)};
}
export function copyFixturePath(relative){
  const parts=relative.split(/[\\/]/);
  // Exclude only workspace outputs. Packages contain executable JS in nested
  // dist/build directories, which must remain intact in each source copy.
  return !['.git','build','dist','.test-build','.superpowers','.agents','.codex','.aws','.ssh','test-results','playwright-report'].includes(parts[0])&&!(parts[0]==='src-tauri'&&parts[1]==='target');
}
export function instrumentCandidatePolicyDiagnostics(template){
  // Standard NSIS has no private-leaf helper protocol to instrument. Qualify
  // the exact product template without adding failure-only modal behavior.
  if(typeof template!=='string'||template.length>262144||!template.includes('Function NearlyDirectoryLeave')||!template.includes('RequestExecutionLevel user')||/NEARLY_QA_POLICY_|NearlyEnsurePolicyHelper|--nearly-install-(?:check|prepare)/.test(template))fail('Unexpected standard installer template');
  return template;
}

async function buildFixture(p,version,signer,token,baseEnv){
  const paths=fixtureBuildPaths(p,version),dir=paths.sourceDir;
  await fs.cp(root,dir,{recursive:true,errorOnExist:true,force:false,filter:src=>copyFixturePath(path.relative(root,src))});
  const template=path.join(dir,'src-tauri/windows/installer.nsi');
  await fs.writeFile(template,instrumentCandidatePolicyDiagnostics(await fs.readFile(template,'utf8')));
  await fs.writeFile(path.join(dir,'version.json'),JSON.stringify({version})+'\n');
  const env={...baseEnv,NEARLY_QA_BUILD_TOKEN:token,NEARLY_QA_CONTROLLER_SHA:p.controllerSha,NEARLY_QA_PUBLIC_KEY:signer.publicRaw.toString('base64'),CARGO_TARGET_DIR:paths.targetDir};
  await execute(process.execPath,['scripts/sync-version.mjs'],{cwd:dir,env});
  const cli=path.join(dir,'node_modules/@tauri-apps/cli/tauri.js');
  await execute(process.execPath,[cli,'build','--no-bundle','--features','installer-qa','--ci','--no-sign','--','--offline','--locked'],{cwd:dir,env,timeoutMs:3600000});
  await execute(process.execPath,[cli,'bundle','--bundles','nsis','--no-binary-patching','--no-sign','--ci'],{cwd:dir,env,timeoutMs:300000});
  const payload=await regular(path.join(env.CARGO_TARGET_DIR,'release/Nearly.exe'));
  if(!payload.includes(Buffer.from(qaBinaryMarker)))throw Error('QA build marker missing; refusing ambiguous fixture');
  const setupBytes=await regular(path.join(env.CARGO_TARGET_DIR,'release/bundle/nsis',`Nearly_${version}_x64-setup.exe`));
  // Snapshot the exact setup before the next sequential build reuses this target
  // tree. Never rely on the loose Nearly.exe after the next version is compiled.
  await fs.mkdir(path.dirname(paths.setupPath),{recursive:true});
  await fs.writeFile(paths.setupPath,setupBytes,{flag:'wx'});
  return {setup:paths.setupPath,payloadSha256:hash(payload)};
}
export function settingsFixture(){
  const columns={order:['name','size','type','modified','permissions','owner'],hidden:['permissions','owner'],widths:{name:280,size:100,type:100,modified:180,permissions:120,owner:120}};
  const tree={version:1,nodes:[]},sort={column:'name',direction:'ascending'};
  const aggregate={schemaVersion:1,revision:1,connections:{profiles:[],history:{},tree},appearance:{theme:'dark',language:'en',compactExplorer:false,localPaneRatio:0.5,localTreeRatio:0.3,remoteTreeRatio:0.3},explorer:{localBookmarks:[],remoteBookmarks:[],folderBookmarks:[],folderPairHistory:[],paneColumns:{local:columns,remote:columns},bookmarkTree:tree},browse:{browseLocations:{},paneSorts:{local:sort,remote:sort}},sync:{exclusions:{},syncOptions:{},syncPresets:[],retainedSyncs:[]},trust:{version:1,pins:{}}};
  const files=packSettings(aggregate);
  // Metadata is deliberately opaque to app writes and provides preservation evidence.
  for(const name of settingsNames){const v=JSON.parse(files[name]);v.metadata={installerQa:'generated-offline-fixture'};files[name]=JSON.stringify(v,null,2);}
  const s=JSON.parse(files['settings.json']);for(const n of settingsNames.slice(1))s.manifest[n].sha256=hash(files[n]);files['settings.json']=JSON.stringify(s,null,2);
  return files;
}
function guestRunner(p,baseEnv){
  const guest=path.join(root,'scripts/installer-qa-guest.ps1');
  const launcher=path.join(root,'scripts/installer-qa-standard-user.ps1');
  return async(action,args=[],env=baseEnv)=>execute('pwsh',['-NoProfile','-NonInteractive','-File',launcher,'-GuestScript',guest,'-GuestArgumentsBase64',Buffer.from(JSON.stringify(['-Action',action,'-RunRoot',p.runRoot,...args])).toString('base64'),'-TimeoutSeconds','300'],{env,timeoutMs:320000});
}
export async function preflight(e=process.env){
  const c=validateContext(e),destination=validateDestination(e.QA_DESTINATION);validateScenario(e.QA_SCENARIO);
  return guestRunner(createPlan(c,destination),cleanChildEnv(e))('preflight');
}
export async function guardProbe(e=process.env){
  const c=validateContext(e),destination=validateDestination(e.QA_DESTINATION);validateScenario(e.QA_SCENARIO);
  const nsis=await requireCachedTools(e.LOCALAPPDATA);
  return guestRunner(createPlan(c,destination),{...cleanChildEnv(e),NEARLY_NSIS_READONLY_QA:'1',NEARLY_NSIS_REQUIRE_PRIVATE_TEMP:'1',NEARLY_NSIS_ROOT:nsis})('guard-probe');
}
export async function production(e=process.env){
  const c=validateContext(e),scenario=validateScenario(e.QA_SCENARIO),destination=validateDestination(e.QA_DESTINATION);
  if(scenario!=='success'||destination!=='default')fail('Signed production regression requires its own default guest');
  const p=createPlan(c,destination),baseEnv=cleanChildEnv(e),ps=guestRunner(p,baseEnv);validatePlan(p,c,destination);
  await ps('preflight');await fs.mkdir(p.runRoot);await fs.writeFile(path.join(p.runRoot,'plan.json'),canonical(p),{flag:'wx'});
  const cases=[];
  try{
    if(await execute('git',['rev-parse','HEAD'],{capture:true,env:baseEnv})!==c.controllerSha)fail('Checkout differs from reviewed controller');
    await loadTrustedPublicKey(root);await downloadProductionRelease(p,e.GH_TOKEN);
    const signed=path.join(p.runRoot,'signed'),manifest=JSON.parse(await regular(path.join(signed,'signed-manifest.json'),131072));
    const checked=await verifySignedBundle(signed,sourceRequest,{manifestHash:SOURCE.manifestHash,unsignedArtifactId:manifest.unsignedArtifactId,unsignedManifestHash:manifest.unsignedManifestHash,toolArtifactId:manifest.toolArtifactId,toolManifestHash:manifest.toolManifestHash});
    if(checked.assets[0].sha256!==SOURCE.installerSha256)fail('Pinned production installer mismatch');
    await fs.mkdir(path.join(p.runRoot,'settings'));
    for(const [name,bytes]of Object.entries(settingsFixture()))await fs.writeFile(path.join(p.runRoot,'settings',name),bytes,{flag:'wx'});
    await ps('production',['-Setup',path.join(signed,'Nearly_r3.1_x64-setup.exe'),'-ExpectedPayload',manifest.payloadSha256]);
    cases.push({case:'signed-production-setup-uninstall',passed:true});
    await fs.writeFile(path.join(p.runRoot,'qa-summary.json'),canonical({schemaVersion:2,controllerSha:c.controllerSha,scenario,destinationKind:destination,passed:true,cases}),{flag:'wx'});
    console.log('Signed production setup/reinstall/uninstall: all four shortcut choices and generated settings preservation passed.');
  }catch(error){
    cases.push({case:'signed-production-setup-uninstall',passed:false});
    await fs.writeFile(path.join(p.runRoot,'qa-summary.json'),canonical({schemaVersion:2,controllerSha:c.controllerSha,scenario,destinationKind:destination,passed:false,cases}),{flag:'wx'});throw error;
  }
}
export async function run(e=process.env){
  const c=validateContext(e),scenario=validateScenario(e.QA_SCENARIO),destination=validateDestination(e.QA_DESTINATION),p=createPlan(c,destination);validatePlan(p,c,destination);
  const baseEnv=cleanChildEnv(e),ps=guestRunner(p,baseEnv);
  // Preflight checks canonical/reparse-free ancestry and absence before any run-root write.
  await ps('preflight');await fs.mkdir(p.runRoot);await fs.writeFile(path.join(p.runRoot,'plan.json'),canonical(p),{flag:'wx'});
  const results=[];
  try{
    if(await execute('git',['rev-parse','HEAD'],{capture:true,env:baseEnv})!==c.controllerSha)fail('Checkout differs from reviewed controller');
    await loadTrustedPublicKey(root);await requireCachedTools(e.LOCALAPPDATA);
    await fs.mkdir(path.join(p.runRoot,'settings'));
    for(const [name,bytes]of Object.entries(settingsFixture()))await fs.writeFile(path.join(p.runRoot,'settings',name),bytes,{flag:'wx'});
    const signer=createFixtureSigner(),token=randomBytes(32).toString('hex');
    const source=await buildFixture(p,p.sourceVersion,signer,token,baseEnv),target=await buildFixture(p,p.targetVersion,signer,token,baseEnv);
    const targetBytes=await regular(target.setup),signature=signer.sign(targetBytes,target.payloadSha256);
    await fs.writeFile(path.join(p.runRoot,'Nearly_r2.0_x64-setup.exe'),targetBytes,{flag:'wx'});
    await fs.writeFile(path.join(p.runRoot,'Nearly_r2.0_x64-setup.exe.sig'),signature,{flag:'wx'});
    await fs.writeFile(path.join(p.runRoot,'authorization.json'),canonical({schemaVersion:2,destinationKind:destination,runId:c.runId,runAttempt:c.runAttempt,controllerSha:c.controllerSha,token,sourceVersion:'1.9.0',targetVersion:'2.0.0',targetFile:'Nearly_r2.0_x64-setup.exe',targetSha256:hash(targetBytes),targetBytes:targetBytes.length,payloadSha256:target.payloadSha256,signatureFile:'Nearly_r2.0_x64-setup.exe.sig'}),{flag:'wx'});
    const fixtureEnv={...baseEnv,NEARLY_QA_TOKEN:token,NEARLY_QA_RUN_ROOT:p.runRoot,NEARLY_QA_SCENARIO:scenario};
    for(const choice of uiCases()){
      await ps('ui',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256,'-Language',choice.language,'-Start',String(choice.start),'-Desktop',String(choice.desktop),'-CaseName',choice.name],fixtureEnv);
      results.push({case:`candidate-ui-${choice.name}`,passed:true});
    }
    for(const language of ['en','ja']){
      await ps('ui',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256,'-Language',language,'-CaseName',`${language}-cancel`,'-UiMode','Cancel'],fixtureEnv);
      results.push({case:`candidate-ui-${language}-cancel`,passed:true});
    }
    if(destination==='drive'||destination==='drive-c'){
      await ps('drive',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256],fixtureEnv);results.push({case:'drive-ordinary-install-and-content-refusal',passed:true});
    }
    await ps('uninstall-options',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256],fixtureEnv);
    results.push({case:'whole-folder-default-off-decline-and-remove',passed:true});
    {
      const env={...baseEnv,NEARLY_QA_TOKEN:token,NEARLY_QA_RUN_ROOT:p.runRoot,NEARLY_QA_SCENARIO:scenario};
      await ps('source',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256],env);
      await ps('launch',[],env);
      const outcome=await waitForOutcome(path.join(p.runRoot,`outcome-${scenario}.json`),scenario,{destination});
      console.log(`Validated native QA outcome: phase=${outcome.phase} version=${outcome.version}`);
      await ps('verify',['-ExpectedPayload',scenario==='success'?target.payloadSha256:source.payloadSha256,'-ExpectedVersion',outcome.version],env);
      const proof=validateCausalProof(await closedQaTraces(p.runRoot,env),scenario);
      console.log('QA causal proof: '+JSON.stringify(proof));
      await ps('uninstall',[],env);results.push({case:scenario,passed:true,outcome});
    }
    await fs.writeFile(path.join(p.runRoot,'results.json'),canonical({schemaVersion:2,controllerSha:c.controllerSha,scenario,destination,source:SOURCE,passed:true,cases:results}),{flag:'wx'});
    if(e.GITHUB_STEP_SUMMARY)await fs.appendFile(e.GITHUB_STEP_SUMMARY,formatSummary(scenario,destination));
    await fs.writeFile(path.join(p.runRoot,'qa-summary.json'),canonical({schemaVersion:2,controllerSha:c.controllerSha,scenario,destinationKind:destination,passed:true,cases:results.map(({case:caseName,passed})=>({case:caseName,passed}))}),{flag:'wx'});
  }catch(error){
    for(const record of await collectQaTraces(p.runRoot))console.log('QA trace: '+JSON.stringify(record));
    await fs.writeFile(path.join(p.runRoot,'qa-summary.json'),canonical({schemaVersion:2,controllerSha:c.controllerSha,scenario,destinationKind:destination,passed:false,cases:results.map(({case:caseName,passed})=>({case:caseName,passed}))}),{flag:'wx'});
    await fs.writeFile(path.join(p.runRoot,'results.json'),canonical({schemaVersion:2,scenario,destination,passed:false,cases:results,error:String(error.message).slice(0,2048)}),{flag:'wx'});throw error;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3||!['run','production','preflight','guard-probe'].includes(process.argv[2])){console.error('Only manually authorized hosted guest commands are supported');process.exitCode=1;}
  else (process.argv[2]==='preflight'?preflight():process.argv[2]==='guard-probe'?guardProbe():process.argv[2]==='production'?production():run()).catch(error=>{console.error(error.message);process.exitCode=1;});
}
