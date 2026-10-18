import {invoke,type TransferPrompt} from './api.js';
import {getLanguage,tError} from './i18n.js';
const say=(ja:string,en:string)=>getLanguage()==='ja'?ja:en;
/** One captured backend prompt. No destination metadata or policy is trusted from the DOM. */
export function watchTransferChoices(id:string) {
 let closed=false,timer:ReturnType<typeof setTimeout>|undefined,view:HTMLElement|undefined,current:string|undefined;
 const show=(prompt:TransferPrompt)=>{
  view?.remove();view=document.createElement('div');view.id='transfer-conflict';view.className='overlay operation-overlay';
  const dialog=document.createElement('section');dialog.className='dialog operation-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','transfer-conflict-title');
  const title=document.createElement('h2');title.id='transfer-conflict-title';title.textContent=say('同名の項目があります','An item with this name already exists');
  const paths=document.createElement('pre');paths.textContent=prompt.source+'\n→ '+prompt.destination;
  const description=document.createElement('p');description.textContent=prompt.canOverwrite?say('既存ファイルを置き換えるか選んでください。','Choose whether to replace the existing file.'):say('ファイルとフォルダの種類が異なります。スキップするか、名前を変えて両方保存してください。','File and folder types differ. Skip or keep both under a new name.');
  const label=document.createElement('label'),all=document.createElement('input'),caption=document.createElement('span');label.className='transfer-apply-all';all.type='checkbox';all.name='apply-all';caption.textContent=say('今回の操作の同じ種類の競合すべてに適用','Apply to all conflicts of this type in this operation');label.append(all,caption);
  const error=document.createElement('p');error.setAttribute('role','alert');const actions=document.createElement('div');actions.className='actions';
  let busy=false;
  const answer=async(action:'overwrite'|'skip'|'keepboth'|'cancel')=>{
   if(busy||closed)return;busy=true;actions.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{await invoke('choose_file_transfer',{id,decision:{token:prompt.token,action,applyAll:all.checked}});if(!closed){view?.remove();view=undefined;}}
   catch(e){if(!closed)error.textContent=tError(e);}
   finally{busy=false;actions.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
  for(const [choice,ja,en] of [['skip','スキップ','Skip'],['keepboth','両方保存（別名）','Keep both (rename)'],...(prompt.canOverwrite?[['overwrite','置き換える','Replace']]:[]),['cancel','操作をキャンセル','Cancel operation']]){
   const button=document.createElement('button');button.dataset.choice=choice;button.textContent=say(ja,en);button.onclick=()=>void answer(choice as 'skip');actions.append(button);
  }
  dialog.append(title,paths,description,label,error,actions);view.append(dialog);document.body.append(view);
  view.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();void answer('cancel');}
   if(e.key==='Tab'){const controls=[...dialog.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')];const i=controls.indexOf(document.activeElement as HTMLElement);e.preventDefault();controls[(i+(e.shiftKey?-1:1)+controls.length)%controls.length]?.focus();}};
  actions.querySelector<HTMLButtonElement>('[data-choice=skip]')?.focus();
 };
 const poll=async()=>{try{const prompt=await invoke('file_transfer_prompt',{id});if(closed)return;if(prompt&&prompt.token!==current){current=prompt.token;show(prompt);}}catch{/* Worker outcome remains authoritative; never infer a choice from a polling failure. */}
  if(!closed)timer=setTimeout(()=>void poll(),200);
 };
 void poll();return ()=>{closed=true;clearTimeout(timer);view?.remove();view=undefined;};
}
