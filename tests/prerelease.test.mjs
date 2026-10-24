import test from 'node:test';
import assert from 'node:assert/strict';
import {displayVersion,internalVersion,compareReleaseTags} from '../scripts/version.mjs';
import {parseSignedRequest} from '../.github/scripts/signed-release-contract.mjs';
import {parseRequest} from '../.github/scripts/release-contract.mjs';
const env={GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_SHA:'b'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'nea-c/Nearly/.github/workflows/release-signed-windows.yml@refs/heads/main',RELEASE_COMMIT:'a'.repeat(40),RELEASE_TAG:'r3.7-pre.1',RELEASE_MODE:'release',RELEASE_CONFIRM:'release r3.7-pre.1 '+'a'.repeat(40)};
test('canonical pre milestone maps losslessly and stable milestone sorts after pre',()=>{
 assert.equal(displayVersion('3.7.0-pre.1'),'r3.7-pre.1');assert.equal(internalVersion('r3.7-pre.1'),'3.7.0-pre.1');
 assert.equal(compareReleaseTags('r3.7','r3.7-pre.65535'),1);assert.equal(compareReleaseTags('r3.7-pre.2','r3.7-pre.1'),1);assert.equal(compareReleaseTags('r3.6','r3.7-pre.1'),-1);
 for(const tag of ['r3.7-pre.0','r3.7-pre.01','r3.7-beta.1','r3.7-pre.65536','r3.7-pre.1+build','r3.7-pre.1\n'])assert.throws(()=>internalVersion(tag));
});
test('only signed controller accepts pre and retains exact confirmation',()=>{
 const r=parseSignedRequest(env);assert.equal(r.version,'3.7.0-pre.1');assert.equal(r.tag,'r3.7-pre.1');assert.equal(r.mode,'release');
 assert.throws(()=>parseRequest(env));assert.throws(()=>parseSignedRequest({...env,RELEASE_CONFIRM:'release r3.7 '+env.RELEASE_COMMIT}));
});

import {publishSignedRelease} from '../.github/scripts/release-publish.mjs';
import {fixture} from './helpers/updater-proof-fixture.mjs';
import {sha256} from '../.github/scripts/release-contract.mjs';
import {publicKeySha256} from '../.github/scripts/release-trust.mjs';
test('signed pre publication is never latest and preserves stable latest identity',async()=>{
 const r=parseSignedRequest(env),file='Nearly_r3.7-pre.1_x64-setup.exe',payloadSha256='a'.repeat(64);
 const proof=fixture({comment:'version:3.7.0-pre.1\tfile:'+file+'\tpayload-sha256:'+payloadSha256+'\tupdater-protocol:3'});
 const raw=[proof.installer,Buffer.from(sha256(proof.installer)+'  '+file+'\n'),proof.signature];
 const assets=raw.map((data,i)=>({name:file+['','.sha256','.sig'][i],bytes:data.length,sha256:sha256(data),data}));
 const manifest={...r,tree:'d'.repeat(40),kind:'signed-updater',schemaVersion:1,publicKeySha256,payloadSha256,assets:assets.map(({data,...a})=>a)};
 let release=null,tag=null;const writes=[];let latest={tag_name:'r3.6',id:36,draft:false,prerelease:false};
 const api={get:async p=>{if(p==='/releases/latest')return latest;if(!p)return{full_name:r.repository,private:false};if(p.startsWith('/git/commits/'))return{sha:r.commit,tree:{sha:manifest.tree}};if(p.startsWith('/contents/'))return{encoding:'base64',content:Buffer.from(JSON.stringify({version:r.version})).toString('base64')};if(p.startsWith('/releases?'))return release?[release]:[];if(p.startsWith('/git/ref/'))return tag;if(p==='/releases/7')return release;throw Error('unexpected '+p);},create:async(p,b)=>{writes.push([p,b]);if(p==='/git/refs')return tag={object:{type:'commit',sha:r.commit}};release={...b,id:7,assets:[]};return release;},patch:async(p,b)=>{writes.push([p,b]);Object.assign(release,b);if(b.make_latest!=='false')latest=release;return release;},upload:async(_,a)=>{const asset={name:a.name,size:a.bytes,digest:'sha256:'+a.sha256,state:'uploaded'};release.assets.push(asset);return asset;}};
 await publishSignedRelease({request:r,bundle:{manifest,assets},notes:'Pre only',api,download:async a=>assets.find(x=>x.name===a.name).data,publicRaw:proof.publicRaw});
 assert.equal(release.prerelease,true);assert.equal(release.draft,false);assert.equal(release.make_latest,'false');assert.deepEqual(latest,{tag_name:'r3.6',id:36,draft:false,prerelease:false});
 assert.ok(writes.filter(([p])=>p==='/releases'||p==='/releases/7').every(([,b])=>b.prerelease===true&&b.make_latest==='false'));
});
