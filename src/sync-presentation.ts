import type { Status } from './core.js';
import {localizeNativeError} from './native-errors.js';
type Language='ja'|'en';
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** A completed transfer is distinct from catching up with a later source save. */
export function syncLogMarkup(line:string,language:Language,localizedLine?:string):string {
  const prefix=['Uploaded ','アップロード完了: '].find(p=>line.startsWith(p));
  if(prefix&&line.length>prefix.length){
    const path=line.slice(prefix.length);
    return `<li class="log-upload"><strong>${language==='ja'?'アップロード完了':'Upload complete'}</strong><code title="${esc(path)}">${esc(path)}</code></li>`;
  }
  return `<li>${esc(localizedLine??localizeNativeError(line,language))}</li>`;
}
export function syncIndicatorClass(s?:Pick<Status,'status'|'syncPhase'|'pending'>):string {
  if(!s||s.status==='stopped')return 'off';
  if(s.status==='failed'||s.syncPhase==='error')return 'error';
  if(s.status==='stopping'||s.syncPhase==='stopping')return 'sync-paused';
  if(s.syncPhase==='scanning'||s.syncPhase==='working'||(!s.syncPhase&&(s.pending??0)>0))return 'sync-active';
  if(s.syncPhase==='caught_up')return 'sync-complete';
  if(s.syncPhase==='deletion_rescan_required')return 'sync-paused';
  return 'sync-watching';
}
export function syncActivityLabel(s:Pick<Status,'status'|'syncPhase'|'pending'>|undefined,language:Language):string|undefined {
  if(!s||s.status!=='running')return undefined;
  if(s.syncPhase==='scanning')return language==='ja'?'走査中':'Scanning';
  if(syncIndicatorClass(s)==='sync-active')return language==='ja'?'同期中':'Syncing';
  if(s.syncPhase==='caught_up')return language==='ja'?'同期済み・監視中':'Up to date · watching';
  return undefined;
}
