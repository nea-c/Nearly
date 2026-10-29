import {invoke} from './api.js';
import type {DropHost} from './file-drop.js';
import {operationBusy,operationFeedback} from './operation-feedback.js';
import {getLanguage,tError} from './i18n.js';
import {formatTransferOutcome} from './transfer-outcome.js';
const say=(ja:string,en:string)=>getLanguage()==='ja'?ja:en;
/** Native OLE owns the drag from its threshold. Sources remain copies. */
export async function startExternalDownload(host:DropHost,sources:readonly string[],sessionId:string,onInternalDrop?:(position:{x:number;y:number})=>void) {
 if(operationBusy()||!host.valid()||!host.uploadAllowed())return;
 const id=crypto.randomUUID(),results=document.createElement('div'),cancel=document.createElement('button');cancel.textContent=say('キャンセル','Cancel');
 const feedback=operationFeedback(say('Windows へダウンロード','Download to Windows'),results,cancel);
 let cancelled=false,prepared=false,dispatched=false,successful=false,terminalCancelled=false;
 let internalPosition:{x:number;y:number}|null|undefined;
 cancel.onclick=()=>{cancelled=true;cancel.disabled=true;if(dispatched)void invoke('cancel_file_operation',{id}).catch(e=>{results.textContent=tError(e);});};
 results.textContent=say('移動先へドラッグしてください。内容はコピー時に読み込みます。','Drag to the destination. Contents are read when copied.');
 try {
  await invoke('prepare_file_operation',{id});prepared=true;
  if(cancelled||!host.operationValid()||!host.uploadAllowed()){await invoke('cancel_file_operation',{id,abandon:true});prepared=false;terminalCancelled=true;results.textContent=say('キャンセルしました。','Cancelled.');return;}
  feedback.track(id);dispatched=true;const outcome=await invoke('run_remote_drag',{request:{id,sessionId,sources:[...sources]}});
  results.textContent=formatTransferOutcome(outcome)+(outcome.message?' '+tError(outcome.message):'');
  terminalCancelled=outcome.status==='cancelled';
  internalPosition=outcome.internalPosition;
  successful=outcome.status==='completed'&&!cancelled;
 } catch(error){results.textContent=tError(error);if(prepared&&!dispatched)await invoke('cancel_file_operation',{id,abandon:true}).catch(e=>{results.textContent+=' '+tError(e);});}
 finally{feedback.finish(terminalCancelled?'cancelled':successful);}
 if(!cancelled&&internalPosition&&host.valid()&&host.operationValid()&&host.uploadAllowed()&&host.sessionId===sessionId){feedback.remove();onInternalDrop?.(internalPosition);}
}
