import {assertProductionPayload} from '../../scripts/production-build-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseRequest,sha256,auditBytes,verifyVersionAndGates} from './release-contract.mjs';
import {publicKeySha256,loadTrustedPublicKey} from './release-trust.mjs';
import {verifyUpdaterProof} from './updater-proof.mjs';
const control=fileURLToPath(new URL('../../',import.meta.url));
const fail=m=>{throw Error(m);};
export const oid=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
export const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const identity=v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v)&&Number.isSafeInteger(Number(v));
export const canonical=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const bindings=['repository','commit','tag','version','workflowCommit','runId','runAttempt','mode'];
const expectedName=r=>`Nearly_${r.tag}_x64-setup.exe`;
function keys(value,wanted){if(!value||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...wanted].sort()))fail('Unexpected manifest schema');}
export async function regular(file,limit=64*1024*1024){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>limit)fail('Unsafe bounded input');const bytes=await fs.readFile(file);if(bytes.length!==stat.size)fail('Input changed while reading');return bytes;}
async function directory(dir,names){const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||JSON.stringify((await fs.readdir(dir)).sort())!==JSON.stringify([...names].sort()))fail('Unexpected bundle files');}
export function pe(bytes,machine){if(bytes.length<90||bytes.readUInt16LE(0)!==0x5a4d)fail('Invalid PE image');const offset=bytes.readUInt32LE(0x3c);if(offset<64||offset+6>bytes.length||bytes.readUInt32LE(offset)!==0x4550||bytes.readUInt16LE(offset+4)!==machine)fail('Wrong PE architecture');}
function descriptor(name,data){return{name,bytes:data.length,sha256:sha256(data)};}
function baseManifest(m,r,kind,extra){keys(m,['schemaVersion','kind',...bindings,'tree','publicKeySha256',...extra]);if(m.schemaVersion!==1||m.kind!==kind||!oid(m.tree)||m.publicKeySha256!==publicKeySha256||bindings.some(k=>m[k]!==r[k]))fail('Bundle source/controller/run binding mismatch');}
async function manifest(dir,name,hash){if(!digest(hash))fail('Trusted manifest digest required');const bytes=await regular(path.join(dir,name),131072);if(sha256(bytes)!==hash)fail('Manifest digest mismatch');const value=JSON.parse(bytes);if(!canonical(value).equals(bytes))fail('Noncanonical or duplicate manifest fields');auditBytes(bytes);return value;}
async function assets(dir,list,names){if(!Array.isArray(list)||list.length!==names.length)fail('Unexpected asset count');const result=[];for(const [i,a]of list.entries()){keys(a,['name','bytes','sha256']);if(a.name!==names[i]||!digest(a.sha256)||!Number.isSafeInteger(a.bytes)||a.bytes<=0)fail('Invalid asset descriptor');const data=await regular(path.join(dir,a.name),a.name.endsWith('.sig')?16384:64*1024*1024);if(data.length!==a.bytes||sha256(data)!==a.sha256)fail('Asset bytes differ');auditBytes(data);result.push({...a,data});}return result;}
function checksum(result,name){if(!result[1].data.equals(Buffer.from(`${result[0].sha256}  ${name}\n`)))fail('Checksum content mismatch');pe(result[0].data,0x14c);}
export function parseSignedRequest(env){
  // Keep the historical unsigned controller's accepted modes unchanged.
  const verification=env.RELEASE_MODE==='verify-signature';
  const r=parseRequest(verification?{...env,RELEASE_MODE:'validate'}:env,{allowPrerelease:true});
  if(verification&&env.RELEASE_CONFIRM!==`verify-signature ${r.tag} ${r.commit}`)fail('Exact verification/version/commit confirmation required');
  if(!identity(env.GITHUB_RUN_ATTEMPT)||env.GITHUB_WORKFLOW_REF!=='nea-c/Nearly/.github/workflows/release-signed-windows.yml@refs/heads/main')fail('Exact signed workflow and run attempt required');
  return {...r,mode:verification?'verify-signature':r.mode,runAttempt:env.GITHUB_RUN_ATTEMPT};
}
export function validateArtifact(a,r,{id,role,digest:zipDigest,repositoryId}){
  if(!identity(id)||!['unsigned','tools','signed'].includes(role)||!digest(zipDigest)||!Number.isSafeInteger(repositoryId)||repositoryId<=0||a?.id!==Number(id)||a.name!==`nearly-${role}-${r.runId}-${r.runAttempt}`||a.expired!==false||!Number.isSafeInteger(a.size_in_bytes)||a.size_in_bytes<=0||a.size_in_bytes>512*1024*1024||a.digest!==`sha256:${zipDigest}`||a.workflow_run?.id!==Number(r.runId)||a.workflow_run.repository_id!==repositoryId||a.workflow_run.head_repository_id!==repositoryId||a.workflow_run.head_branch!=='main'||a.workflow_run.head_sha!==r.workflowCommit)fail('Artifact server identity/digest/run mismatch');
  return true;
}
export async function createUnsignedBundle(root,output,r,{payloadPath,tree}){
  await verifyVersionAndGates(root,r,{profile:'registered-production'});if(!oid(tree))fail('Exact source tree required');
  const name=expectedName(r),installer=await regular(path.join(root,'build',name)),payload=await regular(payloadPath),metadata=JSON.parse(await regular(path.join(root,'build/installer-build-info.json'),131072));
  pe(installer,0x14c);pe(payload,0x8664);
  assertProductionPayload(payload);
  if(metadata.version!==r.version||metadata.displayVersion!==r.tag||metadata.identifier!=='local.syncfiles.native'||metadata.payloadArchitecture!=='x64'||metadata.installMode!=='currentUser'||metadata.settingsIncluded!==false||metadata.adjacentSettingsPreserved!==true||metadata.updaterInstallationEnabled!==true||metadata.updaterProtocol!==3||metadata.signed!==false||metadata.bytes!==installer.length||metadata.sha256!==sha256(installer)||metadata.embeddedApplicationSha256!==sha256(payload))fail('Registered production installer metadata mismatch');
  auditBytes(installer,[root,process.env.USERPROFILE,process.env.GITHUB_WORKSPACE,process.env.RUNNER_TEMP]);auditBytes(payload,[root,process.env.USERPROFILE,process.env.GITHUB_WORKSPACE,process.env.RUNNER_TEMP]);
  const check=Buffer.from(`${sha256(installer)}  ${name}\n`),m={schemaVersion:1,kind:'unsigned-updater',...Object.fromEntries(bindings.map(k=>[k,r[k]])),tree,publicKeySha256,payload:descriptor('Nearly.exe',payload),assets:[descriptor(name,installer),descriptor(name+'.sha256',check)]};
  await fs.mkdir(output);for(const [filename,bytes]of [[name,installer],[name+'.sha256',check],['Nearly.exe',payload],['unsigned-manifest.json',canonical(m)]])await fs.writeFile(path.join(output,filename),bytes,{flag:'wx'});
  return{manifestHash:sha256(canonical(m))};
}
export async function verifyUnsignedBundle(dir,r,{manifestHash,artifactId,allowSignature=false}){
  if(!identity(artifactId))fail('Immutable unsigned artifact ID required');const name=expectedName(r);
  await directory(dir,[name,name+'.sha256','Nearly.exe','unsigned-manifest.json',...(allowSignature?[name+'.sig']:[])]);
  const m=await manifest(dir,'unsigned-manifest.json',manifestHash);baseManifest(m,r,'unsigned-updater',['payload','assets']);
  const checked=await assets(dir,m.assets,[name,name+'.sha256']);checksum(checked,name);
  keys(m.payload,['name','bytes','sha256']);if(m.payload.name!=='Nearly.exe'||!digest(m.payload.sha256)||!Number.isSafeInteger(m.payload.bytes)||m.payload.bytes<=0)fail('Invalid payload descriptor');
  const payload=await regular(path.join(dir,'Nearly.exe'));if(payload.length!==m.payload.bytes||sha256(payload)!==m.payload.sha256)fail('Final payload differs');pe(payload,0x8664);assertProductionPayload(payload);auditBytes(payload);
  return{manifest:m,assets:checked,payload};
}
export async function createSigningPlan(dir,output,r,options){
  const bundle=await verifyUnsignedBundle(dir,r,options),name=expectedName(r);
  const m={updaterProtocol:3,version:r.version,arch:'x64',file:name,sourceCommit:r.commit,artifactId:options.artifactId,archiveMember:'$PLUGINSDIR/Nearly.exe',installerSha256:bundle.assets[0].sha256,payloadSha256:bundle.manifest.payload.sha256};
  const bytes=canonical(m);await fs.writeFile(output,bytes,{flag:'wx'});return{manifest:m,manifestHash:sha256(bytes)};
}
async function trustedRaw(options){return options.trustedPublicRaw||loadTrustedPublicKey(control);}
export async function createSignedBundle(dir,output,r,options){
  if(!identity(options.toolArtifactId)||!digest(options.toolManifestHash))fail('Trusted tool artifact binding required');
  const bundle=await verifyUnsignedBundle(dir,r,{...options,allowSignature:true}),name=expectedName(r),signature=await regular(path.join(dir,name+'.sig'),16384);
  verifyUpdaterProof(bundle.assets[0].data,signature,await trustedRaw(options),{version:r.version,file:name,payloadSha256:bundle.manifest.payload.sha256});
  const all=[...bundle.assets,{...descriptor(name+'.sig',signature),data:signature}];
  const m={schemaVersion:1,kind:'signed-updater',...Object.fromEntries(bindings.map(k=>[k,r[k]])),tree:bundle.manifest.tree,publicKeySha256,payloadSha256:bundle.manifest.payload.sha256,unsignedArtifactId:options.artifactId,unsignedManifestHash:options.manifestHash,toolArtifactId:options.toolArtifactId,toolManifestHash:options.toolManifestHash,assets:all.map(({data,...a})=>a)};
  await fs.mkdir(output);for(const asset of all)await fs.writeFile(path.join(output,asset.name),asset.data,{flag:'wx'});await fs.writeFile(path.join(output,'signed-manifest.json'),canonical(m),{flag:'wx'});
  return{manifestHash:sha256(canonical(m))};
}
export async function verifySignedBundle(dir,r,options){
  const name=expectedName(r);await directory(dir,[name,name+'.sha256',name+'.sig','signed-manifest.json']);
  const m=await manifest(dir,'signed-manifest.json',options.manifestHash);baseManifest(m,r,'signed-updater',['payloadSha256','unsignedArtifactId','unsignedManifestHash','toolArtifactId','toolManifestHash','assets']);
  for(const [field,value]of Object.entries({unsignedArtifactId:options.unsignedArtifactId,unsignedManifestHash:options.unsignedManifestHash,toolArtifactId:options.toolArtifactId,toolManifestHash:options.toolManifestHash}))if(m[field]!==value)fail('Signed bundle job binding mismatch');
  if(!identity(m.unsignedArtifactId)||!identity(m.toolArtifactId)||!digest(m.unsignedManifestHash)||!digest(m.toolManifestHash)||!digest(m.payloadSha256))fail('Invalid signing provenance');
  const checked=await assets(dir,m.assets,[name,name+'.sha256',name+'.sig']);checksum(checked,name);
  verifyUpdaterProof(checked[0].data,checked[2].data,await trustedRaw(options),{version:r.version,file:name,payloadSha256:m.payloadSha256});
  return{manifest:m,assets:checked};
}
