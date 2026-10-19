import fs from 'node:fs/promises';
import path from 'node:path';
export const qaBinaryMarker='NEARLY-INSTALLER-QA-ONLY-v1';
export function assertProductionEnvironment(env=process.env){
  if(Object.keys(env).some(k=>/^NEARLY_QA_/i.test(k)))throw Error('QA build inputs are forbidden in production builders');
}
export function assertProductionPayload(bytes){
  if(['utf8','utf16le'].some(enc=>bytes.includes(Buffer.from(qaBinaryMarker,enc))))throw Error('QA-only payload cannot be packaged as production');
}
export async function assertProductionDefaults(root){
  const manifest=await fs.readFile(path.join(root,'src-tauri/Cargo.toml'),'utf8');
  const section=manifest.split(/^\[features\]\s*$/m)[1]?.split(/^\[/m)[0];
  if(section===undefined||/^\s*default\s*=.*installer-qa/m.test(section))throw Error('Production Cargo defaults must exclude installer-qa');
  // The reviewed crate has no default feature graph. New defaults require review.
  if(/^\s*default\s*=/m.test(section))throw Error('Review production Cargo default features before building');
}
