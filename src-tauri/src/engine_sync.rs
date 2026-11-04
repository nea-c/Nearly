//! Directory-dirty compatible synchronization. Start/stop/reservations remain Engine-owned.
use super::*;
struct WorkerValidation<'a>{root:&'a Path,identity:(u64,u64),stop:&'a AtomicBool}
impl sftp::compatible::LocalValidation for WorkerValidation<'_>{
 fn check(&self,path:&Path,dir:bool)->Result<(),String>{
  if path.as_os_str().is_empty(){if local_root_identity(self.root)?!=self.identity{return Err("Local sync root changed; deletion refused".into())}return Ok(())}
  if dir{directory_action(self.root,path,&self.identity,self.stop).map(|_|())}else{local_transfer_action(self.root,path,&self.identity,true,self.stop).map(|_|())}
 }
 fn shares_upload_check(&self)->bool{cfg!(windows)}
 fn can_prepare_next(&self)->bool{cfg!(windows)}
 fn open_with_parents(&self,root:&Path,path:&Path,parents:Option<crate::parent_lookahead::Parents>)->Result<std::fs::File,String>{
  crate::file_ops::check(self.stop)?;if root!=self.root{return Err("Local source root mismatch".into())}
  match parents{Some(token)=>token.open_at_use(root,path,self.stop,&|p,d|self.check(p,d)),None=>self.open_source(root,path)}
 }
 fn open_source(&self,root:&Path,path:&Path)->Result<std::fs::File,String>{
  crate::file_ops::check(self.stop)?;if root!=self.root{return Err("Local source root mismatch".into())}
  sftp::compatible::open_source_checked(root,path,&|p,d|self.check(p,d))
 }
}

#[path="engine_sync_queue.rs"]mod dirty;
pub(super) fn worker(p:Profile,root:PathBuf,remote:String,_id:String,mut connection:sftp::Connection,state:Arc<Mutex<Status>>,stop:Arc<AtomicBool>,_retry:Arc<AtomicBool>,passphrase:zeroize::Zeroizing<String>,expected_identity:String,rules:crate::exclusion::Rules,options:SyncOptions,root_identity:(u64,u64)){

 let (tx,rx)=std::sync::mpsc::sync_channel(10000);let epoch=Arc::new(AtomicU64::new(0));let(cb_state,cb_stop,cb_epoch)=(state.clone(),stop.clone(),epoch.clone());
 let watcher=notify::recommended_watcher(move|event:Result<notify::Event,notify::Error>|{
  if matches!(&event,Ok(e)if matches!(e.kind,notify::EventKind::Access(_))){return;}
  let mut s=cb_state.lock().unwrap();if cb_stop.load(Ordering::SeqCst)||s.failure.is_some(){return;}
  if event.as_ref().map_or(true,|e|e.need_rescan()){s.failure_context("Watcher error: restart for a full rescan",None,"watch","unknown",0,false);cb_stop.store(true,Ordering::SeqCst);return;}
  #[cfg(test)] if let Ok(event)=&event{for path in &event.paths{new_file_wait_tests::mark(path,"watch");}}
  s.activity.mark_working();
  if tx.try_send((Instant::now(),event.unwrap())).is_err(){let pending=s.pending;s.failure_context("Watcher overflow: restart for a full rescan",None,"watch","unknown",pending,false);cb_stop.store(true,Ordering::SeqCst);}else{cb_epoch.fetch_add(1,Ordering::SeqCst);}
 });
 let mut watcher=match watcher{Ok(w)=>w,Err(_)=>{state.lock().unwrap().failure_context("Cannot initialize local watcher",None,"watch","not_committed",0,false);return;}};
 if watcher.watch(&root,if options.recursive{RecursiveMode::Recursive}else{RecursiveMode::NonRecursive}).is_err(){state.lock().unwrap().failure_context("Cannot monitor local sync root",None,"watch","not_committed",0,false);return;}
 let validation=WorkerValidation{root:&root,identity:root_identity,stop:&stop};
 let diagnostics=state.lock().unwrap().decisions.clone();diagnostics.compatible_policy();connection.diagnostics=Some(diagnostics.clone());
 let mut dirty=dirty::Dirty::default();let mut retry=sftp::compatible::RetryHints::new();let mut initial=true;let mut remaining_cycle=0usize;let mut consumed_epoch=0;let mut interrupted=false;
 state.lock().unwrap().log("Compatible sync: time priority, 2-second tolerance with size tie-break. Small files write directly; large files use fresh unique stages. Remote changes after listing may be overwritten/deleted. No foreign partial resume.");
 loop{
  if stop.load(Ordering::SeqCst)||state.lock().unwrap().failure.is_some(){break;}
  let observed=epoch.load(Ordering::SeqCst);let mut drained=false;
  for _ in 0..2000{match rx.try_recv(){Ok((at,event))=>{
   let structural=matches!(event.kind,notify::EventKind::Create(_)|notify::EventKind::Remove(_)|notify::EventKind::Modify(notify::event::ModifyKind::Name(_)));
   for path in event.paths{let Ok(relative)=path.strip_prefix(&root)else{continue;};let directory=std::fs::symlink_metadata(&path).is_ok_and(|m|m.is_dir());if let Err(e)=dirty.notice(relative,directory,structural,at){state.lock().unwrap().failure_context(&e,Some(relative),"watch","not_committed",dirty.entries.len(),false);break;}}
  },Err(std::sync::mpsc::TryRecvError::Empty)=>{drained=true;break;},Err(_)=>{state.lock().unwrap().failure_context("Watcher channel lost; restart for full rescan",None,"watch","unknown",dirty.entries.len(),false);break;}}}
  if stop.load(Ordering::SeqCst)||state.lock().unwrap().failure.is_some(){break;}
  if drained&&epoch.load(Ordering::SeqCst)==observed{consumed_epoch=observed;}
  let pending=dirty::stop_pending(remaining_cycle,dirty.entries.len(),initial);
  let scope=if initial{Some(PathBuf::new())}else{dirty.take_ready(Instant::now())};
  if let Some(mut scope)=scope{
   state.lock().unwrap().activity.mark_working();
   if local_root_identity(&root).ok()!=Some(root_identity){state.lock().unwrap().failure_context("Local sync root changed; deletion refused",None,"validate","not_committed",pending,false);break;}
   if connection.needs_recycle(){match sftp::connect(&p,&passphrase,&stop){Ok((mut c,identity))if identity==expected_identity=>{c.diagnostics=Some(diagnostics.clone());connection=c;scope=PathBuf::new();retry.clear();},Ok(_)=>{state.lock().unwrap().failure_context("Server identity changed; verify before restart",None,"connect","unknown",pending,false);break;},Err(e)=>{state.lock().unwrap().failure_context(&e,None,"connect","unknown",pending,stop.load(Ordering::SeqCst));break;}}}
   let remaining=std::cell::Cell::new(0usize);let active=std::cell::RefCell::new(scope.clone());let operation=std::cell::Cell::new("scan");let started=Instant::now();let result=sftp::compatible::cycle_with_validation(&mut connection,&root,&remote,&scope,&rules,options.recursive,options.delete_removed,&stop,&retry,&validation,&|path,event|{
    use sftp::compatible::Event;let mut s=state.lock().unwrap();match event{
     Event::Plan(n)=>{remaining.set(n);s.pending=n;s.activity.scan_finished();s.log("Complete local/remote inventory; applying compatible checklist");return;},
      Event::Begin(op)=>{#[cfg(test)] if op=="compare"{new_file_wait_tests::mark(&root.join(path),"selected");}*active.borrow_mut()=path.to_owned();operation.set(op);return;},
      Event::Uploaded(bytes)=>{#[cfg(test)] new_file_wait_tests::mark(&root.join(path),"acknowledged");s.sent+=1;s.speed=(bytes as f64/started.elapsed().as_secs_f64().max(0.001))as u64;s.committed_remote_change(&remote,path);s.log(&format!("Uploaded {}",path.display()));},
     Event::Created=>{s.committed_remote_change(&remote,path);},Event::Deleted(directory)=>{if directory{s.committed_remote_directory_removal(&remote,path);}else{s.committed_remote_change(&remote,path);}s.log(&format!("Deleted {} (compatible checklist)",path.display()));},Event::Skipped=>(),
    }remaining.set(remaining.get().saturating_sub(1));s.pending=remaining.get();
   });remaining_cycle=remaining.get();initial=false;
   match result{
    Ok(sftp::compatible::Outcome::Complete)=>retry.retain(|p,_|!p.starts_with(&scope)),
    Ok(sftp::compatible::Outcome::Rescan{relative,expected})=>{
     let bytes=retry.keys().map(|p|p.as_os_str().len()*2+64).sum::<usize>();
     if retry.len()>=10000||bytes.saturating_add(relative.as_os_str().len()*2+64)>16*1024*1024{state.lock().unwrap().failure_context("Source-change retry budget exceeded; restart for rescan",Some(&relative),"watch","unknown",remaining_cycle,false);break;}
     retry.insert(relative.clone(),expected);remaining_cycle=0;
     if let Err(error)=dirty.notice(&scope.join(".nearly-rescan-intent"),false,true,Instant::now()){state.lock().unwrap().failure_context(&error,Some(&relative),"watch","unknown",1,false);break;}
     let mut s=state.lock().unwrap();s.pending=dirty.entries.len();s.log(&format!("Local source changed; waiting to resend {}",relative.display()));
    },
    Err(error)=>{interrupted=true;let commit=if error.contains("outcome is uncertain")||error.contains("outcome uncertain")||error.contains("written"){"unknown"}else{"not_committed"};state.lock().unwrap().failure_context(&error,Some(&active.borrow()),operation.get(),commit,dirty::stop_pending(remaining_cycle,dirty.entries.len(),true),stop.load(Ordering::SeqCst));break;}
   }
   continue; // Re-enter event drain before any caught-up state or next mutation.
  }
  {let mut s=state.lock().unwrap();let pending=dirty.entries.len();s.pending=pending;s.speed=0;let drained=drained&&epoch.load(Ordering::SeqCst)==observed;s.activity.settle(pending,drained,false,stop.load(Ordering::SeqCst),false);}
  thread::sleep(Duration::from_millis(50));
 }
 let mut s=state.lock().unwrap();if s.failure.is_none(){s.status="stopped".into();s.activity.stopped();}s.speed=0;s.record_stopped_queue(dirty::stop_pending(remaining_cycle,dirty.entries.len(),interrupted||initial||epoch.load(Ordering::SeqCst)!=consumed_epoch));
 // A pending event is never represented as successful completion. Explicit restart rebuilds a fresh checklist.
}

#[cfg(all(test,windows))]mod engine_lookahead_tests{
 use super::*;use sftp::compatible::LocalValidation;
 #[test]fn engine_lookahead_worker_explicitly_opts_in(){
  let stop=AtomicBool::new(false);let v=WorkerValidation{root:Path::new("D:/generated-unused"),identity:(0,0),stop:&stop};
  assert!(v.can_prepare_next(),"normal typed Engine validator must opt into bounded next-parent preparation");
 }
 #[test]fn engine_lookahead_default_callback_cannot_opt_in(){
  struct V;impl LocalValidation for V{fn check(&self,_:&Path,_:bool)->Result<(),String>{Err("ordinary per-item veto".into())}}
  assert!(!V.can_prepare_next());assert_eq!(V.open_with_parents(Path::new("D:/unused"),Path::new("missing"),None).err().unwrap(),"ordinary per-item veto");
 }
}
