import type {Status} from './core.js';
type ErrorState=Pick<Status,'status'|'syncPhase'|'errorCount'>;
const failed=(s:ErrorState)=>s.status!=='stopped'&&(s.status==='failed'||s.syncPhase==='error');
/** Compare observations before mutation. Repainting/restoring a failed snapshot is not an event. */
export function newSyncError(before:ErrorState,after:ErrorState):boolean {
 return failed(after)&&(!failed(before)||(after.errorCount??0)>(before.errorCount??0));
}
/** Notification only; never acknowledges or clears the underlying failure. */
export class ErrorAttention {
 constructor(private readonly set:(active:boolean)=>Promise<unknown>){}
 private dispatch(active:boolean){try{void this.set(active).catch(()=>{});}catch{/* OS notification must not fail synchronization. */}}
 error(){this.dispatch(true);}
 focus(){this.dispatch(false);}
 sync(before:ErrorState,after:ErrorState){if(newSyncError(before,after))this.error();}
}
