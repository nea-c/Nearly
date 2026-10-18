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
export async function verifyBootstrapTrust(root){
  const raw=await loadTrustedPublicKey(root),source=await fs.readFile(path.join(root,'src-tauri/src/update_package.rs'),'utf8'),gate=await fs.readFile(path.join(root,'src-tauri/src/startup_update.rs'),'utf8');
  const constants=[...source.matchAll(/const\s+PRODUCTION_KEY_BYTES\s*:\s*\[\s*u8\s*;\s*42\s*\]\s*=\s*\[([\d,\s]+)\]\s*;/g)];
  const functions=[...source.matchAll(/pub\s+fn\s+production_key\(\)\s*->\s*Option<TrustedKey>\s*\{\s*Some\(TrustedKey\s*\{\s*bytes\s*:\s*PRODUCTION_KEY_BYTES\s*\}\)\s*\}/g)];
  const numbers=constants[0]?.[1].split(',').map(v=>v.trim()).filter(Boolean).map(Number);
  if(constants.length!==1||functions.length!==1||numbers.length!==42||numbers.some(n=>!Number.isInteger(n)||n<0||n>255)||!Buffer.from(numbers).equals(raw)||![...gate.matchAll(/HANDOFF_RELEASE_VALIDATED\s*:\s*bool\s*=\s*false\s*;/g)].length)throw Error('Signed bootstrap must embed only the registered public key and retain the disabled installation gate');
  return true;
}
