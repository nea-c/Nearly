import {
  localFolder,
  remoteFolder,
  text,
  validateConnectionKey,
} from "./explorer-preferences.js";
import { BookmarkTreeEditor, flatBookmarkTree, validateBookmarkTree, type BookmarkTree, type BookmarkTreeNode } from './bookmark-tree.js';
import type { FolderBookmark } from './explorer-preferences.js';
// Only the shared editor's in-memory adapter uses this identity. It is never persisted.
export const LOCAL_BOOKMARK_SCOPE = JSON.stringify(['side','sftp','example.invalid',22,'u','']);
export type SideBookmarkNode = Omit<BookmarkTreeNode,'connectionKey'> & { connectionKey?: string; name?: string; bookmarkId?: string };
export interface SideBookmarkTree { version: 1; nodes: SideBookmarkNode[] }
export interface SideFolderHistory { path: string; openedAt: number; connectionKey?: string }
export function sideBookmarkAdapter(records: readonly LocalBookmark[], side: BookmarkSide): FolderBookmark[] {
  return records.map(b=>({id:b.id,name:b.name,local:side==='local'?b.path:'C:\\',remote:side==='remote'?b.path:'/',connectionKey:side==='remote'?(b as RemoteBookmark).connectionKey:LOCAL_BOOKMARK_SCOPE}));
}
export function sideTreeAdapter(tree: SideBookmarkTree): BookmarkTree {
  return {version:1,nodes:tree.nodes.map(n=>({...n,connectionKey:n.connectionKey??LOCAL_BOOKMARK_SCOPE}) as BookmarkTreeNode)};
}
export function validateSideBookmarkTree(value: unknown, records: readonly LocalBookmark[], side: BookmarkSide): SideBookmarkTree {
  const bookmarks=sideBookmarkAdapter(records,side);
  if(value===undefined)return fromSideTree(flatBookmarkTree(bookmarks),side);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid side bookmark tree');
  const v=value as SideBookmarkTree;
  if(!Array.isArray(v.nodes)||v.nodes.some(n=>!n||typeof n!=='object'||(side==='local'?Object.hasOwn(n,'connectionKey'):!Object.hasOwn(n,'connectionKey'))))throw Error('Invalid side bookmark scope');
  return fromSideTree(validateBookmarkTree({...v,nodes:v.nodes.map(n=>({...n,...(side==='local'?{connectionKey:LOCAL_BOOKMARK_SCOPE}:{})}))},bookmarks,true),side);
}
export function fromSideTree(tree: BookmarkTree,side: BookmarkSide): SideBookmarkTree {
  return {version:1,nodes:tree.nodes.map(n=>{const {connectionKey,...node}=n;return side==='local'?node:{...node,connectionKey};})};
}
export function sideBookmarkEditor(tree: SideBookmarkTree,records: LocalBookmark[],side:BookmarkSide) {
  return new BookmarkTreeEditor(sideTreeAdapter(tree),sideBookmarkAdapter(records,side));
}
export function validateSideHistory(value:unknown,side:BookmarkSide):SideFolderHistory[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>200)throw Error('Invalid side folder history');
  const seen=new Set<string>();
  return value.map(v=>{
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['path','openedAt',...(side==='remote'?['connectionKey']:[])].includes(k))||!Number.isSafeInteger(v.openedAt)||v.openedAt<0)throw Error('Invalid side folder history');
    const path=side==='local'?localFolder(v.path):remoteFolder(v.path),connectionKey=side==='remote'?validateConnectionKey(v.connectionKey):undefined;
    const key=JSON.stringify([connectionKey??'',side==='local'?path.toLowerCase():path]);
    if(seen.has(key))throw Error('Duplicate side folder history');seen.add(key);
    return {path,openedAt:v.openedAt,...(connectionKey?{connectionKey}:{})};
  });
}
export interface LocalBookmark {
  id: string;
  name: string;
  path: string;
}
export interface RemoteBookmark extends LocalBookmark {
  connectionKey: string;
}
export type BookmarkSide = "local" | "remote";
export function validateSideBookmarks(
  value: unknown,
  side: BookmarkSide,
): RemoteBookmark[] | LocalBookmark[] {
  if (!Array.isArray(value) || value.length > 500)
    throw Error("Invalid side bookmark collection");
  const ids = new Set<string>(),
    paths = new Set<string>(),
    names = new Set<string>();
  return value.map((v) => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).some(
        (k) =>
          ![
            "id",
            "name",
            "path",
            ...(side === "remote" ? ["connectionKey"] : []),
          ].includes(k),
      )
    )
      throw Error("Invalid side bookmark");
    const id = text(v.id, 128),
      name = text(v.name, 100).trim(),
      path = side === "local" ? localFolder(v.path) : remoteFolder(v.path);
    const key = side === "remote" ? validateConnectionKey(v.connectionKey) : "";
    const pathKey = JSON.stringify([
        key,
        side === "local" ? path.toLowerCase() : path,
      ]),
      nameKey = JSON.stringify([key, name]);
    if (ids.has(id) || paths.has(pathKey) || names.has(nameKey))
      throw Error("Duplicate side bookmark name or path");
    ids.add(id);
    paths.add(pathKey);
    names.add(nameKey);
    return side === "remote"
      ? { id, name, path, connectionKey: key }
      : { id, name, path };
  });
}
