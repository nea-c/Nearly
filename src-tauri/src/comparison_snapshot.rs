//! One initial comparison pass, not mutation/deletion authority or a session cache.
use super::*;
use std::{collections::{BTreeMap,HashMap,HashSet},path::PathBuf};
use std::cell::{Cell,RefCell};
use futures_util::{stream,StreamExt};

// One pass owns the aggregate bounds. Futures are polled together, not spawned;
// no RefCell borrow crosses an await and no observation survives this pass.
struct Budget{entries:Cell<usize>,bytes:Cell<usize>,batches:Cell<usize>,halt:Cell<bool>}
impl Budget{
    fn bytes(&self,n:usize)->bool{let next=self.bytes.get().saturating_add(n);self.bytes.set(next);next<=16*1024*1024}
    fn fallback(&self)->Result<Option<ComparisonSnapshot>,String>{self.halt.set(true);Ok(None)}
}

pub(crate) struct ComparisonSnapshot {
    pub hints: HashMap<PathBuf, crate::listing_hint::ListingHint>,
    pub missing: Vec<PathBuf>,
    pub directories: usize,
}
fn listing_unavailable(error:&SftpError)->bool{
    matches!(error,SftpError::Status(s) if matches!(s.status_code,StatusCode::PermissionDenied|StatusCode::OpUnsupported))
}

/// Scope reads to parents of the initial local files. A limit/ambiguous listing
/// returns None: discard the ENTIRE pass and use ordinary fresh comparisons.
/// Real permission/network/partial-read errors are errors, never absence.
pub(crate) fn comparison_snapshot(s:&mut Connection,remote:&str,paths:&[PathBuf],session:u64,stop:&AtomicBool)->Result<Option<ComparisonSnapshot>,String>{
    let root=normalize(remote)?;
    if paths.len()>10000{return Ok(None);}
    let mut groups:BTreeMap<PathBuf,Vec<PathBuf>>=BTreeMap::new();
    let mut path_bytes=0usize;
    for path in paths{
        recorded_target(&root,path)?;
        // Optional optimization bounds must not narrow initial_scan's supported
        // 64 directory levels plus a filename. Use the original path instead.
        if path.components().count()>64{return Ok(None);}
        path_bytes=path_bytes.saturating_add(path.as_os_str().len().saturating_mul(6).saturating_add(256));
        if path_bytes>16*1024*1024{return Ok(None);}
        groups.entry(path.parent().unwrap_or(Path::new("")).to_path_buf()).or_default().push(path.clone());
    }
    let requested={
        #[cfg(test)] { std::env::var("NEARLY_DIRECTORY_WIDTH").ok().and_then(|v|v.parse::<usize>().ok()).filter(|n|[1,2,4].contains(n)).unwrap_or(4) }
        #[cfg(not(test))] { 4usize }
    };
    let limit=s.upload_cap.clamp(1,requested);
    s.run(stop,async {
        let budget=Budget{entries:Cell::new(0),bytes:Cell::new(path_bytes),batches:Cell::new(0),halt:Cell::new(false)};
        let missing_parents=RefCell::new(HashSet::<String>::new());
        let mut result=ComparisonSnapshot{hints:HashMap::new(),missing:Vec::new(),directories:0};
        let mut groups=groups.into_iter();
        // Warm up with one fully guarded parent. Missing parents are cheap to
        // share in this pass's existing absence cache; speculative parallel
        // walks otherwise repeat the same missing ancestor. Presence changes
        // only scheduling, never how any later path is classified/validated.
        let limit=if let Some((relative,files))=groups.next(){
            let Some(first)=read_directory(s,&root,relative,files,session,stop,&budget,&missing_parents).await? else{return Ok(None);};
            let present=first.directories>0;
            result.hints.extend(first.hints);result.missing.extend(first.missing);result.directories+=first.directories;
            if present{limit}else{1}
        }else{1};
        let mut first_error=None;let mut fallback=false;
        let mut readers=stream::iter(groups.map(|(relative,files)|read_directory(s,&root,relative,files,session,stop,&budget,&missing_parents))).buffer_unordered(limit);
        while let Some(group)=readers.next().await{
            match group{
                Ok(Some(group)) if !budget.halt.get()=>{result.hints.extend(group.hints);result.missing.extend(group.missing);result.directories+=group.directories;},
                Ok(Some(_))=>(),
                Ok(None)=>{fallback=true;budget.halt.set(true);},
                Err(error)=>{budget.halt.set(true);if first_error.is_none(){first_error=Some(error);}},
            }
        }
        // Settle already admitted readers before reusing this session. A real
        // error wins over an optional fallback; neither publishes partial hints.
        if let Some(error)=first_error{return Err(error);}
        crate::file_ops::check(stop)?;
        if fallback{return Ok(None);}
        Ok(Some(result))
    })
}

async fn read_directory(s:&Connection,root:&str,relative:PathBuf,files:Vec<PathBuf>,session:u64,stop:&AtomicBool,budget:&Budget,missing_parents:&RefCell<HashSet<String>>)->Result<Option<ComparisonSnapshot>,String>{
    crate::file_ops::check(stop)?;
    if budget.halt.get(){return Ok(None);}
    let mut result=ComparisonSnapshot{hints:HashMap::new(),missing:Vec::new(),directories:0};
    let parent=if relative.as_os_str().is_empty(){root.to_owned()}else{recorded_target(root,&relative)?};
    if parent.split('/').filter(|p|!p.is_empty()).count()>128||!budget.bytes(parent.len().saturating_mul(4).saturating_add(256)){return budget.fallback();}
    if missing_parents.borrow().iter().any(|p|parent==*p||parent.starts_with(&format!("{p}/"))){result.missing=files;return Ok(Some(result));}
    let before=match inspect_directory(&s.raw,&parent).await?{
        DirectoryInspection::Present(stamp)=>stamp,
        DirectoryInspection::Missing(missing)=>{
            if missing==root||root.starts_with(&format!("{missing}/")){return Err("Remote sync root disappeared during comparison".into());}
            missing_parents.borrow_mut().insert(missing);result.missing=files;return Ok(Some(result));
        },
    };
    if budget.halt.get(){return Ok(None);}
    let handle=match s.raw.opendir(parent.clone()).await{
        Ok(h)=>h.handle,
        Err(e) if listing_unavailable(&e)=>return budget.fallback(),
        Err(_)=>return Err("Remote comparison listing open failed".into()),
    };
    let reading=async {
        let wanted:HashMap<_,_>=files.iter().map(|p|(p.file_name().unwrap().to_str().unwrap().to_string(),p)).collect();
        let mut found=HashSet::new();let mut seen=HashSet::new();let mut read_succeeded=false;
        loop{
            crate::file_ops::check(stop)?;
            if budget.halt.get(){return Ok(None);}
            let batches=budget.batches.get().saturating_add(1);budget.batches.set(batches);
            if batches>20000{return budget.fallback();}
            match s.raw.readdir(handle.clone()).await{
                Ok(batch)=>{
                    read_succeeded=true;
                    for entry in batch.files{
                        if budget.halt.get(){return Ok(None);}
                        if entry.filename=="."||entry.filename==".."{continue;}
                        let entries=budget.entries.get().saturating_add(1);budget.entries.set(entries);
                        if entries>10000||!budget.bytes(entry.filename.len().saturating_mul(4).saturating_add(256))||!seen.insert(entry.filename.to_lowercase()){return budget.fallback();}
                        if let Some(path)=wanted.get(&entry.filename){
                            found.insert((**path).clone());
                            // Unknown type is present-but-unclassified, never absence.
                            if entry.attrs.permissions.is_none_or(|mode|mode&0o170000==0){continue;}
                            if !entry.attrs.file_type().is_file()||entry.attrs.is_symlink(){return Err("Remote comparison target is not a regular file".into());}
                            if let Some(size)=entry.attrs.size{result.hints.insert((**path).clone(),crate::listing_hint::ListingHint::from_listing(size,entry.attrs.mtime,session));}
                        }
                    }
                },
                Err(e) if !read_succeeded&&listing_unavailable(&e)=>return budget.fallback(),
                Err(SftpError::Status(status)) if status.status_code==StatusCode::Eof=>break,
                Err(_)=>return Err("Remote comparison listing incomplete; no comparison snapshot published".into()),
            }
        }
        if budget.halt.get(){return Ok(None);}
        result.directories=1;result.missing=files.iter().filter(|p|!found.contains(*p)).cloned().collect();
        Ok(Some(result))
    }.await;
    if reading.is_err(){budget.halt.set(true);}
    // Close on partial/error/fallback too. Outer cancellation disconnects the
    // session, releasing any handles whose future cannot finish cleanup.
    let closed=s.raw.close(handle).await.map_err(|_|"Remote comparison listing close failed".to_string());
    match reading{
        Err(error)=>Err(error),
        Ok(value)=>{
            closed?;
            if budget.halt.get(){return Ok(None);}
            // Preserve the original ordering: CLOSE ACK, then a fresh ordered
            // type/permission/canonical walk. Closing is not a validation cache.
            if value.is_some()&&directory_guard(&s.raw,&parent).await?!=before{return Err("Remote comparison directory changed during listing".into());}
            Ok(value)
        }
    }
}
