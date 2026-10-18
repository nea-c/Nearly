const fail=m=>{throw Error(m);};
export function validateWorkflowRun(run,r){
  if(run?.id!==Number(r.runId)||run.run_attempt!==Number(r.runAttempt)||run.event!=='workflow_dispatch'||run.head_branch!=='main'||run.head_sha!==r.workflowCommit||run.path!=='.github/workflows/release-signed-windows.yml'||run.repository?.full_name!==r.repository||run.head_repository?.full_name!==r.repository)fail('Wrong server workflow/controller/run attempt');
  return true;
}
export async function verifySigningPolicy(r,api,{requireNewTarget=r.mode==='release'}={}){
  const repo=await api.get(''),main=await api.get('/branches/main'),environment=await api.get('/environments/nearly-updater-production'),branches=await api.get('/environments/nearly-updater-production/deployment-branch-policies?per_page=100');
  if(repo.full_name!==r.repository||repo.private!==false||repo.owner?.login!=='nea-c'||repo.owner.type!=='User'||repo.owner.id!==45559303||repo.default_branch!=='main'||!Number.isSafeInteger(repo.id)||repo.id<=0||main.name!=='main'||main.protected!==true)fail('Official public repository/protected main required');
  const reviewers=environment.protection_rules?.filter(p=>p.type==='required_reviewers');
  if(environment.name!=='nearly-updater-production'||environment.can_admins_bypass!==false||environment.deployment_branch_policy?.protected_branches!==false||environment.deployment_branch_policy?.custom_branch_policies!==true||reviewers?.length!==1||reviewers[0].prevent_self_review!==false||reviewers[0].reviewers?.length!==1||reviewers[0].reviewers[0].type!=='User'||reviewers[0].reviewers[0].reviewer?.id!==45559303||branches.total_count!==1||branches.branch_policies?.length!==1||branches.branch_policies[0].name!=='main'||branches.branch_policies[0].type!=='branch')fail('Signing Environment protection differs from approved policy');
  const commit=await api.get(`/git/commits/${r.commit}`),version=await api.get(`/contents/version.json?ref=${r.commit}`),comparison=await api.get(`/compare/${r.commit}...${r.workflowCommit}`);
  if(commit.sha!==r.commit||version.encoding!=='base64'||JSON.parse(Buffer.from(version.content,'base64')).version!==r.version||!['ahead','identical'].includes(comparison.status)||comparison.merge_base_commit?.sha!==r.commit)fail('Exact reviewed main-history source/version required');
  if(requireNewTarget&&((await api.get(`/git/ref/tags/${r.tag}`))||(await api.get(`/releases/tags/${r.tag}`))))fail('Release target already exists; preserve it and inspect before continuing');
  // Branch protection detail requires an Administration credential (anonymous
  // probe returns401). Do not add one to CI. Public protected state is checked;
  // owner approval must inspect full PR/admin/force/delete settings as well as
  // workflow/controller/source/artifact bindings. Environment is not workflow-scoped.
  return{repositoryId:repo.id};
}
