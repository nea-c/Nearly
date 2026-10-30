//! One initial comparison pass, not mutation/deletion authority or a session cache.
use super::*;
use std::{collections::{BTreeMap,HashMap,HashSet},path::PathBuf};

pub(crate) struct ComparisonSnapshot {
    pub hints: HashMap<PathBuf, crate::listing_hint::ListingHint>,
    pub missing: Vec<PathBuf>,
    pub directories: usize,
}
fn listing_unavailable(error:&SftpError)->bool{
    matches!(error,SftpError::Status(s) if matches!(s.status_code,StatusCode::PermissionDenied|StatusCode::OpUnsupported))
}

// Walk ancestors in order: never query descendants of an observed symlink.
async fn first_missing(raw:&RawSftpSession,path:&str)->Result<Option<String>,String>{
    let root=raw.lstat("/").await.map_err(|_|"Remote comparison root lookup failed")?.attrs;
    if !root.file_type().is_dir()||root.is_symlink(){return Err("Remote comparison root is not a directory".into());}
    let mut current=String::new();
    for part in path.split('/').filter(|p|!p.is_empty()){
        current.push('/');current.push_str(part);
        match raw.lstat(current.clone()).await{
            Ok(a) if a.attrs.file_type().is_dir()&&!a.attrs.is_symlink()=>(),
            Err(SftpError::Status(s)) if s.status_code==StatusCode::NoSuchFile=>return Ok(Some(current)),
            _=>return Err("Remote comparison parent unavailable or unsafe".into()),
        }
    }
    Ok(None)
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
    s.run(stop,async {
        let mut result=ComparisonSnapshot{hints:HashMap::new(),missing:Vec::new(),directories:0};
        let mut missing_parents=HashSet::<String>::new();
        let(mut entries,mut bytes,mut batches)=(0usize,path_bytes,0usize);
        for (relative,files) in groups{
            crate::file_ops::check(stop)?;
            let parent=if relative.as_os_str().is_empty(){root.clone()}else{recorded_target(&root,&relative)?};
            if parent.split('/').filter(|p|!p.is_empty()).count()>128{return Ok(None);}
            bytes=bytes.saturating_add(parent.len().saturating_mul(4).saturating_add(256));
            if bytes>16*1024*1024{return Ok(None);}
            if missing_parents.iter().any(|p|parent==*p||parent.starts_with(&format!("{p}/"))){result.missing.extend(files);continue;}
            if let Some(missing)=first_missing(&s.raw,&parent).await?{
                if missing==root||root.starts_with(&format!("{missing}/")){return Err("Remote sync root disappeared during comparison".into());}
                missing_parents.insert(missing);result.missing.extend(files);continue;
            }
            let before=directory_guard(&s.raw,&parent).await?;
            let handle=match s.raw.opendir(parent.clone()).await{
                Ok(h)=>h.handle,
                Err(e) if listing_unavailable(&e)=>return Ok(None),
                Err(_)=>return Err("Remote comparison listing open failed".into()),
            };
            result.directories+=1;
            let wanted:HashMap<_,_>=files.iter().map(|p|(p.file_name().unwrap().to_str().unwrap().to_string(),p)).collect();
            let mut found=HashSet::new();let mut seen=HashSet::new();let mut fallback=false;let mut read_succeeded=false;
            loop{
                crate::file_ops::check(stop)?;batches=batches.saturating_add(1);
                if batches>20000{fallback=true;break;}
                match s.raw.readdir(handle.clone()).await{
                    Ok(batch)=>{
                        read_succeeded=true;
                        for entry in batch.files{
                            if entry.filename=="."||entry.filename==".."{continue;}
                            entries=entries.saturating_add(1);bytes=bytes.saturating_add(entry.filename.len().saturating_mul(4).saturating_add(256));
                            if entries>10000||bytes>16*1024*1024||!seen.insert(entry.filename.to_lowercase()){fallback=true;break;}
                            if let Some(path)=wanted.get(&entry.filename){
                                found.insert((**path).clone());
                                // READDIR attrs are optional in SFTPv3. Unknown
                                // type is present-but-unclassified, never absence
                                // or an equality hint; LSTAT must classify it.
                                if entry.attrs.permissions.is_none_or(|mode|mode&0o170000==0){continue;}
                                if !entry.attrs.file_type().is_file()||entry.attrs.is_symlink(){return Err("Remote comparison target is not a regular file".into());}
                                if let Some(size)=entry.attrs.size{result.hints.insert((**path).clone(),crate::listing_hint::ListingHint::from_listing(size,entry.attrs.mtime,session));}
                            }
                        }
                        if fallback{break;}
                    },
                    Err(e) if !read_succeeded&&listing_unavailable(&e)=>{fallback=true;break;},
                    Err(SftpError::Status(s)) if s.status_code==StatusCode::Eof=>break,
                    Err(_)=>return Err("Remote comparison listing incomplete; no comparison snapshot published".into()),
                }
            }
            s.raw.close(handle).await.map_err(|_|"Remote comparison listing close failed")?;
            if fallback{return Ok(None);}
            if directory_guard(&s.raw,&parent).await?!=before{return Err("Remote comparison directory changed during listing".into());}
            result.missing.extend(files.into_iter().filter(|p|!found.contains(p)));
        }
        crate::file_ops::check(stop)?;
        Ok(Some(result))
    })
}
