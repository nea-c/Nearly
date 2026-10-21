import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const candidate=await import('../.github/scripts/candidate-build.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const root=fileURLToPath(new URL('../',import.meta.url));
const sha='a'.repeat(40),base='f93745aa6030f0c2b0a54d490cda0cdb143c2e6e';
const env={GITHUB_REPOSITORY:'nea-c/Nearly',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/codex/r33-candidate',GITHUB_WORKFLOW_REF:'nea-c/Nearly/.github/workflows/candidate-windows.yml@refs/heads/codex/r33-candidate',GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,CANDIDATE_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',RELEASE_MODE:'validate',RELEASE_TAG:'r3.3',RELEASE_CONFIRM:''};

test('admission audits source without requesting hosted output publication; host commands keep outputs',()=>{
  assert.equal(typeof candidate.candidateCommand,'function');
  assert.deepEqual(candidate.candidateCommand(['admission','source']),{command:'admission',source:'source',writeOutputs:false});
  assert.deepEqual(candidate.candidateCommand(['context']),{command:'context',writeOutputs:false});
  assert.deepEqual(candidate.candidateCommand(['preflight','source']),{command:'preflight',source:'source',writeOutputs:true});
  assert.deepEqual(candidate.candidateCommand(['package','source','output']),{command:'package',source:'source',output:'output',writeOutputs:true});
});

test('candidate commands reject signing, release, empty paths and unexpected arguments',()=>{
  assert.equal(typeof candidate.candidateCommand,'function');
  for(const args of [[],['sign','source'],['release','source'],['publish','source'],['context','source'],['admission'],['admission',''],['admission','source','output'],['preflight'],['preflight','source','output'],['package','source'],['package','source',''],['package','source','output','extra']])assert.throws(()=>candidate.candidateCommand(args),JSON.stringify(args));
});

test('candidate binds source and controller to the exact branch push or manual dispatch, unsigned r3.3 only',()=>{
  assert.equal(typeof candidate.candidateRequest,'function');
  for(const event of ['push','workflow_dispatch'])assert.deepEqual(candidate.candidateRequest({...env,GITHUB_EVENT_NAME:event},'3.3.0'),{repository:'nea-c/Nearly',commit:sha,tag:'r3.3',version:'3.3.0',mode:'validate',workflowCommit:sha,runId:'123',runAttempt:'1'});
});

test('candidate rejects stale source/controller SHA, forks, wrong workflow/ref, release events and versions',()=>{
  assert.equal(typeof candidate.candidateRequest,'function');
  for(const patch of [{GITHUB_SHA:'b'.repeat(40)},{GITHUB_WORKFLOW_SHA:'b'.repeat(40)},{CANDIDATE_SHA:'b'.repeat(40)},{CANDIDATE_SHA:sha+'\n'},{CANDIDATE_SHA:sha.toUpperCase()},{CANDIDATE_SHA:'main'},{GITHUB_REPOSITORY:'fork/Nearly'},{GITHUB_EVENT_NAME:'release'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_REF:'refs/heads/main'},{GITHUB_REF:'refs/tags/r3.3'},{GITHUB_WORKFLOW_REF:'nea-c/Nearly/.github/workflows/release-signed-windows.yml@refs/heads/main'},{GITHUB_RUN_ID:'0'},{GITHUB_RUN_ATTEMPT:'1\n'},{GITHUB_RUN_ID:'9007199254740992'},{RELEASE_MODE:'release'},{RELEASE_MODE:'verify-signature'},{RELEASE_CONFIRM:'release'},{RELEASE_TAG:'r3.2'}])assert.throws(()=>candidate.candidateRequest({...env,...patch},'3.3.0'),JSON.stringify(patch));
  for(const version of ['3.2.0','3.3.1','03.3.0','3.3.0\n'])assert.throws(()=>candidate.candidateRequest(env,version));
});

test('candidate refuses a supplied release commit that differs from its actual source',()=>{
  assert.equal(typeof candidate.candidateRequest,'function');
  assert.equal(candidate.candidateRequest({...env,RELEASE_COMMIT:sha},'3.3.0').commit,sha);
  for(const commit of ['b'.repeat(40),'',sha+'\n'])assert.throws(()=>candidate.candidateRequest({...env,RELEASE_COMMIT:commit},'3.3.0'));
});

async function sourceFixture(t){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nearly-candidate-contract-'));
  t.after(async()=>{
    const actual=await fs.realpath(temporary),parent=await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
    assert.match(path.basename(actual),/^nearly-candidate-contract-/);
    await fs.rm(actual,{recursive:true,force:true});
  });
  for(const file of ['.github/updater-public-key.pub','src-tauri/src/update_package.rs','src-tauri/src/startup_update.rs']){
    await fs.mkdir(path.dirname(path.join(temporary,file)),{recursive:true});
    await fs.copyFile(path.join(root,file),path.join(temporary,file));
  }
  await fs.writeFile(path.join(temporary,'version.json'),'{"version":"3.3.0"}');
  return temporary;
}

// The Git subprocess boundary is controlled because this suite must not create
// commits. Trust/version files and all history/path/privacy parsers remain real.
function gitFixture(overrides={}){
  const body=Buffer.from(overrides.blob??'public source');
  const object='b'.repeat(40),tree='c'.repeat(40);
  return (_root,args,options={})=>{
    const command=args.join(' ');
    if(command==='rev-parse HEAD')return Buffer.from(overrides.head??sha);
    if(command==='status --porcelain --untracked-files=all')return Buffer.from(overrides.status??'');
    if(command===`cat-file -e ${base}^{commit}`){if(overrides.missingBase)throw Error('Missing fixed public base');return Buffer.alloc(0);}
    if(command===`merge-base --is-ancestor ${base} ${sha}`){if(overrides.unrelated)throw Error('Candidate does not descend from public base');return Buffer.alloc(0);}
    if(command==='ls-files -z')return Buffer.from(overrides.names??'version.json\0');
    if(command===`log --format=%ae%n%ce ${sha}`)return Buffer.from(overrides.identities??'author@users.noreply.github.com\nnoreply@github.com\n');
    if(command===`rev-list --objects ${sha}`)return Buffer.from(overrides.objects??`${object} ${overrides.historyPath??'version.json'}\n`);
    if(command==='cat-file --batch'){
      assert.equal(options.input,object+'\n');
      return Buffer.concat([Buffer.from(`${object} blob ${body.length}\n`),body,Buffer.from('\n')]);
    }
    if(command==='rev-parse HEAD^{tree}')return Buffer.from(tree);
    throw Error('Unexpected Git command: '+command);
  };
}

test('candidate accepts descendant source outside main and returns its audited tree',async t=>{
  assert.equal(typeof candidate.auditCandidateSource,'function');
  const source=await sourceFixture(t),request=candidate.candidateRequest(env,'3.3.0');
  assert.equal(await candidate.auditCandidateSource(source,request,gitFixture()),'c'.repeat(40));
});

test('candidate refuses dirty/stale source, missing public base or unrelated ancestry',async t=>{
  assert.equal(typeof candidate.auditCandidateSource,'function');
  const source=await sourceFixture(t),request=candidate.candidateRequest(env,'3.3.0');
  for(const state of [{head:'b'.repeat(40)},{status:' M version.json'},{missingBase:true},{unrelated:true}])await assert.rejects(()=>candidate.auditCandidateSource(source,request,gitFixture(state)));
});

test('candidate retains canonical version and registered production gate checks',async t=>{
  assert.equal(typeof candidate.auditCandidateSource,'function');
  const source=await sourceFixture(t),request=candidate.candidateRequest(env,'3.3.0');
  await fs.writeFile(path.join(source,'version.json'),'{"version":"3.2.0"}');
  await assert.rejects(()=>candidate.auditCandidateSource(source,request,gitFixture()),/version/i);
  await fs.writeFile(path.join(source,'version.json'),'{"version":"3.3.0"}');
  await fs.writeFile(path.join(source,'src-tauri/src/startup_update.rs'),'pub const HANDOFF_RELEASE_VALIDATED: bool = false;');
  await assert.rejects(()=>candidate.auditCandidateSource(source,request,gitFixture()),/gate/i);
});

test('candidate audits removed history paths, public identities and all blob encodings',async t=>{
  assert.equal(typeof candidate.auditCandidateSource,'function');
  const source=await sourceFixture(t),request=candidate.candidateRequest(env,'3.3.0');
  const personal=['C:','Users','private-person','project'].join(String.fromCharCode(92));
  for(const state of [{names:'build/output.exe\0'},{historyPath:'.ssh/id_rsa'},{identities:'private@example.invalid\nnoreply@github.com\n'},{identities:'author@users.noreply.github.com\nprivate@example.invalid\n'},{blob:personal},{blob:Buffer.from(personal,'utf16le')},{blob:Buffer.concat([Buffer.from([0]),Buffer.from(personal,'utf16le')])},{blob:'gh'+'p_'+'x'.repeat(40)}])await assert.rejects(()=>candidate.auditCandidateSource(source,request,gitFixture(state)),/source|history|privacy/i);
});
