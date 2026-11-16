import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory,runFixtureTest} from './native-test-process.mjs';
for(const mode of ['complete','missing','symlink','ancestor']) {
 const out=fixtureDirectory('download-inventory-'+mode);
 const fixture=await createFixture(out,{mapStat(p,a){return mode==='ancestor'&&p==='/bench'?{...a,mode:0o120777}:a;},mapReadDir(p,entries){return entries.map(e=>mode==='missing'?{...e,attrs:{}}:mode==='symlink'&&e.filename==='f0'?{...e,attrs:{...e.attrs,mode:0o120777}}:e);}});
 try {
  for(const dir of ['bench/data','bench/dimensions/nested'])fs.mkdirSync(path.join(fixture.remote,dir),{recursive:true});
  for(let i=0;i<100;i++)fs.writeFileSync(path.join(fixture.remote,i<50?'bench/data':'bench/dimensions/nested','f'+i),'test');
  const manifest=path.join(out,'fixture.json');fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,root:out,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint,mode}));
  assert.equal(await runFixtureTest('generated_download_inventory_roundtrips',{NEARLY_TRANSFER_FIXTURE:manifest},out),0);
  if(mode==='complete')assert.equal(fixture.requestCounts.LSTAT,4,'Only common ancestors and selected roots require LSTAT, not listed descendants');
  if(mode==='missing')assert.equal(fixture.requestCounts.LSTAT,105,'Missing listing attributes fall back only at the affected entries');
  assert.equal(fixture.requestCounts.READ??0,0);assert.equal(fixture.requestCounts.WRITE??0,0);
  console.log(JSON.stringify({mode,requests:fixture.requestCounts}));
 }finally{await fixture.close();}
}
// Exercise the real RemoteReader too: READDIR owner fields are optional in SFTP.
{
 const out=fixtureDirectory('download-listed-owner');
 const fixture=await createFixture(out,{mapReadDir(_p,entries){return entries.map(e=>{const {uid,gid,...attrs}=e.attrs;return {...e,attrs};});}});
 try {
  const manifest=path.join(out,'fixture.json');
  fs.writeFileSync(manifest,JSON.stringify({generatedOnly:true,root:out,remote:fixture.remote,port:fixture.port,key:fixture.ppk3,passphrase:fixture.passphrase,fingerprint:fixture.fingerprint}));
  assert.equal(await runFixtureTest('generated_transfer_virtual_remote_streams_and_explicit_release',{NEARLY_TRANSFER_FIXTURE:manifest},out),0);
  console.log(JSON.stringify({mode:'stream-without-listed-owner',requests:fixture.requestCounts}));
 }finally{await fixture.close();}
}
