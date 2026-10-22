import {invoke,type UpdateRestartReport} from './api.js';
import {getLanguage} from './i18n.js';
import './update-recovery.css';

let started=false,disposed=false,revision=-1,recovery=false,probation=false,cleanupPending=false;
let settled:((error?:Error)=>void)|undefined;
let stop:(()=>void)|undefined,observer:MutationObserver|undefined;
function render(){
 document.documentElement.toggleAttribute('data-update-probation',probation);
 let settling=document.getElementById('update-probation');
 if(probation&&!settling){settling=document.createElement('div');settling.id='update-probation';settling.setAttribute('role','status');document.body.append(settling);}
 if(settling){if(!probation)settling.remove();else settling.textContent=getLanguage()==='ja'?'更新を確認しています…':'Confirming the update…';}
 let cleanup=document.getElementById('update-cleanup-notice');
 if(cleanupPending&&!recovery&&!cleanup){cleanup=document.createElement('aside');cleanup.id='update-cleanup-notice';cleanup.setAttribute('role','status');document.body.append(cleanup);}
 if(cleanup){if(!cleanupPending||recovery)cleanup.remove();else cleanup.textContent=getLanguage()==='ja'
  ?'更新は完了しました。更新用ファイルの一部を安全に削除できなかったため保持しています。次回起動時に再確認します。'
  :'The update succeeded. Some update files were retained because they could not be safely removed. Cleanup will be checked again at the next startup.';}
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
 if(value.phase==='waitingForUi'||value.phase==='awaitingSuccess'){probation=true;render();}
 if((value.phase==='succeeded'||value.phase==='cleaned')&&!recovery){probation=false;cleanupPending=false;render();settled?.();}
 if(value.phase==='cleanupPending'&&!recovery){cleanupPending=true;render();}
 // Recovery is terminal for this process; a late or malformed idle report cannot
 // dismiss evidence loss. Native code also fences all later cleanup transitions.
 if(value.phase==='recoveryRequired'){recovery=true;render();settled?.(Error('Update confirmation requires repair'));}
}
export async function initializeUpdateRestart(label:string|undefined,ready:()=>boolean):Promise<boolean>{
 if(started||label!=='main'||!window.__TAURI__)return false;
 let installerQa=false;
 started=true;
 window.addEventListener('pagehide',()=>{disposed=true;stop?.();observer?.disconnect();},{once:true});
 observer=new MutationObserver(render);observer.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
 try{
  stop=await window.__TAURI__.event?.listen<UpdateRestartReport>('update-restart-status',event=>accept(event.payload));
  if(disposed){stop?.();return false;}
  // Subscribe first: the revision check protects a newer event from this read.
  const status=await invoke('update_restart_status');
  installerQa=status?.installerQa===true;accept(status);
  // Background windows may suspend animation frames. Only actual update
  // probation needs a painted readiness proof; ordinary startup must progress.
  if(probation)await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  if(!disposed&&ready())await invoke('ack_update_restart_ready');
 }catch{
  // This carries no renderer claims about signatures, paths, or installer exit.
  // Native code independently times out and retains artifacts without the ack.
 }
 // Startup has rendered and loaded settings, but has not registered a workspace
 // or opened a connection. Only a native authenticated Success releases this.
 if(recovery)throw Error('Update confirmation requires repair');
 if(probation)await new Promise<void>((resolve,reject)=>{settled=error=>{settled=undefined;error?reject(error):resolve();};});
 return installerQa;
}
