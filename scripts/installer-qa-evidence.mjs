// Public evidence export only. Never upload the run root, raw logs or binaries.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateContext,validateDestination,validateScenario,createPlan} from './installer-qa.mjs';
const exact=(r,v)=>typeof v==='string'&&r.exec(v)?.[0]===v;
const label=v=>exact(/[a-z0-9][a-z0-9-]{0,63}/,v);
const fail=()=>{throw Error('Public evidence rejected: unsupported or unsafe record');};
function keys(v,wanted){if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify([...wanted].sort()))fail();}
const bits=v=>Array.isArray(v)&&v.length===2&&v.every(x=>x===0||x===1);
export function validatePublicSummary(v){
 keys(v,['schemaVersion','controllerSha','scenario','destinationKind','passed','cases']);
 if(v.schemaVersion!==2||!exact(/[a-f0-9]{40}/,v.controllerSha)||!['success','health-failure'].includes(v.scenario)||!['default','custom'].includes(v.destinationKind)||typeof v.passed!=='boolean'||!Array.isArray(v.cases)||v.cases.length>32)fail();
 for(const c of v.cases){keys(c,['case','passed']);if(!label(c.case)||typeof c.passed!=='boolean')fail();}
 return v;
}
const pages=['language','welcome','directory','destination-rejected','shortcuts-defaults','independent-0','independent-1','shortcuts-selected','directory-back','shortcuts-back-return','cancel-confirmation','finish-run-unchecked'];
const captions={en:['Create a Start menu shortcut','Create a desktop shortcut'],ja:['スタートメニューに登録する','デスクトップショートカットを作成する']};
export function validateUiEvidence(v){
 keys(v,['schemaVersion','case','language','mode','destinationKind','start','desktop','result','lastStage','events']);
 if(v.schemaVersion!==1||!label(v.case)||!['en','ja'].includes(v.language)||!['Install','Cancel','Reject','Drive'].includes(v.mode)||!['default','custom','drive'].includes(v.destinationKind)||!bits([v.start,v.desktop])||!['failed','installed','cancelled','rejected'].includes(v.result)||!['launch','language','directory','destination-rejection','shortcuts','cancel','install','finish'].includes(v.lastStage)||!Array.isArray(v.events)||v.events.length>32)fail();
 for(const event of v.events){
  if(pages.includes(event.stage)){keys(event,['stage','screenshot']);if(event.screenshot!==event.stage+'.png')fail();}
  else if(event.stage==='shortcut-assertions'){
   keys(event,['stage','captions','defaults','selected','independentToggle']);
   if(JSON.stringify(event.captions)!==JSON.stringify(captions[v.language])||!bits(event.defaults)||!bits(event.selected)||event.selected[0]!==v.start||event.selected[1]!==v.desktop||event.independentToggle!==true)fail();
  }else if(event.stage==='finish-assertions'){
   keys(event,['stage','runUnchecked','backRetainedChoices','destinationFromActualEdit']);
   if(event.runUnchecked!==true||event.backRetainedChoices!==true||event.destinationFromActualEdit!==true)fail();
  }else fail();
 }
 return v;
}
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
export function publicPng(bytes){
 const signature=Buffer.from([137,80,78,71,13,10,26,10]);
 if(bytes.length<45||bytes.length>8*1024*1024||!bytes.subarray(0,8).equals(signature))fail();
 const chunks=[signature];let cursor=8,count=0,header=false,data=false,ended=false;
 while(cursor<bytes.length){
  if(++count>512||cursor+12>bytes.length)fail();
  const length=bytes.readUInt32BE(cursor),end=cursor+12+length;
  if(end>bytes.length)fail();
  const type=bytes.toString('ascii',cursor+4,cursor+8),payload=bytes.subarray(cursor+8,end-4);
  if(crc32(bytes.subarray(cursor+4,end-4))!==bytes.readUInt32BE(end-4))fail();
  if(type==='IHDR'){
   if(header||cursor!==8||length!==13)fail();
   const width=payload.readUInt32BE(0),height=payload.readUInt32BE(4);
   if(width<100||height<100||width>3000||height>3000||payload[8]!==8||![2,6].includes(payload[9])||payload[10]!==0||payload[11]!==0||payload[12]!==0)fail();header=true;
  }else if(type==='IDAT'){if(!header||ended)fail();data=true;}
  else if(type==='IEND'){if(!header||!data||length!==0||end!==bytes.length)fail();ended=true;}
  else if(!exact(/[a-z][A-Za-z]{3}/,type))fail();
  // Strip all ancillary metadata, including textual comments and EXIF.
  if(['IHDR','IDAT','IEND'].includes(type))chunks.push(bytes.subarray(cursor,end));
  cursor=end;
 }
 if(!ended)fail();return Buffer.concat(chunks);
}
async function plainDirectory(dir){
 const absolute=path.resolve(dir);let current=path.parse(absolute).root;
 for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);const stat=await fs.lstat(current);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail();
 }
}
async function regular(file,limit){
 const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)fail();
 const bytes=await fs.readFile(file);if(bytes.length>limit)fail();return bytes;
}
export async function exportEvidence(e=process.env){
 const c=validateContext(e),destination=validateDestination(e.QA_DESTINATION),scenario=validateScenario(e.QA_SCENARIO),plan=createPlan(c,destination);
 await plainDirectory(plan.runRoot);
 const output=path.join(plan.runRoot,'public-evidence');await fs.mkdir(output);
 let summary;
 try{summary=validatePublicSummary(JSON.parse((await regular(path.join(plan.runRoot,'qa-summary.json'),32768)).toString('utf8').replace(/^\uFEFF/,'')));}
 catch(error){if(error.code!=='ENOENT')throw error;summary={schemaVersion:2,controllerSha:c.controllerSha,scenario,destinationKind:destination,passed:false,cases:[]};}
 if(summary.controllerSha!==c.controllerSha||summary.scenario!==scenario||summary.destinationKind!==destination)fail();
 await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
 const ui=path.join(plan.runRoot,'ui-evidence');let entries;
 try{await plainDirectory(ui);entries=await fs.readdir(ui,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(entries.length>16)fail();
 for(const entry of entries){
  if(!label(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())fail();
  const dir=path.join(ui,entry.name);await plainDirectory(dir);
  const bytes=await regular(path.join(dir,'evidence.json'),65536),report=validateUiEvidence(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  if(report.case!==entry.name||![destination,'drive'].includes(report.destinationKind))fail();
  // Reserialize validated objects, never copy unvalidated raw JSON bytes.
  await fs.writeFile(path.join(output,entry.name+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const names=await fs.readdir(dir);if(names.length>16||names.some(n=>n!=='evidence.json'&&!pages.some(p=>n===p+'.png')))fail();
  const screenshots=report.events.filter(x=>Object.hasOwn(x,'screenshot')).map(x=>x.screenshot);
  if(names.some(n=>n.endsWith('.png')&&!screenshots.includes(n)))fail();
  if(screenshots.length){await fs.mkdir(path.join(output,entry.name));}
  for(const name of screenshots){await fs.writeFile(path.join(output,entry.name,name),publicPng(await regular(path.join(dir,name),8*1024*1024)),{flag:'wx'});}
 }
 console.log('Validated public installer UI evidence exported; no raw logs, settings or binaries.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))exportEvidence().catch(()=>{console.error('Public evidence export failed closed; private run files were not uploaded.');process.exitCode=1;});
