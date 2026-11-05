//! Compatible directory-checklist sync. Manual file operations use their original paths.
use super::*;
async fn direct(raw:&RawSftpSession,handle:Vec<u8>,target:String,data:Vec<u8>,attrs:FileAttributes,stop:&AtomicBool)->Result<(),String>{
 let writes=data.chunks(32768).enumerate().map(|(i,b)|raw.write(handle.clone(),i as u64*32768,b.to_vec()));
 // All futures are polled together; packet IDs route even reversed replies.
 // Do not cancel/drop this future after issuing requests: settle close and all ACKs.
 let(writes,closed,time)=futures_util::future::join3(futures_util::future::join_all(writes),raw.close(handle),raw.setstat(target.clone(),attrs)).await;
 let failed=writes.iter().any(Result::is_err);let cancelled=stop.load(Ordering::SeqCst);
 if closed.is_err(){return Err("Direct sync close outcome is uncertain; partial final file may remain; restart to reconcile".into())}
 if failed||cancelled{raw.remove(target).await.map_err(|_|"Direct sync cleanup outcome is uncertain; partial final file may remain")?;return Err(if cancelled{"Operation stopped; direct partial final file removed"}else{"Direct sync WRITE failed; partial final file removed"}.into())}
 if time.is_err(){return Err("Direct sync bytes written; timestamp update failed; restart to reconcile".into())}Ok(())
}
#[path="sync_checklist.rs"]pub(crate) mod checklist;
pub(crate) enum Event{Plan(usize),Begin(&'static str),Uploaded(u64),Created,Deleted(bool),Skipped}
pub(crate) type RetryHints=std::collections::HashMap<std::path::PathBuf,Option<(u64,u32)>>;
pub(crate) enum Outcome{Complete,Rescan{relative:std::path::PathBuf,expected:Option<(u64,u32)>}}
#[path="sftp_sync_cycle.rs"]mod cycle_impl;
pub(crate) use cycle_impl::{cycle,cycle_with_validation,source as open_source_checked,source_held as open_held_source_checked};
/// The callback adapter retains its original per-action veto before comparison.
/// Only a validator that explicitly combines that action check with source open
/// may opt in; this does not cache any result for a later observation.
pub(crate) trait LocalValidation {
 fn check(&self,path:&Path,directory:bool)->Result<(),String>;
 fn shares_upload_check(&self)->bool{false}
 fn can_prepare_next(&self)->bool{false}
 fn uses_held_source(&self)->bool{false}
 fn open_with_parents(&self,root:&Path,path:&Path,parents:Option<crate::parent_lookahead::Parents>)->Result<std::fs::File,String>{drop(parents);self.open_source(root,path)}
 fn open_source(&self,root:&Path,path:&Path)->Result<std::fs::File,String>{
  self.check(path,false)?;
  cycle_impl::source(root,path,&|p,d|self.check(p,d))
 }
}
struct CallbackValidation<'a>(&'a dyn Fn(&Path,bool)->Result<(),String>);
impl LocalValidation for CallbackValidation<'_>{fn check(&self,p:&Path,d:bool)->Result<(),String>{(self.0)(p,d)}}
#[cfg(test)]#[path="sftp_sync_tests.rs"]mod protocol_tests;
#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub(crate) enum Decision{Upload,Skip,Retain}
pub(crate) fn classify(local:(u64,u32),remote:Option<(u64,u32)>)->Decision{
 let Some((size,time))=remote else{return Decision::Upload};
 let delta=local.1 as i64-time as i64;
 if delta>2{Decision::Upload}else if delta< -2{Decision::Retain}else if size!=local.0{Decision::Upload}else{Decision::Skip}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn compatible_time_priority_tolerance_and_size_tie_break(){
  assert_eq!(classify((469,100),None),Decision::Upload);
  assert_eq!(classify((469,100),Some((469,140))),Decision::Retain);
  assert_eq!(classify((351,100),Some((353,13178))),Decision::Retain);
  assert_eq!(classify((469,140),Some((469,100))),Decision::Upload);
  for time in [98,99,100,101,102]{assert_eq!(classify((469,time),Some((469,100))),Decision::Skip);}
  assert_eq!(classify((351,100),Some((353,100))),Decision::Upload);
 }
}
