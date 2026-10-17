const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

/** Both immutable roots use the same structure; only label and data role differ. */
export function syncPathSummary(kind:'source'|'destination',label:string,path:string):string{
 const legacy=kind==='source'?'sync-source':'target';
 return `<div class="sync-path-summary ${legacy}" role="group" aria-label="${escape(label)}"><small>${escape(label)}</small><code data-sync-${kind}>${escape(path)}</code></div>`;
}
