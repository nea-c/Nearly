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
export const SOURCE=Object.freeze({sourceCommit:'b56f01ddff9698ef316dfa775c1e8a441965674f',artifactId:'12158897824',sourceRunId:'39185149137',sourceRunAttempt:'1',zipSha256:'e8baf6d70cdfe9278e8ad162d75c989a434226cec9da04b62b9a691895ec9526',installerSha256:'71d2163d75489a1845d46291b3b046d381e619e0748d75216c83accc92e9fcc5',manifestHash:'9c6d56d8ae841dec48a56cbb07b3585fc0326173ddd60ef32b8d6890a80d2866'});
function canonicalWindows(value){
  if(typeof value!=='string'||!exact(/[A-Za-z]:\\[^\x00-\x1f<>"|?*]+/,value)||value.slice(2).includes(':')||value.includes('/')||value.split('\\').some(x=>x==='.'||x==='..'||/[. ]$/.test(x))||path.win32.normalize(value)!==value)fail('Canonical local Windows path required');
  return value;
}
export function validateContext(e,platform=process.platform){
  const fixed={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',RUNNER_OS:'Windows',RUNNER_ENVIRONMENT:'github-hosted'};
  if(platform!=='win32'||Object.hasOwn(e,'SYNCFILES_CONFIG_DIR')||Object.entries(fixed).some(([k,v])=>e[k]!==v))fail('Manual fresh GitHub-hosted Windows guest required');
  const sha=e.QA_CONTROLLER_SHA;
  if(!exact(/[a-f0-9]{40}/,sha)||e.GITHUB_SHA!==sha||e.GITHUB_WORKFLOW_SHA!==sha||e.QA_CONFIRMATION!==`installer-qa ${sha}`)fail('Exact controller SHA and installer-qa confirmation required');
  for(const k of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])if(!exact(/[1-9][0-9]*/,e[k])||!Number.isSafeInteger(Number(e[k])))fail('Canonical run identity required');
  return Object.freeze({controllerSha:sha,runId:e.GITHUB_RUN_ID,runAttempt:e.GITHUB_RUN_ATTEMPT,runnerTemp:canonicalWindows(e.RUNNER_TEMP),localAppData:canonicalWindows(e.LOCALAPPDATA)});
}
export function validateDestination(value){if(!['default','custom'].includes(value))fail('Select exactly one QA_DESTINATION for this fresh guest');return value;}
export function createPlan(c,destinationKind='default'){
  validateDestination(destinationKind);
  const leaf=`Nearly Installer QA ${c.runId}-${c.runAttempt}`,destinations={default:path.win32.join(c.localAppData,'Nearly'),custom:path.win32.join(c.localAppData,leaf,'日本語 space','Nearly'),drive:path.win32.join('D:\\',`Nearly QA 日本語 ${c.runId}-${c.runAttempt}`)};
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
  return `Installer QA (${scenario}, ${destination}): signed production setup/uninstall, eight English/Japanese candidate UI choices, cancellation/back navigation and ${lifecycle} passed. QA fixtures remain only on this ephemeral runner; nothing published.\n`;
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
  peerObservation:['pathQueryFailed','exitAfterPathFailure','pathFailureStillLive','identityQueryFailed'],
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
const sourceRequest={repository:'nea-c/Nearly',commit:SOURCE.sourceCommit,tag:'r2.0',version:'2.0.0',workflowCommit:SOURCE.sourceCommit,runId:SOURCE.sourceRunId,runAttempt:SOURCE.sourceRunAttempt,mode:'verify-signature'};
export function validatePinnedArtifact(artifact,repositoryId){return validateArtifact(artifact,sourceRequest,{id:SOURCE.artifactId,role:'signed',digest:SOURCE.zipSha256,repositoryId});}
async function api(suffix,token){const response=await fetch(`https://api.github.com/repos/nea-c/Nearly${suffix}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)fail('Pinned GitHub source unavailable (expired/deleted artifacts have no fallback)');return response.json();}
async function downloadSigned(p,token){
  if(!token)fail('Read-only GitHub artifact access required');
  const [repo,artifact,run]=await Promise.all([api('',token),api(`/actions/artifacts/${SOURCE.artifactId}`,token),api(`/actions/runs/${SOURCE.sourceRunId}/attempts/${SOURCE.sourceRunAttempt}`,token)]);
  validatePinnedArtifact(artifact,repo.id);
  if(run.id!==Number(SOURCE.sourceRunId)||run.run_attempt!==1||run.head_sha!==SOURCE.sourceCommit||run.event!=='workflow_dispatch'||run.status!=='completed'||run.conclusion!=='success'||run.path!=='.github/workflows/release-signed-windows.yml')fail('Historical signed workflow source mismatch');
  const redirect=await fetch(`https://api.github.com/repos/nea-c/Nearly/actions/artifacts/${SOURCE.artifactId}/zip`,{headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(redirect.status!==302)fail('Pinned signed ZIP unavailable; no fallback');
  const location=new URL(redirect.headers.get('location'));
  if(location.protocol!=='https:'||location.username||location.password)fail('Unsafe artifact redirect');
  // Never forward the API token to artifact object storage.
  const response=await fetch(location,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok||Number(response.headers.get('content-length'))>512*1024*1024)fail('Artifact download unavailable/oversized');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>512*1024*1024)fail('Artifact download oversized');chunks.push(chunk);}
  const zip=Buffer.concat(chunks);if(hash(zip)!==SOURCE.zipSha256)fail('Pinned signed ZIP checksum mismatch');
  await fs.writeFile(path.join(p.runRoot,'signed.zip'),zip,{flag:'wx'});
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
async function buildFixture(p,version,signer,token,baseEnv){
  const paths=fixtureBuildPaths(p,version),dir=paths.sourceDir;
  await fs.cp(root,dir,{recursive:true,errorOnExist:true,force:false,filter:src=>copyFixturePath(path.relative(root,src))});
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
export async function run(e=process.env){
  const c=validateContext(e),scenario=validateScenario(e.QA_SCENARIO),destination=validateDestination(e.QA_DESTINATION),p=createPlan(c,destination);validatePlan(p,c,destination);
  const guest=path.join(root,'scripts/installer-qa-guest.ps1'),baseEnv=cleanChildEnv(e);
  const ps=async(action,args=[],env=baseEnv)=>execute('pwsh',['-NoProfile','-NonInteractive','-File',guest,'-Action',action,'-RunRoot',p.runRoot,...args],{env,timeoutMs:300000});
  // Preflight checks canonical/reparse-free ancestry and absence before any run-root write.
  await ps('preflight');await fs.mkdir(p.runRoot);await fs.writeFile(path.join(p.runRoot,'plan.json'),canonical(p),{flag:'wx'});
  const results=[];
  try{
    if(await execute('git',['rev-parse','HEAD'],{capture:true,env:baseEnv})!==c.controllerSha)fail('Checkout differs from reviewed controller');
    await loadTrustedPublicKey(root);await requireCachedTools(e.LOCALAPPDATA);
    await downloadSigned(p,e.GH_TOKEN);await ps('extract');
    const signed=path.join(p.runRoot,'signed'),manifest=JSON.parse(await regular(path.join(signed,'signed-manifest.json'),131072));
    const checked=await verifySignedBundle(signed,sourceRequest,{manifestHash:SOURCE.manifestHash,unsignedArtifactId:manifest.unsignedArtifactId,unsignedManifestHash:manifest.unsignedManifestHash,toolArtifactId:manifest.toolArtifactId,toolManifestHash:manifest.toolManifestHash});
    if(checked.assets[0].sha256!==SOURCE.installerSha256)fail('Pinned production installer mismatch');
    await fs.mkdir(path.join(p.runRoot,'settings'));
    for(const [name,bytes]of Object.entries(settingsFixture()))await fs.writeFile(path.join(p.runRoot,'settings',name),bytes,{flag:'wx'});
    await ps('production',['-Setup',path.join(signed,'Nearly_r2.0_x64-setup.exe'),'-ExpectedPayload',manifest.payloadSha256]);results.push({case:'signed-production-setup-uninstall',passed:true});
    console.log('Signed production setup/reinstall/uninstall: all four shortcut choices and generated settings preservation passed.');
    const signer=createFixtureSigner(),token=randomBytes(32).toString('hex');
    const source=await buildFixture(p,p.sourceVersion,signer,token,baseEnv),target=await buildFixture(p,p.targetVersion,signer,token,baseEnv);
    const targetBytes=await regular(target.setup),signature=signer.sign(targetBytes,target.payloadSha256);
    await fs.writeFile(path.join(p.runRoot,'Nearly_r2.0_x64-setup.exe'),targetBytes,{flag:'wx'});
    await fs.writeFile(path.join(p.runRoot,'Nearly_r2.0_x64-setup.exe.sig'),signature,{flag:'wx'});
    await fs.writeFile(path.join(p.runRoot,'authorization.json'),canonical({schemaVersion:2,destinationKind:destination,runId:c.runId,runAttempt:c.runAttempt,controllerSha:c.controllerSha,token,sourceVersion:'1.9.0',targetVersion:'2.0.0',targetFile:'Nearly_r2.0_x64-setup.exe',targetSha256:hash(targetBytes),targetBytes:targetBytes.length,payloadSha256:target.payloadSha256,signatureFile:'Nearly_r2.0_x64-setup.exe.sig'}),{flag:'wx'});
    for(const choice of uiCases()){
      await ps('ui',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256,'-Language',choice.language,'-Start',String(choice.start),'-Desktop',String(choice.desktop),'-CaseName',choice.name]);
      results.push({case:`candidate-ui-${choice.name}`,passed:true});
    }
    for(const language of ['en','ja']){
      await ps('ui',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256,'-Language',language,'-CaseName',`${language}-cancel`,'-UiMode','Cancel']);
      results.push({case:`candidate-ui-${language}-cancel`,passed:true});
    }
    await ps('drive',['-Setup',source.setup,'-ExpectedPayload',source.payloadSha256]);results.push({case:'drive-destination-boundary',passed:true});
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
  if(process.argv.length!==3||process.argv[2]!=='run'){console.error('Only the manually authorized hosted guest run command is supported');process.exitCode=1;}
  else run().catch(error=>{console.error(error.message);process.exitCode=1;});
}
