import { t,getLanguage } from './i18n.js';
import {invoke,type OperationProgress} from './api.js';
/** Shared UI reservation: acquired synchronously before prepare, released after invalidation. */
const reservations = new Set<object>();
const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
const clearTimer = (card: HTMLElement) => { clearTimeout(timers.get(card)); timers.delete(card); };
let observing = false;
export function operationBusy() { return reservations.size > 0; }
export function reserveOperation() {
 if(operationBusy())throw Error(t("処理中です。"));
 const token={}; reservations.add(token); window.dispatchEvent(new Event("operation-busy-changed")); let released=false;
 return () => { if (!released) { released=true; reservations.delete(token); window.dispatchEvent(new Event("operation-busy-changed")); } };
}
/** Body portal survives app renders. Successful/cancelled notices expire; errors remain. */
export function operationFeedback(title: string, results: HTMLElement, cancel: HTMLButtonElement) {
 const release=reserveOperation();
 const root=document.getElementById('operation-feedback-root') ?? Object.assign(document.createElement('div'),{id:'operation-feedback-root'});
 if(!root.isConnected)document.body.append(root);
 if (!observing) {
   observing = true;
   new MutationObserver(() => { for (const card of timers.keys()) if (!card.isConnected) clearTimer(card); })
     .observe(document.body, { childList: true, subtree: true });
 }
 for(const old of Array.from(root.querySelectorAll<HTMLElement>('[data-complete][data-success="true"]')).slice(0,-2)){clearTimer(old);old.remove();}
 const card=document.createElement('section');card.className='operation-feedback';card.setAttribute('role','status');
 const heading=document.createElement('strong');heading.textContent=title;card.append(heading,results,cancel);root.append(card);
 const meter=document.createElement('div');meter.className='operation-progress';meter.hidden=true;
 const gauge=document.createElement('progress');gauge.setAttribute('aria-label',getLanguage()==='ja'?'操作の進捗':'Operation progress');
 const label=document.createElement('span');label.className='operation-progress-label';meter.append(gauge,label);heading.after(meter);
 let generation=0,finished=false,pollTimer:ReturnType<typeof setTimeout>|undefined;
 let activeId:string|undefined,inFlight=false,nextPollAt=0;
 const words=(ja:string,en:string)=>getLanguage()==='ja'?ja:en;
 const render=(sample:OperationProgress)=>{
  meter.hidden=false;
  const amount=sample.unit==='bytes'?sample.done.toLocaleString()+' / '+(sample.total?.toLocaleString() ?? '?')+' B':sample.done+' / '+(sample.total ?? '?')+' '+words('件','entries');
  const phase=({uploading:words('アップロード中','Uploading'),downloading:words('ダウンロード中','Downloading'),waiting:words('確認待ち','Waiting for confirmation'),connecting:words('接続中','Connecting'),scanning:words('走査中','Scanning'),copying:words('コピー中','Copying'),deleting:words('削除中','Deleting'),finalizing:words('確定中','Finalizing')} as Record<string,string>)[sample.phase] ?? words('準備中','Preparing');
  const determinate=['copying','deleting','uploading','downloading'].includes(sample.phase)&&sample.total!==null&&sample.total>0&&sample.done<sample.total;
  if(determinate){gauge.max=sample.total!;gauge.value=sample.done;}else gauge.removeAttribute('value');
  label.textContent=(sample.itemCount>1?sample.item+' / '+sample.itemCount+' · ':'')+phase+(sample.total===null?'':' · '+amount);
 };
 const schedule=()=>{
  if(finished||!activeId||inFlight||pollTimer!==undefined)return;
  pollTimer=setTimeout(()=>{pollTimer=undefined;void poll();},Math.max(0,nextPollAt-performance.now()));
 };
 const poll=async()=>{
  if(finished||!activeId||inFlight)return;
  const id=activeId,token=generation;inFlight=true;nextPollAt=performance.now()+200;
  try{
   const snapshot=await invoke('file_operation_progress',{id});
   if(!finished&&token===generation&&snapshot)render(snapshot);
  }catch{/* worker may finish between ownership check and polling */}
  finally{inFlight=false;schedule();}
 };
 const track=(id:string)=>{
  if(finished)return;
  activeId=id;++generation;
  render({phase:'connecting',unit:'bytes',done:0,total:null,entries:0,item:1,itemCount:1});
  schedule();
 };
 cancel.disabled=false;
 const remove = () => { clearTimer(card); card.remove(); };
 return {track,finish(success: boolean | 'cancelled' = false){finished=true;++generation;clearTimeout(pollTimer);if(!meter.hidden){if(success===true){gauge.max=1;gauge.value=1;}else gauge.removeAttribute('value');label.textContent=success===true?words('完了','Completed'):words('未完了・結果を確認してください','Operation incomplete — inspect results');}release();clearTimer(card);card.dataset.complete='true';card.dataset.success=String(success===true);card.dataset.dismissible=String(success===true||success==='cancelled');cancel.disabled=false;cancel.textContent=t('閉じる');cancel.dataset.feedbackClose='';cancel.onclick=remove;
   if(success===true||success==='cancelled')timers.set(card,setTimeout(remove,5000));
 }, remove(){if(card.dataset.complete !== "true")return;release();remove();}};
}
