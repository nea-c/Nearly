import { t } from './i18n.js';
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
 cancel.disabled=false;
 const remove = () => { clearTimer(card); card.remove(); };
 return {finish(success: boolean | 'cancelled' = false){release();clearTimer(card);card.dataset.complete='true';card.dataset.success=String(success===true);card.dataset.dismissible=String(success===true||success==='cancelled');cancel.disabled=false;cancel.textContent=t('閉じる');cancel.dataset.feedbackClose='';cancel.onclick=remove;
   if(success===true||success==='cancelled')timers.set(card,setTimeout(remove,5000));
 }, remove(){if(card.dataset.complete !== "true")return;release();remove();}};
}
