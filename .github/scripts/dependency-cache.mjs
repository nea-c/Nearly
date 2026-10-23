import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const hash=/^[a-f0-9]{64}$/;
const roles=new Set(['native-debug','unsigned-release']);
const fail=message=>{throw Error('Dependency cache: '+message);};
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
const digest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

// This is a compatibility digest, never evidence of who created a cache.
export function dependencyContext(c){
  if(!c||!roles.has(c.role)||c.profile!==(c.role==='native-debug'?'test':'release'))fail('invalid role/profile');
  if(typeof c.toolchain!=='string'||!c.toolchain||!hash.test(c.vendorHash)||!hash.test(c.policyHash))fail('incomplete build identity');
  for(const name of ['features','flags'])if(!Array.isArray(c[name])||c[name].some(x=>typeof x!=='string'))fail('invalid '+name);
  if(!Array.isArray(c.packages)||!c.rootDependencies||typeof c.rootDependencies!=='object')fail('missing dependency graph');
  const roots=c.packages.filter(p=>p.root===true);
  if(roots.length!==1||roots[0].name!=='nearly'||roots[0].source!==null)fail('ambiguous workspace root');
  const packages=c.packages.filter(p=>p.root!==true);
  for(const p of packages){
    if(typeof p.name!=='string'||!p.name||typeof p.version!=='string'||!p.version)fail('invalid package identity');
    if(typeof p.source==='string'&&p.source.startsWith('registry+')&&!hash.test(p.checksum))fail('missing locked registry checksum');
  }
  // Root package outputs are forbidden from the payload; only its version is irrelevant here.
  return digest({schema:1,role:c.role,profile:c.profile,toolchain:c.toolchain,features:[...c.features].sort(),flags:c.flags,packages:packages.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),rootDependencies:c.rootDependencies,vendorHash:c.vendorHash,policyHash:c.policyHash});
}

// Names are obtained from the current locked registry package graph. No workspace
// or path dependency may be added by a cache's self-declared manifest.
export function dependencyPathAllowed(relative,role,packages){
  if(!roles.has(role)||typeof relative!=='string'||relative.length>1000||/[\\:\x00-\x1f]/.test(relative))return false;
  const parts=relative.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[ .]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))return false;
  if(parts[0]!== (role==='native-debug'?'debug':'release'))return false;
  const allowed=(packages||[]).filter(p=>p.name!=='nearly'&&typeof p.source==='string'&&p.source.startsWith('registry+')&&/^[a-zA-Z0-9_-]+$/.test(p.name));
  const targetNames=new Set(allowed.flatMap(p=>(p.targets||[]).map(t=>t.name.replaceAll('-','_'))));
  if(parts[1]==='deps'&&parts.length===3){
    const match=/^(?:lib)?(.+)-[a-f0-9]{16}\.(rlib|rmeta|d|dll|dll\.lib|lib|pdb|exp|dll\.exp)$/.exec(parts[2]);
    return !!match&&targetNames.has(match[1]);
  }
  if(!['.fingerprint','build'].includes(parts[1])||parts.length<4)return false;
  const owner=/^(.+)-[a-f0-9]{16}$/.exec(parts[2]);
  if(!owner||!allowed.some(p=>p.name===owner[1]))return false;
  if(parts[1]==='.fingerprint')return parts.length===4&&/^[a-zA-Z0-9_.-]+$/.test(parts[3]);
  if(parts[3]==='out')return parts.length>4;
  return parts.length===4&&/^(?:build[-_]script[-_]build(?:-[a-f0-9]{16})?\.(?:exe|pdb|d)|output|stderr|root-output|invoked\.timestamp)$/.test(parts[3]);
}

export const manifestDigest=manifest=>digest(manifest);
const maxBytes=4*1024**3,maxFile=256*1024**2,maxFiles=50000;
async function directoriesOnly(absolute){
  const full=path.resolve(absolute),base=path.parse(full).root;
  let current=base;
  for(const component of full.slice(base.length).split(path.sep).filter(Boolean)){
    current=path.join(current,component);const s=await fs.lstat(current);
    if(s.isSymbolicLink()||!s.isDirectory())fail('directory boundary is not regular');
  }
  return full;
}
function overlaps(a,b){
  const canonical=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
  const x=canonical(a),y=canonical(b);
  return x===y||x.startsWith(y+path.sep)||y.startsWith(x+path.sep);
}
async function createDirectories(absolute,created){
  const full=path.resolve(absolute),base=path.parse(full).root;
  let current=base;
  for(const component of full.slice(base.length).split(path.sep).filter(Boolean)){
    await directoriesOnly(current);current=path.join(current,component);
    try{await fs.mkdir(current);created.push(current);}catch(e){if(e.code!=='EEXIST')throw e;}
    await directoriesOnly(current);
  }
}
async function inventory(root){
  await directoriesOnly(root);const result=[];
  async function visit(directory,relative=''){
    for(const item of await fs.readdir(directory,{withFileTypes:true})){
      const rel=relative?relative+'/'+item.name:item.name,full=path.join(directory,item.name),s=await fs.lstat(full);
      if(s.isSymbolicLink())fail('linked payload entry');
      if(s.isDirectory())await visit(full,rel);
      else if(s.isFile()){if(result.length>=maxFiles)fail('too many cache files');result.push({path:rel,bytes:s.size});}
      else fail('non-regular payload entry');
    }
  }
  await visit(root);return result.sort((a,b)=>a.path.localeCompare(b.path));
}
async function fileHash(filename){
  const handle=await fs.open(filename,'r');
  try{
    const before=await handle.stat();if(!before.isFile()||before.size>maxFile)fail('oversized cache file');
    const h=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))h.update(chunk);
    const after=await handle.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('file changed during cache verification');
    return h.digest('hex');
  }finally{await handle.close();}
}
async function absent(p){try{await fs.lstat(p);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}

// Only called after all checks/package auditing finish. Existing target bytes are
// read, never cleaned or modified. Callers treat cache export failures as optional.
export async function exportPayload({target,payload,role,packages,contextHash}){
  if(!roles.has(role)||!hash.test(contextHash))fail('invalid export request');
  const source=await directoriesOnly(target),destination=path.resolve(payload);
  await directoriesOnly(path.dirname(destination));
  if(!await absent(destination))fail('payload staging already exists');
  if(overlaps(destination,source))fail('overlapping target and staging');
  const items=(await inventory(source)).filter(f=>dependencyPathAllowed(f.path,role,packages));
  if(!items.length||items.some(f=>f.bytes>maxFile)||items.reduce((n,f)=>n+f.bytes,0)>maxBytes)fail('empty or oversized dependency payload');
  await fs.mkdir(destination);
  const files=[];
  for(const f of items){
    const from=path.join(source,...f.path.split('/')),to=path.join(destination,...f.path.split('/'));
    await directoriesOnly(path.dirname(from));const s=await fs.lstat(from);if(!s.isFile()||s.isSymbolicLink()||s.size!==f.bytes)fail('export entry changed');
    const sha256=await fileHash(from);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to,1);await fs.utimes(to,s.atime,s.mtime);
    if(await fileHash(to)!==sha256)fail('export copy differs');files.push({...f,sha256,mtimeMs:s.mtimeMs});
  }
  return {schema:1,role,contextHash,files};
}

// Cache contents share the existing main-branch build trust boundary. This digest
// detects corruption, not producer identity. Adopt only after complete validation.
export async function restorePayload({payload,target,role,packages,contextHash,manifest,expectedManifestHash}){
  let scratch,owner;const created=[];
  try{
    if(!roles.has(role)||!hash.test(contextHash)||!hash.test(expectedManifestHash)||manifestDigest(manifest)!==expectedManifestHash)fail('invalid manifest');
    if(manifest.schema!==1||manifest.role!==role||manifest.contextHash!==contextHash||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>maxFiles)fail('manifest context mismatch');
    const seen=new Set();let total=0;
    for(const f of manifest.files){
      if(!dependencyPathAllowed(f.path,role,packages)||seen.has(f.path.toLowerCase())||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>maxFile||!hash.test(f.sha256)||!Number.isFinite(f.mtimeMs)||f.mtimeMs<0)fail('invalid manifest entry');
      total+=f.bytes;seen.add(f.path.toLowerCase());
    }
    if(total>maxBytes)fail('payload exceeds capacity');
    const source=await directoriesOnly(payload),actual=await inventory(source);
    if(actual.length!==manifest.files.length)fail('unknown payload files');
    const records=new Map(manifest.files.map(f=>[f.path,f]));
    for(const f of actual){const expected=records.get(f.path);if(!expected||expected.bytes!==f.bytes||await fileHash(path.join(source,...f.path.split('/')))!==expected.sha256)fail('payload differs from authenticated manifest');}
    const destination=path.resolve(target),profile=role==='native-debug'?'debug':'release';
    if(overlaps(destination,source))fail('overlapping payload and target');
    await createDirectories(destination,created);
    if(!await absent(path.join(destination,profile)))fail('existing build profile must be preserved');
    scratch=await fs.mkdtemp(path.join(destination,'.nearly-deps-'));owner=randomUUID();await fs.writeFile(path.join(scratch,'.owner'),owner,{flag:'wx'});
    for(const f of manifest.files){
      const to=path.join(scratch,...f.path.split('/'));await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(path.join(source,...f.path.split('/')),to,1);await fs.utimes(to,new Date(f.mtimeMs),new Date(f.mtimeMs));
      if(await fileHash(to)!==f.sha256)fail('staged restore differs');
    }
    await directoriesOnly(destination);
    // Windows rename refuses an existing nonempty profile; nothing is merged.
    if(!await absent(path.join(destination,profile)))fail('build profile appeared during restore');
    await fs.rename(path.join(scratch,profile),path.join(destination,profile));
    return {restored:true,files:manifest.files.length,bytes:total};
  }catch{return {restored:false,reason:'cache rejected; use the normal build'};}
  finally{
    if(scratch){
      try{
        const full=path.resolve(scratch),base=path.resolve(target);
        if(path.dirname(full)!==base||!path.basename(full).startsWith('.nearly-deps-'))fail('invalid owned scratch root');
        await directoriesOnly(full);
        if(await fs.readFile(path.join(full,'.owner'),'utf8')!==owner)fail('scratch ownership changed');
        await fs.rm(full,{recursive:true,force:true});
      }catch{/* Never remove an unrecognized path or turn a cache miss into a build error. */}
    }
    for(const directory of created.reverse()){
      try{await directoriesOnly(directory);await fs.rmdir(directory);}catch{/* Remove only empty directories created by this attempt. */}
    }
  }
}

function command(program,args,cwd,env){
  const r=spawnSync(program,args,{cwd,env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024**2});
  if(r.error||r.status!==0)fail('build identity command failed');
  return r.stdout;
}
async function treeDigest(root){
  if(await absent(root))return digest([]);
  return digest(await Promise.all((await inventory(root)).map(async f=>[f.path,await fileHash(path.join(root,...f.path.split('/')))])));
}
async function optionalHash(file){return await absent(file)?null:await fileHash(file);}
async function buildPolicy(root){
  const repository=path.dirname(root),entries=[];
  for(const file of ['scripts/build-installer.mjs','scripts/build-windows.mjs','scripts/production-build-policy.mjs'])entries.push([file,await optionalHash(path.join(repository,file))]);
  for(const [file,base]of [['tauri.conf.json',root],['package.json',repository],['package-lock.json',repository]]){
    const full=path.join(base,file);if(await absent(full)){entries.push([file,null]);continue;}
    const json=JSON.parse(await fs.readFile(full,'utf8'));delete json.version;
    if(json.packages?.[''])delete json.packages[''].version;
    entries.push([file,digest(json)]);
  }
  return entries;
}

// Main-branch code and its locked dependencies are the trust unit, just as for
// a cold build. The key is compatibility/invalidation, not authentication.
export async function collectBuildContext({source,role,env=process.env,policyHash}){
  if(!roles.has(role)||!hash.test(policyHash))fail('invalid context request');
  const root=await directoriesOnly(source),manifest=path.join(root,'Cargo.toml');
  const toolchain=command('rustc',['+1.97.1','-vV'],root,env)+command('cargo',['+1.97.1','-V'],root,env);
  const args=['+1.97.1','metadata','--offline','--locked','--format-version','1','--filter-platform','x86_64-pc-windows-msvc','--manifest-path',manifest];
  // Packaging enables this feature; native qualification also builds feature variants.
  if(role==='unsigned-release')args.push('--features','custom-protocol');
  const metadata=JSON.parse(command('cargo',args,root,env));
  const own=metadata.packages.filter(p=>path.resolve(p.manifest_path)===manifest);
  if(own.length!==1||own[0].name!=='nearly'||metadata.workspace_members.length!==1)fail('unsupported workspace');
  const lock=await fs.readFile(path.join(root,'Cargo.lock'),'utf8');
  const checksums=new Map();
  for(const entry of lock.split('[[package]]').slice(1)){
    const field=name=>new RegExp('^'+name+' = "([^"\\r\\n]+)"','m').exec(entry)?.[1];
    checksums.set([field('name'),field('version'),field('source')].join('|'),field('checksum'));
  }
  const packages=metadata.packages.map(p=>({name:p.name,version:p.version,source:p.source,root:p.id===own[0].id,checksum:p.source?.startsWith('registry+')?checksums.get([p.name,p.version,p.source].join('|')):undefined,targets:p.targets.map(t=>({name:t.name,kind:t.kind,crate_types:t.crate_types}))}));
  // Path/git dependencies are not cached; changes still invalidate registry outputs.
  const local=[];
  for(const p of metadata.packages.filter(p=>p.id!==own[0].id&&!p.source)){
    const relative=path.relative(root,path.dirname(p.manifest_path));
    if(relative.startsWith('..')||path.isAbsolute(relative))fail('external path dependency is unsupported');
    local.push([relative.replaceAll('\\','/'),await treeDigest(path.dirname(p.manifest_path))]);
  }
  const rawManifest=await fs.readFile(manifest,'utf8');
  const normalizedManifest=rawManifest.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"\r\n]+"/,'$1"<root-version>"');
  // Never persist CARGO_REGISTRY_TOKEN or arbitrary environment variables.
  const flagNames=new Set(['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','RUSTC','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','RUSTDOC','RUSTDOCFLAGS','RUSTUP_TOOLCHAIN','CARGO_INCREMENTAL','CARGO_BUILD_TARGET','CARGO_BUILD_RUSTFLAGS','CARGO_BUILD_RUSTC','CARGO_BUILD_RUSTC_WRAPPER','CC','CXX','AR','CFLAGS','CXXFLAGS','CPPFLAGS','CL','INCLUDE','LIB','LIBPATH','VCTOOLSVERSION','WINDOWSSDKVERSION','WINDOWSSDKLIBVERSION','IMAGEVERSION']);
  const flags=Object.entries(env).filter(([k])=>flagNames.has(k.toUpperCase())||/^CARGO_(?:PROFILE_.*|TARGET_.*_(?:RUSTFLAGS|LINKER|AR))$/i.test(k)).map(([k,v])=>`${k.toUpperCase()}=${v}`).sort();
  const cargoHome=env.CARGO_HOME||path.join(env.USERPROFILE||env.HOME||'','.cargo');
  const c={role,profile:role==='native-debug'?'test':'release',toolchain,features:[...new Set((metadata.resolve?.nodes||[]).flatMap(n=>n.features))].sort(),flags,packages,rootDependencies:{manifest:normalizedManifest,local,buildPolicy:await buildPolicy(root),config:await treeDigest(path.join(root,'.cargo')),parentConfig:await treeDigest(path.join(root,'..','.cargo')),globalConfig:await Promise.all(['config','config.toml'].map(f=>optionalHash(path.join(cargoHome,f))))},vendorHash:await treeDigest(path.join(root,'vendor')),policyHash};
  const contextHash=dependencyContext(c);
  return {schema:2,role,contextHash,key:`nearly-deps-v2-${role}-${contextHash}`,packages};
}

export async function saveLocalCache({target,bundle,context}){
  try{
    if(!await absent(bundle))fail('cache staging already present');
    await directoriesOnly(path.dirname(bundle));await fs.mkdir(bundle);
    const manifest=await exportPayload({target,payload:path.join(bundle,'payload'),role:context.role,packages:context.packages,contextHash:context.contextHash});
    await fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify({manifest,digest:manifestDigest(manifest)}),{flag:'wx'});
    return {saved:true,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)};
  }catch{return {saved:false,reason:'optional cache export unavailable'};}
}
export async function restoreLocalCache({target,bundle,context,matchedKey}){
  try{
    if(matchedKey!==context.key)fail('nonexact cache match');
    await directoriesOnly(bundle);
    const stat=await fs.lstat(path.join(bundle,'manifest.json'));
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024**2)fail('invalid cache manifest file');
    const record=JSON.parse(await fs.readFile(path.join(bundle,'manifest.json'),'utf8'));
    return await restorePayload({payload:path.join(bundle,'payload'),target,role:context.role,packages:context.packages,contextHash:context.contextHash,manifest:record.manifest,expectedManifestHash:record.digest});
  }catch{return {restored:false,reason:'cache miss; use the normal build'};}
}

async function output(values,env){
  if(env.GITHUB_OUTPUT)await fs.appendFile(env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}\n`).join(''));
}
export async function cacheMain(args,env=process.env){
  const [mode,role,source]=args;
  const started=performance.now();
  try{
    if(!roles.has(role)||!env.RUNNER_TEMP||!env.CARGO_TARGET_DIR)fail('unsupported cache environment');
    const temp=await directoriesOnly(env.RUNNER_TEMP),bundle=path.join(temp,`nearly-deps-${role}`),identity=path.join(temp,`nearly-deps-${role}.json`);
    if(mode==='prepare'){
      const controller=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
      const files=['.github/scripts/dependency-cache.mjs','.github/scripts/prepare-windows.ps1','.github/scripts/windows-build-paths.ps1','.github/workflows/release-signed-windows.yml'];
      const policyHash=digest(await Promise.all(files.map(async f=>[f,await fileHash(path.join(controller,f))])));
      const context=await collectBuildContext({source:path.resolve(source),role,env,policyHash});
      await fs.writeFile(identity,JSON.stringify(context),{flag:'wx'});
      await output({enabled:'true',key:context.key,path:bundle},env);console.log(`Dependency cache ${role}: context ready in ${Math.round(performance.now()-started)}ms`);
    }else{
      const context=JSON.parse(await fs.readFile(identity,'utf8'));
      if(context.role!==role)fail('wrong context role');
      const result=mode==='restore'?await restoreLocalCache({target:env.CARGO_TARGET_DIR,bundle,context,matchedKey:env.CACHE_MATCHED_KEY}):mode==='save'?await saveLocalCache({target:env.CARGO_TARGET_DIR,bundle,context}):fail('unknown cache operation');
      await output({ready:result.saved?'true':'false'},env);
      console.log(`Dependency cache ${role}: ${JSON.stringify({...result,elapsedMs:Math.round(performance.now()-started)})}`);
    }
  }catch{
    await output({enabled:'false',ready:'false'},env).catch(()=>{});
    console.log('Dependency cache unavailable; continue with the normal build');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await cacheMain(process.argv.slice(2));
