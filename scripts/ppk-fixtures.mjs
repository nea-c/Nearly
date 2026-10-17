// Disposable test inputs only. No existing key or account is read, and nothing is uploaded.
// PPK encoding: https://the.earth.li/~sgtatham/putty/0.85/htmldoc/AppendixC.html
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync, randomBytes, createHash, createHmac, createCipheriv} from 'node:crypto';
import {argon2id} from '@noble/hashes/argon2.js';

export const fixtureNames = ['generated-encrypted-v2.ppk','generated-encrypted-v3.ppk'];
const secret = 'fixture-only-not-a-user-secret';
const field = value => {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const size = Buffer.alloc(4); size.writeUInt32BE(b.length); return Buffer.concat([size,b]);
};
const integer = value => {
  const b = Buffer.from(value,'base64url');
  return field(b[0] & 128 ? Buffer.concat([Buffer.from([0]),b]) : b);
};
const hash = b => createHash('sha1').update(b).digest();
const lines = b => b.toString('base64').match(/.{1,64}/g);

function generate() {
  const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk = privateKey.export({format:'jwk'});
  const publicBlob = Buffer.concat([field('ssh-rsa'),integer(jwk.e),integer(jwk.n)]);
  const raw = Buffer.concat([integer(jwk.d),integer(jwk.p),integer(jwk.q),integer(jwk.qi)]);
  const privateBlob = Buffer.concat([raw,randomBytes((16 - raw.length % 16) % 16)]);
  const comment = 'generated disposable test fixture - never use for an account';
  const macData = Buffer.concat(['ssh-rsa','aes256-cbc',comment,publicBlob,privateBlob].map(field));
  try {
    return [2,3].map(version => {
      let key, iv, macKey, metadata = '';
      if (version === 2) {
        key = Buffer.concat([0,1].map(n => {const seq = Buffer.alloc(4);seq.writeUInt32BE(n);return hash(Buffer.concat([seq,Buffer.from(secret)]));})).subarray(0,32);
        iv = Buffer.alloc(16); macKey = hash(Buffer.from('putty-private-key-file-mac-key'+secret));
      } else {
        const salt = randomBytes(16);
        // Deliberately small bounded costs: these generated keys must never secure a real account.
        const material = Buffer.from(argon2id(secret,salt,{t:2,m:32,p:1,dkLen:80}));
        key = material.subarray(0,32);iv = material.subarray(32,48);macKey = material.subarray(48);
        metadata = `Key-Derivation: Argon2id\nArgon2-Memory: 32\nArgon2-Passes: 2\nArgon2-Parallelism: 1\nArgon2-Salt: ${salt.toString('hex')}\n`;
      }
      try {
        const cipher = createCipheriv('aes-256-cbc',key,iv);cipher.setAutoPadding(false);
        const encrypted = Buffer.concat([cipher.update(privateBlob),cipher.final()]);
        const publicLines = lines(publicBlob), privateLines = lines(encrypted);
        const mac = createHmac(version === 2 ? 'sha1' : 'sha256',macKey).update(macData).digest('hex');
        return `PuTTY-User-Key-File-${version}: ssh-rsa\nEncryption: aes256-cbc\nComment: ${comment}\nPublic-Lines: ${publicLines.length}\n${publicLines.join('\n')}\n${metadata}Private-Lines: ${privateLines.length}\n${privateLines.join('\n')}\nPrivate-MAC: ${mac}\n`;
      } finally {key.fill(0);iv.fill(0);macKey.fill(0);}
    });
  } finally {raw.fill(0);privateBlob.fill(0);macData.fill(0);}
}

async function noLinks(target) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const name of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current,name);
    const s = await fs.lstat(current).catch(e => {if(e.code === 'ENOENT')return null;throw e;});
    if (!s) break;
    if (s.isSymbolicLink() || !s.isDirectory()) throw Error('Fixture root must use ordinary directories');
  }
}
export async function ensurePpkFixtures(output) {
  output = path.resolve(output);await noLinks(output);
  await fs.mkdir(output,{recursive:true});await noLinks(output);
  const existing = await Promise.all(fixtureNames.map(async n => {
    const s = await fs.lstat(path.join(output,n)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(s && (!s.isFile() || s.isSymbolicLink()))throw Error('Fixture file must be ordinary');return Boolean(s);
  }));
  if(existing.every(Boolean))return 'existing';
  if(existing.some(Boolean))throw Error('Partial fixture set; preserve existing files and inspect it');
  const contents = generate();
  for (let i=0;i<fixtureNames.length;i++) await fs.writeFile(path.join(output,fixtureNames[i]),contents[i],{flag:'wx',mode:0o600});
  return 'generated';
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensurePpkFixtures(fileURLToPath(new URL('../src-tauri/tests/fixtures',import.meta.url)))
    .then(result=>console.log(`Disposable PPK fixtures: ${result}; ignored by Git`))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}
