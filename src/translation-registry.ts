import {fileOperationTranslations} from "./translations-file-operations.js";
import {sideBookmarkTranslations,sideBookmarkErrors} from './translations-side-bookmarks.js';
import {tabDragTranslations} from "./translations-tab-drag.js";
import {syncActionTranslations} from "./translations-sync-actions.js";
import {themeTranslations} from "./translations-themes.js";
import {tabContextTranslations} from "./translations-tab-context.js";
import {archiveTranslations} from "./translations-archive.js";
import {retainedTranslations} from "./translations-retained.js";
import { appTranslations, appErrorTranslations } from './translations-app.js';
import { explorerTranslations, explorerErrorTranslations } from './translations-explorer.js';

const shared:Record<string,string>={
  '設定':'Settings',
  '設定を保存':'Save settings',
  '「{0}」を削除しますか？':'Delete "{0}"?',
  '「{name}」を削除しますか？':'Delete "{name}"?',
  'テーマを保存できませんでした。 {0}':'Could not save the theme. {0}',
};
const sharedMessages:Record<string,string>={
  'テーマを保存できませんでした。 {0}':'Could not save the theme. {0}',
};
export const catalogConflicts:string[]=[];
function merge(parts:Record<string,string>[]):Record<string,string>{
  const merged:Record<string,string>=Object.create(null);
  for(const part of parts)for(const [key,value] of Object.entries(part)){
    if(Object.hasOwn(merged,key)&&merged[key]!==value){
      if(catalogConflicts.length<128)catalogConflicts.push(key);
      continue;
    }
    merged[key]=value;
  }
  return merged;
}
export const catalog=merge([sideBookmarkTranslations,fileOperationTranslations,shared,appTranslations,explorerTranslations,archiveTranslations,retainedTranslations,themeTranslations,tabContextTranslations,tabDragTranslations,syncActionTranslations]);
export const ownedMessages=merge([sideBookmarkErrors,sharedMessages,appErrorTranslations,explorerErrorTranslations,retainedTranslations,tabContextTranslations,tabDragTranslations,syncActionTranslations]);
