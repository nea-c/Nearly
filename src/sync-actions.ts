import type {SyncTab} from './core.js';
import {snapshotRetainedSync,type RetainedSync} from './retained-sync.js';
import {t,text} from './i18n.js';

/** A persisted entry is never evidence that this session has run a sync.
 * A live/transfer-owned job supplies the immutable pair and actual start options.
 */
export function sessionResumeContext(ownerId:string,job:SyncTab|undefined,owned:RetainedSync|undefined):RetainedSync|undefined {
  if(!job?.retainedId || !owned || owned.ownerTabId!==ownerId || owned.ownerTabClosed || job.retainedId!==owned.id)return undefined;
  const value=snapshotRetainedSync({...owned,profile:{...job.profile},local:job.local,remote:job.remote,
    exclusionRules:job.exclusionRules??'',deleteRemoved:job.deleteRemoved??false,recursive:job.recursive??true});
  delete value.presetId;
  return value;
}
// Short labels have one source, separate from the full accessible descriptions.
export function syncActionLabel(){return t('同期');}
export function resumeActionLabel(){return t('再開');}
export function currentSyncHelp(local:string,remote:string){return text`現在表示しているローカルフォルダー ${local} から、現在表示しているリモートフォルダー ${remote} へ同期します。`;}
export function resumeSyncHelp(local:string,remote:string){return text`前回の同期元 ${local} から同期先 ${remote} へ、前回の設定を使って再開します。表示中のフォルダーは使いません。`;}
