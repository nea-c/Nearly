// Execute the actual bounded stage functions with generated API facts only.
// This is source/control-flow qualification, never actual NSIS execution.
import assert from 'node:assert/strict';
import path from 'node:path';
export function runStage(template, command, facts={}) {
  const nonce='a'.repeat(32),root='C:\\Fixture\\Local\\Nearly';
  const api={pid:'123',created:'134000000000000001',nonce,workerPid:'456',workerCreated:'134000000000000002',helperLive:true,authorize:true,readyFresh:true,candidateAttributes:16,...facts};
  const vars={INSTDIR:root,OUTDIR:root,NearlyUpdateMode:'0'},stack=[],effects=[];
  let authorizeOpens=0,authorizeWaits=0,helperWaits=0;
  let errors=false,errorLevel=0,aborted=false;
  const expand=text=>text.replace(/^"|"$/g,'').replace(/\$\{MAINBINARYNAME\}/g,'Nearly').replace(/\$\{MAINBINARYSRCPATH\}/g,'generated-input.exe').replace(/\$\{NSIS_MAX_STRLEN\}/g,'1024').replace(/\$(\w+)/g,(_,key)=>String(vars[key]??''));
  const fn=name=>template.match(new RegExp(`Function ${name.replaceAll('.','\\.')}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1];
  function linesOf(body) {
    return body.split(/\r?\n/).flatMap(line=>{
      line=line.trim(); if(!line||line.startsWith(';'))return [];
      const macro=line.match(/^!insertmacro NearlyStageDecimal (\$\w+) "(\d+)" (\w+)$/);
      if(!macro)return [line];
      const source=template.match(/!macro NearlyStageDecimal value maximum label\r?\n([\s\S]*?)!macroend/)?.[1];
      assert.ok(source,'actual decimal macro required');
      return linesOf(source.replaceAll('${value}',macro[1]).replaceAll('${maximum}',macro[2]).replaceAll('${label}',macro[3]));
    });
  }
  function execute(body) {
    const lines=linesOf(body);let pc=0,budget=20000;
    const jump=(label,index)=>{if(label===undefined||label==='0')return index+1;if(/^[+-]\d+$/.test(label))return index+Number(label);const at=lines.indexOf(label+':');assert.ok(at>=0,'unknown label '+label);return at+1;};
    const assign=(dest,value)=>{assert.match(dest,/^\$\w+$/);vars[dest.slice(1)]=String(value);};
    const condition=line=>{
      if(line==='${Errors}')return errors;
      const p=line.match(/^(\$\w+) = (\d+)$/);assert.ok(p,'unsupported condition '+line);return expand(p[1])===p[2];
    };
    while(pc<lines.length&&!aborted) {
      assert.ok(budget-->0,'stage interpreter budget exceeded');
      const line=lines[pc];if(line.endsWith(':')){pc++;continue;}
      const [op,...args]=line.match(/"[^"]*"|\S+/g);
      switch(op) {
        case '${If}':case '${IfNot}':{
          const result=condition(args.join(' '));if(result===(op==='${If}')){pc++;break;}
          let depth=1;while(depth){pc++;assert.ok(pc<lines.length);if(/^\$\{If(?:Not)?\}/.test(lines[pc]))depth++;if(lines[pc]==='${EndIf}')depth--;}pc++;break;
        }
        case '${EndIf}':pc++;break;
        case '${GetParameters}':assign(args[0],command);pc++;break;
        case '${GetOptions}':{
          const input=expand(args[0]),option=expand(args[1]);const tokens=input.split(/\s+/);const token=tokens.find(v=>v.startsWith(option));errors=!token;assign(args[2],token?token.slice(option.length):'');pc++;break;
        }
        case 'ClearErrors':errors=false;pc++;break;
        case 'StrCpy':{
          const value=expand(args[1]),start=args[3]===undefined?0:Number(expand(args[3]));
          assign(args[0],args[2]===undefined?value:value.slice(start,start+Number(expand(args[2]))));pc++;break;
        }
        case 'StrLen':assign(args[0],expand(args[1]).length);pc++;break;
        case 'StrCmp':case 'StrCmpS':{
          const a=expand(args[0]),b=expand(args[1]);pc=jump((op==='StrCmpS'?a===b:a.toLowerCase()===b.toLowerCase())?args[2]:args[3],pc);break;
        }
        case 'IntCmp':{
          const a=Number(expand(args[0])),b=Number(expand(args[1]));assert.ok(Number.isSafeInteger(a)&&Number.isSafeInteger(b));pc=jump(a===b?args[2]:a<b?args[3]:args[4],pc);break;
        }
        case 'IntOp':{
          const a=Number(expand(args[1])),b=Number(expand(args[3]));assert.ok(['+','-','&'].includes(args[2]));assign(args[0],args[2]==='+'?a+b:args[2]==='-'?a-b:a&b);pc++;break;
        }
        case 'Goto':pc=jump(args[0],pc);break;
        case 'Pop':assert.ok(stack.length);assign(args[0],stack.pop());pc++;break;
        case 'GetFullPathName':assign(args[0],path.win32.normalize(expand(args[1])));pc++;break;
        case 'SetSilent':effects.push({op});pc++;break;
        case 'Sleep':effects.push({op,milliseconds:Number(expand(args[0]))});pc++;break;
        case 'SetOutPath':{
          const target=expand(args[0]);effects.push({op,path:target});errors=!!api.setOutPathFailure;
          if(!errors)vars.OUTDIR=target;pc++;break;
        }
        case 'File':{
          const name=args.map(expand).find(v=>v.startsWith('/oname='));
          const filename=name?name.slice(7):path.win32.basename(expand(args.at(-1)));
          effects.push({op,path:path.win32.join(vars.OUTDIR,filename)});errors=!!api.payloadFailure;pc++;break;
        }
        case 'WriteUninstaller':effects.push({op,path:expand(args[0])});errors=!!api.uninstallerFailure;pc++;break;
        case 'SetErrorLevel':errorLevel=Number(args[0]);pc++;break;
        case 'Abort':aborted=true;break;
        case 'Return':return;
        case 'Call':assert.ok(fn(args[0]),'unknown actual function');execute(fn(args[0]));pc++;break;
        case 'System::Call':{
          const call=expand(line.slice('System::Call '.length).replace(/^'|'$/g,''));effects.push({op:'api',call});
          if(call.includes('::OpenProcess('))stack.push(BigInt(vars.NearlyParent||'0')===BigInt(api.pid)?100:0);
          else if(call.includes('::GetProcessTimes(')){const own=call.includes('p r0');vars['1']=own?api.workerCreated:api.created;vars['5']=(own?api.workerTimesFailure:api.helperTimesFailure)?'0':'1';}
          else if(call.includes('::QueryFullProcessImageNameW(')){vars['2']=api.helperPath??`${root}\\.Nearly-update-state\\${api.nonce}\\previous-image.exe`;vars['3']=api.queryImageFailure?'0':'1';}
          else if(call.includes('::WaitForSingleObject(')){
            const handle=Number(call.match(/\(p ([^,]+)/)[1]);
            if(handle===100)helperWaits++;if(handle===200)authorizeWaits++;
            const helperLive=api.helperLive&&(api.helperExitAfterWaits===undefined||helperWaits<=api.helperExitAfterWaits);
            const authorized=api.authorize&&authorizeWaits>(api.authorizeDelayWaits??0);
            vars[call.match(/i\.r(\d+)$/)[1]]=String(handle===100?(api.helperWaitFailure?0xffffffff:helperLive?258:0):handle===200?(api.authorizeWaitFailure?0xffffffff:authorized?0:258):handle===300?(api.readyFresh?258:0):0xffffffff);
          }
          else if(call.includes('::GetCurrentProcessId('))stack.push(api.workerPid);
          else if(call.includes('::GetCurrentProcess('))vars['0']='-1';
          else if(call.includes('::OpenEventW(')){
            const event=call.match(/w "([^"]+)"/)[1],suffix=`${api.nonce}-${api.eventWorkerPid??api.workerPid}-${api.eventWorkerCreated??api.workerCreated}`;
            if(event===`Local\\NearlyStageAuthorize-${suffix}`)authorizeOpens++;
            stack.push(event===`Local\\NearlyStageAuthorize-${suffix}`?(authorizeOpens>(api.eventMissingAttempts??0)?200:0):event===`Local\\NearlyStageReady-${suffix}`&&!api.missingReady?300:0);
          }
          else if(call.includes('::CloseHandle(')){}
          else if(call.includes('::GetFileAttributesW('))vars['5']=String(api.candidateAttributes);
          else if(call.includes('::SetEvent('))vars['1']=api.setReadyFails?'0':'1';
          else assert.fail('unsupported generated API '+call);
          pc++;break;
        }
        default:assert.fail('unsupported actual stage instruction: '+line);
      }
    }
  }
  execute(fn('NearlyStageUpdate'));
  if(!aborted&&vars.NearlyUpdateMode==='3') {
    const section=template.match(/Section Install\r?\n([\s\S]*?)SectionEnd/)?.[1];assert.ok(section);execute(section);
  }
  return {aborted,errorLevel,variables:vars,effects,writes:effects.filter(e=>e.op==='File'||e.op==='WriteUninstaller')};
}
