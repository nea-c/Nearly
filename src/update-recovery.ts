import {invoke,type UpdateRestartReport} from './api.js';
import {getLanguage} from './i18n.js';
import './update-recovery.css';

let started=false,disposed=false,revision=-1,recovery=false;
let stop:(()=>void)|undefined,observer:MutationObserver|undefined;
function render(){
 if(disposed||!recovery)return;
 let notice=document.getElementById('update-recovery-notice');
 if(!notice){notice=document.createElement('aside');notice.id='update-recovery-notice';notice.setAttribute('role','alert');document.body.append(notice);}
 // Native reason codes are diagnostic hints, never HTML, paths, or repair actions.
 notice.textContent=getLanguage()==='ja'
  ?'更新の完了を確認できませんでした。更新用ファイルと前のアプリを保持しています。作業を保存し、信頼できる配布元に修復方法を確認してください。'
  :'The update could not be confirmed. Update files and the previous app have been retained. Save your work and check repair instructions with your trusted distribution source.';
}
function accept(value:UpdateRestartReport|undefined){
 if(disposed||!value||typeof value.phase!=='string'||!Number.isFinite(value.revision)||value.revision<revision)return;
 revision=value.revision;
 // Recovery is terminal for this process; a late or malformed idle report cannot
 // dismiss evidence loss. Native code also fences all later cleanup transitions.
 if(value.phase==='recoveryRequired'){recovery=true;render();}
}
export async function initializeUpdateRestart(label:string|undefined,ready:()=>boolean):Promise<void>{
 if(started||label!=='main'||!window.__TAURI__)return;
 started=true;
 window.addEventListener('pagehide',()=>{disposed=true;stop?.();observer?.disconnect();},{once:true});
 observer=new MutationObserver(render);observer.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 try{
  stop=await window.__TAURI__.event?.listen<UpdateRestartReport>('update-restart-status',event=>accept(event.payload));
  if(disposed){stop?.();return;}
  // Subscribe first: the revision check protects a newer event from this read.
  void invoke('update_restart_status').then(accept).catch(()=>{});
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  if(!disposed&&ready())await invoke('ack_update_restart_ready');
 }catch{
  // This carries no renderer claims about signatures, paths, or installer exit.
  // Native code independently times out and retains artifacts without the ack.
 }
}
