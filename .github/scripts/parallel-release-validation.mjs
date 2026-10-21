import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {auditSource} from './release-contract.mjs';
import {createUnsignedBundle} from './signed-release-contract.mjs';
const control=fileURLToPath(new URL('../../',import.meta.url));
export function validationRequest(env,version){
  const oid=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
  if(env.GITHUB_REPOSITORY!=='nea-c/Nearly'||env.GITHUB_EVENT_NAME!=='pull_request'||!/^refs\/pull\/[1-9][0-9]*\/merge$/.test(env.GITHUB_REF||'')||env.GITHUB_WORKFLOW_REF!==`nea-c/Nearly/.github/workflows/parallel-release-validation.yml@${env.GITHUB_REF}`||env.VALIDATION_HEAD_REPOSITORY!=='nea-c/Nearly'||env.VALIDATION_HEAD_BRANCH!=='codex/parallel-release-ui-local'||env.RELEASE_MODE!=='validate'||env.RELEASE_CONFIRM!==''||!oid(env.RELEASE_COMMIT)||!oid(env.GITHUB_WORKFLOW_SHA)||![env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT].every(v=>/^[1-9][0-9]*$/.test(v||'')))throw Error('Only exact same-repository parallel-build PR validation is allowed');
  const parts=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.0$/.exec(version);
  if(!parts||env.RELEASE_TAG!==`r${parts[1]}.${parts[2]}`)throw Error('Validation source version mismatch');
  return {repository:'nea-c/Nearly',commit:env.RELEASE_COMMIT,tag:env.RELEASE_TAG,version,mode:'validate',workflowCommit:env.GITHUB_WORKFLOW_SHA,runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT};
}
export async function main(args,env=process.env){
  const r=validationRequest(env,JSON.parse(await fs.readFile(path.join(control,'version.json'),'utf8')).version);
  const git=(...args)=>execFileSync('git',['-C',control,...args],{encoding:'utf8',windowsHide:true}).trim();
  if(git('rev-parse','HEAD')!==r.workflowCommit||git('status','--porcelain','--untracked-files=all'))throw Error('Validation controller changed');
  const [command,source,output]=args;
  if(command==='context'){console.log(JSON.stringify(r));return;}
  if(!['preflight','package'].includes(command))throw Error('No signing or publication operation is supported');
  const root=path.resolve(source),tree=await auditSource(root,r,{profile:'registered-production'});
  if(command==='package'){
    if(!env.CARGO_TARGET_DIR||!output)throw Error('Owned build target and validation output required');
    const result=await createUnsignedBundle(root,path.resolve(output),r,{tree,payloadPath:path.join(env.CARGO_TARGET_DIR,'release/Nearly.exe')});
    if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,`manifest-sha256=${result.manifestHash}\n`);
    // JSON metadata only. Binaries remain on the disposable guest, never uploaded.
    const manifest=JSON.parse(await fs.readFile(path.join(path.resolve(output),'unsigned-manifest.json'),'utf8'));
    console.log(JSON.stringify({sourceCommit:r.commit,controllerCommit:r.workflowCommit,sourceTree:tree,manifestSha256:result.manifestHash,installerSha256:manifest.assets[0].sha256,payloadSha256:manifest.payload.sha256,mode:'validate'}));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
