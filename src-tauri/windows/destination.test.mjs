import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const s=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
const body=n=>s.match(new RegExp(`Function ${n.replaceAll('.','\\.')}\\r?\\n([\\s\\S]*?)FunctionEnd`))?.[1]??'';

test('shortcut selections are captured before navigating Back to destination',()=>{
 assert.match(body('NearlyShortcutPage'),/NSD_OnBack\} NearlyShortcutPageLeave/);
 assert.match(body('NearlyShortcutPageLeave'),/NSD_GetState\} \$NearlyStartMenuCheckbox \$NearlyStartMenu/);
 assert.match(body('NearlyShortcutPageLeave'),/NSD_GetState\} \$NearlyDesktopCheckbox \$NearlyDesktop/);
});
test('fresh destination page precedes independent shortcuts and is locked for registered updates',()=>{
 assert.ok(s.indexOf('MUI_PAGE_DIRECTORY')<s.indexOf('Page custom NearlyShortcutPage'));
 assert.match(body('NearlyDirectoryPre'),/NearlyOwnedUpgrade/);
 assert.match(body('NearlyDirectoryPre'),/NearlyPassive/);
 assert.match(s,/スタートメニューに登録する/);assert.match(s,/デスクトップショートカットを作成する/);
});
test('registered resolution precedes stage authentication; ordinary effects stay after stage return',()=>{
 const init=body('.onInit');assert.ok(init.indexOf('Call NearlyResolveRegistration')>=0);
 assert.ok(init.indexOf('Call NearlyResolveRegistration')<init.indexOf('Call NearlyStageUpdate'));
 assert.match(body('NearlyResolveRegistration'),/NearlyRequestedRoot/);
 assert.match(body('NearlyResolveRegistration'),/NearlyRegisteredRoot/);
});
test('root guard pins ancestors and validates filesystem without private ACL admission or security changes',()=>{
 for(const token of ['GetDriveTypeW','GetFullPathNameW','GetFileInformationByHandle','GetTokenInformation','NearlyReleaseLeaf','0x02200000']) assert.ok(s.includes(token),token);
 assert.doesNotMatch(s,/SetSecurityInfo|SetNamedSecurityInfo|SetFileSecurity|icacls|takeown/i);
 assert.doesNotMatch(s,/NearlyCheckAcl|GetSecurityInfo|EqualSid/);
 assert.match(s,/CreateFileW\(w "\$NearlyWalk", i 0x81, i 3,/);
 assert.match(s,/NumberOfLinks|single-link/);
});
test('uninstall uses registered root plus original image directory and retains ancestors until nonrecursive removal',()=>{
 const init=body('un.onInit');assert.match(init,/NearlyRegisteredRoot/);assert.match(init,/\$EXEDIR/);
 const section=s.slice(s.indexOf('Section Uninstall'));
 assert.ok(section.indexOf('Call un.NearlyReleaseLeaf')<section.indexOf('RMDir "$INSTDIR"'));
 assert.doesNotMatch(section,/RMDir \/r|Delete.*settings/i);
});

// Execute the actual NSIS lexical validator against mocked read-only Win32 facts.
// OS calls are mocked here; a separate minimal native harness covers the System ABI.
function pathDecision(destination,{driveType=3,filesystem='NTFS',canonical=destination}={}) {
 const source=s.match(/Function \$\{prefix\}NearlyValidatePath\r?\n([\s\S]*?)FunctionEnd/)[1];
 const lines=source.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith(';'));
 const vars={INSTDIR:destination};let pc=0,budget=10000;
 const exp=t=>String(t??'').replace(/^"|"$/g,'').replaceAll('$$','$').replace(/\$\{NSIS_MAX_STRLEN\}/g,'1024').replace(/\$(\w+)/g,(_,k)=>String(vars[k]??''));
 const jump=t=>!t||t==='0'?pc+1:lines.indexOf(t+':')+1;
 while(pc<lines.length){assert.ok(budget-->0,'path validator terminates');const line=lines[pc];if(line.endsWith(':')){pc++;continue;}
  const [op,...a]=line.match(/"[^"]*"|\S+/g);
  switch(op){
   case 'StrLen':vars[a[0].slice(1)]=exp(a[1]).length;pc++;break;
   case 'StrCpy':{let v=exp(a[1]),n=a[2]===undefined?undefined:Number(exp(a[2])),start=a[3]===undefined?0:Number(exp(a[3]));if(start<0)start=v.length+start;vars[a[0].slice(1)]=n===undefined?v:v.slice(start,start+n);pc++;break;}
   case 'IntCmp':{const l=Number(exp(a[0])),r=Number(exp(a[1]));pc=jump(l===r?a[2]:l<r?a[3]:a[4]);break;}
   case 'IntOp':{const l=Number(exp(a[1])),r=Number(exp(a[3]));assert.ok(['+','&'].includes(a[2]));vars[a[0].slice(1)]=a[2]==='+'?l+r:l&r;pc++;break;}
   case 'StrCmp':pc=jump(exp(a[0]).toUpperCase()===exp(a[1]).toUpperCase()?a[2]:a[3]);break;
   case 'Goto':pc=jump(a[0]);break;
   case 'Call':assert.equal(a[0],'${prefix}NearlyRejectRoot');return false;
   case 'Return':return true;
   case 'System::Call':{
    if(line.includes('WideCharToMultiByte'))vars['0']=Buffer.byteLength(destination,'utf8')+1;
    else if(line.includes('lstrcmpiW')){const target=line.includes('"A"')?'A':'Z';vars['2']=String(vars['1']).toUpperCase().localeCompare(target);}
    else if(line.includes('GetStringTypeW')){vars['4']=1;vars['2']=/[\x00-\x1f\x7f]/.test(vars['1'])?32:0;}
    else if(line.includes('GetFullPathNameW')){vars['1']=canonical;vars['0']=canonical.length;}
    else if(line.includes('GetDriveTypeW'))vars['0']=driveType;
    else if(line.includes('GetVolumeInformationW')){vars['0']=1;vars['2']=filesystem;}
    else assert.fail('Unhandled OS call: '+line);pc++;break;
   }
   default:assert.fail('Unhandled instruction: '+line);
  }
 }
 assert.fail('Validator fell through');
}
test('actual path validator accepts dedicated local folders and rejects ambiguous or unsupported namespaces',()=>{
 for(const p of ['C:\\Nearly','D:\\Apps\\Nearly','d:\\Components\\Nearly','C:\\Computer\\Nearly','C:\\日本語\\Nearly','.'].slice(0,-1))assert.equal(pathDecision(p),true,p);
 assert.equal(pathDecision('C:\\'+'x'.repeat(173)),true,'176 UTF16 boundary');
 assert.equal(pathDecision('C:\\'+'x'.repeat(174)),false,'177 UTF16 boundary');
 for(const p of ['C:\\','C:Nearly','Nearly','\\\\server\\Nearly','\\\\?\\C:\\Nearly','C:\\Nearly\\','C:\\\\Nearly','C:/Nearly','C:\\Nearly:stream','C:\\Nearly.','C:\\Nearly ','C:\\..\\Nearly','C:\\.\\Nearly','C:\\CON','C:\\NUL.txt','C:\\CONIN$','C:\\CONOUT$','C:\\COM1','C:\\COM¹.txt','C:\\LPT9.log','C:\\LPT³','C:\\Na\x01me','C:\\'+ 'x'.repeat(237),'C:\\'+'界'.repeat(171)])assert.equal(pathDecision(p),false,JSON.stringify(p));
 assert.equal(pathDecision('D:\\Nearly',{driveType:4}),false,'network mapped drive');
 assert.equal(pathDecision('D:\\Nearly',{filesystem:'exFAT'}),false,'unsupported ACL/identity filesystem');
 assert.equal(pathDecision('C:\\Alias',{canonical:'C:\\Original'}),false,'canonical spelling differs');
});
test('pointer state is explicitly initialized before first guard use and cleanup releases the leaf first',()=>{
 for(const fn of ['.onInit','un.onInit'])for(const v of ['NearlyUserSid','NearlyGuardHead','NearlyLeafNode'])assert.ok(body(fn).indexOf(`StrCpy $${v} 0`)<body(fn).indexOf(fn==='.onInit'?'Call NearlyResolveRegistration':'Call un.NearlyPinRoot'));
 const release=s.match(/Function \$\{prefix\}NearlyReleaseGuards\r?\n([\s\S]*?)FunctionEnd/)[1];
 assert.match(release,/Call \$\{prefix\}NearlyReleaseLeaf/);assert.match(release,/StrCmp \$NearlyGuardHead 0 nearly_release_done/);assert.match(release,/StrCpy \$NearlyGuardHead \$0/);
});

test('uninstaller image equivalence is mandatory before mutations and held until self-delete',()=>{
 const init=body('un.onInit');assert.ok(init.includes('Call un.NearlyVerifyUninstallerImage'));
 const open=body('un.NearlyOpenImage');assert.match(open,/CreateFileW\(w "\$NearlyPayload", i \$NearlyImageAccess, i \$NearlyImageShare,/);assert.match(open,/GetFileInformationByHandle/);assert.match(open,/StrCmp \$3 1/);
 const verify=body('un.NearlyVerifyUninstallerImage');assert.match(verify,/GetModuleFileNameW/);assert.match(verify,/ReadFile/);assert.match(verify,/RtlCompareMemory/);assert.match(verify,/StrCmp \$NearlyImageSize \$NearlyImageRemaining/);
 assert.match(verify,/StrCpy \$NearlyImageAccess 0x80010080/);
 const section=s.slice(s.indexOf('Section Uninstall'));assert.ok(section.indexOf('Call un.NearlyImageCleanup')>section.indexOf('StrCpy $NearlyIoWriteHandle $NearlyRegisteredImageHandle'));assert.ok(section.indexOf('Call un.NearlyImageCleanup')<section.indexOf('DeleteRegKey HKCU'));
});
test('all pending handles and buffers release before rejecting a directory page',()=>{
 const reject=s.match(/Function \$\{prefix\}NearlyRejectRoot\r?\n([\s\S]*?)FunctionEnd/)[1];
 assert.match(reject,/CloseHandle\(p \$NearlyHandle\)/);assert.match(reject,/System::Free \$NearlyPendingBuffer/);assert.match(reject,/Call \$\{prefix\}NearlyReleaseGuards/);
 assert.match(s,/GetFileAttributesW\(w "\$NearlyWalk"\) i.r0 \?e/);assert.match(s,/FindNextFileW[^\n]+\?e/);
});
