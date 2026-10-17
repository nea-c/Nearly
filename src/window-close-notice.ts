import {t,tError} from './i18n.js';
let source='';
export function showBlockedCloseNotice(value:string){
  source=value;
  let notice=document.getElementById('window-close-notice');
  const parent=document.querySelector<HTMLDialogElement>('dialog:modal')??document.body;
  if(!notice){
    notice=document.createElement('div');notice.id='window-close-notice';notice.className='notice window-close-notice';notice.setAttribute('role','alert');notice.setAttribute('popover','manual');
    const text=document.createElement('span');text.dataset.closeFeedback='';
    const close=document.createElement('button');close.type='button';close.textContent='×';
    close.onclick=()=>{const focused=notice?.contains(document.activeElement);const owner=notice?.closest('dialog');notice?.remove();source='';if(focused)owner?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus({preventScroll:true});};
    notice.append(text,close);
  }
  // A top-layer popover still inherits modal inertness when it is outside the
  // active native dialog. Keep this singleton inside that dialog when present.
  if(notice.parentElement!==parent){if(notice.matches(':popover-open'))notice.hidePopover();parent.append(notice);}
  if(typeof notice.showPopover==='function'&&!notice.matches(':popover-open'))notice.showPopover();
  refreshBlockedCloseNotice();
}
export function refreshBlockedCloseNotice(){const notice=document.getElementById('window-close-notice');if(!notice)return;const parent=document.querySelector<HTMLDialogElement>('dialog:modal')??document.body;if(notice.parentElement!==parent){if(notice.matches(':popover-open'))notice.hidePopover();parent.append(notice);}if(typeof notice.showPopover==='function'&&!notice.matches(':popover-open'))notice.showPopover();notice.querySelector('span')!.textContent=tError(source);notice.querySelector('button')!.setAttribute('aria-label',t('通知を閉じる'));}
