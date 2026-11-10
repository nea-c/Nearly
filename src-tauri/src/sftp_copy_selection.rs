//! Bounded small-file groups. Directories and large files remain sequential.
use super::*;
use crate::file_ops::{check, ItemOutcome, Outcome};
use crate::operation_progress::Progress;
use std::cell::{Cell, RefCell};
pub(super) const SMALL_FILE: u64 = 256 * 1024;

pub(super) fn parent(path: &str) -> &str {
    let value = path.rsplit_once('/').map(|v|v.0).unwrap_or("");
    if value.is_empty() { "/" } else { value }
}
pub(super) struct CopyFile { pub source: String, pub target: String, pub size: u64 }

async fn copy_one(s: &Connection, file: &CopyFile, stop: &AtomicBool, progress: Option<&Progress>) -> Result<(), String> {
    check(stop)?;
    let input = s.raw.open(file.source.clone(), OpenFlags::READ, FileAttributes::empty()).await
        .map_err(|_|remote_error("copy source open"))?.handle;
    if let Err(error) = check(stop) { let _=s.raw.close(input).await; return Err(error); }
    let output = match s.raw.open(file.target.clone(), OpenFlags::CREATE|OpenFlags::EXCLUDE|OpenFlags::WRITE, FileAttributes::empty()).await {
        Ok(value) => value.handle,
        Err(_) => { let _=s.raw.close(input).await; return Err("Remote target creation failed; partial target retained; no overwrite attempted".into()); }
    };
    let copied=sftp_copy::contents(s,&input,&output,file.size,stop,progress).await;
    if copied.is_ok() {if let Some(p)=progress {let state=p.snapshot();if state.total.is_some_and(|total|total>0 && state.done>=total){p.phase("finalizing");}}}
    // Release both admitted handles even after data failure. Both acknowledgements
    // settle; successful sibling receipts are saved before returning any error.
    let (source_close,target_close)=tokio::join!(s.raw.close(input),s.raw.close(output));
    copied?;
    source_close.map_err(|_|remote_error("copy source close"))?;
    target_close.map_err(|_|remote_error("copy target close"))?;
    Ok(())
}

pub(super) async fn files_async(s:&Connection,files:&[CopyFile],stop:&AtomicBool,progress:Option<&Progress>,selected:bool,slots:&[RefCell<Option<Result<(),String>>>],started:&[Cell<bool>]) {
    futures_util::future::join_all(files.iter().enumerate().map(|(index,file)|async move {
        if stop.load(Ordering::SeqCst) { return; }
        started[index].set(true);
        let result=copy_one(s,file,stop,progress).await;
        if result.is_ok() { if let Some(p)=progress {p.committed();if selected {p.selection_committed();}} }
        *slots[index].borrow_mut()=Some(result);
    })).await;
}
pub(super) fn files(s:&Connection,files:&[CopyFile],stop:&AtomicBool,progress:Option<&Progress>,selected:bool)->Vec<(bool,Result<(),String>)> {
    let slots:Vec<_>=files.iter().map(|_|RefCell::new(None)).collect();
    let started:Vec<_>=files.iter().map(|_|Cell::new(false)).collect();
    // Cancellation stops new READ/WRITE stages, but does not drop admitted replies.
    // Each raw request retains its existing 15-second deadline.
    let execution:Result<(),String>=runtime().block_on(async {files_async(s,files,stop,progress,selected,&slots,&started).await;Ok(())});
    let reason=execution.err().unwrap_or_else(||"Copy not admitted after cancellation".into());
    let results:Vec<_>=slots.into_iter().zip(started).map(|(slot,started)|(started.get(),slot.into_inner().unwrap_or_else(||Err(reason.clone())))).collect();
    if results.iter().any(|(_,r)|r.is_err()) { let _=s.abort.0.shutdown(Shutdown::Both); }
    results
}

// Look ahead only within the bounded current group. No all-selection inventory.
pub(crate) fn selection(s:&mut Connection,selected:&[(String,Option<String>)],stop:&AtomicBool,progress:Option<&Progress>)->Outcome {
    let mut parents=OperationParents::default();
    let mut outcomes=Vec::with_capacity(selected.len());let mut completed=0;let mut index=0;let mut failed=false;
    let mut lookahead:Option<Result<FileAttributes,String>>=None;
    while index<selected.len() {
        if failed || stop.load(Ordering::SeqCst) {
            outcomes.push(ItemOutcome{source:selected[index].0.clone(),completed:false,attempted:false,message:"Not attempted after cancellation or earlier failure; refresh before retrying".into()});index+=1;continue;
        }
        if let Some(p)=progress {p.item(index+1,selected.len());}
        let mut group=Vec::new();
        while index+group.len()<selected.len() && group.len()<s.copy_cap.max(1) {
            let at=index+group.len();let (source,target)=&selected[at];
            let metadata=lookahead.take().unwrap_or_else(||runtime().block_on(guarded(stop,async {
                check(stop)?;parents.check(&s.raw,parent(source)).await?;
                let attrs=s.raw.lstat(source.clone()).await.map_err(|_|remote_error("source lookup"))?.attrs;
                if attrs.is_symlink() || (!attrs.is_dir() && !attrs.file_type().is_file()) {return Err("Remote tree contains a symlink or unsupported entry; operation refused".into());}
                parents.check(&s.raw,parent(target.as_deref().ok_or("Copy requires destination")?)).await?;
                Ok(attrs)
            })));
            match metadata {
                Ok(a) if !a.is_dir() && a.size.is_some_and(|size|size<=SMALL_FILE) && s.copy_cap>0 => {
                    group.push(CopyFile{source:source.clone(),target:target.clone().unwrap(),size:a.size.unwrap()});
                }
                other => {lookahead=Some(other);break;}
            }
        }
        if !group.is_empty() {
            if let Some(p)=progress {p.group(index+1,selected.len(),group.len());p.plan("bytes",group.iter().map(|f|f.size).sum());}
            let results=files(s,&group,stop,progress,true);
            if let Some(p)=progress {p.phase("finalizing");}
            for (file,(attempted,result)) in group.into_iter().zip(results) {
                let ok=result.is_ok();if ok {completed+=1;} else {failed=true;}
                outcomes.push(ItemOutcome{source:file.source,completed:ok,attempted,message:result.map(|_|"Remote copy completed; refresh both folders".into()).unwrap_or_else(|e|format!("{e}. Partial/uncertain targets may remain; refresh before retrying"))});index+=1;
            }
            continue;
        }
        let result=match lookahead.take().unwrap() {
            Err(error)=>Err(error),
            Ok(_) if s.copy_cap==0=>Err("Remote server handle limit is below the two handles required for copying; no copy attempted".into()),
            Ok(attrs)=>file_operation_prepared(s,crate::file_ops::Action::Copy,&selected[index].0,selected[index].1.as_deref(),stop,progress,&mut parents,Some(attrs)),
        };
        let ok=result.is_ok();let message=match result {Ok(out)=>{completed+=out.completed;if let Some(p)=progress {p.selection_committed();}out.message},Err(error)=>{failed=true;error}};
        outcomes.push(ItemOutcome{source:selected[index].0.clone(),completed:ok,attempted:true,message});index+=1;
    }
    Outcome{completed,items:outcomes,message:"Remote selection finished; inspect individual results and refresh".into()}
}
