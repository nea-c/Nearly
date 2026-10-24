import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const contracts = await import('../.github/scripts/release-contract.mjs').catch(e => {if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const publisher = await import('../.github/scripts/release-publish.mjs').catch(e => {if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const sha=b=>createHash('sha256').update(b).digest('hex');
const commit='a'.repeat(40), workflow='b'.repeat(40);
const env={GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_SHA:workflow,GITHUB_RUN_ID:'123',RELEASE_COMMIT:commit,RELEASE_TAG:'r1.0',RELEASE_MODE:'validate',RELEASE_CONFIRM:''};
function request(mode='release'){return {...contracts.parseRequest({...env,RELEASE_MODE:mode,RELEASE_CONFIRM:mode==='release'?`release r1.0 ${commit}`:''})};}

test('manual release defaults to validation and binds exact commit, version and workflow run',()=>{
  assert.equal(typeof contracts.parseRequest,'function');
  assert.deepEqual(contracts.parseRequest(env),{repository:'nea-c/Nearly',commit,tag:'r1.0',version:'1.0.0',mode:'validate',workflowCommit:workflow,runId:'123'});
});
test('rejects ambiguous commits, malformed versions, wrong dispatch context and missing release confirmation',()=>{
  assert.equal(typeof contracts.parseRequest,'function');
  for(const patch of [{RELEASE_COMMIT:'main'},{RELEASE_COMMIT:commit+'\n'},{RELEASE_COMMIT:commit.toUpperCase()},{RELEASE_TAG:'r01.0'},{RELEASE_TAG:'r1.0.0'},{RELEASE_TAG:'r65536.0'},{RELEASE_MODE:'publish'},{GITHUB_REPOSITORY:'foreign/Nearly'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/tags/r1.0'},{GITHUB_RUN_ID:'123\n'},{RELEASE_MODE:'release'},{RELEASE_MODE:'release',RELEASE_CONFIRM:'release r1.0 main'}])assert.throws(()=>contracts.parseRequest({...env,...patch}));
  assert.equal(request().mode,'release');
});
test('privacy audit rejects credentials, personal paths and forbidden source outputs without leaking them',()=>{
  assert.equal(typeof contracts.auditBytes,'function');
  const home=['C:', 'Users', 'private-person', 'project'].join(String.fromCharCode(92));
  const key='-----BEGIN '+'PRIVATE KEY-----\n'+'A'.repeat(64)+'\n-----END '+'PRIVATE KEY-----';
  for(const b of [Buffer.from(home),Buffer.from(home,'utf16le'),Buffer.concat([Buffer.from([0]),Buffer.from(home,'utf16le')]),Buffer.from('gh'+'p_'+'x'.repeat(40)),Buffer.from(key),Buffer.from(JSON.stringify({key}))])assert.throws(()=>contracts.auditBytes(b),/privacy/i);
  for(const name of ['build/settings.json','docs/qa/result.json','.ssh/id_rsa','diagnostics/report.json','test-results/generated.ppk','src/key.pem'])assert.throws(()=>contracts.assertSafeSourcePath(name),/source/i);
  assert.doesNotThrow(()=>contracts.assertSafeSourcePath('tests/manual-release.test.mjs'));
  assert.doesNotThrow(()=>contracts.auditBytes(Buffer.from('https://github.com/nea-c/Nearly /srv/example')));
  assert.doesNotThrow(()=>contracts.auditBytes(Buffer.from('-----BEGIN '+'PRIVATE KEY-----\0supported format constant')));
});

async function fixture(t){
  const base=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(base,'nearly-release-contract-'));
  t.after(async()=>{const stat=await fs.lstat(root),resolved=await fs.realpath(root),resolvedBase=await fs.realpath(base);assert.equal(stat.isSymbolicLink(),false);assert.equal(path.dirname(resolved).toLowerCase(),resolvedBase.toLowerCase());assert.match(path.basename(resolved),/^nearly-release-contract-/);await fs.rm(root,{recursive:true,force:true});});
  for(const d of ['src-tauri/src','build'])await fs.mkdir(path.join(root,d),{recursive:true});
  await fs.writeFile(path.join(root,'version.json'),'{"version":"1.0.0"}');
  await fs.writeFile(path.join(root,'src-tauri/src/update_package.rs'),'fn production_key() -> Option<TrustedKey> { None }');
  await fs.writeFile(path.join(root,'src-tauri/src/startup_update.rs'),'const HANDOFF_RELEASE_VALIDATED: bool = false;');
  const pe=Buffer.alloc(160);pe.write('MZ');pe.writeUInt32LE(64,0x3c);pe.writeUInt32LE(0x4550,64);pe.writeUInt16LE(0x8664,68);
  const payload=path.join(root,'payload.exe');await fs.writeFile(payload,pe);
  const installer=Buffer.from(pe);installer.writeUInt16LE(0x14c,68);
  await fs.writeFile(path.join(root,'build/Nearly_r1.0_x64-setup.exe'),installer);
  const metadata={version:'1.0.0',displayVersion:'r1.0',identifier:'local.syncfiles.native',payloadArchitecture:'x64',installMode:'currentUser',settingsIncluded:false,adjacentSettingsPreserved:true,updaterInstallationEnabled:false,signed:false,bytes:installer.length,sha256:sha(installer),embeddedApplicationSha256:sha(pe)};
  await fs.writeFile(path.join(root,'build/installer-build-info.json'),JSON.stringify(metadata));
  return {root,payload,installer,metadata,out:path.join(root,'release-output')};
}
test('package contains only installer, checksum and path-free bound manifest',async t=>{
  assert.equal(typeof contracts.createPackage,'function');const f=await fixture(t),r=request('validate');
  const result=await contracts.createPackage(f.root,f.out,r,{payloadPath:f.payload,tree:'c'.repeat(40)});
  assert.deepEqual((await fs.readdir(f.out)).sort(),['Nearly_r1.0_x64-setup.exe','Nearly_r1.0_x64-setup.exe.sha256','manifest.json']);
  const checked=await contracts.verifyPackage(f.out,r,{manifestHash:result.manifestHash});
  assert.equal(checked.manifest.commit,commit);assert.equal(checked.assets[0].sha256,sha(f.installer));
  assert.equal(JSON.stringify(checked.manifest).includes(f.root),false);
  await assert.rejects(()=>contracts.createPackage(f.root,f.out,r,{payloadPath:f.payload,tree:'c'.repeat(40)}));
});
test('version mismatch, enabled updater, metadata mismatch and private embedded payload cannot be packaged',async t=>{
  assert.equal(typeof contracts.createPackage,'function');
  for(const kind of ['version','key','gate','metadata','payload']){const f=await fixture(t);
    if(kind==='version')await fs.writeFile(path.join(f.root,'version.json'),'{"version":"1.1.0"}');
    if(kind==='key')await fs.writeFile(path.join(f.root,'src-tauri/src/update_package.rs'),'fn production_key() -> Option<TrustedKey> { Some(test_key) }');
    if(kind==='gate')await fs.writeFile(path.join(f.root,'src-tauri/src/startup_update.rs'),'const HANDOFF_RELEASE_VALIDATED: bool = true;');
    if(kind==='metadata')await fs.writeFile(path.join(f.root,'build/installer-build-info.json'),JSON.stringify({...f.metadata,sha256:'0'.repeat(64)}));
    if(kind==='payload')await fs.appendFile(f.payload,Buffer.from(['C:', 'Users','fixture'].join(String.fromCharCode(92)),'utf16le'));
    await assert.rejects(()=>contracts.createPackage(f.root,f.out,request(),{payloadPath:f.payload,tree:'c'.repeat(40)}));
  }
});
test('downloaded packages refuse changed bytes, wrong manifest/run binding and extra/symlink files',async t=>{
  assert.equal(typeof contracts.createPackage,'function');
  for(const kind of ['bytes','manifest','run','extra','symlink']){const f=await fixture(t),r=request();const result=await contracts.createPackage(f.root,f.out,r,{payloadPath:f.payload,tree:'c'.repeat(40)});
    if(kind==='bytes')await fs.appendFile(path.join(f.out,'Nearly_r1.0_x64-setup.exe'),'changed');
    if(kind==='manifest')await fs.appendFile(path.join(f.out,'manifest.json'),' ');
    if(kind==='run')r.runId='124';
    if(kind==='extra')await fs.writeFile(path.join(f.out,'settings.json'),'{}');
    if(kind==='symlink'){await fs.unlink(path.join(f.out,'Nearly_r1.0_x64-setup.exe'));await fs.symlink(path.join(f.root,'build'),path.join(f.out,'Nearly_r1.0_x64-setup.exe'),'junction');}
    await assert.rejects(()=>contracts.verifyPackage(f.out,r,{manifestHash:result.manifestHash}));
  }
});

function packageFor(r=request()) {const data=Buffer.from('generated installer fixture');const name='Nearly_r1.0_x64-setup.exe';const checksum=Buffer.from(`${sha(data)}  ${name}\n`);const assets=[{name,data},{name:name+'.sha256',data:checksum}].map(a=>({...a,bytes:a.data.length,sha256:sha(a.data)}));return {manifest:{schemaVersion:1,repository:r.repository,commit:r.commit,tree:'c'.repeat(40),tag:r.tag,version:r.version,workflowCommit:r.workflowCommit,runId:r.runId,assets:assets.map(({data,...a})=>a)},assets};}
function remote(){
  const s={tag:null,release:null,bytes:new Map(),writes:[],interrupt:false};
  const api={async get(p){if(p==='')return {full_name:'nea-c/Nearly',private:false};if(p.startsWith('/git/commits/'))return {sha:commit,tree:{sha:'c'.repeat(40)}};if(p.startsWith('/contents/version.json'))return {encoding:'base64',content:Buffer.from('{"version":"1.0.0"}').toString('base64')};if(p.startsWith('/releases?'))return s.release?[s.release]:[];if(p.startsWith('/git/ref/'))return s.tag;if(p==='/releases/7')return s.release;throw Error('Unexpected read '+p);},
    async create(p,body){s.writes.push(['create',p]);if(p==='/git/refs'){s.tag={object:{type:'commit',sha:body.sha}};return s.tag;}if(p==='/releases'){assert.equal(body.prerelease,false);assert.equal(Object.hasOwn(body,'make_latest'),false,'stable draft creation keeps historical API parameters');s.release={...body,id:7,assets:[],html_url:'https://github.com/nea-c/Nearly/releases/tag/r1.0',upload_url:'https://uploads.github.com/repos/nea-c/Nearly/releases/7/assets{?name,label}'};return s.release;}throw Error('Unexpected create');},
    async upload(release,a){s.writes.push(['upload',a.name]);const id=s.bytes.size+1;s.bytes.set(a.name,Buffer.from(a.data));const uploaded={name:a.name,id,size:a.bytes,digest:'sha256:'+a.sha256,state:'uploaded',browser_download_url:'https://github.com/nea-c/Nearly/releases/download/r1.0/'+a.name};s.release.assets.push(uploaded);if(s.interrupt){s.interrupt=false;throw Error('uncertain upload outcome');}return uploaded;},
    async patch(p,body){s.writes.push(['publish',p]);s.release={...s.release,...body};return s.release;}};
  return {s,api,download:async a=>s.bytes.get(a.name)};
}
test('publisher refuses validation mode before any remote write',async()=>{assert.equal(typeof publisher.publishRelease,'function');const r=request('validate'),x=remote();await assert.rejects(()=>publisher.publishRelease({request:r,bundle:packageFor(r),notes:'Public notes',...x}));assert.equal(x.s.writes.length,0);});
test('stable publish binds tag, uploads exactly two assets and then publishes, without overwrites',async()=>{assert.equal(typeof publisher.publishRelease,'function');const x=remote(),r=request();await publisher.publishRelease({request:r,bundle:packageFor(r),notes:'Public notes',...x});assert.equal(x.s.tag.object.sha,commit);assert.equal(x.s.release.draft,false);assert.equal(x.s.release.prerelease,false);assert.deepEqual(x.s.writes.map(v=>v[0]),['create','create','upload','upload','publish']);});
test('uncertain upload is read back on same-run retry, never duplicated; completed retry writes nothing',async()=>{assert.equal(typeof publisher.publishRelease,'function');const x=remote(),r=request(),b=packageFor(r);x.s.interrupt=true;await assert.rejects(()=>publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x}),/uncertain/);assert.equal(x.s.release.draft,true);await publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x});const count=x.s.writes.length;await publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x});assert.equal(x.s.writes.length,count);assert.equal(x.s.writes.filter(v=>v[0]==='upload').length,2);});
test('foreign tag, foreign draft, changed asset or another run cannot be overwritten or published',async()=>{assert.equal(typeof publisher.publishRelease,'function');for(const kind of ['tag','draft','asset','run']){const x=remote(),r=request(),b=packageFor(r);if(kind==='tag')x.s.tag={object:{type:'commit',sha:'d'.repeat(40)}};else{ x.s.interrupt=true;await assert.rejects(()=>publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x}));if(kind==='draft')x.s.release.body='foreign draft';if(kind==='asset')x.s.release.assets[0].digest='sha256:'+'f'.repeat(64);if(kind==='run')r.runId='999';}const count=x.s.writes.length;await assert.rejects(()=>publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x}));assert.equal(x.s.writes.length,count);assert.ok(!x.s.release||x.s.release.draft);}});
test('a tag disappearing before publication preserves the draft and never recreates or publishes it',async()=>{const x=remote(),r=request();const get=x.api.get;let reads=0;x.api.get=async p=>{if(p.startsWith('/git/ref/')&&++reads>1)return null;return get(p)};await assert.rejects(()=>publisher.publishRelease({request:r,bundle:packageFor(r),notes:'Public notes',...x}));assert.equal(x.s.release.draft,true);assert.equal(x.s.writes.some(w=>w[0]==='publish'),false);});
test('remote repository, source tree or version mismatch causes zero writes',async()=>{for(const kind of ['repo','tree','version']){const x=remote(),r=request(),get=x.api.get;x.api.get=async p=>{if(kind==='repo'&&p==='')return {full_name:'nea-c/Nearly',private:true};if(kind==='tree'&&p.startsWith('/git/commits'))return {sha:commit,tree:{sha:'f'.repeat(40)}};if(kind==='version'&&p.startsWith('/contents/'))return {encoding:'base64',content:Buffer.from('{"version":"2.0.0"}').toString('base64')};return get(p)};await assert.rejects(()=>publisher.publishRelease({request:r,bundle:packageFor(r),notes:'Public notes',...x}));assert.equal(x.s.writes.length,0);}});
test('failed public download is reported after publication; retry verifies without remote mutation',async()=>{const x=remote(),r=request(),b=packageFor(r);await assert.rejects(()=>publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x,download:async()=>Buffer.from('wrong bytes')}),/downloaded/);assert.equal(x.s.release.draft,false);const count=x.s.writes.length;await publisher.publishRelease({request:r,bundle:b,notes:'Public notes',...x});assert.equal(x.s.writes.length,count);});
test('history object parser inspects complete blobs and rejects truncated or credential-containing records',()=>{const body=Buffer.from('public fixture');const raw=Buffer.concat([Buffer.from(`${commit} blob ${body.length}\n`),body,Buffer.from('\n')]);assert.equal(contracts.auditGitObjects(raw),1);assert.throws(()=>contracts.auditGitObjects(raw.subarray(0,raw.length-2)));const secret=Buffer.from('gh'+'p_'+'x'.repeat(40));assert.throws(()=>contracts.auditGitObjects(Buffer.concat([Buffer.from(`${commit} blob ${secret.length}\n`),secret,Buffer.from('\n')])));});
test('real Git preflight accepts root tree records and still audits the complete committed blob history',async t=>{
  const f=await fixture(t);const git=args=>execFileSync('git',['-C',f.root,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  await fs.writeFile(path.join(f.root,'.gitignore'),'/build/\n/payload.exe\n');
  git(['init','-b','main']);git(['config','user.name','Generated fixture']);git(['config','user.email','fixture@users.noreply.github.com']);
  git(['add','--','.gitignore','version.json','src-tauri/src/update_package.rs','src-tauri/src/startup_update.rs']);git(['commit','-m','Generated release fixture']);
  const r={...request(),commit:git(['rev-parse','HEAD'])};git(['update-ref','refs/remotes/origin/main',r.commit]);
  assert.match(await contracts.auditSource(f.root,r),/^[a-f0-9]{40}$/);
  await fs.writeFile(path.join(f.root,'public.txt'),['C:','Users','private-person','secret-folder'].join(String.fromCharCode(92)));
  git(['add','--','public.txt']);git(['commit','-m','Generated privacy rejection fixture']);r.commit=git(['rev-parse','HEAD']);git(['update-ref','refs/remotes/origin/main',r.commit]);
  await assert.rejects(()=>contracts.auditSource(f.root,r),/privacy/i);
});
test('only exact reviewed public source-example blobs get narrow path exceptions, never binary payloads or changed blobs',async()=>{
  for(const name of ['src-tauri/windows/template.test.mjs','src-tauri/windows/upstream/utils.nsh']){
    let source=(await fs.readFile(new URL(name==='src-tauri/windows/template.test.mjs'?'./fixtures/reviewed-public-template.txt':'../'+name,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
    if(name==='src-tauri/windows/template.test.mjs'){
      // Frozen already-public blob: active installer tests evolve independently.
      assert.equal(contracts.sha256(Buffer.from(source)),'e4ba4a3e32f236b5037afc0951bc01301eeb7f986b4764f026f7c82b9c04b92e');
    }
    const data=Buffer.from(source);
    assert.throws(()=>contracts.auditBytes(data),/privacy/i);
    const record=b=>Buffer.concat([Buffer.from(`${commit} blob ${b.length}\n`),b,Buffer.from('\n')]);
    assert.equal(contracts.auditGitObjects(record(data)),1);
    const changed=Buffer.concat([data,Buffer.from('\n'+['C:','Users','private-person','secret-folder'].join(String.fromCharCode(92)))]);
    assert.throws(()=>contracts.auditGitObjects(record(changed)),/privacy/i);
  }
});

test('normal GitHub merge committer is public while private or Github-style author identities still fail',async t=>{
  for(const kind of ['github-committer','private-committer','github-author']){
    const f=await fixture(t),git=(args,extra={})=>execFileSync('git',['-C',f.root,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe'],...extra}).trim();
    await fs.writeFile(path.join(f.root,'.gitignore'),'/build/\n/payload.exe\n');
    git(['init','-b','main']);git(['config','user.name','Generated fixture']);git(['config','user.email','fixture@users.noreply.github.com']);
    git(['add','.gitignore','version.json','src-tauri/src/update_package.rs','src-tauri/src/startup_update.rs']);
    const env={...process.env,GIT_COMMITTER_EMAIL:kind==='private-committer'?'fixture@example.invalid':'noreply@github.com'};
    if(kind==='github-author')env.GIT_AUTHOR_EMAIL='noreply@github.com';
    git(['commit','-m','Generated commit identity fixture'],{env});
    const r={...request(),commit:git(['rev-parse','HEAD'])};git(['update-ref','refs/remotes/origin/main',r.commit]);
    if(kind==='github-committer')assert.match(await contracts.auditSource(f.root,r),/^[a-f0-9]{40}$/);
    else await assert.rejects(()=>contracts.auditSource(f.root,r),/non-public commit email/);
  }
});
test('GitHub adapter never retries failed writes and rejects foreign upload endpoints before sending credentials',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('unavailable',{status:503});});
  const api=publisher.githubApi('generated-ephemeral-token');
  await assert.rejects(()=>api.create('/git/refs',{ref:'refs/tags/r1.0',sha:commit}),/503/);assert.equal(calls,1);
  await assert.rejects(()=>api.upload({id:7,upload_url:'https://foreign.invalid/upload'},packageFor().assets[0]),/endpoint/);assert.equal(calls,1);
});
test('GitHub adapter tolerates only missing tag reads and bounds untrusted JSON responses',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('missing',{status:404}));const api=publisher.githubApi('generated-ephemeral-token');
  assert.equal(await api.get('/git/ref/tags/r1.0'),null);await assert.rejects(()=>api.get(''),/404/);
  globalThis.fetch=async()=>new Response(Buffer.alloc(4*1024*1024+1,65));await assert.rejects(()=>api.get('/releases'),/budget/);
});
test('public download follows only trusted HTTPS hosts and never sends authentication',async t=>{
  const b=packageFor().assets[0],url='https://github.com/nea-c/Nearly/releases/download/r1.0/'+b.name;let calls=0;
  t.mock.method(globalThis,'fetch',async(u,options)=>{assert.equal(options.headers,undefined);calls++;if(calls===1)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/generated'}});return new Response(b.data);});
  assert.deepEqual(await publisher.downloadPublic({...b,browser_download_url:url}),b.data);assert.equal(calls,2);
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'https://foreign.invalid/generated'}});
  await assert.rejects(()=>publisher.downloadPublic({...b,browser_download_url:url}),/redirect/);
});

test('reviewed protected-area fixture history remains exact and never exempts payloads or modified tests',async()=>{
 const source=Buffer.from((await fs.readFile(new URL('../src-tauri/windows/whole-folder.test.mjs',import.meta.url),'utf8')).replaceAll('\r\n','\n'));
 assert.equal(sha(source),'bf895b4812deede57739a46d698ebb56c4c8cfa308674740ffd4cd37cd832c81');
 const record=b=>Buffer.concat([Buffer.from(commit+' blob '+b.length+'\n'),b,Buffer.from('\n')]);
 assert.throws(()=>contracts.auditBytes(source),/privacy/i);
 assert.equal(contracts.auditGitObjects(record(source)),1);
 for(const changed of [Buffer.concat([source,Buffer.from('\n')]),Buffer.from(source.toString().replaceAll('Fixture','PrivatePerson')),Buffer.concat([source,Buffer.from(['C:','Users','private-person','private-folder'].join(String.fromCharCode(92)))])]){
  assert.throws(()=>contracts.auditGitObjects(record(changed)),/privacy/i);
 }
});

test('exact reviewed hosted guest source history never exempts changed blobs or payloads',async()=>{
 const source=await fs.readFile(new URL('./fixtures/reviewed-public-installer-qa.txt',import.meta.url));
 assert.equal(sha(source),'06a67db742b5753eb05d9c9f0279c51ed060641f8f65e505f110e5100d38187d');
 const record=b=>Buffer.concat([Buffer.from(commit+' blob '+b.length+'\n'),b,Buffer.from('\n')]);
 assert.throws(()=>contracts.auditBytes(source),/privacy/i);
 assert.equal(contracts.auditGitObjects(record(source)),1);
 assert.throws(()=>contracts.auditGitObjects(record(Buffer.concat([source,Buffer.from('\n')]))),/privacy/i);
 const privatePath=Buffer.from(['C:','Users','private-person','private-folder'].join(String.fromCharCode(92)));
 assert.throws(()=>contracts.auditGitObjects(record(Buffer.concat([source,privatePath]))),/privacy/i);
});
