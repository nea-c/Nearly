use super::*;
use std::{collections::HashSet,path::PathBuf};
use std::{cell::RefCell,sync::atomic::AtomicU8};
#[derive(Default)]
pub(super) struct Ledger{pub(super) phase:AtomicU8,pub(super) bytes:AtomicU64}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) enum BatchCommit{NotCommitted,Unknown,Committed}
pub(crate) struct BatchUploadResult{
    pub result:Result<SourceOutcome<(u64,Option<RemoteStamp>)>,String>,
    pub commit:BatchCommit,
    pub committed_bytes:Option<u64>,
    pub cancelled:bool,
}
fn validate(root:&Path,remote:&str,paths:&[PathBuf])->Result<(),String>{
    if paths.is_empty()||paths.len()>8{return Err("Invalid upload batch size".into());}
    let parent=paths[0].parent();let mut targets=HashSet::new();let mut sources=HashSet::new();
    for path in paths{
        if path.parent()!=parent{return Err("Upload batch must use one parent directory".into());}
        if !targets.insert(recorded_target(remote,path)?.to_lowercase()){return Err("Duplicate or case-aliased upload target".into());}
        let source=root.join(path).canonicalize().map_err(|_|"Batch source unavailable")?;
        if !source.starts_with(root)||!sources.insert(source.to_string_lossy().to_lowercase()){return Err("Escaped or aliased upload source".into());}
    }
    Ok(())
}
pub(crate) fn upload_batch(s:&mut Connection,root:&Path,paths:&[PathBuf],remote:&str,stop:&AtomicBool,id:&str,recorded:bool,verify_local:&dyn Fn(&Path)->Result<(),String>,on_complete:&dyn Fn(usize,&BatchUploadResult))->Result<Vec<BatchUploadResult>,String>{
    validate(root,remote,paths)?;
    if paths.len()>s.upload_cap{return Err("Upload batch exceeds server handle limit; no file writes attempted".into());}
    let ledgers:Vec<_>=paths.iter().map(|_|Ledger::default()).collect();
    let slots:Vec<RefCell<Option<BatchUploadResult>>>=paths.iter().map(|_|RefCell::new(None)).collect();
    // Preserve the existing aggregate eight WRITE requests /256KiB window.
    let window=8/paths.len();let shared=&*s;
    let execution=s.run(stop,async {
        // Never try_join here: a failed peer must not erase sibling commit ACKs.
        futures_util::future::join_all(paths.iter().enumerate().map(|(index,path)|{
            let ledger=&ledgers[index];let slot=&slots[index];
            async move{
                let upload=match verify_local(path){Ok(())=>upload_async(shared,root,path,remote,stop,id,false,window,Some(ledger)).await,Err(error)=>Err(error)};
                let result=match upload{
                    Ok(SourceOutcome::Complete(receipt)) if recorded=>record_upload_receipt(shared,root,path,remote,stop,receipt).await
                        .map(|o|match o{SourceOutcome::Complete((b,stamp))=>SourceOutcome::Complete((b,Some(stamp))),SourceOutcome::Changed{committed}=>SourceOutcome::Changed{committed:committed.map(|(b,stamp)|(b,Some(stamp)))}})
                        .map_err(|reason|format!("Upload committed; {reason}")),
                    Ok(SourceOutcome::Complete(receipt))=>Ok(SourceOutcome::Complete((receipt.bytes,None))),
                    Ok(SourceOutcome::Changed{..})=>Ok(SourceOutcome::Changed{committed:None}),
                    Err(error)=>Err(error),
                };
                let cancelled=stop.load(Ordering::SeqCst)&&result.as_ref().err().is_some_and(|e|e.starts_with("Operation stopped")||e.starts_with("Upload committed; Operation stopped"));
                let outcome=outcome(result,ledger,cancelled);on_complete(index,&outcome);*slot.borrow_mut()=Some(outcome);
            }
        })).await;
        Ok(())
    });
    let interrupted=execution.is_err();let reason=execution.err().unwrap_or_else(||"Missing batch outcome; restart to reconcile".into());
    let mut results=Vec::with_capacity(paths.len());
    for (index,slot) in slots.into_iter().enumerate(){
        let result=if let Some(result)=slot.into_inner(){result}else{
            let ledger=&ledgers[index];let phase=ledger.phase.load(Ordering::SeqCst);
            let message=match phase{2=>format!("Upload committed; {reason}"),1=>format!("Final rename outcome uncertain; {reason}"),_ if stop.load(Ordering::SeqCst)=>"Operation stopped before final rename; staging may remain".into(),_=>reason.clone()};
            let result=outcome(Err(message),ledger,interrupted&&stop.load(Ordering::SeqCst));on_complete(index,&result);result
        };
        results.push(result);
    }
    if results.iter().any(|r|r.result.is_err()){let _=s.abort.0.shutdown(Shutdown::Both);}
    Ok(results)
}
fn outcome(result:Result<SourceOutcome<(u64,Option<RemoteStamp>)>,String>,ledger:&Ledger,cancelled:bool)->BatchUploadResult{
    let commit=match ledger.phase.load(Ordering::SeqCst){2=>BatchCommit::Committed,1=>BatchCommit::Unknown,_=>BatchCommit::NotCommitted};
    let committed_bytes=(commit==BatchCommit::Committed).then(||ledger.bytes.load(Ordering::SeqCst));
    BatchUploadResult{result,commit,committed_bytes,cancelled}
}
pub(crate) fn prepare_upload_parent(s:&mut Connection,remote:&str,parent:&Path,stop:&AtomicBool)->Result<bool,String>{
    let root=normalize(remote)?;let target=if parent.as_os_str().is_empty(){root.clone()}else{recorded_target(&root,parent)?};
    s.run(stop,async{checked_directory(&s.raw,&root,false).await?;checked_directory_created(&s.raw,&target,true,Some(&root)).await})
}
