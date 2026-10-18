// Explicit external maintenance tool. Never imported by application startup.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {names,unpackSettings} from './storage-fixture.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const backup=n=>n.replace(/\.json$/,'.backup.json');
function regular(p){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('Nonregular maintenance file refused');return s;}
function bytes(p){regular(p);return fs.readFileSync(p);}
function directory(p){const full=path.resolve(p),s=fs.lstatSync(full);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(full).toLowerCase()!==full.toLowerCase())throw Error('Directory aliases/reparse points are refused');return full;}
function flush(p,b){const fd=fs.openSync(p,'wx');try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(!bytes(p).equals(Buffer.from(b)))throw Error('Written backup verification failed');}
function probe(directory){const script=fs.readFileSync(new URL('./storage-writers.ps1',import.meta.url),'utf8');const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({directory}),encoding:'utf8',windowsHide:true});if(r.error||r.status!==0)throw Error('App closure status unavailable; no files were published');return r.stdout.trim()?[].concat(JSON.parse(r.stdout)):[];}
function closed(inspect,directory){if(inspect(directory).length)throw Error('Nearly or an executable in its settings directory is running; close all app writers before maintenance');}
export {probe as inspectStorageWriters};
function noWriter(root){for(const n of ['.nearly-settings.lock','.nearly-storage-migration.lock'])if(fs.existsSync(path.join(root,n)))throw Error('Existing settings writer/maintenance lock requires inspection');}
function nativeValidation({validator,validatorSha256,input,output}){
 if(hash(bytes(validator))!==validatorSha256)throw Error('Native validator changed');
 const r=spawnSync(validator,['--exact','unified_settings::tests::external_split_fixture','--ignored','--nocapture'],{env:{...process.env,NEARLY_VALIDATE_SETTINGS_FIXTURE:input,NEARLY_PREPARE_SPLIT_FIXTURE:output},encoding:'utf8',windowsHide:true});
 if(r.error||r.status!==0||!r.stdout.includes('Prepared and natively validated five-file fixture'))throw Error('Native conversion validation failed; preserve the preparation directory for inspection');
}
function checkSource(root,records){for(const {name,sha256}of records){const p=path.join(root,name);if(sha256===null){if(fs.existsSync(p))throw Error('Destination collision or source changed: '+name);}else if(!fs.existsSync(p)||hash(bytes(p))!==sha256)throw Error('Source changed: '+name);}}
function storageFiles(root){return Object.fromEntries(names.map(n=>[n,bytes(path.join(root,n)).toString('utf8')]));}
export function prepareStorage(options,services={}){
 const inspect=services.probe??probe;
 const root=directory(options.directory);closed(inspect,root);noWriter(root);
 const workspace=path.resolve(options.workspace);directory(path.dirname(workspace));
 if(workspace.toLowerCase()===root.toLowerCase()||workspace.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('Backup workspace must be outside the live directory');
 if(fs.existsSync(workspace))throw Error('Existing preparation workspace is preserved');
 const candidate=path.resolve(options.candidate),validator=path.resolve(options.validator);
 if(!/^[a-f0-9]{64}$/.test(options.validatorSha256??'')||hash(bytes(validator))!==options.validatorSha256)throw Error('Exact native validator hash required');
 const candidateBytes=bytes(candidate);if(candidateBytes.subarray(0,2).toString()!=='MZ')throw Error('Candidate must be a Windows executable');
 const allowed=['settings.json','settings.backup.json','Nearly.exe'];
 const sourceNames=[...new Set([...names,...names.map(backup),'Nearly.exe'])];
 const source=sourceNames.map(name=>{const p=path.join(root,name);if(!fs.existsSync(p)){if(name==='settings.json'||name==='Nearly.exe')throw Error('Missing authoritative source');return {name,sha256:null};}if(!allowed.includes(name))throw Error('Existing split destination is preserved: '+name);return {name,sha256:hash(bytes(p))};});
 fs.mkdirSync(workspace);const legacy=path.join(workspace,'legacy'),prepared=path.join(workspace,'prepared');fs.mkdirSync(legacy);fs.mkdirSync(prepared);
 for(const record of source.filter(r=>r.sha256!==null)){const b=bytes(path.join(root,record.name));if(hash(b)!==record.sha256)throw Error('Source changed during backup');flush(path.join(legacy,record.name),b);}
 const candidateSnapshot=path.join(workspace,'candidate.exe');flush(candidateSnapshot,candidateBytes);
 (services.validate??nativeValidation)({validator,validatorSha256:options.validatorSha256,input:path.join(legacy,'settings.json'),output:prepared});
 const preparedFiles=storageFiles(prepared);unpackSettings(preparedFiles);
 const parts=names.map(name=>({name,sha256:hash(Buffer.from(preparedFiles[name]))}));
 closed(inspect,root);noWriter(root);checkSource(root,source);
 const plan={migrationFormat:1,status:'prepared',createdAt:new Date().toISOString(),directory:root,workspace,source,prepared:parts,candidate:{path:candidate,sha256:hash(candidateBytes),snapshot:'candidate.exe'},validator:{path:validator,sha256:options.validatorSha256},warning:'No live files changed. Apply only with all app writers closed. Interrupted publication requires explicit recovery from legacy/; no automatic restore.'};
 const file=path.join(workspace,'plan.json'),encoded=Buffer.from(JSON.stringify(plan,null,2));flush(file,encoded);return {path:file,sha256:hash(encoded),plan};
}
export function applyStorage(planFile,expectedPlanHash,services={}){
 const encoded=bytes(planFile);if(hash(encoded)!==expectedPlanHash)throw Error('Plan changed; exact reviewed hash required');
 const p=JSON.parse(encoded);if(p.migrationFormat!==1||p.status!=='prepared')throw Error('Unsupported migration plan');
 const root=directory(p.directory),workspace=directory(p.workspace);
 if(path.resolve(planFile).toLowerCase()!==path.join(workspace,'plan.json').toLowerCase())throw Error('Plan location mismatch');
 const sourceNames=[...new Set([...names,...names.map(backup),'Nearly.exe'])];
 if(p.source.length!==sourceNames.length||new Set(p.source.map(r=>r.name)).size!==sourceNames.length||p.source.some(r=>!sourceNames.includes(r.name))||p.prepared.length!==5||p.prepared.some((r,i)=>r.name!==names[i]))throw Error('Invalid plan filename set');
 const inspect=services.probe??probe;closed(inspect,root);noWriter(root);checkSource(root,p.source);
 for(const r of p.source.filter(r=>r.sha256!==null))if(hash(bytes(path.join(workspace,'legacy',r.name)))!==r.sha256)throw Error('Original backup changed');
 const prepared=path.join(workspace,'prepared'),files=storageFiles(prepared);unpackSettings(files);
 for(const r of p.prepared)if(hash(Buffer.from(files[r.name]))!==r.sha256)throw Error('Prepared file changed');
 if(p.candidate.snapshot!=='candidate.exe'||hash(bytes(p.candidate.path))!==p.candidate.sha256||hash(bytes(path.join(workspace,'candidate.exe')))!==p.candidate.sha256)throw Error('Candidate changed');
 const resultPath=path.join(workspace,'apply-result.json');if(fs.existsSync(resultPath))throw Error('Previous apply outcome exists; inspect it before any retry');
 const result={status:'preparing',startedAt:new Date().toISOString(),published:[],pending:null,recovery:path.join(workspace,'legacy'),planSha256:expectedPlanHash};
 const lockPath=path.join(root,'.nearly-settings.lock'),lock=fs.openSync(lockPath,'wx');const staged=[];
 function record(){const temp=resultPath+'.tmp';if(fs.existsSync(temp))throw Error('Existing receipt temporary preserved');flush(temp,Buffer.from(JSON.stringify(result,null,2)));fs.renameSync(temp,resultPath);}
 try {
  const entries=[...names.slice(1).flatMap(name=>[{name,data:Buffer.from(files[name])},{name:backup(name),data:Buffer.from(files[name])}]),{name:'settings.backup.json',data:Buffer.from(files['settings.json'])},{name:'settings.json',data:Buffer.from(files['settings.json'])},{name:'Nearly.exe',data:bytes(path.join(workspace,'candidate.exe'))}];
  for(const entry of entries){const temp=path.join(root,'.nearly-migrate-'+randomUUID()+'.tmp');flush(temp,entry.data);staged.push({...entry,temp,sha256:hash(entry.data)});}
  closed(inspect,root);checkSource(root,p.source);result.status='publishing';record();
  for(const [index,entry]of staged.entries()){services.beforePublish?.({index,name:entry.name});if(hash(bytes(entry.temp))!==entry.sha256)throw Error('Staged bytes changed');const original=p.source.find(r=>r.name===entry.name);if(original.sha256===null){if(fs.existsSync(path.join(root,entry.name)))throw Error('Destination changed before publication');}else if(hash(bytes(path.join(root,entry.name)))!==original.sha256)throw Error('Destination changed before publication');result.pending={index,name:entry.name,beforeSha256:original.sha256,afterSha256:entry.sha256};record();fs.renameSync(entry.temp,path.join(root,entry.name));services.afterPublish?.({index,name:entry.name});result.published.push(entry.name);result.pending=null;record();}
  result.status='applied';result.finishedAt=new Date().toISOString();record();return result;
 }catch(error){result.status=result.published.length||result.pending?'partial':'refused';result.reason=String(error.message);try{record();}catch{ /* Existing verified original backups remain authoritative. */ }throw error;
 }finally{for(const entry of staged){try{if(fs.existsSync(entry.temp)&&hash(bytes(entry.temp))===entry.sha256)fs.unlinkSync(entry.temp);}catch{ /* Never delete a changed or unknown file. */ }}fs.closeSync(lock);fs.unlinkSync(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const [mode,...args]=process.argv.slice(2);if(mode==='prepare'){if(args.length!==5)throw Error('prepare requires live-directory, absent-workspace, candidate-exe, validator-exe and validator-sha256');console.log(JSON.stringify(prepareStorage({directory:args[0],workspace:args[1],candidate:args[2],validator:args[3],validatorSha256:args[4]})));}else if(mode==='apply'){if(args.length!==2)throw Error('apply requires plan-path and reviewed-plan-sha256');console.log(JSON.stringify(applyStorage(args[0],args[1])));}else throw Error('Explicit prepare or apply mode required');}catch(error){console.error('Storage maintenance refused: '+error.message);process.exitCode=1;}
}
