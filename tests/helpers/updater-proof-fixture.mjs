import {generateKeyPairSync,sign,createHash} from 'node:crypto';
export function fixture({prehash=true,comment,payloadSha256='a'.repeat(64)}={}) {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const publicRaw=Buffer.concat([Buffer.from('Ed'),Buffer.from('fixture1'),publicKey.export({type:'spki',format:'der'}).subarray(-32)]);
  const installer=Buffer.alloc(256);installer.write('MZ');installer.writeUInt32LE(64,0x3c);installer.write('PE\0\0',64);installer.writeUInt16LE(0x14c,68);
  const expected={version:'3.1.0',file:'Nearly_r3.1_x64-setup.exe',payloadSha256};
  comment??=`version:${expected.version}\tfile:${expected.file}\tpayload-sha256:${expected.payloadSha256}\tupdater-protocol:3`;
  const signature=sign(null,prehash?createHash('blake2b512').update(installer).digest():installer,privateKey);
  const record=Buffer.concat([Buffer.from(prehash?'ED':'Ed'),publicRaw.subarray(2,10),signature]);
  const global=sign(null,Buffer.concat([signature,Buffer.from(comment)]),privateKey);
  const outer=Buffer.from(`untrusted comment: generated disposable fixture\n${record.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
  return {installer,publicRaw,signature:Buffer.from(outer),expected};
}
