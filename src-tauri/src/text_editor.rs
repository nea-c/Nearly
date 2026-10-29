use crate::{engine::Engine,sessions::Lease,text_codec::{self,Decoded},file_ops::check};
use serde::Serialize;
use std::{collections::HashMap,fs::{self,File},io::{Read,Write},path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::SystemTime};

pub enum Target {Local(PathBuf),Remote{path:String,lease:Lease}}
#[derive(serde::Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct OpenRequest{pub id:String,pub side:crate::file_ops::Side,pub path:String,pub workspace_id:String,pub session_id:Option<String>}
enum Snapshot{Local(LocalSnapshot),Remote(crate::text_remote::Snapshot)}
#[derive(PartialEq)]struct LocalSnapshot{bytes:Vec<u8>,identity:(u32,u64),modified:SystemTime,attributes:u32}
struct Content{target:Target,snapshot:Snapshot,decoded:Decoded,read_only:Option<String>}
pub struct Document{remote:bool,owner:String,pub workspace:String,key:String,token:String,_reservation:crate::engine::EditorReservation,closed:AtomicBool,content:Mutex<Content>,view:Mutex<View>,change:serde_json::Value}
#[derive(Default)]pub struct Broker{documents:Mutex<HashMap<String,Arc<Document>>>,opening:Mutex<()>,origin_gate:Mutex<()>,pending:Arc<std::sync::atomic::AtomicUsize>,origin_requests:Mutex<HashMap<String,tokio::sync::oneshot::Sender<bool>>>}
pub struct PendingOpen(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for PendingOpen{fn drop(&mut self){self.0.fetch_sub(1,Ordering::SeqCst);}}
#[derive(Clone,Serialize)]#[serde(rename_all="camelCase")]
pub struct View{pub token:String,pub text:String,encoding:&'static str,newline:&'static str,path:String,side:&'static str,connection_label:String,read_only:Option<String>}
#[derive(Serialize)]pub struct Saved{pub text:String,pub message:String}
fn error(e:crate::zip_preflight::ArchiveError)->String{format!("Local text save refused: {}",e.code)}
fn nonce()->Result<String,String>{let mut bytes=[0u8;16];getrandom::fill(&mut bytes).map_err(|_|"Random token unavailable")?;Ok(bytes.iter().map(|b|format!("{b:02x}")).collect())}
fn parent_locks(path:&Path)->Result<Vec<File>,String>{path.parent().ok_or("File parent unavailable")?.ancestors().collect::<Vec<_>>().into_iter().rev().map(|p|crate::local_publish::lock_dir(p).map_err(error)).collect()}
fn read_local(path:&Path)->Result<LocalSnapshot,String>{
 let file=crate::local_publish::source_file(path).map_err(error)?;read_local_handle(&file)
}
fn read_local_handle(file:&File)->Result<LocalSnapshot,String>{
 let before=file.metadata().map_err(|_|"Local metadata unavailable")?;
 if before.len()>text_codec::MAX_BYTES as u64{return Err("Text editor limit is 1 MiB".into());}
 let identity=crate::local_publish::identity(&file).map_err(error)?;let modified=before.modified().map_err(|_|"Local timestamp unavailable")?;
 let mut reader=file;let mut bytes=Vec::new();Read::by_ref(&mut reader).take(text_codec::MAX_BYTES as u64+1).read_to_end(&mut bytes).map_err(|_|"Local text read failed")?;
 let after=file.metadata().map_err(|_|"Local metadata unavailable")?;
 if bytes.len() as u64!=before.len()||before.len()!=after.len()||modified!=after.modified().map_err(|_|"Local timestamp unavailable")?{return Err("File changed while opening; reopen it".into());}
 #[cfg(windows)]let attributes={use std::os::windows::fs::MetadataExt;before.file_attributes()};
 #[cfg(not(windows))]let attributes=0;
 Ok(LocalSnapshot{bytes,identity,modified,attributes})
}
fn reserve_remote(engine:&Engine,id:&str,lease:&Lease,path:&str,identity:String)->Result<(),String>{use std::net::ToSocketAddrs;let p=lease.profile();let endpoints=(p.host.as_str(),p.port).to_socket_addrs().map_err(|_|"Remote endpoint unavailable")?.collect();engine.reserve_upload_operation(id,vec![],vec![path.into()],identity,endpoints)}
fn view_document(_token:&str,doc:&Document)->Result<View,String>{doc.view.lock().map(|v|v.clone()).map_err(|_|"Editor view lock failed".into())}
impl Broker {
 pub fn remote_tokens(&self,workspaces:&[String])->Result<Vec<String>,String>{Ok(self.documents.lock().map_err(|_|"Editor lock failed")?.values().filter(|d|d.remote&&workspaces.contains(&d.workspace)).map(|d|d.token.clone()).collect())}
 pub fn guard_origin_close<T>(&self,workspaces:&[String],close:impl FnOnce()->Result<T,String>)->Result<T,String>{
  // Serialize only insertion and intentional disconnection, never network I/O.
  // A pending read gets canceled by its originating lease before it can insert.
  let _origin=self.origin_gate.lock().map_err(|_|"Editor origin lock failed")?;
  if !self.remote_tokens(workspaces)?.is_empty(){return Err("Close this connection's remote editor documents first; unsaved changes may still be open".into());}
  close()
 }
 pub fn begin_origin_request(&self)->Result<(String,tokio::sync::oneshot::Receiver<bool>),String>{let id=nonce()?;let(tx,rx)=tokio::sync::oneshot::channel();let mut requests=self.origin_requests.lock().map_err(|_|"Editor request lock failed")?;if !requests.is_empty(){return Err("An editor close confirmation is already pending".into());}requests.insert(id.clone(),tx);Ok((id,rx))}
 pub fn resolve_origin_request(&self,id:&str,accepted:bool)->Result<(),String>{if let Some(tx)=self.origin_requests.lock().map_err(|_|"Editor request lock failed")?.remove(id){let _=tx.send(accepted);}Ok(())}

 pub fn changed(&self,owner:&str,token:&str)->Result<serde_json::Value,String>{Ok(self.get(owner,token)?.change.clone())}
 pub fn pending_open(&self)->PendingOpen{self.pending.fetch_add(1,Ordering::SeqCst);PendingOpen(self.pending.clone())}
 pub fn list(&self,owner:&str)->Result<Vec<View>,String>{let docs:Vec<_>=self.documents.lock().map_err(|_|"Editor lock failed")?.values().filter(|d|d.owner==owner).cloned().collect();let mut views=Vec::new();for d in docs{if d.closed.load(Ordering::SeqCst){continue;}let v=view_document(&d.token,&d)?;if !d.closed.load(Ordering::SeqCst){views.push(v);}}Ok(views)}
 pub fn get(&self,owner:&str,token:&str)->Result<Arc<Document>,String>{let docs=self.documents.lock().map_err(|_|"Editor lock failed")?;let doc=docs.get(token).ok_or("Editor document is closed")?;if doc.owner!=owner{return Err("Editor document belongs to another window".into());}Ok(doc.clone())}
 pub fn any_open(&self)->bool{self.documents.lock().map(|d|!d.is_empty()).unwrap_or(true)}
 pub fn has_window(&self,owner:&str)->bool{(owner=="text-editor"&&self.pending.load(Ordering::SeqCst)!=0)||self.documents.lock().map(|d|d.values().any(|v|v.owner==owner)).unwrap_or(true)}
 pub fn has_workspace(&self,workspace:&str)->bool{self.documents.lock().map(|d|d.values().any(|v|v.workspace==workspace)).unwrap_or(true)}
 pub fn forget_window(&self,owner:&str){if owner=="text-editor"{if let Ok(mut requests)=self.origin_requests.lock(){for(_,tx)in requests.drain(){let _=tx.send(false);}}}if let Ok(mut d)=self.documents.lock(){for v in d.values().filter(|v|v.owner==owner){v.closed.store(true,Ordering::SeqCst);}d.retain(|_,v|v.owner!=owner);}}
 pub fn close_window(&self,owner:&str)->Result<(),String>{let mut docs=self.documents.lock().map_err(|_|"Editor lock failed")?;let owned:Vec<_>=docs.values().filter(|d|d.owner==owner).cloned().collect();let guards=owned.iter().map(|d|d.content.try_lock().map_err(|_|"Editor operation is still in progress")).collect::<Result<Vec<_>,_>>()?;for d in &owned{d.closed.store(true,Ordering::SeqCst);}drop(guards);docs.retain(|_,d|d.owner!=owner);Ok(())}
 pub fn close(&self,owner:&str,token:&str)->Result<(),String>{let mut docs=self.documents.lock().map_err(|_|"Editor lock failed")?;let doc=docs.get(token).ok_or("Editor document is closed")?;if doc.owner!=owner{return Err("Editor document belongs to another window".into());}{let _guard=doc.content.try_lock().map_err(|_|"Editor save in progress")?;doc.closed.store(true,Ordering::SeqCst);}docs.remove(token);Ok(())}
 pub fn open(&self,engine:&Engine,owner:&str,workspace:&str,id:&str,target:Target,stop:&Arc<AtomicBool>)->Result<View,String>{
  let _opening=self.opening.lock().map_err(|_|"Editor open lock failed")?;
  if let Target::Remote{lease,..}=&target{if lease.stop().load(Ordering::SeqCst){return Err("Session disconnected".into());}}
  let remote=matches!(&target,Target::Remote{..});
  let key=match &target{Target::Local(path)=>format!("local:{}",crate::file_ops::local_path(path.to_str().ok_or("Unsupported path")?,true)?.to_string_lossy().replace('/',"\\").to_uppercase()),Target::Remote{path,lease}=>{let p=lease.profile();format!("remote:{}:{}:{}:{}:{}:{}:{}",workspace,lease.generation(),p.host.to_ascii_lowercase(),p.port,p.user,p.host_key,crate::file_ops::remote_path(path)?)} };
  let existing={let docs=self.documents.lock().map_err(|_|"Editor lock failed")?;let existing=docs.values().find(|d|d.owner==owner&&d.key==key).cloned();if existing.is_none()&&docs.len()>=8{return Err("At most eight editor documents".into());}existing};if let Some(d)=existing{return view_document(&d.token,&d);}
  check(stop)?;
  engine.mark_editor_operation(id)?;
  let (target,snapshot,read_only,side,path,label)=match target{
   Target::Local(path)=>{let path=crate::file_ops::local_path(path.to_str().ok_or("Unsupported path")?,true)?;let _parents=parent_locks(&path)?;engine.reserve_upload_operation(id,vec![path.clone()],vec![],String::new(),vec![])?;let snap=read_local(&path)?;let read_only=(snap.attributes&!(0x80|0x20|0x2|0x4|0x2000)!=0).then(||"Read-only or special local file attributes are unsupported for editing".into());let label=path.to_string_lossy().into_owned();(Target::Local(path),Snapshot::Local(snap),read_only,"local",label,String::new())},
   Target::Remote{path,lease}=>{let path=crate::file_ops::remote_path(&path)?;lease.link_stop(stop)?;let(mut c,identity)=crate::sftp::connect(lease.profile(),lease.secret(),stop)?;reserve_remote(engine,id,&lease,&path,identity)?;let snap=crate::text_remote::read(&mut c,&path,stop)?;let read_only=crate::text_remote::read_only(&c,&snap);let label=format!("{}@{}:{}",lease.profile().user,lease.profile().host,lease.profile().port);(Target::Remote{path:path.clone(),lease},Snapshot::Remote(snap),read_only,"remote",path,label)}
  };
  let bytes=match &snapshot{Snapshot::Local(s)=>&s.bytes,Snapshot::Remote(s)=>&s.bytes};let decoded=text_codec::decode(bytes)?;check(stop)?;let token=nonce()?;
  let view=View{token:token.clone(),text:decoded.text.clone(),encoding:decoded.encoding(),newline:decoded.newline(),path,side,connection_label:label,read_only:read_only.clone()};
  let reservation=engine.retain_editor_reservation(id,&token)?;
  let change=match &target{Target::Local(_)=>serde_json::json!({"side":"local","path":view.path}),Target::Remote{lease,..}=>{let p=lease.profile();serde_json::json!({"side":"remote","path":view.path,"connectionKey":[p.host.to_ascii_lowercase(),p.port,p.user,p.host_key]})}};
  #[cfg(test)]tests::open_checkpoint();
  let _origin=self.origin_gate.lock().map_err(|_|"Editor origin lock failed")?;
  if let Target::Remote{lease,..}=&target{if lease.stop().load(Ordering::SeqCst){return Err("Session disconnected while opening editor".into());}}
  let mut docs=self.documents.lock().map_err(|_|"Editor lock failed")?;docs.insert(token.clone(),Arc::new(Document{remote,owner:owner.into(),workspace:workspace.into(),key,token,_reservation:reservation,closed:AtomicBool::new(false),content:Mutex::new(Content{target,snapshot,decoded,read_only}),view:Mutex::new(view.clone()),change}));Ok(view)
 }
 pub fn save(&self,engine:&Engine,owner:&str,token:&str,id:&str,text:&str,stop:&Arc<AtomicBool>)->Result<Saved,String>{
  let doc=self.get(owner,token)?;save_document(&doc,engine,id,text,stop)
 }
}
fn save_document(doc:&Document,engine:&Engine,id:&str,text:&str,stop:&Arc<AtomicBool>)->Result<Saved,String>{
 let mut state=doc.content.try_lock().map_err(|_|"Editor save in progress")?;if doc.closed.load(Ordering::SeqCst){return Err("Editor document is closed".into());}if let Some(reason)=&state.read_only{return Err(reason.clone());}let bytes=state.decoded.encode(text)?;check(stop)?;
 engine.bind_editor_operation(id,&doc.token)?;
  let snapshot=match (&state.target,&state.snapshot){
   (Target::Local(path),Snapshot::Local(original))=>{
    let validated=crate::file_ops::local_path(path.to_str().ok_or("Unsupported path")?,true)?;if validated!=*path{return Err("Editor file path changed; reopen it".into());}
    let _parents=parent_locks(path)?;engine.reserve_upload_operation(id,vec![path.clone()],vec![],String::new(),vec![])?;
    if read_local(path)?!=*original{return Err("External file change detected; original was not overwritten. Reopen and compare your edits".into());}
    if bytes!=original.bytes{
     let budget=crate::zip_preflight::Budget::new(stop);let mut stage=crate::local_publish::OwnedStage::create(path.parent().unwrap(),false,&budget).map_err(error)?;
     let result=(||{stage.handle.write_all(&bytes).map_err(|_|"Local stage write failed")?;stage.handle.sync_all().map_err(|_|"Local stage flush failed")?;
      #[cfg(windows)]{use std::os::windows::ffi::OsStrExt;use windows::{core::PCWSTR,Win32::Storage::FileSystem::{SetFileAttributesW,FILE_FLAGS_AND_ATTRIBUTES}};let wide:Vec<u16>=stage.path.as_os_str().encode_wide().chain(Some(0)).collect();unsafe{SetFileAttributesW(PCWSTR(wide.as_ptr()),FILE_FLAGS_AND_ATTRIBUTES(original.attributes))}.map_err(|_|"Local file attributes could not be preserved")?;}
      if read_local(path)?!=*original{return Err("External file change detected before publication; original retained".into());}#[cfg(test)]tests::publication_gap(path);check(stop)?;stage.publish_replacing_verified(path,&budget,|handle|{if read_local_handle(handle).map_err(|_|crate::zip_preflight::ArchiveError::new("verification_failed"))?!=*original{return Err(crate::zip_preflight::ArchiveError::new("external_change"));}Ok(())}).map_err(error)?;Ok::<(),String>(())})();
     if let Err(e)=result{let _=stage.discard_file();return Err(format!("{e}; owned staging may remain at {}",stage.path.display()));}
    }
    let after=read_local(path)?;if after.bytes!=bytes{return Err("Saved file changed again; reopen and compare before retrying".into());}Snapshot::Local(after)
   },
   (Target::Remote{path,lease},Snapshot::Remote(original))=>{lease.link_stop(stop)?;let(mut c,identity)=crate::sftp::connect(lease.profile(),lease.secret(),stop)?;reserve_remote(engine,id,lease,path,identity)?;Snapshot::Remote(crate::text_remote::save(&mut c,path,original,&bytes,stop)?)},
   _=>return Err("Editor snapshot unavailable".into()),
  };
  state.snapshot=snapshot;state.decoded.text=text.to_owned();doc.view.lock().map_err(|_|"Saved, but editor view refresh failed")?.text=text.to_owned();Ok(Saved{text:text.into(),message:"Saved".into()})
 }

#[cfg(test)] mod tests {
 use super::*;
 type OpenHook=Option<(std::sync::mpsc::Sender<()>,std::sync::mpsc::Receiver<()>)>;
 thread_local!{static OPEN_HOOK:std::cell::RefCell<OpenHook>=const{std::cell::RefCell::new(None)};}
 pub(super)fn hold_open(ready:std::sync::mpsc::Sender<()>,release:std::sync::mpsc::Receiver<()>){OPEN_HOOK.with(|hook|*hook.borrow_mut()=Some((ready,release)));}
 pub(super)fn open_checkpoint(){if let Some((ready,release))=OPEN_HOOK.with(|hook|hook.borrow_mut().take()){ready.send(()).unwrap();release.recv_timeout(std::time::Duration::from_secs(5)).unwrap();}}
 #[test]fn origin_confirmation_is_bounded_scoped_and_destroy_cleanup_replies_false(){
  let broker=Broker::default();let(first,mut response)=broker.begin_origin_request().unwrap();assert!(broker.begin_origin_request().is_err());broker.resolve_origin_request(&first,false).unwrap();assert_eq!(response.try_recv().unwrap(),false);
  let(second,mut response)=broker.begin_origin_request().unwrap();broker.resolve_origin_request(&first,true).unwrap();assert!(matches!(response.try_recv(),Err(tokio::sync::oneshot::error::TryRecvError::Empty)));broker.forget_window("other-window");assert!(matches!(response.try_recv(),Err(tokio::sync::oneshot::error::TryRecvError::Empty)));broker.forget_window("text-editor");assert_eq!(response.try_recv().unwrap(),false);broker.resolve_origin_request(&second,true).unwrap();assert!(broker.begin_origin_request().is_ok());
 }
 #[test]fn review_listing_does_not_wait_for_a_document_save(){let root=std::env::temp_dir().join(format!("nearly-editor-review-list-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let file=root.join("a.txt");fs::write(&file,b"sample").unwrap();let e=Engine::default();let b=Broker::default();let stop=e.claim_operation("open").unwrap();let view=b.open(&e,"text-editor","origin","open",Target::Local(file),&stop).unwrap();e.finish_operation("open");let doc=b.get("text-editor",&view.token).unwrap();let held=doc.content.lock().unwrap();let (tx,rx)=std::sync::mpsc::channel();let result=std::thread::scope(|scope|{let worker=scope.spawn(||{tx.send(b.list("text-editor").map(|v|v.len())).unwrap();});let result=rx.recv_timeout(std::time::Duration::from_millis(300));drop(held);worker.join().unwrap();result});assert_eq!(result.unwrap(),Ok(1),"listing must use a non-blocking view snapshot");drop(doc);b.close("text-editor",&view.token).unwrap();fs::remove_dir_all(root).unwrap();}
 #[test]fn review_zip_of_a_sibling_is_allowed_but_edited_source_and_parent_are_protected(){let root=std::env::temp_dir().join(format!("nearly-editor-review-zip-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let a=root.join("a.txt");let bfile=root.join("b.txt");fs::write(&a,b"edited").unwrap();fs::write(&bfile,b"other").unwrap();let e=Engine::default();let b=Broker::default();let stop=e.claim_operation("open").unwrap();let v=b.open(&e,"text-editor","origin","open",Target::Local(a.clone()),&stop).unwrap();e.finish_operation("open");e.claim_archive_operation("zip").unwrap();assert!(e.reserve_archive_operation("zip",bfile.clone(),root.join("b.zip"),root.clone()).is_ok(),"staging parent alone must not block unrelated ZIP");e.finish_operation("zip");for(id,source,target)in[("zip-edited",a.clone(),root.join("a.zip")),("zip-parent",root.clone(),root.join("parent.zip")),("zip-overwrite",bfile.clone(),a.clone())]{e.claim_archive_operation(id).unwrap();assert!(e.reserve_archive_operation(id,source,target,root.clone()).is_err());e.finish_operation(id);}b.close("text-editor",&v.token).unwrap();e.claim_archive_operation("zip-first").unwrap();e.reserve_archive_operation("zip-first",bfile,root.join("b.zip"),root.clone()).unwrap();let stop=e.claim_operation("open-after-zip").unwrap();let v=b.open(&e,"text-editor","origin","open-after-zip",Target::Local(a),&stop).expect("unrelated existing archive must not block opening a document");e.finish_operation("open-after-zip");b.close("text-editor",&v.token).unwrap();e.finish_operation("zip-first");fs::remove_dir_all(root).unwrap();}
 #[test]fn eight_editor_documents_do_not_consume_unrelated_worker_slots(){let root=std::env::temp_dir().join(format!("nearly-editor-capacity-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let e=Engine::default();let b=Broker::default();for n in 0..8{let path=root.join(format!("{n}.txt"));fs::write(&path,b"sample").unwrap();let id=format!("open-{n}");let stop=e.claim_operation(&id).unwrap();b.open(&e,"text-editor","source",&id,Target::Local(path),&stop).unwrap();e.finish_operation(&id);}for n in 0..8{e.claim_operation(&format!("worker-{n}")).unwrap();}assert!(e.claim_operation("ninth-worker").is_err());for n in 0..8{e.finish_operation(&format!("worker-{n}"));}b.close_window("text-editor").unwrap();e.claim_operation("after-close").unwrap();assert!(e.reserve_operation("after-close",vec![root.clone()],vec![],String::new(),vec![],true).is_ok());e.finish_operation("after-close");fs::remove_dir_all(root).unwrap();}
 #[test]fn multiple_editor_tabs_deduplicate_and_release_each_reservation_independently(){
  let root=std::env::temp_dir().join(format!("nearly-editor-tabs-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let e=Engine::default();let b=Broker::default();let mut views=Vec::new();for n in 0..2{let path=root.join(format!("{n}.txt"));fs::write(&path,b"sample").unwrap();let id=format!("open-{n}");let stop=e.claim_operation(&id).unwrap();let view=b.open(&e,"text-editor","origin",&id,Target::Local(path.clone()),&stop).unwrap();e.finish_operation(&id);views.push((path,view));}
  let stop=e.claim_operation("duplicate").unwrap();assert_eq!(b.open(&e,"text-editor","another-origin","duplicate",Target::Local(views[0].0.clone()),&stop).unwrap().token,views[0].1.token);e.finish_operation("duplicate");assert_eq!(b.list("text-editor").unwrap().len(),2);assert!(!b.has_window("origin"));b.close("text-editor",&views[0].1.token).unwrap();
  for n in 0..2{let id=format!("operation-{n}");e.claim_operation(&id).unwrap();assert_eq!(e.reserve_operation(&id,vec![views[n].0.clone()],vec![],String::new(),vec![],true).is_err(),n==1);e.finish_operation(&id);}
  b.forget_window("text-editor");e.claim_operation("after-destroy").unwrap();assert!(e.reserve_operation("after-destroy",vec![root.clone()],vec![],String::new(),vec![],true).is_ok());e.finish_operation("after-destroy");fs::remove_dir_all(root).unwrap();
 }
 #[test]fn editor_document_reserves_only_its_target_until_closed(){
  let root=std::env::temp_dir().join(format!("nearly-editor-reservation-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let file=root.join("a.txt");let sibling=root.join("b.txt");fs::write(&file,b"original").unwrap();fs::write(&sibling,b"other").unwrap();let e=Engine::default();let b=Broker::default();let stop=e.claim_operation("open").unwrap();let v=b.open(&e,"editor","source","open",Target::Local(file.clone()),&stop).unwrap();e.finish_operation("open");
  for (id,path,blocked) in [("delete-file",file.clone(),true),("move-parent",root.clone(),true),("other-file",sibling,false)]{e.claim_operation(id).unwrap();let result=e.reserve_operation(id,vec![path],vec![],String::new(),vec![],true);assert_eq!(result.is_err(),blocked,"{id}");e.finish_operation(id);}
  let stop=e.claim_operation("save").unwrap();b.save(&e,"editor",&v.token,"save","changed",&stop).unwrap();e.finish_operation("save");b.close("editor",&v.token).unwrap();e.claim_operation("after-close").unwrap();assert!(e.reserve_operation("after-close",vec![file],vec![],String::new(),vec![],true).is_ok());e.finish_operation("after-close");fs::remove_dir_all(root).unwrap();
 }
 thread_local!{static GAP:std::cell::Cell<u8>=const{std::cell::Cell::new(0)};}
 pub(super)fn publication_gap(path:&Path){let mode=GAP.with(|g|g.replace(0));if mode==1{fs::write(path,b"external").unwrap();}if mode==2{let replacement=path.with_extension("replacement");fs::write(&replacement,b"external").unwrap();fs::rename(replacement,path).unwrap();}}
 #[test]fn external_change_after_preflight_is_not_overwritten(){for mode in [1,2]{
  let root=std::env::temp_dir().join(format!("nearly-editor-publication-gap-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let path=root.join("sample.txt");fs::write(&path,b"original").unwrap();let e=Engine::default();let b=Broker::default();let stop=e.claim_operation("open").unwrap();let view=b.open(&e,"window","workspace","open",Target::Local(path.clone()),&stop).unwrap();e.finish_operation("open");GAP.with(|g|g.set(mode));let stop=e.claim_operation("save").unwrap();let result=b.save(&e,"window",&view.token,"save","new text",&stop);e.finish_operation("save");assert!(result.is_err(),"concurrent external edit must be refused");assert_eq!(fs::read(&path).unwrap(),b"external");b.close("window",&view.token).unwrap();fs::remove_dir_all(root).unwrap();
 }}
 #[test]fn captured_document_cannot_save_after_explicit_close(){
  let root=std::env::temp_dir().join(format!("nearly-editor-close-race-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let path=root.join("plain.txt");fs::write(&path,b"original").unwrap();let e=Engine::default();let b=Broker::default();let stop=e.claim_operation("open").unwrap();let view=b.open(&e,"window","workspace","open",Target::Local(path.clone()),&stop).unwrap();e.finish_operation("open");let captured=b.get("window",&view.token).unwrap();b.close("window",&view.token).unwrap();let stop=e.claim_operation("late-save").unwrap();assert!(save_document(&captured,&e,"late-save","must not be saved",&stop).is_err());assert_eq!(fs::read(&path).unwrap(),b"original");e.finish_operation("late-save");fs::remove_dir_all(root).unwrap();
 }
 #[test] fn local_save_roundtrip_and_conflict_keep_original(){
  let root=std::env::temp_dir().join(format!("nearly-editor-local-{}",getrandom::u64().unwrap()));std::fs::create_dir(&root).unwrap();let path=root.join("sample.txt");std::fs::write(&path,b"\xef\xbb\xbforiginal\r\n").unwrap();
  let e=crate::engine::Engine::default();let b=Broker::default();let stop=e.claim_operation("open").unwrap();let view=b.open(&e,"window","workspace","open",Target::Local(path.clone()),&stop).unwrap();e.finish_operation("open");
  let stop=e.claim_operation("save").unwrap();b.save(&e,"window",&view.token,"save","updated\n",&stop).unwrap();e.finish_operation("save");assert_eq!(std::fs::read(&path).unwrap(),b"\xef\xbb\xbfupdated\r\n");
  std::fs::write(&path,b"external\r\n").unwrap();let stop=e.claim_operation("conflict").unwrap();assert!(b.save(&e,"window",&view.token,"conflict","bad\n",&stop).is_err());e.finish_operation("conflict");assert_eq!(std::fs::read(&path).unwrap(),b"external\r\n");assert!(b.close("other",&view.token).is_err());b.close("window",&view.token).unwrap();std::fs::remove_dir_all(root).unwrap();
 }
 #[test] fn native_lifecycle_guards_keep_open_editor_and_cancel_preserves_bytes(){
  let root=std::env::temp_dir().join(format!("nearly-editor-guard-{}",getrandom::u64().unwrap()));fs::create_dir(&root).unwrap();let path=root.join("plain.txt");fs::write(&path,b"original").unwrap();
  let state=crate::AppState::default();{let mut r=state.ownership.lock().unwrap();r.bootstrap("window").unwrap();r.claim("window","workspace").unwrap();}
  let stop=state.engine.claim_operation("open").unwrap();let view=state.text_editor.open(&state.engine,"window","workspace","open",Target::Local(path.clone()),&stop).unwrap();state.engine.finish_operation("open");
  assert!(crate::seal_native_window_close(&state,"window",false).is_err());assert!(crate::begin_native_update(&state).is_err());assert!(state.text_editor.has_workspace("workspace"));
  let stop=state.engine.claim_operation("cancel").unwrap();state.engine.cancel_operation("cancel").unwrap();assert!(state.text_editor.save(&state.engine,"window",&view.token,"cancel","unsafe",&stop).is_err());state.engine.finish_operation("cancel");assert_eq!(fs::read(&path).unwrap(),b"original");
  state.text_editor.close("window",&view.token).unwrap();assert!(crate::seal_native_window_close(&state,"window",false).is_ok());assert!(!state.text_editor.any_open());fs::remove_dir_all(root).unwrap();
 }
}
#[cfg(test)]#[path="text_editor_fixture.rs"]mod fixture;
