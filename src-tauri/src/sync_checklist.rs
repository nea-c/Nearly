//! Pure bounded remote inventory; no connection, path authorization or cache.
use std::{collections::{BTreeMap,HashSet},path::{Path,PathBuf}};
#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub(crate) enum Kind{File,Directory,Blocked}
#[derive(Clone,Copy,Debug)]pub(crate) struct Node{pub kind:Kind,pub version:Option<(u64,u32)>,pub permissions:Option<u32>}
#[derive(Default)]pub(crate) struct Inventory{pub entries:BTreeMap<PathBuf,Node>,retained:HashSet<PathBuf>,folded:HashSet<String>,bytes:usize}
impl Inventory{
 pub fn validate_locals(&self,local:&HashSet<PathBuf>)->Result<(),String>{
  let names=self.entries.keys().map(|p|(p.to_string_lossy().to_lowercase(),p)).collect::<BTreeMap<_,_>>();
  for path in local{if names.get(&path.to_string_lossy().to_lowercase()).is_some_and(|remote|*remote!=path){return Err("Sync target case alias; align local and remote filename case before restarting".into())}}Ok(())
 }
 pub fn insert(&mut self,path:PathBuf,node:Node)->Result<(),String>{
  let depth=path.components().count();if depth==0||depth>65||(depth==65&&node.kind==Kind::Directory)||path.components().any(|c|!matches!(c,std::path::Component::Normal(_))){return Err("Invalid remote inventory path".into())}
  let key=path.to_string_lossy().to_lowercase();let cost=path.as_os_str().len().saturating_mul((depth+2)*2).saturating_add(depth*128);
  if self.entries.len()>=10000||self.bytes.saturating_add(cost)>16*1024*1024||self.folded.contains(&key){return Err("Remote inventory ambiguous or exceeds budget; deletion refused".into())}
  if node.kind==Kind::Blocked{for p in path.ancestors().filter(|p|!p.as_os_str().is_empty()){self.retained.insert(p.to_owned());}}
  self.bytes+=cost;self.folded.insert(key);self.entries.insert(path,node);Ok(())
 }
 pub fn deletions(&self,local:&HashSet<PathBuf>)->Vec<PathBuf>{
  let mut paths=self.entries.iter().filter(|(p,n)|n.kind!=Kind::Blocked&&!local.contains(*p)&&!self.retained.contains(*p)).map(|(p,_)|p.clone()).collect::<Vec<_>>();
  paths.sort_by_key(|p|(std::cmp::Reverse(p.components().count()),p.clone()));paths
 }
}
#[cfg(test)]mod tests{
 use super::*;
 fn node(kind:Kind)->Node{Node{kind,version:Some((512,100)),permissions:None}}
 #[test]fn directory_depth_limit_still_allows_a_file_inside_64_directories(){let mut dir=PathBuf::new();for _ in 0..64{dir.push("d");}let mut i=Inventory::default();i.insert(dir.clone(),node(Kind::Directory)).unwrap();i.insert(dir.join("file"),node(Kind::File)).unwrap();assert!(i.insert(dir.join("too-deep-dir"),node(Kind::Directory)).is_err());assert!(i.insert(dir.join("more/file"),node(Kind::File)).is_err());}
 #[test]fn cross_side_case_alias_refuses_plan_before_upload_then_delete_can_erase_same_file(){let mut i=Inventory::default();i.insert("ITEM.bin".into(),node(Kind::File)).unwrap();assert!(i.validate_locals(&HashSet::from([PathBuf::from("item.bin")])).is_err());assert!(i.validate_locals(&HashSet::from([PathBuf::from("ITEM.bin")])).is_ok());}
 #[test]fn complete_inventory_deletes_only_absent_supported_entries_children_first(){let mut i=Inventory::default();for(p,k)in[("old",Kind::Directory),("old/file",Kind::File),("keep",Kind::File)]{i.insert(p.into(),node(k)).unwrap();}assert_eq!(i.deletions(&HashSet::from([PathBuf::from("keep")])),vec![PathBuf::from("old/file"),PathBuf::from("old")]);}
 #[test]fn unsupported_child_retains_itself_and_ancestor_directory(){let mut i=Inventory::default();for(p,k)in[("old",Kind::Directory),("old/link",Kind::Blocked),("old/file",Kind::File)]{i.insert(p.into(),node(k)).unwrap();}assert_eq!(i.deletions(&HashSet::new()),vec![PathBuf::from("old/file")]);}
 #[test]fn bounds_duplicates_and_unsafe_paths_do_not_publish_partial_entries(){let mut i=Inventory::default();i.insert("a".into(),node(Kind::File)).unwrap();assert!(i.insert("a".into(),node(Kind::File)).is_err());for p in ["../escape","/absolute","a/../b",""]{assert!(i.insert(p.into(),node(Kind::File)).is_err());}assert_eq!(i.entries.len(),1);for n in 1..10000{i.insert(format!("f{n}").into(),node(Kind::File)).unwrap();}assert!(i.insert("too-many".into(),node(Kind::File)).is_err());assert_eq!(i.entries.len(),10000);}
}
