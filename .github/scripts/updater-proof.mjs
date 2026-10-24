import {displayVersion} from '../../scripts/version.mjs';
import {createPublicKey,verify,createHash} from 'node:crypto';
const fail=()=>{throw Error('Invalid updater signature proof');};
function decode(text){if(typeof text!=='string'||!text||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))fail();const bytes=Buffer.from(text,'base64');if(bytes.toString('base64')!==text)fail();return bytes;}
// Independent public verification: built-in maintained Ed25519/BLAKE2b, no
// homegrown cryptography and no invocation of any artifact/target executable.
export function verifyUpdaterProof(installer,signature,publicRaw,expected) {
  if(!Buffer.isBuffer(installer)||installer.length<72||installer.length>64*1024*1024||!Buffer.isBuffer(signature)||signature.length===0||signature.length>16384||!Buffer.isBuffer(publicRaw)||publicRaw.length!==42||publicRaw.subarray(0,2).toString()!=='Ed')fail();
  const text=decode(signature.toString('utf8').trim()).toString('utf8');
  const lines=text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');
  if(lines.length!==4||!lines[0].startsWith('untrusted comment: ')||!lines[2].startsWith('trusted comment: '))fail();
  const record=decode(lines[1]),global=decode(lines[3]),comment=lines[2].slice(17);
  if(record.length!==74||global.length!==64||!record.subarray(2,10).equals(publicRaw.subarray(2,10)))fail();
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicRaw.subarray(10)]),format:'der',type:'spki'});
  const algorithm=record.subarray(0,2).toString();
  const message=algorithm==='ED'?createHash('blake2b512').update(installer).digest():algorithm==='Ed'?installer:null;
  if(!message||!verify(null,message,key,record.subarray(10))||!verify(null,Buffer.concat([record.subarray(10),Buffer.from(comment)]),key,global))fail();
  if(!expected || expected.file!==`Nearly_${displayVersion(expected.version)}_x64-setup.exe`||!/^[a-f0-9]{64}$/.test(expected?.payloadSha256)||comment!==`version:${expected.version}\tfile:${expected.file}\tpayload-sha256:${expected.payloadSha256}\tupdater-protocol:3`)fail();
  const offset=installer.readUInt32LE(0x3c);
  if(installer.readUInt16LE(0)!==0x5a4d||offset<64||offset+6>installer.length||installer.readUInt32LE(offset)!==0x4550||installer.readUInt16LE(offset+4)!==0x14c)fail();
  return true;
}
