//! Bounded one-item parent preparation. No final file handle or bytes are prefetched.
use std::{fs::File,path::{Path,PathBuf},sync::atomic::{AtomicBool,Ordering},future::Future};
#[cfg(test)]pub(crate) static PREPARED:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]pub(crate) static USED:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
pub(crate) const MAX_PARENTS:usize=64;
pub(crate) const MAX_BINDING_UNITS:usize=32767;
pub(crate) struct Parents{root:PathBuf,relative:PathBuf,held:Vec<File>}
impl Parents{
 pub(crate) fn prepare(root:&Path,relative:&Path,stop:&AtomicBool)->Result<Option<Self>,String>{
  crate::file_ops::check(stop)?;
  if !root.is_absolute()||relative.as_os_str().is_empty()||relative.components().any(|p|!matches!(p,std::path::Component::Normal(_))){return Err("Invalid look-ahead source binding".into())}
  if relative.components().count()>MAX_PARENTS{return Ok(None)}
  #[cfg(windows)]{use std::os::windows::ffi::OsStrExt;if root.as_os_str().encode_wide().count()+relative.as_os_str().encode_wide().count()+1>MAX_BINDING_UNITS{return Ok(None)}}
  #[cfg(not(windows))]{return Ok(None)}
  #[cfg(windows)]{
   let held=crate::engine::compatible_deletion_parents(root,relative)?;
   if held.len()!=relative.components().count(){return Err("Look-ahead source parent not present".into())}
   crate::file_ops::check(stop)?;
   #[cfg(test)]PREPARED.fetch_add(1,Ordering::Relaxed);
   Ok(Some(Self{root:root.to_owned(),relative:relative.to_owned(),held}))
  }
 }
 pub(crate) fn open_at_use(self,root:&Path,relative:&Path,stop:&AtomicBool,validate:&dyn Fn(&Path,bool)->Result<(),String>)->Result<File,String>{self.open_with_sharing(root,relative,stop,validate,7)}
 pub(crate) fn open_at_use_held(self,root:&Path,relative:&Path,stop:&AtomicBool,validate:&dyn Fn(&Path,bool)->Result<(),String>)->Result<File,String>{let f=self.open_with_sharing(root,relative,stop,validate,3)?;crate::source_hold::opened();Ok(f)}
 fn open_with_sharing(self,root:&Path,relative:&Path,stop:&AtomicBool,validate:&dyn Fn(&Path,bool)->Result<(),String>,sharing:u32)->Result<File,String>{
  crate::file_ops::check(stop)?;
  if self.root!=root||self.relative!=relative||self.held.len()!=relative.components().count(){return Err("Look-ahead source binding mismatch".into())}
  for file in &self.held{
   let metadata=file.metadata().map_err(|_|"Look-ahead parent metadata unavailable")?;
   if !metadata.is_dir(){return Err("Look-ahead parent is not a directory".into())}
   #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return Err("Look-ahead parent is a reparse point".into())}}
  }
  // Caller invokes this AFTER the next Begin notification. Do not reuse a root
  // decision or a leaf file opened before that notification.
  validate(Path::new(""),true)?;
  crate::file_ops::check(stop)?;
  let mut options=std::fs::OpenOptions::new();options.read(true);
  #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.share_mode(sharing).custom_flags(0x00200000);}
  let file=options.open(root.join(relative)).map_err(|_|"Local source open failed")?;
  crate::source_change::Snapshot::capture(&file)?;
  #[cfg(test)]USED.fetch_add(1,Ordering::Relaxed);
  Ok(file)
 }
}
pub(crate) async fn during_current<F,T>(root:&Path,relative:&Path,stop:&AtomicBool,current:F)->Result<(T,Option<Parents>),String>where F:Future<Output=Result<T,String>>{
 let mut current=Box::pin(current);let mut attempted=false;let mut prepared=None;
 // No spawned work, byte queue or cancellation select. An issued current
 // operation always settles through its original future before token disposal.
 futures_util::future::poll_fn(|cx|match current.as_mut().poll(cx){
  std::task::Poll::Ready(Ok(value))=>{let next=if stop.load(Ordering::SeqCst){drop(prepared.take());None}else{prepared.take()};std::task::Poll::Ready(Ok((value,next)))},
  std::task::Poll::Ready(Err(error))=>{drop(prepared.take());std::task::Poll::Ready(Err(error))},
  std::task::Poll::Pending=>{if !attempted{attempted=true;prepared=Parents::prepare(root,relative,stop).ok().flatten();}std::task::Poll::Pending},
 }).await
}

#[cfg(all(test,windows))]mod tests{
 use super::*;use std::{fs,io::Read,time::SystemTime};
 struct Fixture{base:PathBuf,root:PathBuf}
 impl Fixture{fn new()->Self{let base=std::env::temp_dir().join(format!("nearly-lookahead-generated-{}-{:016x}",std::process::id(),getrandom::u64().unwrap()));fs::create_dir(&base).unwrap();fs::write(base.join("owned.marker"),b"GENERATED_LOOKAHEAD_ONLY").unwrap();let root=base.join("root");fs::create_dir_all(root.join("d")).unwrap();fs::write(root.join("d/item.bin"),b"oldbytes").unwrap();Self{base:base.canonicalize().unwrap(),root:root.canonicalize().unwrap()}}
 fn token(&self)->Parents{Parents::prepare(&self.root,Path::new("d/item.bin"),&AtomicBool::new(false)).unwrap().expect("one checked parent token")}}
 impl Drop for Fixture{fn drop(&mut self){let base=self.base.canonicalize().unwrap();assert!(base.starts_with(std::env::temp_dir().canonicalize().unwrap()));assert!(base.file_name().unwrap().to_string_lossy().starts_with("nearly-lookahead-generated-"));assert_eq!(fs::read(base.join("owned.marker")).unwrap(),b"GENERATED_LOOKAHEAD_ONLY");fs::remove_dir_all(base).unwrap();}}
 fn allow(_: &Path,_:bool)->Result<(),String>{Ok(())}
 #[test]fn lookahead_parent_token_holds_and_releases_only_its_ancestors(){let f=Fixture::new();let token=f.token();assert_eq!(token.held.len(),2);assert!(fs::rename(f.root.join("d"),f.root.join("moved")).is_err(),"ordinary parent rename must fail while token is held");drop(token);fs::rename(f.root.join("d"),f.root.join("moved")).unwrap();}
 #[test]fn lookahead_final_file_is_opened_fresh_after_same_metadata_replacement(){let f=Fixture::new();let time=SystemTime::now();File::options().write(true).open(f.root.join("d/item.bin")).unwrap().set_times(fs::FileTimes::new().set_modified(time)).unwrap();let token=f.token();fs::write(f.root.join("d/new.bin"),b"newbytes").unwrap();File::options().write(true).open(f.root.join("d/new.bin")).unwrap().set_times(fs::FileTimes::new().set_modified(time)).unwrap();fs::rename(f.root.join("d/new.bin"),f.root.join("d/item.bin")).unwrap();let mut file=token.open_at_use(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),&allow).unwrap();let mut bytes=Vec::new();file.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"newbytes");}
 #[test]fn lookahead_final_content_is_read_after_in_place_change(){let f=Fixture::new();let token=f.token();fs::write(f.root.join("d/item.bin"),b"edited now").unwrap();let mut file=token.open_at_use(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),&allow).unwrap();let mut bytes=Vec::new();file.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"edited now");}
 #[test]fn lookahead_missing_final_is_not_replaced_by_prefetched_bytes(){let f=Fixture::new();let token=f.token();fs::remove_file(f.root.join("d/item.bin")).unwrap();assert!(token.open_at_use(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),&allow).is_err());}
 #[test]fn lookahead_root_veto_after_begin_precedes_final_open(){use std::os::windows::fs::OpenOptionsExt;let f=Fixture::new();let token=f.token();let _exclusive=File::options().read(true).share_mode(0).open(f.root.join("d/item.bin")).unwrap();let err=token.open_at_use(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),&|p,d|{assert!(p.as_os_str().is_empty()&&d);Err("generated root veto after Begin".into())}).err().unwrap();assert_eq!(err,"generated root veto after Begin");}
 #[test]fn lookahead_token_cannot_be_used_for_another_item_or_root(){let f=Fixture::new();fs::write(f.root.join("d/other.bin"),b"otherone").unwrap();fs::create_dir(f.base.join("d")).unwrap();fs::write(f.base.join("d/item.bin"),b"outside!").unwrap();assert!(crate::sftp::compatible::open_source_checked(&f.root,Path::new("d/other.bin"),&allow).is_ok());assert!(crate::sftp::compatible::open_source_checked(&f.base,Path::new("d/item.bin"),&allow).is_ok());let token=f.token();assert!(token.open_at_use(&f.root,Path::new("d/other.bin"),&AtomicBool::new(false),&allow).is_err());let token=f.token();assert!(token.open_at_use(&f.base,Path::new("d/item.bin"),&AtomicBool::new(false),&allow).is_err());}
 #[test]fn lookahead_stop_at_use_drops_parent_handles(){let f=Fixture::new();let token=f.token();assert!(token.open_at_use(&f.root,Path::new("d/item.bin"),&AtomicBool::new(true),&allow).is_err());fs::rename(f.root.join("d"),f.root.join("moved")).unwrap();}
 #[test]fn lookahead_parent_depth_cap_falls_back_without_opening(){let f=Fixture::new();let p=(0..MAX_PARENTS+1).map(|_|"d").collect::<PathBuf>();assert!(Parents::prepare(&f.root,&p,&AtomicBool::new(false)).unwrap().is_none());assert!(Parents::prepare(&f.root,Path::new("../other"),&AtomicBool::new(false)).is_err());}
 #[test]fn lookahead_binding_memory_cap_falls_back_before_parent_open(){let f=Fixture::new();let long="x".repeat(MAX_BINDING_UNITS);assert!(Parents::prepare(&f.root,Path::new(&long),&AtomicBool::new(false)).unwrap().is_none());}
 #[test]fn lookahead_exact_parent_cap_is_supported_and_bounded(){let f=Fixture::new();let mut rel=(0..MAX_PARENTS-1).map(|_|"q").collect::<PathBuf>();fs::create_dir_all(f.root.join(&rel)).unwrap();rel.push("item.bin");fs::write(f.root.join(&rel),b"bounded").unwrap();let token=Parents::prepare(&f.root,&rel,&AtomicBool::new(false)).unwrap().unwrap();assert_eq!(token.held.len(),MAX_PARENTS);let mut file=token.open_at_use(&f.root,&rel,&AtomicBool::new(false),&allow).unwrap();let mut bytes=Vec::new();file.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"bounded");}
 #[tokio::test]async fn lookahead_only_prepares_while_current_is_pending_and_drops_on_error(){let f=Fixture::new();let (tx,rx)=tokio::sync::oneshot::channel::<Result<usize,String>>();let root=f.root.clone();let actor=tokio::spawn(async move{tokio::task::yield_now().await;assert!(fs::rename(root.join("d"),root.join("moved")).is_err());tx.send(Err("current WRITE failed".into())).unwrap();});let result=during_current(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),async{rx.await.map_err(|_|"fixture receiver closed".to_owned())?}).await;assert_eq!(result.err().unwrap(),"current WRITE failed");actor.await.unwrap();fs::rename(f.root.join("d"),f.root.join("moved")).unwrap();}
 #[tokio::test]async fn lookahead_pending_success_returns_one_token_and_no_file_bytes(){let f=Fixture::new();let(tx,rx)=tokio::sync::oneshot::channel::<Result<usize,String>>();let root=f.root.clone();let actor=tokio::spawn(async move{tokio::task::yield_now().await;assert!(fs::rename(root.join("d"),root.join("moved")).is_err());tx.send(Ok(7)).unwrap();});let(value,slot)=during_current(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),async{rx.await.map_err(|_|"fixture receiver closed".to_owned())?}).await.unwrap();assert_eq!(value,7);let token=slot.expect("exactly one prepared next item");assert!(token.held.len()<=MAX_PARENTS);actor.await.unwrap();drop(token);fs::rename(f.root.join("d"),f.root.join("moved")).unwrap();}
 #[tokio::test]async fn lookahead_stop_while_waiting_discards_slot_after_current_settles(){let f=Fixture::new();let stop=std::sync::Arc::new(AtomicBool::new(false));let other=stop.clone();let root=f.root.clone();let(tx,rx)=tokio::sync::oneshot::channel::<Result<usize,String>>();let actor=tokio::spawn(async move{tokio::task::yield_now().await;other.store(true,Ordering::SeqCst);assert!(fs::rename(root.join("d"),root.join("moved")).is_err(),"stop must not drop a queued token before the current operation settles");tx.send(Ok(7)).unwrap();});let(value,slot)=during_current(&f.root,Path::new("d/item.bin"),&stop,async{rx.await.map_err(|_|"fixture receiver closed".to_owned())?}).await.unwrap();assert_eq!(value,7);assert!(slot.is_none());actor.await.unwrap();fs::rename(f.root.join("d"),f.root.join("moved")).unwrap();}
 #[tokio::test]async fn lookahead_immediate_current_failure_does_not_prepare_next(){let f=Fixture::new();let result=during_current(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),async{Err::<usize,String>("current OPEN failed".into())}).await;assert_eq!(result.err().unwrap(),"current OPEN failed");fs::rename(f.root.join("d"),f.root.join("moved")).unwrap();}
 #[tokio::test]async fn lookahead_prepare_miss_does_not_abort_current_and_fresh_fallback_can_repair(){let f=Fixture::new();fs::remove_file(f.root.join("d/item.bin")).unwrap();fs::remove_dir(f.root.join("d")).unwrap();let(tx,rx)=tokio::sync::oneshot::channel::<Result<usize,String>>();let root=f.root.clone();let actor=tokio::spawn(async move{tokio::task::yield_now().await;fs::create_dir(root.join("d")).unwrap();fs::write(root.join("d/item.bin"),b"repaired").unwrap();tx.send(Ok(7)).unwrap();});let(value,slot)=during_current(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),async{rx.await.map_err(|_|"fixture receiver closed".to_owned())?}).await.unwrap();assert_eq!(value,7);assert!(slot.is_none());actor.await.unwrap();let mut file=crate::sftp::compatible::open_source_checked(&f.root,Path::new("d/item.bin"),&allow).unwrap();let mut bytes=Vec::new();file.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"repaired");}
 #[test]fn lookahead_post_transfer_change_detection_remains_fresh(){let f=Fixture::new();let old=f.token().open_at_use(&f.root,Path::new("d/item.bin"),&AtomicBool::new(false),&allow).unwrap();let snapshot=crate::source_change::Snapshot::capture(&old).unwrap();fs::write(f.root.join("d/item.bin"),b"new longer generated content").unwrap();let current=crate::sftp::compatible::open_source_checked(&f.root,Path::new("d/item.bin"),&allow).unwrap();assert_eq!(snapshot.changed(&old,&current,8).unwrap(),Some(crate::source_change::Change::Content));}
}
