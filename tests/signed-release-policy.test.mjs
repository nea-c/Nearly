import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySigningPolicy,validateWorkflowRun} from '../.github/scripts/signed-release-policy.mjs';
const r={repository:'nea-c/Nearly',commit:'a'.repeat(40),workflowCommit:'b'.repeat(40),tag:'r3.1',version:'3.1.0',runId:'123',runAttempt:'2',mode:'release'};
function api(){return{async get(p){if(p==='')return {id:7,full_name:r.repository,private:false,default_branch:'main',owner:{login:'nea-c',type:'User',id:45559303}};
  if(p==='/branches/main')return{name:'main',protected:true};
  if(p==='/environments/nearly-updater-production')return{name:'nearly-updater-production',can_admins_bypass:false,deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{login:'nea-c',id:45559303}}]}]};
  if(p.includes('/deployment-branch-policies'))return{total_count:1,branch_policies:[{name:'main',type:'branch'}]};
  if(p.startsWith('/compare/'))return{status:'ahead',merge_base_commit:{sha:r.commit}};
  if(p.startsWith('/git/commits/'))return{sha:r.commit};
  if(p.startsWith('/contents/version.json'))return{encoding:'base64',content:Buffer.from('{"version":"3.1.0"}').toString('base64')};
  if(p.startsWith('/git/ref/tags/')||p.startsWith('/releases/tags/'))return null;throw Error('unexpected read '+p);}};}
test('public policy verifies protected main, exact environment approval/source/version and new target without admin credentials',async()=>{
  assert.equal((await verifySigningPolicy(r,api())).repositoryId,7);
  for(const kind of ['main','reviewer','branch','existing','source','version']){
    const a=api(),get=a.get;a.get=async p=>{const value=await get(p);if(kind==='main'&&p==='/branches/main')value.protected=false;if(kind==='reviewer'&&p==='/environments/nearly-updater-production')value.can_admins_bypass=true;if(kind==='branch'&&p.includes('deployment-branch-policies'))value.branch_policies[0].type='tag';if(kind==='existing'&&p.startsWith('/git/ref/tags/'))return {object:{sha:r.commit}};if(kind==='source'&&p.startsWith('/compare/'))value.merge_base_commit.sha='c'.repeat(40);if(kind==='version'&&p.startsWith('/contents/'))value.content=Buffer.from('{"version":"3.2.0"}').toString('base64');return value;};
    await assert.rejects(()=>verifySigningPolicy(r,a));
  }
});
test('server run must be this exact official manual workflow/controller and attempt',()=>{
  const run={id:123,run_attempt:2,event:'workflow_dispatch',head_branch:'main',head_sha:r.workflowCommit,path:'.github/workflows/release-signed-windows.yml',repository:{full_name:r.repository},head_repository:{full_name:r.repository}};
  assert.equal(validateWorkflowRun(run,r),true);
  for(const field of ['id','run_attempt','event','head_branch','head_sha','path'])assert.throws(()=>validateWorkflowRun({...run,[field]:'wrong'},r));
});

test('verification-only policy can sign the current version without reading or changing existing tags/releases',async()=>{
  const a=api(),get=a.get,reads=[];a.get=async p=>{reads.push(p);if(p.startsWith('/git/ref/')||p.startsWith('/releases/'))throw Error('Existing publication must stay untouched');return get(p);};
  assert.equal((await verifySigningPolicy({...r,mode:'verify-signature'},a)).repositoryId,7);
  assert.ok(reads.includes('/branches/main'));assert.ok(reads.some(p=>p.startsWith('/environments/')));
});
