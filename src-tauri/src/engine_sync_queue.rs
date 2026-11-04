//! Watcher dirty directories, not an authorization cache.
use std::{collections::BTreeMap,path::{Path,PathBuf},time::{Duration,Instant}};
pub(super) fn stop_pending(cycle_remaining:usize,dirty:usize,unknown:bool)->usize{cycle_remaining.saturating_add(dirty).max(usize::from(unknown))}
#[derive(Default)]pub(super) struct Dirty{pub(super) entries:BTreeMap<PathBuf,(Instant,Instant)>,bytes:usize}
impl Dirty{
 pub(super) fn notice(&mut self,relative:&Path,directory:bool,structural:bool,at:Instant)->Result<bool,String>{
  if relative.components().any(|p|!matches!(p,std::path::Component::Normal(_))){return Err("Watcher path outside sync root".into())}if directory&&!structural{return Ok(false)}
  let parent=relative.parent().unwrap_or(Path::new(""));
  if let Some((_,seen))=self.entries.iter_mut().find(|(p,_)|parent.starts_with(p)){seen.0=seen.0.min(at);seen.1=seen.1.max(at);return Ok(true)}
  let cost=|p:&Path|p.as_os_str().len().saturating_mul(2).saturating_add(80);let children=self.entries.keys().filter(|p|p.starts_with(parent)).cloned().collect::<Vec<_>>();let reclaimed=children.iter().map(|p|cost(p)).sum::<usize>();let bytes=self.bytes.saturating_sub(reclaimed).saturating_add(cost(parent));
  if self.entries.len()-children.len()>=10000||bytes>16*1024*1024{return Err("Watcher dirty-directory budget exceeded; restart for full rescan".into())}
  let first=children.iter().map(|p|self.entries[p].0).min().unwrap_or(at).min(at);let last=children.iter().map(|p|self.entries[p].1).max().unwrap_or(at).max(at);for p in children{self.entries.remove(&p);}self.bytes=bytes;self.entries.insert(parent.to_owned(),(first,last));Ok(true)
 }
 pub(super) fn take_ready(&mut self,now:Instant)->Option<PathBuf>{
  let path=self.entries.iter().find(|(_,at)|now.saturating_duration_since(at.1)>=Duration::from_millis(500)||now.saturating_duration_since(at.0)>=Duration::from_secs(2)).map(|(p,_)|p.clone())?;self.entries.remove(&path);self.bytes=self.bytes.saturating_sub(path.as_os_str().len()*2+80);Some(path)
 }
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn integration_review_continuous_notices_have_a_finite_flush_deadline(){let t=Instant::now();let mut q=Dirty::default();for i in 0..=20{q.notice(Path::new("dir/edit"),false,false,t+Duration::from_millis(i*100)).unwrap();}assert_eq!(q.take_ready(t+Duration::from_secs(2)),Some(PathBuf::from("dir")));}
 #[test]fn integration_review_ancestor_coalescing_preserves_oldest_pending_age(){let t=Instant::now();let mut q=Dirty::default();q.notice(Path::new("dir/sub/edit"),false,false,t).unwrap();q.notice(Path::new("dir/new"),false,true,t+Duration::from_millis(1900)).unwrap();assert_eq!(q.take_ready(t+Duration::from_secs(2)),Some(PathBuf::from("dir")));}
 #[test]fn stop_summary_never_double_counts_idle_dirty_scopes_and_retains_unknown_work(){assert_eq!(stop_pending(0,2,false),2);assert_eq!(stop_pending(3,2,false),5);assert_eq!(stop_pending(3,2,true),5);assert_eq!(stop_pending(0,0,true),1);assert_eq!(stop_pending(0,0,false),0);}
 #[test]fn coalesces_ancestor_scope_without_losing_later_notice_debounce(){let mut q=Dirty::default();let t=Instant::now();q.notice(Path::new("one/sub/a"),false,false,t).unwrap();q.notice(Path::new("one/newdir"),true,true,t+Duration::from_millis(100)).unwrap();assert_eq!(q.entries.len(),1);assert!(q.entries.contains_key(Path::new("one")));assert!(q.take_ready(t+Duration::from_millis(599)).is_none());assert_eq!(q.take_ready(t+Duration::from_millis(600)),Some(PathBuf::from("one")));assert!(q.entries.is_empty());}
 #[test]fn directory_read_noise_does_not_create_work_and_file_or_remove_does(){let mut q=Dirty::default();let t=Instant::now();assert!(!q.notice(Path::new("dir"),true,false,t).unwrap());assert!(q.entries.is_empty());q.notice(Path::new("file"),false,true,t).unwrap();assert_eq!(q.take_ready(t+Duration::from_millis(500)),Some(PathBuf::new()));}
 #[test]fn unsafe_watch_path_never_creates_work(){let mut q=Dirty::default();for path in ["../bad","/outside"]{assert!(q.notice(Path::new(path),false,true,Instant::now()).is_err());}assert!(q.entries.is_empty());}
}
