// Generated loopback fixture only. Never loads settings or starts the Nearly UI.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './sftp-fixture.mjs';
import {fixtureDirectory, runFixtureTest} from './native-test-process.mjs';

const out = fixtureDirectory('transfer-progress');
const fixture = await createFixture(out, {
  mapStat(p, attrs) {
    if (p.startsWith('/metadata-missing/')) {const {size, ...missing}=attrs; return missing;}
    if (p.startsWith('/metadata-overflow/')) return {...attrs, size:2**63};
    if (p.startsWith('/metadata-imprecise/')) return {...attrs, size:p.endsWith('/first.bin')?Number.MAX_SAFE_INTEGER:1};
    return attrs;
  },
  async beforeWrite(p, offset) {
    await new Promise(resolve => setTimeout(resolve, 35));
    if (p.startsWith('/failed/') && offset >= 32768) return 4;
  },
  async beforeRead(p, offset) {
    await new Promise(resolve => setTimeout(resolve, 35));
    if (p.startsWith('/download-failed/') && offset >= 32768) return 4;
  },
  beforeRename(_from, to) {
    if (to === '/publish-failed/second.bin') throw Error('Generated publication rejection');
  },
});
for (const name of ['upload','legacy','failed','cancel','skip','publish-failed','empty']) {
  fs.mkdirSync(path.join(fixture.remote, name), {recursive:true});
}
const manifest = path.join(out, 'fixture.json');
fs.writeFileSync(manifest, JSON.stringify({
  generatedOnly:true, root:out, remote:fixture.remote, port:fixture.port,
  key:fixture.ppk3, passphrase:fixture.passphrase, fingerprint:fixture.fingerprint,
}));
let code, virtual, metadata;
try {
  code = await runFixtureTest('generated_transfer_progress_acknowledgements_and_aggregate', {
    NEARLY_PROGRESS_FIXTURE:manifest,
  }, out);
  assert.equal(code, 0);
  const virtualOutput = path.join(out, 'virtual');
  fs.mkdirSync(virtualOutput);
  virtual = await runFixtureTest('generated_transfer_virtual_remote_streams_and_explicit_release', {
    NEARLY_TRANSFER_FIXTURE:manifest,
  }, virtualOutput);
  assert.equal(virtual, 0);
  const metadataOutput=path.join(out,'metadata');
  fs.mkdirSync(metadataOutput);
  const opensBefore=fixture.requestCounts.OPEN??0;
  metadata=await runFixtureTest('generated_transfer_progress_rejects_invalid_metadata_before_mutation', {
    NEARLY_PROGRESS_FIXTURE:manifest,
  }, metadataOutput);
  assert.equal(metadata,0);
  assert.equal(fixture.requestCounts.OPEN??0,opensBefore,'invalid aggregate cannot open source streams or owned remote stages');
} finally {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({
    code, virtual, metadata, requests:fixture.requestCounts,
  }, null, 2));
  console.log('TRANSFER_PROGRESS_RESULTS', out);
  await fixture.close();
}
