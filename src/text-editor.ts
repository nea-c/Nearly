import {invoke} from './api.js';
import {getLanguage} from './i18n.js';
type Target={side:'local'|'remote';path:string;workspaceId:string;sessionId?:string};
// Local documents keep their independent lifetime. Remote documents follow their connection.
export const closeTextEditor=(ids:string[]=[])=>ids.length&&window.__TAURI__?invoke("request_text_editor_origin_close",{workspaceIds:ids}):Promise.resolve(true);
export const closeTextEditorForWorkspace=(id:string)=>closeTextEditor([id]);
export async function openTextEditor(target:Target,valid:()=>boolean,_changed:()=>Promise<void>){
 if(!valid())throw Error(getLanguage()==='ja'?'接続または対象タブが変わりました':'Connection or target tab changed');
 const id=crypto.randomUUID();await invoke('prepare_file_operation',{id});
 try{if(!valid())throw Error('Connection or target tab changed');await invoke('open_text_document',{request:{...target,id}});}
 catch(error){await invoke('cancel_file_operation',{id,abandon:true}).catch(()=>{});throw error;}
}
