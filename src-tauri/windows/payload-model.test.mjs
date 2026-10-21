import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const text=fs.readFileSync(new URL('./installer.nsi',import.meta.url),'utf8');
function model(entry,{bytes=70001,fault='',expected='7:0:42',exists=true,attrs=0,links=1,identity=42}={}){
 const vars={NearlyIoSource:11,NearlyIoWriteHandle:22,NearlyIoSize:bytes,NearlyIoExpected:expected,NearlyPayload:'owned-destination'};
 const original=Buffer.alloc(bytes,0x5a),dest={data:Buffer.from('unchanged'),attrs,links,identity};
 const files=new Map([[11,{data:original,attrs:0,links:1,identity:10}],[22,dest]]),words=new Map(),events=[];
 let next=1000,stack=[],read=0,written=0,failed=false;
 const exp=s=>String(s??'').replace(/^("|')(.*)\1$/,'$2').replace(/\$(\w+)/g,(_,n)=>String(vars[n]??''));
 const set=(n,v)=>vars[n]=v;
 const win=raw=>{
  events.push(raw);
  const arg=(n)=>Number(vars[n]);
  if(raw.startsWith('*')){
   const ptr=Number(exp(raw.slice(1,raw.indexOf('('))));
   const outputs=[...raw.matchAll(/\.r(\d+)/g)].map(x=>x[1]);outputs.forEach((n,i)=>set(n,words.get(ptr+4*i)??0));return;
  }
  if(raw.includes('CreateFileW')){set('0',exists&&Number(vars.NearlyIoDisposition)===1||!exists&&Number(vars.NearlyIoDisposition)===3?-1:22);return;}
  if(raw.includes('GetFileType')){set('0',1);return;}
  if(raw.includes('GetFileInformationByHandle')){
   const f=files.get(arg('NearlyIoWriteHandle')),p=arg('NearlyIoInfo');
   words.set(p,f.attrs);words.set(p+28,7);words.set(p+32,0);words.set(p+36,f.data.length);words.set(p+40,f.links);words.set(p+44,0);words.set(p+48,f.identity);set('0',1);return;
  }
  if(raw.includes('SetFilePointerEx')){assert.equal(arg('NearlyIoWriteHandle'),22);set('0',fault==='seek'?0:1);return;}
  if(raw.includes('SetEndOfFile')){assert.equal(arg('NearlyIoWriteHandle'),22);set('0',fault==='truncate'?0:1);if(fault!=='truncate')dest.data=Buffer.alloc(0);return;}
  if(raw.includes('ReadFile')){assert.equal(arg('NearlyIoSource'),11);const count=arg('NearlyIoChunk');assert.ok(count>0&&count<=65536);read=count;set('0',fault==='read'?0:1);set('1',fault==='short-read'?count-1:count);return;}
  if(raw.includes('WriteFile')){
   assert.equal(arg('NearlyIoWriteHandle'),22,'writes must retain the verified destination handle');
   const count=arg('NearlyIoChunk');assert.equal(count,read);
   const actual=fault==='short-write'?count-1:count;set('0',fault==='write'?0:1);set('1',actual);
   if(fault!=='write'){dest.data=Buffer.concat([dest.data,original.subarray(written,written+actual)]);written+=actual;}return;
  }
  if(raw.includes('FlushFileBuffers')){assert.equal(arg('NearlyIoWriteHandle'),22);set('0',fault==='flush'?0:1);return;}
  if(raw.includes('CloseHandle'))return;
  assert.fail('Unsupported Win32 instruction '+raw);
 };
 function run(name){
  const match=text.match(new RegExp('Function \\$\\{prefix\\}'+name+'\\r?\\n([\\s\\S]*?)FunctionEnd'));assert.ok(match,name);
  const lines=match[1].split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith(';'));
  let pc=0,budget=30000;
  const jump=to=>!to||to==='0'?pc+1:/^[+-]\d+$/.test(to)?pc+Number(to):lines.indexOf(to+':')+1;
  while(pc<lines.length){assert.ok(budget--,'bounded NSIS model');const line=lines[pc];if(line.endsWith(':')){pc++;continue;}
   const [op,...a]=line.match(/"[^"]*"|'[^']*'|\S+/g);
   switch(op){
    case 'StrCpy':set(a[0].slice(1),exp(a[1]));pc++;break;
    case 'StrCmp':pc=jump(exp(a[0]).toLowerCase()===exp(a[1]).toLowerCase()?a[2]:a[3]);break;
    case 'IntCmp':{const l=Number(exp(a[0])),r=Number(exp(a[1]));pc=jump(l===r?a[2]:l<r?a[3]:a[4]);break;}
    case 'IntOp':{const l=Number(exp(a[1])),r=Number(exp(a[3]));set(a[0].slice(1),a[2]==='+'?l+r:a[2]==='-'?l-r:l&r);pc++;break;}
    case 'Goto':pc=jump(a[0]);break;
    case 'Pop':set(a[0].slice(1),stack.pop());pc++;break;
    case 'System::Alloc':stack.push(next);next+=Number(exp(a[0]))+16;pc++;break;
    case 'System::Free':pc++;break;
    case 'System::Call':win(a.join(' ').slice(1,-1));pc++;break;
    case 'Call':{const called=a[0].replace('${prefix}','');if(called==='NearlyIoFail'){failed=true;throw new Error('expected-io-refusal');}run(called);pc++;break;}
    case 'Return':return;
    default:assert.fail('Unsupported NSIS instruction '+line);
   }
  }
 }
 try{run(entry);}catch(e){if(e.message!=='expected-io-refusal')throw e;}
 return {failed,events,vars,dest,original};
}
test('actual NSIS copy loop writes an exact multi-chunk payload through the held object',()=>{
 const r=model('NearlyIoCopy');assert.equal(r.failed,false);assert.deepEqual(r.dest.data,r.original);
 assert.equal(r.events.filter(e=>e.includes('WriteFile')).length,2);
 assert.ok(!r.events.some(e=>e.includes('CreateFile')));
});
test('seek, truncate, read, short read, write, short write and flush failures cannot return success',()=>{
 for(const fault of ['seek','truncate','read','short-read','write','short-write','flush']){
  const r=model('NearlyIoCopy',{fault});assert.equal(r.failed,true,fault);
  if(['seek','truncate','read','short-read'].includes(fault))assert.ok(!r.events.some(e=>e.includes('WriteFile')),fault);
 }
 assert.equal(model('NearlyIoCopy',{bytes:0}).failed,true,'empty sources must fail before truncate');
});
test('destination admission rejects changed identity, late hardlink/reparse and CREATE_NEW collision before bytes change',()=>{
 for(const opts of [{identity:99},{links:2},{attrs:0x400},{attrs:0x10},{expected:'',exists:true}]){
  const r=model('NearlyIoOpenDestination',opts);assert.equal(r.failed,true,JSON.stringify(opts));assert.equal(r.dest.data.toString(),'unchanged');
  assert.equal(r.events.filter(e=>e.includes('CreateFileW')).length,1,'no open fallback after a collision');
 }
 for(const opts of [{},{expected:'',exists:false}])assert.equal(model('NearlyIoOpenDestination',opts).failed,false);
});
