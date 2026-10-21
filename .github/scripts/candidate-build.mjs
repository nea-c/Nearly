import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {assertSafeSourcePath,auditGitObjects,verifyVersionAndGates} from './release-contract.mjs';
import {createUnsignedBundle} from './signed-release-contract.mjs';

const control=fileURLToPath(new URL('../../',import.meta.url));
const publicBase='f93745aa6030f0c2b0a54d490cda0cdb143c2e6e';
const candidateRef='refs/heads/codex/r33-candidate';
const exact=(re,value)=>typeof value==='string'&&re.exec(value)?.[0]===value;
const oid=value=>exact(/[a-f0-9]{40}/,value);
const identity=value=>exact(/[1-9][0-9]*/,value)&&Number.isSafeInteger(Number(value));
const git=(root,args,options={})=>execFileSync('git',['-C',root,...args],{maxBuffer:128*1024*1024,windowsHide:true,...options});

export function candidateRequest(env,version){
  if(env.GITHUB_REPOSITORY!=='nea-c/Nearly'||!['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)||env.GITHUB_REF!==candidateRef||env.GITHUB_WORKFLOW_REF!==`nea-c/Nearly/.github/workflows/candidate-windows.yml@${candidateRef}`||!oid(env.CANDIDATE_SHA)||env.GITHUB_SHA!==env.CANDIDATE_SHA||env.GITHUB_WORKFLOW_SHA!==env.CANDIDATE_SHA||![env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT].every(identity))throw Error('Exact official candidate branch, workflow, source SHA and run identity required');
  if(env.RELEASE_COMMIT!==undefined&&env.RELEASE_COMMIT!==env.CANDIDATE_SHA)throw Error('Candidate release commit must match its exact source SHA');
  if(version!=='3.3.0'||env.RELEASE_TAG!=='r3.3'||![undefined,'validate'].includes(env.RELEASE_MODE)||![undefined,''].includes(env.RELEASE_CONFIRM))throw Error('Only unsigned r3.3 candidate validation is supported');
  return {repository:'nea-c/Nearly',commit:env.CANDIDATE_SHA,tag:'r3.3',version:'3.3.0',mode:'validate',workflowCommit:env.GITHUB_WORKFLOW_SHA,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT};
}

export async function auditCandidateSource(root,request,runGit=git){
  if(runGit(root,['rev-parse','HEAD']).toString().trim()!==request.commit||runGit(root,['status','--porcelain','--untracked-files=all']).length)throw Error('Candidate source checkout is not clean at the exact requested commit');
  // Candidate work is allowed beyond main; its complete public baseline must
  // still exist as a commit and precede the requested candidate source.
  runGit(root,['cat-file','-e',`${publicBase}^{commit}`]);
  runGit(root,['merge-base','--is-ancestor',publicBase,request.commit]);
  await verifyVersionAndGates(root,request,{profile:'registered-production'});
  const names=runGit(root,['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
  for(const name of names)assertSafeSourcePath(name);
  const identities=runGit(root,['log','--format=%ae%n%ce',request.commit]).toString('utf8').trim().split(/\r?\n/);
  if(identities.some((email,index)=>!exact(/[a-zA-Z0-9+_.-]+@users\.noreply\.github\.com/,email)&&!(index%2===1&&email==='noreply@github.com')))throw Error('History uses a non-public commit email; review it before building');
  const objects=runGit(root,['rev-list','--objects',request.commit]).toString('utf8').trim().split('\n');
  if(objects.length>100000)throw Error('History audit object budget exceeded');
  for(const line of objects){const separator=line.indexOf(' ');if(separator>=0&&line.slice(separator+1))assertSafeSourcePath(line.slice(separator+1));}
  const input=objects.map(line=>line.split(' ')[0]).join('\n')+'\n';
  auditGitObjects(runGit(root,['cat-file','--batch'],{input}));
  return runGit(root,['rev-parse','HEAD^{tree}']).toString('utf8').trim();
}

export async function main(args,env=process.env){
  const request=candidateRequest(env,JSON.parse(await fs.readFile(path.join(control,'version.json'),'utf8')).version);
  if(git(control,['rev-parse','HEAD']).toString().trim()!==request.workflowCommit||git(control,['status','--porcelain','--untracked-files=all']).length)throw Error('Candidate controller changed');
  const [command,source,output]=args;
  if(command==='context'&&args.length===1){console.log(JSON.stringify(request));return;}
  if(!['preflight','package'].includes(command)||!source||args.length!==(command==='package'?3:2))throw Error('Only candidate context, preflight and unsigned package commands are supported');
  const sourceRoot=path.resolve(source),tree=await auditCandidateSource(sourceRoot,request);
  const outputs={'source-commit':request.commit,'source-tree':tree};
  if(command==='package'){
    if(!env.CARGO_TARGET_DIR||!path.isAbsolute(env.CARGO_TARGET_DIR)||!output)throw Error('Owned absolute Cargo target and candidate output required');
    const result=await createUnsignedBundle(sourceRoot,path.resolve(output),request,{tree,payloadPath:path.join(env.CARGO_TARGET_DIR,'release/Nearly.exe')});
    outputs['manifest-sha256']=result.manifestHash;
    const manifest=JSON.parse(await fs.readFile(path.join(path.resolve(output),'unsigned-manifest.json'),'utf8'));
    console.log(JSON.stringify({sourceCommit:request.commit,sourceTree:tree,controllerCommit:request.workflowCommit,manifestSha256:result.manifestHash,installerSha256:manifest.assets[0].sha256,payloadSha256:manifest.payload.sha256,mode:'validate'}));
  }
  if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,Object.entries(outputs).map(([key,value])=>`${key}=${value}\n`).join(''));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
