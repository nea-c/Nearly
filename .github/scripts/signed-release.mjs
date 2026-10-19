import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditSource} from './release-contract.mjs';
import {githubApi,downloadPublic,publishSignedRelease} from './release-publish.mjs';
import {loadTrustedPublicKey} from './release-trust.mjs';
import {parseSignedRequest,validateArtifact,identity,digest,createUnsignedBundle,createSigningPlan,createSignedBundle,verifySignedBundle} from './signed-release-contract.mjs';
import {collectToolInputs,createToolBundle,verifyToolBundle} from './signed-tool-contract.mjs';
import {verifySigningPolicy,validateWorkflowRun} from './signed-release-policy.mjs';
const control=fileURLToPath(new URL('../../',import.meta.url));
export async function main(args,env=process.env){
  const r=parseSignedRequest(env),[command,first,second]=args;
  if(command==='publish'&&r.mode!=='release')throw Error('Only release mode may invoke publication');
  const output=async values=>{if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));};
  const api=()=>githubApi(env.GH_TOKEN);
  async function artifact(role,id,zipDigest){
    if(!identity(id)||!digest(zipDigest))throw Error('Exact producer artifact ID/digest required');
    const a=api(),repo=await a.get(''),run=await a.get(`/actions/runs/${r.runId}/attempts/${r.runAttempt}`);validateWorkflowRun(run,r);
    validateArtifact(await a.get(`/actions/artifacts/${id}`),r,{id,role,digest:zipDigest,repositoryId:repo.id});
  }
  const unsigned=()=>({manifestHash:env.UNSIGNED_MANIFEST_SHA256,artifactId:env.UNSIGNED_ARTIFACT_ID});
  const signed=()=>({manifestHash:env.SIGNED_MANIFEST_SHA256,unsignedArtifactId:env.UNSIGNED_ARTIFACT_ID,unsignedManifestHash:env.UNSIGNED_MANIFEST_SHA256,toolArtifactId:env.TOOL_ARTIFACT_ID,toolManifestHash:env.TOOL_MANIFEST_SHA256});
  if(command==='policy'){
    await loadTrustedPublicKey(control);await collectToolInputs(control,r);
    const checked=await verifySigningPolicy(r,api());validateWorkflowRun(await api().get(`/actions/runs/${r.runId}/attempts/${r.runAttempt}`),r);
    await output({'repository-id':checked.repositoryId});
    if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,`Manual signed workflow (${r.mode}): ${r.tag}, source ${r.commit}, controller ${r.workflowCommit}, run ${r.runId}/${r.runAttempt}. Signing requires the nea-c Environment approval. Inspect the workflow/SHA/artifacts and full main PR/admin/force/delete settings; Environment is not a workflow allowlist. Installation requires the enabled production gate and registered public key. verify-signature retains artifacts only and cannot publish a Release.\n`);
  }else if(command==='preflight')await auditSource(path.resolve(first),r,{profile:'registered-production'});
  else if(command==='package'){
    const root=path.resolve(first),tree=await auditSource(root,r,{profile:'registered-production'});if(!env.CARGO_TARGET_DIR)throw Error('Owned Cargo target required');
    const result=await createUnsignedBundle(root,path.resolve(second),r,{tree,payloadPath:path.join(env.CARGO_TARGET_DIR,'release/Nearly.exe')});await output({'manifest-sha256':result.manifestHash});
  }else if(command==='tools'){
    if(!env.CARGO_TARGET_DIR||!env.NEARLY_EXTRACTOR_DIRECTORY)throw Error('Prepared owned tool paths required');
    const result=await createToolBundle(control,path.resolve(first),r,{signerPath:path.join(env.CARGO_TARGET_DIR,'release/nearly-updater-signer.exe'),extractorDirectory:env.NEARLY_EXTRACTOR_DIRECTORY});await output({'manifest-sha256':result.manifestHash});
  }else if(command==='artifacts'){
    await artifact('unsigned',env.UNSIGNED_ARTIFACT_ID,env.UNSIGNED_ARTIFACT_DIGEST);await artifact('tools',env.TOOL_ARTIFACT_ID,env.TOOL_ARTIFACT_DIGEST);
  }else if(command==='signed-artifact'){
    await artifact('signed',env.SIGNED_ARTIFACT_ID,env.SIGNED_ARTIFACT_DIGEST);
  }else if(command==='prepare-sign'){
    await verifySigningPolicy(r,api());
    await artifact('unsigned',env.UNSIGNED_ARTIFACT_ID,env.UNSIGNED_ARTIFACT_DIGEST);await artifact('tools',env.TOOL_ARTIFACT_ID,env.TOOL_ARTIFACT_DIGEST);
    await verifyToolBundle(control,path.resolve(second),r,{manifestHash:env.TOOL_MANIFEST_SHA256});
    const result=await createSigningPlan(path.resolve(first),path.join(env.RUNNER_TEMP,'nearly-signing-plan.json'),r,unsigned());await output({'manifest-sha256':result.manifestHash});
  }else if(command==='signed'){
    const result=await createSignedBundle(path.resolve(first),path.resolve(second),r,{...unsigned(),toolArtifactId:env.TOOL_ARTIFACT_ID,toolManifestHash:env.TOOL_MANIFEST_SHA256});await output({'manifest-sha256':result.manifestHash});
    if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,`Independent signature verification succeeded for ${r.tag}, mode ${r.mode}, source ${r.commit}, run ${r.runId}/${r.runAttempt}. ${r.mode==='verify-signature'?'Verification only: no tag/Release/publisher job.':'Release publication is a separate job.'}\n`);
  }else if(command==='verify-signed'||command==='publish'){
    await artifact('signed',env.SIGNED_ARTIFACT_ID,env.SIGNED_ARTIFACT_DIGEST);
    const bundle=await verifySignedBundle(path.resolve(first),r,signed());
    if(command==='publish'){
      // Public cryptographic verification has already succeeded before any write.
      const notes=await fs.readFile(new URL(`../release-notes/${r.tag}.md`,import.meta.url),'utf8');
      const result=await publishSignedRelease({request:r,bundle,notes,api:api(),download:downloadPublic,publicRaw:await loadTrustedPublicKey(control)});
      if(env.GITHUB_STEP_SUMMARY)await fs.appendFile(env.GITHUB_STEP_SUMMARY,`Verified and published [Nearly ${r.tag}](${result.url}) with installer/checksum/protocol3 signature. No installer was executed.\n`);console.log(result.url);
    }
  }else throw Error('Unknown signed release operation');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
