import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as trust from '../.github/scripts/release-trust.mjs';
import * as policy from '../scripts/production-build-policy.mjs';
test('registered production accepts only enabled canonical gate and pinned key',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-production-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'.github'));await fs.mkdir(path.join(dir,'src-tauri/src'),{recursive:true});
 for(const f of ['.github/updater-public-key.pub','src-tauri/src/update_package.rs'])await fs.copyFile(new URL('../'+f,import.meta.url),path.join(dir,f));
 const gate=path.join(dir,'src-tauri/src/startup_update.rs'),good='pub const HANDOFF_RELEASE_VALIDATED:bool=true;';
 await fs.writeFile(gate,good);assert.equal(await trust.verifyProductionTrust(dir),true);await assert.rejects(()=>trust.verifyBootstrapTrust(dir));
 for(const bad of [good.replace('true','false'),'',good+'\n'+good, 'const FAKE:&str=\"'+good+'\";', 'const OPEN:&str=\"/*\";\n'+good.replace('true','false')+'\nconst CLOSE:&str=\"*/\";\nconst FAKE:&str=\"'+good+'\";', '// '+good, '/* '+good+' */',good.replace('true','1==1'),good+'\npub const HANDOFF_RELEASE_VALIDATED:bool=false;']){
  await fs.writeFile(gate,bad);await assert.rejects(()=>trust.verifyProductionTrust(dir));
 }
 await fs.writeFile(gate,'// pub const HANDOFF_RELEASE_VALIDATED:bool=false;\n'+good);assert.equal(await trust.verifyProductionTrust(dir),true);
 const key=path.join(dir,'src-tauri/src/update_package.rs');await fs.writeFile(key,(await fs.readFile(key,'utf8')).replace('bytes:PRODUCTION_KEY_BYTES','bytes:OTHER_KEY'));await assert.rejects(()=>trust.verifyProductionTrust(dir));
});
test('production build rejects guest-only inputs and retained QA payloads',()=>{
 assert.doesNotThrow(()=>policy.assertProductionEnvironment({}));
 for(const name of ['NEARLY_QA_BUILD_TOKEN','NEARLY_QA_PUBLIC_KEY','NEARLY_QA_SCENARIO'])assert.throws(()=>policy.assertProductionEnvironment({[name]:'value'}));
 assert.doesNotThrow(()=>policy.assertProductionPayload(Buffer.from('ordinary PE fixture')));
 for(const encoding of ['utf8','utf16le'])assert.throws(()=>policy.assertProductionPayload(Buffer.from(policy.qaBinaryMarker,encoding)));
});

test('production Cargo defaults cannot introduce the guest feature graph',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-defaults-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'src-tauri'));
 const file=path.join(dir,'src-tauri/Cargo.toml');
 await fs.writeFile(file,'[features]\ninstaller-qa = []\n');await policy.assertProductionDefaults(dir);
 for(const bad of ['[features]\ndefault=["installer-qa"]','[features]\n  default=["installer-qa"]','[features]\ndefault=["indirect"]\nindirect=["installer-qa"]','[package]\nname="fixture"']){await fs.writeFile(file,bad);await assert.rejects(()=>policy.assertProductionDefaults(dir));}
});
