import type {UploadOutcome} from './api.js';
import {getLanguage} from './i18n.js';

/** Item counts and bytes have different units; bytes are confirmed completed copies. */
export function formatTransferOutcome(outcome:UploadOutcome):string {
 const ja=getLanguage()==='ja';
 const status=outcome.status==='completed'?(ja?'完了':'Completed'):outcome.status==='cancelled'?(ja?'キャンセル':'Cancelled'):(ja?'一部のみ完了':'Partial');
 const count=outcome.completed,bytes=outcome.bytes,skipped=outcome.skipped??0,transferred=outcome.transferredBytes??bytes;
 let text=ja?`${status}: ${count} 件 · ${bytes} バイト · ${skipped} 件スキップ`:`${status}: ${count} ${count===1?'item':'items'} · ${bytes} bytes · ${skipped} skipped`;
 if(transferred!==bytes)text+=ja?`（送受信済み ${transferred} バイト、一時データを含む）`:` (${transferred} bytes transferred, including staging)`;
 return text;
}
