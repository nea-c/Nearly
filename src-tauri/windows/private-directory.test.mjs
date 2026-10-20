import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const source=()=>fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const token=kind=>`${kind}.${'a'.repeat(32)}.${'b'.repeat(64)}`;
// Execute production NSIS decisions. Only the external read-only planner,
// mutation worker and dialog are simulated; no generated installer is run.
function decision(name,{code=10,kind='empty',accept=true,silent=false,variables={}}={}){
 const match=source().match(new RegExp(`Function ${name}\\r?\\n([\\s\\S]*?)FunctionEnd`));assert.ok(match,`Missing ${name}`);
 const lines=match[1].split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith(';'));
 const vars={INSTDIR:'D:\\Nearly',NearlyPolicyPath:'C:\\Readonly\\policy.exe',NearlyPassive:'0',NearlyConsentPath:'',NearlyConsentToken:'',...variables},stack=[],events=[];
 const expand=s=>s.replace(/^("|')(.*)\1$/,'$2').replace(/\$(\w+)/g,(_,key)=>String(vars[key]??''));
 const jump=(to,pc)=>!to||to==='0'?pc+1:/^[+-]\d+$/.test(to)?pc+Number(to):lines.indexOf(to+':')+1;
 let pc=0,budget=200;
 while(pc<lines.length){assert.ok(budget--);const line=lines[pc];if(line.endsWith(':')){pc++;continue;}const [op,...a]=line.match(/"[^"]*"|'[^']*'|\S+/g);
  switch(op){
   case 'StrCpy':{const value=expand(a[1]),start=Number(a[3]??0);vars[a[0].slice(1)]=a[2]===undefined?value:value.slice(start,start+Number(a[2]));pc++;break;}
   case 'StrCmp':case 'StrCmpS':{let left=expand(a[0]),right=expand(a[1]);if(op==='StrCmp'){left=left.toLowerCase();right=right.toLowerCase();}pc=jump(left===right?a[2]:a[3],pc);break;}
   case 'IfSilent':pc=jump(silent?a[0]:a[1],pc);break;
   case 'Goto':pc=jump(a[0],pc);break;
   case 'Pop':vars[a[0].slice(1)]=stack.pop();pc++;break;
   case '${GetParent}':vars[a[1].slice(1)]=expand(a[0]).slice(0,expand(a[0]).lastIndexOf('\\'));pc++;break;
   case 'Call':events.push(a[0]);if(a[0]==='NearlyRejectRoot')return {aborted:true,vars,events};assert.ok(['NearlyEnsurePolicyHelper','NearlyPinRoot','NearlyRequireFreshContents','NearlyCleanupPolicyHelper'].includes(a[0]));if(a[0]==='NearlyPinRoot')vars.NearlyRootMissing='0';pc++;break;
   case 'nsExec::ExecToStack':events.push(expand(a[0]));stack.push(name==='NearlyPrepareFreshRoot'?'':token(kind),String(code));pc++;break;
   case 'MessageBox':events.push('consent');pc=accept?jump(a[a.indexOf('IDYES')+1],pc):pc+1;break;
   case 'Return':return {aborted:false,vars,events};
   case 'Abort':return {aborted:true,vars,events};
   default:assert.fail('Unsupported decision instruction '+line);
  }
 }
 return {aborted:false,vars,events};
}
test('D Nearly consent is explicit and binds the exact selected root and worker token',()=>{
 const result=decision('NearlyCheckFreshPlan');assert.equal(result.aborted,false);assert.equal(result.vars.NearlyConsentPath,'D:\\Nearly');assert.equal(result.vars.NearlyConsentToken,token('empty'));assert.equal(result.vars.NearlyPreservedRoot,'D:\\.Nearly-preserved-'+ 'a'.repeat(32));assert.ok(result.events.includes('consent'));assert.ok(result.events.some(e=>e.includes('--nearly-install-check "D:\\Nearly"')));assert.ok(!result.events.some(e=>e.includes('--nearly-install-prepare')));
});
test('declined, silent and passive preparation never obtains consent or mutates folders',()=>{
 for(const options of [{accept:false},{silent:true},{variables:{NearlyPassive:'1'}}]){const r=decision('NearlyCheckFreshPlan',options);assert.equal(r.aborted,true);assert.equal(r.vars.NearlyConsentToken,'');assert.ok(!r.events.some(e=>e.includes('--nearly-install-prepare')));}
});
test('already private empty folders need no permission consent; unsafe folders remain refused',()=>{
 const ready=decision('NearlyCheckFreshPlan',{code:0,kind:'ready'});assert.equal(ready.aborted,false);assert.ok(!ready.events.includes('consent'));assert.equal(ready.vars.NearlyConsentToken,token('ready'));
 for(const code of [5,8,'error'])assert.equal(decision('NearlyCheckFreshPlan',{code}).aborted,true);
});
test('Back preserves same-path consent; preparing a different path is rejected before worker launch',()=>{
 const variables={NearlyConsentPath:'D:\\Nearly',NearlyConsentToken:token('empty')};const back=decision('NearlyCheckFreshPlan',{variables});assert.equal(back.aborted,false);assert.deepEqual(back.events,[]);
 const changed=decision('NearlyPrepareFreshRoot',{variables:{...variables,INSTDIR:'D:\\Other'}});assert.equal(changed.aborted,true);assert.ok(!changed.events.some(e=>e.includes('--nearly-install-prepare')));
});
test('only successful preparation is followed by final private-root admission',()=>{
 const variables={NearlyConsentPath:'D:\\Nearly',NearlyConsentToken:token('new')};const good=decision('NearlyPrepareFreshRoot',{code:0,variables});assert.equal(good.aborted,false);assert.ok(good.events.some(e=>e.includes('--nearly-install-prepare "D:\\Nearly"')));assert.deepEqual(good.events.slice(-2),['NearlyPinRoot','NearlyRequireFreshContents']);
 const failed=decision('NearlyPrepareFreshRoot',{code:5,variables});assert.equal(failed.aborted,true);assert.ok(!failed.events.includes('NearlyPinRoot'));
});
test('private ready roots preserve default-data reinstall through the existing content whitelist without preparation',()=>{
 const r=decision('NearlyPrepareFreshRoot',{variables:{NearlyConsentPath:'D:\\Nearly',NearlyConsentToken:token('ready')}});
 assert.equal(r.aborted,false);assert.deepEqual(r.events,['NearlyPinRoot','NearlyRequireFreshContents']);
 const contents=source().match(/Function NearlyRequireFreshContents\r?\n([\s\S]*?)FunctionEnd/)[1];
 assert.match(contents,/StrCmp \$INSTDIR \$NearlyDefaultRoot 0 nearly_contents_bad/);
 assert.match(contents,/StrCmp \$NearlyEntry "settings.json" nearly_contents_file/);
});
test('fresh Install prepares before extraction; registered update and uninstall retain their guarded paths',()=>{
 const text=source(),section=text.slice(text.indexOf('Section Install'),text.indexOf('Section Uninstall'));
 assert.ok(section.indexOf('Call NearlyPrepareFreshRoot')>=0);assert.ok(section.indexOf('Call NearlyPrepareFreshRoot')<section.indexOf('Call NearlyExtractApplication'));
 assert.match(text,/NearlyProtectExisting[^\n]*NearlyPreservedRoot/);assert.match(text,/NearlyProtectNew[^\n]*INSTDIR/);
 assert.match(text,/Call un\.NearlyRequireStandardUser/);assert.match(text,/Call NearlyRequireStandardUser/);assert.match(text,/0x500C0040/);
});
test('policy helper keeps its namespace pins until both launches finish, including silent cleanup',()=>{
 const text=source();const helper=text.match(/Function NearlyEnsurePolicyHelper\r?\n([\s\S]*?)FunctionEnd/)[1];
 assert.match(helper,/StrCpy \$NearlyPolicyGuardHead \$NearlyGuardHead/);
 assert.doesNotMatch(helper,/Call NearlyReleaseGuards/);
 for(const callback of ['.onInstSuccess','.onInstFailed','.onGUIEnd']){
  const body=text.slice(text.indexOf('Function '+callback),text.indexOf('FunctionEnd',text.indexOf('Function '+callback)));
  assert.match(body,/Call NearlyCleanupPolicyHelper/);
 }
});
