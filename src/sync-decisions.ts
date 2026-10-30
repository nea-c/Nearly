// Only the dedicated anonymous report is shareable. Never copy ordinary logs,
// roots, errors, profiles or endpoints into this field.
const reasons=['size_mismatch','mtime_mismatch','metadata_unavailable','remote_missing','metadata_unchanged','source_changed_during_check','watcher_forced_candidate','uploaded_content_unchanged','upload_dispatched','listing_fallback','remote_newer_retained','sync_conflict'] as const;
export function syncDecisionSummary(input:unknown):string {
  if(!input||typeof input!=='object')return '';
  const value=input as Record<string,unknown>;
  if(value.version!==1&&value.version!==2)return '';
  const counts=value.counts&&typeof value.counts==='object'?value.counts as Record<string,unknown>:{};
  const numeric=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)?n:null;
  const safeCounts=Object.fromEntries(reasons.filter(r=>numeric(counts[r])!==null).map(r=>[r,counts[r]]));
  const examples=(Array.isArray(value.examples)?value.examples:[]).slice(0,12).flatMap((entry:unknown)=>{
    if(!entry||typeof entry!=='object')return [];
    const e=entry as Record<string,unknown>;
    if(typeof e.id!=='string'||!/^f-[0-9a-f]{16}$/.test(e.id)||!reasons.includes(e.reason as typeof reasons[number]))return [];
    return [{id:e.id,reason:e.reason,...Object.fromEntries(['localSize','remoteSize','localUtcSeconds','remoteUtcSeconds','remoteMinusLocalSeconds'].map(k=>[k,numeric(e[k])]))}];
  });
  return JSON.stringify({version:value.version,precision:value.version===1?'UTC Unix seconds (SFTP v3), exact equality':'UTC Unix seconds (SFTP v3), no tolerance',...(value.version===2?{comparisonPolicy:'initial local-newer; watch content changes with remote baseline'}:{}),counts:safeCounts,examples},null,2);
}
