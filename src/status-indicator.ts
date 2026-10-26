import type {Status} from './core.js';
type Kind='connected'|'disconnected'|'connecting'|'sync'|'stopping'|'error';
export type Indicator={kind:Kind;label:string};
type Connection={connection?:unknown;connecting?:boolean;connectionFailed?:boolean};
/** Presentation of existing observations only: never probes a connection. */
export function workspaceIndicator(w:Connection,job:Pick<Status,'status'|'syncPhase'|'pending'>|undefined,language:'ja'|'en'):Indicator {
 const ja=language==='ja';
 if(job?.status!=='stopped'&&(job?.status==='failed'||job?.syncPhase==='error')||w.connectionFailed)return {kind:'error',label:ja?'接続または同期エラー':'Connection or sync error'};
 if(job?.status==='stopping')return {kind:'stopping',label:ja?'停止中':'Stopping'};
 if(job?.status==='running')return {kind:'sync',label:job.syncPhase==='scanning'?(ja?'走査中':'Scanning'):job.syncPhase==='caught_up'||(!job.syncPhase&&!job.pending)?(ja?'変更を監視中':'Watching for changes'):(ja?'同期中':'Syncing')};
 if(w.connecting)return {kind:'connecting',label:ja?'接続中…':'Connecting…'};
 if(w.connection)return {kind:'connected',label:job?.status==='stopped'?(ja?'接続済み・同期停止':'Connected • sync stopped'):(ja?'接続済み':'Connected')};
 return {kind:'disconnected',label:ja?'未接続':'Not connected'};
}
const shapes:Record<Kind,string>={
 connected:'<circle cx="8" cy="8" r="5.875" fill="currentColor" stroke="none"/>',
 disconnected:'<circle cx="8" cy="8" r="5"/>',
 connecting:'<circle cx="8" cy="8" r="5" pathLength="32" stroke-dasharray="1 3"/>',
 sync:'<path d="M12.4 6A4.8 4.8 0 0 0 4 4.9L2.5 6.5M2.5 3v3.5H6M3.6 10A4.8 4.8 0 0 0 12 11.1l1.5-1.6M10 9.5h3.5V13"/>',
 stopping:'<rect x="3.3" y="3.3" width="9.4" height="9.4" rx="1.2"/>',
 error:'<circle cx="8" cy="8" r="5"/><path d="M8 4.7v4M8 11.2h.01"/>',
};
export function statusIcon(state:Indicator,legacyClass=''):string {
 return `<span class="dot status-icon state-${state.kind} ${legacyClass}" data-state="${state.kind}" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false">${shapes[state.kind]}</svg></span>`;
}
