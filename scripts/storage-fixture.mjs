// QA fixture serialization and external maintenance integrity checks only.
// Never imported by application startup; live legacy data is natively validated.
import {createHash} from 'node:crypto';
export const names=['settings.json','history.json','bookmarks.json','sync-profiles.json','connections.json'];
const kinds=['settings','history','bookmarks','sync-profiles','connections'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function packSettings(a){
 const {connections:c,appearance,explorer:e,browse:b,sync,trust}=a;
 const files=[{appearance,paneColumns:e.paneColumns,paneSorts:b.paneSorts},{folderMappings:c.history,browseLocations:b.browseLocations,folderPairHistory:e.folderPairHistory},{local:e.localBookmarks??[],remote:e.remoteBookmarks??[],pair:{items:e.folderBookmarks,tree:e.bookmarkTree}},sync,{profiles:c.profiles,...(c.lastSelectedProfileId===undefined?{}:{lastSelectedProfileId:c.lastSelectedProfileId}),tree:c.tree,trust}];
 const output={};for(let i=4;i>=0;i--){const value={...files[i],schemaVersion:1,kind:kinds[i],revision:a.revision};if(i===0)value.manifest=Object.fromEntries(names.slice(1).map((n,j)=>[n,{revision:a.revision,sha256:hash(output[n])}]));output[names[i]]=JSON.stringify(value,null,2);}
 return output;
}
export function unpackSettings(files){
 const values=names.map((n,i)=>{const v=JSON.parse(files[n]);if(v.kind!==kinds[i]||v.schemaVersion!==1||!Number.isSafeInteger(v.revision)||v.revision<1)throw Error('Invalid generated fixture format');return v;});
 const [s,h,b,y,c]=values;
 for(let i=1;i<5;i++){const r=s.manifest[names[i]];if(r?.revision!==values[i].revision||r.sha256!==hash(files[names[i]]))throw Error('Fixture manifest mismatch');}
 return {schemaVersion:1,revision:s.revision,connections:{profiles:c.profiles,...(c.lastSelectedProfileId===undefined?{}:{lastSelectedProfileId:c.lastSelectedProfileId}),history:h.folderMappings,tree:c.tree},appearance:s.appearance,explorer:{localBookmarks:b.local,remoteBookmarks:b.remote,folderBookmarks:b.pair.items,folderPairHistory:h.folderPairHistory,paneColumns:s.paneColumns,bookmarkTree:b.pair.tree},browse:{browseLocations:h.browseLocations,paneSorts:s.paneSorts},sync:{exclusions:y.exclusions,syncOptions:y.syncOptions,syncPresets:y.syncPresets,retainedSyncs:y.retainedSyncs??[]},trust:c.trust};
}
