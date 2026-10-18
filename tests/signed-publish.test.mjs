import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {publishSignedRelease} from '../.github/scripts/release-publish.mjs';
import {fixture} from './helpers/updater-proof-fixture.mjs';
import {main as signedMain} from '../.github/scripts/signed-release.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const r={repository:'nea-c/Nearly',commit:'a'.repeat(40),workflowCommit:'b'.repeat(40),runId:'123',runAttempt:'2',tag:'r3.1',version:'3.1.0',mode:'release'};
function bundle(){const f=fixture(),file=f.expected.file,check=Buffer.from(`${sha(f.installer)}  ${file}\n`);const assets=[{name:file,data:f.installer},{name:file+'.sha256',data:check},{name:file+'.sig',data:f.signature}].map(a=>({...a,bytes:a.data.length,sha256:sha(a.data)}));return{publicRaw:f.publicRaw,bundle:{manifest:{schemaVersion:1,kind:'signed-updater',...r,tree:'c'.repeat(40),publicKeySha256:'2592845a518adb9df5b7773dd58672ea411b3038758bfaf2808a3cb13dcc8695',payloadSha256:f.expected.payloadSha256,assets:assets.map(({data,...a})=>a)},assets}};}
function remote(){
  const state={tag:null,release:null,bytes:new Map(),writes:[],reads:0,interrupt:false};
  const api={async get(p){state.reads++;if(p==='')return{full_name:r.repository,private:false};if(p.startsWith('/git/commits/'))return{sha:r.commit,tree:{sha:'c'.repeat(40)}};if(p.startsWith('/contents/version.json'))return{encoding:'base64',content:Buffer.from('{"version":"3.1.0"}').toString('base64')};if(p.startsWith('/releases?'))return state.release?[state.release]:[];if(p.startsWith('/git/ref/'))return state.tag;if(p==='/releases/7')return state.release;throw Error('unexpected read');},
    async create(p,b){state.writes.push(p);if(p==='/git/refs'){state.tag={object:{type:'commit',sha:b.sha}};return state.tag;}state.release={...b,id:7,assets:[],upload_url:'https://uploads.github.com/repos/nea-c/Nearly/releases/7/assets{?name,label}'};return state.release;},
    async upload(release,a){state.writes.push(a.name);state.bytes.set(a.name,a.data);const uploaded={id:state.bytes.size,name:a.name,state:'uploaded',size:a.bytes,digest:'sha256:'+a.sha256,browser_download_url:`https://github.com/nea-c/Nearly/releases/download/${r.tag}/${a.name}`};state.release.assets.push(uploaded);if(state.interrupt&&a.name.endsWith('.sig')){state.interrupt=false;throw Error('uncertain upload');}return uploaded;},
    async patch(p,b){state.writes.push('publish');Object.assign(state.release,b);return state.release;}};
  return{state,api,download:async a=>state.bytes.get(a.name)};
}
test('signed publisher independently verifies before writes and publishes exactly installer/checksum/signature',async()=>{
  const b=bundle(),x=remote();await publishSignedRelease({request:r,...b,notes:'Generated public notes',...x});
  assert.equal(x.state.release.draft,false);assert.equal(x.state.release.assets.length,3);assert.ok(x.state.writes.at(-1)==='publish');
});
test('invalid cryptography, wrong key/attempt or validation request never starts remote writes',async()=>{
  for(const kind of ['signature','key','attempt','validate']){
    const b=bundle(),x=remote(),request={...r};if(kind==='signature'){b.bundle.assets[2].data=Buffer.from('invalid');b.bundle.assets[2].sha256=sha(b.bundle.assets[2].data);}if(kind==='key')b.publicRaw=bundle().publicRaw;if(kind==='attempt')request.runAttempt='3';if(kind==='validate')request.mode='validate';
    await assert.rejects(()=>publishSignedRelease({request,...b,notes:'notes',...x}));assert.equal(x.state.writes.length,0);
  }
});

test('verification-only request and artifact cannot publish or make any API call',async()=>{
  for(const which of ['request','artifact']){
    const b=bundle(),x=remote(),request={...r};
    if(which==='request')request.mode='verify-signature';else b.bundle.manifest.mode='verify-signature';
    await assert.rejects(()=>publishSignedRelease({request,...b,notes:'notes',...x}),/Only release/);
    assert.equal(x.state.reads,0);assert.equal(x.state.writes.length,0);
  }
  const env={GITHUB_REPOSITORY:r.repository,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_SHA:r.workflowCommit,GITHUB_RUN_ID:r.runId,GITHUB_RUN_ATTEMPT:r.runAttempt,GITHUB_WORKFLOW_REF:r.repository+'/.github/workflows/release-signed-windows.yml@refs/heads/main',RELEASE_COMMIT:r.commit,RELEASE_TAG:r.tag,RELEASE_MODE:'verify-signature',RELEASE_CONFIRM:`verify-signature ${r.tag} ${r.commit}`};
  await assert.rejects(()=>signedMain(['publish','unused'],env),/Only release/);
});
test('same exact-run uncertain signature upload resumes by metadata and never duplicates or overwrites',async()=>{
  const b=bundle(),x=remote();x.state.interrupt=true;await assert.rejects(()=>publishSignedRelease({request:r,...b,notes:'notes',...x}),/uncertain/);assert.equal(x.state.release.draft,true);
  await publishSignedRelease({request:r,...b,notes:'notes',...x});const count=x.state.writes.length;await publishSignedRelease({request:r,...b,notes:'notes',...x});assert.equal(x.state.writes.length,count);assert.equal(x.state.writes.filter(n=>n.endsWith('.sig')).length,1);
});
test('foreign tags/drafts/conflicting signature metadata are retained without any new write',async()=>{
  for(const kind of ['tag','draft','signature']){const b=bundle(),x=remote();
    if(kind==='tag')x.state.tag={object:{type:'commit',sha:'d'.repeat(40)}};else{x.state.interrupt=true;await assert.rejects(()=>publishSignedRelease({request:r,...b,notes:'notes',...x}));if(kind==='draft')x.state.release.body='foreign';else x.state.release.assets[2].digest='sha256:'+'f'.repeat(64);}
    const count=x.state.writes.length;await assert.rejects(()=>publishSignedRelease({request:r,...b,notes:'notes',...x}));assert.equal(x.state.writes.length,count);
  }
});
