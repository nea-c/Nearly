//! Same-parent positive upload candidates only. Directory/delete scheduler stays serial.
use super::*;
use std::{cell::Cell,collections::HashSet};
// Four balances the measured latency benefit against server handle pressure.
const DEFAULT_WIDTH:usize=4;
fn width()->usize{
    #[cfg(test)] if let Ok(value)=std::env::var("NEARLY_SYNC_WIDTH"){if let Ok(n)=value.parse::<usize>(){if [1,2,4,8].contains(&n){return n;}}}
    DEFAULT_WIDTH
}
pub(super) struct Parallel{prepared:HashSet<PathBuf>,bytes:usize}
impl Default for Parallel{fn default()->Self{Self{prepared:HashSet::from([PathBuf::new()]),bytes:0}}}
impl Parallel{pub(super) fn reset(&mut self){*self=Self::default();}}
// True means the iteration was handled (or latched an error); caller re-enters
// watcher/cancel/debounce handling before selecting another mutation.
pub(super) fn run(parallel:&mut Parallel,ready:&Path,selected_absent:bool,queue:&mut HashMap<PathBuf,Pending>,connection:&mut sftp::Connection,root:&Path,root_identity:(u64,u64),remote:&str,id:&str,stop:&AtomicBool,state:&Arc<Mutex<Status>>,rules:&crate::exclusion::Rules,options:&SyncOptions,delete_enabled:bool,directories:&HashMap<PathBuf,Option<DeletionBasis<sftp::RemoteDirectoryStamp>>>,inventory:&mut HashMap<PathBuf,DeletionBasis<sftp::RemoteStamp>>,file_bytes:&mut usize,listing_hints:&mut HashMap<PathBuf,ListingHint>,absent:&mut HashMap<PathBuf,crate::listing_absence::ListedAbsence>,session:u64)->Option<bool>{
    let limit=width().min(connection.upload_cap);if limit<2||connection.needs_recycle()||directories.contains_key(ready){return None;}
    let positive=|path:&Path,item:&Pending|item.force_upload||(path==ready&&selected_absent)||absent.get(path).is_some_and(|a|a.matches(session));
    let eligible=|path:&Path,item:&Pending|{
        item.last.elapsed()>=Duration::from_millis(500)&&positive(path,item)&&!directories.contains_key(path)
            &&(!delete_enabled||path.ancestors().skip(1).filter(|p|!p.as_os_str().is_empty()).all(|p|directories.get(p).and_then(Option::as_ref).is_some_and(|b|b.expected(session).is_ok())))
            &&!rules.excludes(path,false).unwrap_or(true)&&(options.recursive||path.components().count()==1)
    };
    if !queue.get(ready).is_some_and(|item|eligible(ready,item)){return None;}
    let parent=ready.parent().unwrap_or(Path::new(""));
    let mut paths=vec![ready.to_path_buf()];
    // Case-only watcher aliases must settle serially, not poison the whole job
    // by entering a batch with two names for the same Windows source.
    let source_key=|p:&Path|dunce::canonicalize(root.join(p)).ok().map(|p|p.to_string_lossy().to_lowercase());
    let mut sources=HashSet::new();if let Some(key)=source_key(ready){sources.insert(key);}
    let mut targets=HashSet::from([ready.to_string_lossy().to_lowercase()]);
    for (path,item) in queue.iter(){
        if paths.len()>=limit{break;}
        if path.as_path()==ready||path.parent()!=Some(parent)||!eligible(path,item){continue;}
        let Some(key)=source_key(path)else{continue;};
        let target=path.to_string_lossy().to_lowercase();
        if sources.contains(&key)||targets.contains(&target){continue;}
        sources.insert(key);targets.insert(target);paths.push(path.clone());
    }
    if paths.len()<2{return None;}
    for path in &paths{
        match local_transfer_action(root,path,&root_identity,delete_enabled&&inventory.contains_key(path),stop){
            Ok(LocalAction::Upload)=>(),Ok(_)=>return None,
            Err(error)=>{state.lock().unwrap().failure_context(&error,Some(path),"validate","not_committed",queue.len(),stop.load(Ordering::SeqCst));return Some(false);}
        }
    }
    state.lock().unwrap().activity.mark_working();
    if !delete_enabled&&!parallel.prepared.contains(parent){
        match sftp::prepare_upload_parent(connection,remote,parent,stop){
            Ok(created)=>{
                if created{state.lock().unwrap().committed_remote_change(remote,parent);}
                let next=parallel.bytes.saturating_add(parent.as_os_str().len().saturating_mul(2).saturating_add(128));
                if next<=16*1024*1024&&parallel.prepared.len()<10000{parallel.prepared.insert(parent.to_path_buf());parallel.bytes=next;}
            },
            Err(error)=>{state.lock().unwrap().failure_context(&format!("Batch parent preparation failed; directories may have changed; no file batch dispatched: {error}"),Some(parent),"directory","unknown",queue.len(),stop.load(Ordering::SeqCst));return Some(false);}
        }
    }
    let items:Vec<_>=paths.iter().map(|p|{listing_hints.remove(p);absent.remove(p);queue.remove(p).unwrap()}).collect();
    let base=queue.len();let count=paths.len();let resolved=Cell::new(0usize);let bytes=Cell::new(0u64);let committed=Cell::new(false);let first_error=Cell::new(None::<usize>);let started=Instant::now();
    let verify=|path:&Path|{if local_transfer_action(root,path,&root_identity,delete_enabled&&inventory.contains_key(path),stop)?!=LocalAction::Upload{return Err("Local source disappeared or changed type before batch dispatch".into());}Ok(())};
    let on_complete=|index:usize,outcome:&sftp::BatchUploadResult|{
        let mut s=state.lock().unwrap();
        if let Some(n)=outcome.committed_bytes{committed.set(true);s.sent+=1;s.committed_remote_change(remote,&paths[index]);bytes.set(bytes.get().saturating_add(n));s.latency=items[index].first.elapsed().as_millis()as u64;}
        match &outcome.result{
            Ok(sftp::SourceOutcome::Complete(_))=>{resolved.set(resolved.get()+1);s.log(&format!("Uploaded {}",paths[index].display()));},
            Ok(sftp::SourceOutcome::Changed{..})=>s.log(&format!("Local source changed; waiting to resend {}",paths[index].display())),
            Err(error)=>{if !outcome.cancelled&&first_error.get().is_none(){first_error.set(Some(index));}s.log(&format!("Batch {} ({:?}, settling in-flight results): {error}",paths[index].display(),outcome.commit));},
        }
        s.pending=base+count-resolved.get();s.speed=if s.failure.is_some()||outcome.result.is_err(){0}else{(bytes.get()as f64/started.elapsed().as_secs_f64().max(0.001))as u64};
    };
    let outcomes=match sftp::upload_batch(connection,root,&paths,remote,stop,id,delete_enabled,&verify,&on_complete){
        Ok(outcomes)=>outcomes,
        Err(error)=>{for(path,item)in paths.iter().zip(items){queue.insert(path.clone(),item);}state.lock().unwrap().failure_context(&error,Some(ready),"upload","not_committed",queue.len(),stop.load(Ordering::SeqCst));return Some(false);}
    };
    let mut ownership_error=None;
    for (index,(outcome,mut item)) in outcomes.iter().zip(items).enumerate(){
        let mut unresolved=!matches!(outcome.result,Ok(sftp::SourceOutcome::Complete(_)));
        let data=match &outcome.result{Ok(sftp::SourceOutcome::Complete(data))=>Some(data),Ok(sftp::SourceOutcome::Changed{committed})=>committed.as_ref(),Err(_)=>None};
        if let Some((_,Some(stamp)))=data{
            if let Err(error)=remember_file(inventory,paths[index].clone(),stamp.clone(),file_bytes){if ownership_error.is_none(){ownership_error=Some((index,error));}unresolved=true;}
        }
        if unresolved{item.last=Instant::now();item.force_upload=true;queue.insert(paths[index].clone(),item);}
    }
    if let Some(index)=first_error.get(){
        let outcome=&outcomes[index];let commit=match outcome.commit{sftp::BatchCommit::Committed=>"committed",sftp::BatchCommit::Unknown=>"unknown",sftp::BatchCommit::NotCommitted=>"not_committed"};
        state.lock().unwrap().failure_context(outcome.result.as_ref().err().unwrap(),Some(&paths[index]),"upload",commit,queue.len(),false);
    }else if let Some((index,error))=ownership_error{state.lock().unwrap().failure_context(&error,Some(&paths[index]),"record","committed",queue.len(),false);}
    state.lock().unwrap().pending=queue.len();
    Some(committed.get())
}
