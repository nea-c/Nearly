import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const publicKeySha256='2592845a518adb9df5b7773dd58672ea411b3038758bfaf2808a3cb13dcc8695';
export async function loadTrustedPublicKey(root){
  const filename=path.join(root,'.github/updater-public-key.pub'),stat=await fs.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Invalid trusted public key file');
  const bytes=await fs.readFile(filename);
  if(createHash('sha256').update(bytes).digest('hex')!==publicKeySha256)throw Error('Registered public key identity mismatch');
  const lines=bytes.toString('utf8').trimEnd().split(/\r?\n/),raw=Buffer.from(lines[1]||'','base64');
  if(lines.length!==2||raw.length!==42||raw.subarray(0,2).toString()!=='Ed'||raw.toString('base64')!==lines[1])throw Error('Invalid registered public key');
  return raw;
}
// Mask comments and literal contents before checking the small supported Rust
// declaration contract. Preserve newlines; reject unterminated lexical regions.
function rustCode(source){
  let out='',i=0;
  const mask=end=>{out+=source.slice(i,end).replace(/[^\r\n]/g,' ');i=end;};
  while(i<source.length){
    if(source.startsWith('//',i)){const end=source.indexOf('\n',i);mask(end<0?source.length:end);continue;}
    if(source.startsWith('/*',i)){
      let end=i+2,depth=1;
      while(end<source.length&&depth){if(source.startsWith('/*',end)){depth++;end+=2;}else if(source.startsWith('*/',end)){depth--;end+=2;}else end++;}
      if(depth)throw Error('Unterminated Rust comment');mask(end);continue;
    }
    const raw=/^(?:br|cr|r)(#*)"/.exec(source.slice(i));
    if(raw){const delimiter='"'+raw[1],end=source.indexOf(delimiter,i+raw[0].length);if(end<0)throw Error('Unterminated Rust raw string');mask(end+delimiter.length);continue;}
    if(source[i]==='"'){
      let end=i+1;while(end<source.length&&source[end]!=='"'){if(source[end]==='\\')end++;end++;}
      if(end>=source.length)throw Error('Unterminated Rust string');mask(end+1);continue;
    }
    // Single-scalar and escaped character literals; lifetime names remain code.
    if(source[i]==="'"){
      const character=/^'(?:\\(?:u\{[a-fA-F0-9_]+\}|x[a-fA-F0-9]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(source.slice(i));
      if(character){mask(i+character[0].length);continue;}
    }
    out+=source[i++];
  }
  return out;
}
export async function readInstallationGate(root){
  const source=await fs.readFile(path.join(root,'src-tauri/src/startup_update.rs'),'utf8');
  const code=rustCode(source);
  const declarations=[...code.matchAll(/\b(?:const|static)\s+HANDOFF_RELEASE_VALIDATED\b/g)];
  const gates=[...code.matchAll(/\bpub\s+const\s+HANDOFF_RELEASE_VALIDATED\s*:\s*bool\s*=\s*(true|false)\s*;/g)];
  if(declarations.length!==1||gates.length!==1)throw Error('Exactly one canonical installation gate required');
  return gates[0][1]==='true';
}
export async function verifyBootstrapTrust(root){return verifyRegisteredTrust(root,false);}
export async function verifyProductionTrust(root){return verifyRegisteredTrust(root,true);}
async function verifyRegisteredTrust(root,enabled){
  const raw=await loadTrustedPublicKey(root),source=rustCode(await fs.readFile(path.join(root,'src-tauri/src/update_package.rs'),'utf8'));
  const constants=[...source.matchAll(/const\s+PRODUCTION_KEY_BYTES\s*:\s*\[\s*u8\s*;\s*42\s*\]\s*=\s*\[([\d,\s]+)\]\s*;/g)];
  const functions=[...source.matchAll(/pub\s+fn\s+production_key\(\)\s*->\s*Option<TrustedKey>\s*\{\s*Some\(TrustedKey\s*\{\s*bytes\s*:\s*PRODUCTION_KEY_BYTES\s*\}\)\s*\}/g)];
  const numbers=constants[0]?.[1].split(',').map(v=>v.trim()).filter(Boolean).map(Number);
  if(constants.length!==1||functions.length!==1||numbers.length!==42||numbers.some(n=>!Number.isInteger(n)||n<0||n>255)||!Buffer.from(numbers).equals(raw)||await readInstallationGate(root)!==enabled)throw Error('Registered key or required installation gate mismatch');
  return true;
}
