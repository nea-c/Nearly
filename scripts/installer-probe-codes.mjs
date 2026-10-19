// Diagnostic mock setups only. No filesystem effects and no production use.
const fail=()=>{throw Error('Actual template does not match diagnostic code contract');};
function once(text,needle,value){const parts=text.split(needle);if(parts.length!==2)fail();return parts.join(value);}
export const diagnosticCodes=Object.freeze({51:'registration-incomplete',52:'registration-owner',53:'requested-root',54:'uninstall-command',55:'registered-root-pin',56:'registered-root-missing'});
export function instrumentProbeTemplate(text){
 if(typeof text!=='string'||text.length>256*1024||text.includes('NearlyProbeCode'))fail();
 let result=text.replaceAll('\r\n','\n');
 result=once(result,'Var NearlyPendingBuffer\n','Var NearlyPendingBuffer\nVar NearlyProbeCode\n');
 for(const name of ['.onInit','un.onInit'])result=once(result,`Function ${name}\n`,`Function ${name}\n  StrCpy $NearlyProbeCode 5\n`);
 const resolver=/Function NearlyResolveRegistration\n([\s\S]*?)FunctionEnd/;
 if(!resolver.test(result))fail();
 result=result.replace(resolver,(_,body)=>{
  body='  StrCpy $NearlyProbeCode 51\n'+body;
  body=once(body,'  nearly_resolve_owned:\n','  nearly_resolve_owned:\n  StrCpy $NearlyProbeCode 52\n');
  body=once(body,'  StrCpy $NearlyRegisteredRoot $1\n','  StrCpy $NearlyRegisteredRoot $1\n  StrCpy $NearlyProbeCode 53\n');
  body=once(body,'  nearly_resolve_use:\n','  nearly_resolve_use:\n  StrCpy $NearlyProbeCode 54\n');
  body=once(body,'  Call NearlyPinRoot\n','  StrCpy $NearlyProbeCode 55\n  Call NearlyPinRoot\n  StrCpy $NearlyProbeCode 56\n');
  if(body.split('  Return\n').length!==3)fail();
  body=body.replaceAll('  Return\n','  StrCpy $NearlyProbeCode 5\n  Return\n');
  return 'Function NearlyResolveRegistration\n'+body+'FunctionEnd';
 });
 const reject=/Function \$\{prefix\}NearlyRejectRoot\n([\s\S]*?)FunctionEnd/;
 if(!reject.test(result))fail();
 result=result.replace(reject,(_,body)=>'Function ${prefix}NearlyRejectRoot\n'+once(body,'  SetErrorLevel 5\n','  SetErrorLevel $NearlyProbeCode\n')+'FunctionEnd');
 return result;
}
