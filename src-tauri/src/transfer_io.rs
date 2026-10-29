use crate::{
    file_ops::check,
    sftp::{checked_directory, Connection},
    transfer_choices::{Choice, Exchange},
    upload::{UploadOutcome, UploadStatus},
};
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use std::{
    collections::HashSet,
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
};
#[derive(Default)]
struct Mappings {
    renamed: Vec<(String, String)>,
    skipped: Vec<String>,
}
impl Mappings {
    fn map(&self, path: &str) -> Option<String> {
        if self
            .skipped
            .iter()
            .any(|p| path == p || path.starts_with(&(p.clone() + "/")))
        {
            return None;
        }
        self.renamed
            .iter()
            .rev()
            .find_map(|(a, b)| {
                if path == a {
                    Some(b.clone())
                } else {
                    path.strip_prefix(&(a.clone() + "/"))
                        .map(|rest| format!("{b}/{rest}"))
                }
            })
            .or_else(|| Some(path.into()))
    }
}
fn copy_name(name: &str, directory: bool, n: u32) -> String {
    if !directory {
        if let Some((stem, ext)) = name.rsplit_once('.').filter(|(s, _)| !s.is_empty()) {
            return format!("{stem} ({n}).{ext}");
        }
    }
    format!("{name} ({n})")
}
pub(crate) fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Transfer token unavailable")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
async fn lookup(s: &Connection, path: &str) -> Result<Option<FileAttributes>, String> {
    match s.raw.lstat(path).await {
        Ok(v) => {
            if v.attrs.is_symlink() || !v.attrs.is_dir() && !v.attrs.file_type().is_file() {
                return Err("Unsafe or unsupported destination type".into());
            }
            Ok(Some(v.attrs))
        }
        Err(SftpError::Status(v)) if v.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(_) => Err("SFTP target lookup failed".into()),
    }
}
fn same(a: &FileAttributes, b: &FileAttributes) -> bool {
    a.permissions == b.permissions
        && a.size == b.size
        && a.mtime == b.mtime
        && a.uid == b.uid
        && a.gid == b.gid
}
pub(crate) async fn unchanged(
    s: &Connection,
    path: &str,
    before: Option<&FileAttributes>,
) -> Result<(), String> {
    let after = lookup(s, path).await?;
    match (before, after) {
        (None, None) => Ok(()),
        (Some(a), Some(b)) if same(a, &b) => Ok(()),
        _ => Err("Destination changed after confirmation; refresh and retry".into()),
    }
}
pub(crate) fn attributes_match(a: &FileAttributes, b: &FileAttributes) -> bool {
    same(a, b)
}
fn result(
    outcome: Result<(), String>,
    stop: &AtomicBool,
    completed: usize,
    bytes: u64,
    transferred_bytes: u64,
    skipped: usize,
) -> UploadOutcome {
    UploadOutcome{status:if outcome.is_ok(){UploadStatus::Completed}else if stop.load(Ordering::SeqCst){UploadStatus::Cancelled}else{UploadStatus::Partial},completed,bytes,transferred_bytes,skipped,message:match outcome{Ok(())=>format!("Transfer complete; {skipped} skipped. Sources retained."),Err(e)=>format!("{e}. Sources retained. Completed copies or owned staging files may remain; refresh before retrying.")}}
}
/** Merge directories; replace only regular files after explicit policy and staged publication. */
pub fn upload(
    s: &Connection,
    remote: &str,
    entries: &mut [crate::upload::Entry],
    stop: &AtomicBool,
    choices: &Exchange,
    progress: Option<&crate::operation_progress::Progress>,
) -> Result<UploadOutcome, String> {
    let mut completed = 0;
    let mut bytes = 0;
    let mut transferred_bytes = 0;
    let mut skipped = 0;
    let mut mappings = Mappings::default();
    let execution=s.run(stop,async{
  let outcome=async{
   checked_directory(&s.raw,remote,false).await?;
   let count=entries.len();
   for (index,entry) in entries.iter_mut().enumerate() {
    if let Some(p)=progress {p.position(index+1,count);p.phase("uploading");}
    check(stop)?;crate::upload::revalidate(entry)?;
    let Some(relative)=mappings.map(&entry.relative) else{if let Some(p)=progress {if !entry.directory {p.skip_bytes(entry.size);}}skipped+=1;continue};
    let mut target=format!("{}/{}",remote.trim_end_matches('/'),relative);let mut existing=lookup(s,&target).await?;
    if let Some(attrs)=existing.as_ref(){
     if !(entry.directory&&attrs.is_dir()){
      if let Some(p)=progress {p.phase("waiting");}
      let decision=choices.ask(entry.path.to_str().ok_or("Unsupported source path")?,&target,entry.directory,attrs.is_dir(),stop)?;
      if let Some(p)=progress {p.phase("uploading");}
      match decision {
       Choice::Skip=>{if let Some(p)=progress {if !entry.directory {p.skip_bytes(entry.size);}}if entry.directory{mappings.skipped.push(entry.relative.clone());}skipped+=1;continue},
       Choice::KeepBoth=>{let (parent,name)=relative.rsplit_once('/').unwrap_or(("",relative.as_str()));let mut found=None;
        for n in 2..=10000{check(stop)?;let candidate=copy_name(name,entry.directory,n);crate::file_ops::validate_creation_name(&candidate,crate::file_ops::Side::Remote)?;let renamed=if parent.is_empty(){candidate}else{format!("{parent}/{candidate}")};let p=format!("{}/{}",remote.trim_end_matches('/'),renamed);if lookup(s,&p).await?.is_none(){found=Some((renamed,p));break}}
        let (renamed,p)=found.ok_or("No available keep-both name")?;mappings.renamed.push((entry.relative.clone(),renamed.clone()));target=p;existing=None;
       },
       Choice::Overwrite=>{if entry.directory||attrs.is_dir(){return Err("File/directory replacement is refused; choose skip or keep both".into())}if !s.posix_rename{return Err("Server lacks atomic replacement support; existing file retained".into())}},
       Choice::Cancel=>return Err("Transfer cancelled".into()),
      }
     }
    }
    let parent=target.rsplit_once('/').unwrap().0;let parent=if parent.is_empty(){"/"}else{parent};checked_directory(&s.raw,parent,false).await?;unchanged(s,&target,existing.as_ref()).await?;
    if entry.directory{if existing.is_none(){s.raw.mkdir(target.clone(),FileAttributes::empty()).await.map_err(|_|"Directory creation failed or outcome uncertain")?;}completed+=1;if let Some(p)=progress {p.committed();}continue}
    let stage=format!("{parent}/.nearly-transfer-{}.partial",nonce()?);
    let mut stage_attributes=FileAttributes::empty();stage_attributes.permissions=existing.as_ref().and_then(|a|a.permissions).map(|p|p&0o777);
    let handle=s.raw.open(stage.clone(),OpenFlags::CREATE|OpenFlags::EXCLUDE|OpenFlags::WRITE,stage_attributes).await.map_err(|_|"Exclusive stage creation failed")?.handle;
    let transfer=async{
     let mut offset=0;loop{check(stop)?;let mut data=vec![0u8;32768];let n=entry.file.read(&mut data).map_err(|_|"Source read failed")?;if n==0{break}if offset+n as u64>entry.size{return Err("Source size changed".into())}data.truncate(n);s.raw.write(handle.clone(),offset,data).await.map_err(|_|"Upload write failed")?;offset+=n as u64;transferred_bytes+=n as u64;if let Some(p)=progress {p.bytes(n as u64);}}
     if let Some(p)=progress {p.phase("finalizing");}
     if offset!=entry.size{return Err("Source size changed".into())}crate::upload::revalidate(entry)?;
     let staged=s.raw.fstat(handle.clone()).await.map_err(|_|"Stage verification failed")?.attrs;if staged.size!=Some(offset)||!staged.file_type().is_file(){return Err("Stage size or type changed".into())}
     if let Some(original)=existing.as_ref(){if staged.permissions.map(|p|p&0o777)!=original.permissions.map(|p|p&0o777)||staged.uid!=original.uid||staged.gid!=original.gid{return Err("Destination permissions or ownership cannot be preserved; original retained".into())}}
     Ok::<(),String>(())
    }.await;
    let close=s.raw.close(handle).await.map(|_|()).map_err(|_|"Upload close acknowledgement uncertain".to_owned());
    if let Err(error)=transfer.and(close){let cleaned=s.raw.remove(stage.clone()).await.is_ok();return Err(if cleaned{error}else{format!("{error}; staging retained at {stage}")})}
    let publish=async{check(stop)?;crate::upload::revalidate(entry)?;checked_directory(&s.raw,parent,false).await?;unchanged(s,&target,existing.as_ref()).await?;
     if existing.is_some(){let mut data=Vec::new();for p in [&stage,&target]{data.extend_from_slice(&(p.len() as u32).to_be_bytes());data.extend_from_slice(p.as_bytes());}match s.raw.extended("posix-rename@openssh.com",data).await{Ok(Packet::Status(v))if v.status_code==StatusCode::Ok=>Ok(()),_=>Err("Atomic replacement failed or acknowledgement uncertain".into())}}
     else{s.raw.rename(stage.clone(),target.clone()).await.map(|_|()).map_err(|_|"Exclusive publication failed or acknowledgement uncertain".into())}
    }.await;
    if let Err(error)=publish{let cleaned=s.raw.remove(stage.clone()).await.is_ok();return Err(if cleaned{error}else{format!("{error}; staging may remain at {stage}")})}completed+=1;bytes+=entry.size;if let Some(p)=progress {p.committed();}
   }
   if let Some(p)=progress {p.phase("finalizing");}
   Ok(())
  }.await;
  Ok(result(outcome,stop,completed,bytes,transferred_bytes,skipped))
 });
    match execution {
        Ok(outcome) => Ok(outcome),
        Err(error) => Ok(result(Err(error), stop, completed, bytes, transferred_bytes, skipped)),
    }
}
#[derive(Clone)]
pub(crate) struct RemoteEntry {
    pub path: String,
    pub relative: String,
    pub attrs: FileAttributes,
}
/// Metadata only. Bounded inventory is reused by internal downloads and virtual-file descriptors.
pub(crate) async fn remote_inventory(
    s: &Connection,
    sources: &[String],
    stop: &AtomicBool,
) -> Result<Vec<RemoteEntry>, String> {
    if sources.is_empty() || sources.len() > 10000 {
        return Err("Select 1 to 10,000 sources".into());
    }
    let mut pending = Vec::new();
    for source in sources.iter().rev() {
        if source.split('/').any(|p| p == "." || p == "..") {
            return Err("Remote traversal refused".into());
        }
        let path = crate::sftp::normalize(source)?;
        let name = path
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .ok_or("Remote roots cannot be downloaded")?
            .to_owned();
        pending.push((path, name, 0));
    }
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    while let Some((path, relative, depth)) = pending.pop() {
        check(stop)?;
        if depth > 64 || entries.len() >= 10000 {
            return Err("Download exceeds 10,000 entries or depth 64".into());
        }
        crate::file_ops::validate_creation_name(
            relative.rsplit('/').next().unwrap(),
            crate::file_ops::Side::Local,
        )?;
        if !names.insert(relative.to_uppercase()) {
            return Err("Duplicate or case-ambiguous source names".into());
        }
        let parent = path.rsplit_once('/').unwrap().0;
        checked_directory(&s.raw, if parent.is_empty() { "/" } else { parent }, false).await?;
        let attrs = lookup(s, &path).await?.ok_or("Remote source disappeared")?;
        if attrs.is_dir() {
            let handle = s
                .raw
                .opendir(path.clone())
                .await
                .map_err(|_| "Remote directory open failed")?
                .handle;
            let listing = async {
                loop {
                    check(stop)?;
                    match s.raw.readdir(handle.clone()).await {
                        Ok(batch) => {
                            for entry in batch.files {
                                let name = entry.filename;
                                if name == "." || name == ".." {
                                    continue;
                                }
                                crate::file_ops::validate_creation_name(
                                    &name,
                                    crate::file_ops::Side::Local,
                                )?;
                                if pending.len() + entries.len() >= 10000 {
                                    return Err("Download inventory exceeds 10,000 entries".into());
                                }
                                pending.push((
                                    format!("{path}/{name}"),
                                    format!("{relative}/{name}"),
                                    depth + 1,
                                ));
                            }
                        }
                        Err(SftpError::Status(v)) if v.status_code == StatusCode::Eof => break,
                        Err(_) => return Err("Remote directory read failed".into()),
                    }
                }
                Ok::<(), String>(())
            }
            .await;
            let close = s
                .raw
                .close(handle)
                .await
                .map_err(|_| "Remote directory close failed");
            listing?;
            close?;
        } else if attrs.size.is_none() || attrs.mtime.is_none() {
            return Err("Source size/timestamp unavailable".into());
        }
        entries.push(RemoteEntry {
            path,
            relative,
            attrs,
        });
    }
    Ok(entries)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRequest {
    pub id: String,
    pub session_id: String,
    pub sources: Vec<String>,
    pub local: String,
}
#[derive(PartialEq, Debug)]
struct LocalStamp {
    identity: (u32, u64),
    directory: bool,
    size: u64,
    modified: std::time::SystemTime,
}
fn local_lookup(path: &std::path::Path) -> Result<Option<(LocalStamp, std::fs::File)>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Local destination lookup failed".into()),
        Ok(m) if !crate::local_publish::ordinary(&m) => {
            return Err("Unsafe local destination".into())
        }
        _ => {}
    }
    let file = std::fs::OpenOptions::new()
        .access_mode(0x80)
        .share_mode(5)
        .custom_flags(0x02200000)
        .open(path)
        .map_err(|_| "Local target locked or changed")?;
    let meta = file.metadata().map_err(|_| "Local metadata unavailable")?;
    if !crate::local_publish::ordinary(&meta) {
        return Err("Unsafe local target".into());
    }
    let stamp = LocalStamp {
        identity: crate::local_publish::identity(&file)
            .map_err(|_| "Local identity unavailable")?,
        directory: meta.is_dir(),
        size: meta.len(),
        modified: meta.modified().map_err(|_| "Local timestamp unavailable")?,
    };
    Ok(Some((stamp, file)))
}
fn local_unchanged(path: &std::path::Path, old: Option<&LocalStamp>) -> Result<(), String> {
    let current = local_lookup(path)?;
    match (old, current) {
        (None, None) => Ok(()),
        (Some(a), Some((b, _))) if a == &b => Ok(()),
        _ => Err("Local target changed after confirmation; refresh and retry".into()),
    }
}
fn validate_local_target(path: &std::path::Path) -> Result<(), String> {
    let exists = match std::fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Local destination metadata unavailable".into()),
    };
    crate::file_ops::local_path(path.to_str().ok_or("Unsupported destination path")?, exists)?;
    Ok(())
}
struct DownloadStage(crate::local_publish::OwnedStage);
impl Drop for DownloadStage {
    fn drop(&mut self) {
        let _ = self.0.discard_file();
    }
}
pub fn download(
    engine: &crate::engine::Engine,
    request: DownloadRequest,
    profile: &crate::sftp::Profile,
    secret: &str,
    stop: &AtomicBool,
    choices: &Exchange,
) -> Result<UploadOutcome, String> {
    use std::net::ToSocketAddrs;
    let progress=engine.operation_progress(&request.id);
    let local = crate::file_ops::local_path(&request.local, true)?;
    let mut guards = Vec::new();
    for ancestor in local.ancestors() {
        guards.push(
            crate::local_publish::lock_dir(ancestor)
                .map_err(|_| "Cannot lock local destination parent")?,
        );
    }
    let endpoints = (profile.host.as_str(), profile.port)
        .to_socket_addrs()
        .map_err(|_| "Cannot resolve transfer endpoint")?
        .collect();
    let (s, identity) = crate::sftp::connect(profile, secret, stop)?;
    engine.reserve_upload_operation(
        &request.id,
        vec![local.clone()],
        request.sources.clone(),
        identity,
        endpoints,
    )?;
    let mut completed = 0;
    let mut bytes = 0;
    let mut transferred_bytes = 0;
    let mut skipped = 0;
    let mut mappings = Mappings::default();
    let execution = s.run(stop, async {
        let outcome = async {
            if let Some(p)=&progress {p.phase("scanning");}
            let entries = remote_inventory(&s, &request.sources, stop).await?;
            let count=entries.len();
            let total=crate::operation_progress::checked_byte_total(entries.iter().filter(|e|!e.attrs.is_dir()).map(|e|e.attrs.size))?;
            if let Some(p)=&progress {p.plan("bytes",total);}
            for (index,entry) in entries.into_iter().enumerate() {
                if let Some(p)=&progress {p.position(index+1,count);p.phase("downloading");}
                check(stop)?;
                unchanged(&s, &entry.path, Some(&entry.attrs)).await?;
                let Some(relative) = mappings.map(&entry.relative) else {
                    if let Some(p)=&progress {if !entry.attrs.is_dir() {p.skip_bytes(entry.attrs.size.ok_or("Remote size unavailable")?);}}
                    skipped += 1;
                    continue;
                };
                let mut target = local.join(relative.replace('/', "\\"));
                validate_local_target(&target)?;
                let mut existing = local_lookup(&target)?;
                if let Some((attrs, _)) = existing.as_ref() {
                    if !(entry.attrs.is_dir() && attrs.directory) {
                        if let Some(p)=&progress {p.phase("waiting");}
                        let decision=choices.ask(
                            &entry.path,
                            target.to_str().ok_or("Unsupported destination path")?,
                            entry.attrs.is_dir(),
                            attrs.directory,
                            stop,
                        )?;
                        if let Some(p)=&progress {p.phase("downloading");}
                        match decision {
                            Choice::Skip => {
                                if let Some(p)=&progress {if !entry.attrs.is_dir() {p.skip_bytes(entry.attrs.size.unwrap_or(0));}}
                                if entry.attrs.is_dir() {
                                    mappings.skipped.push(entry.relative.clone());
                                }
                                skipped += 1;
                                continue;
                            }
                            Choice::KeepBoth => {
                                let (parent, name) =
                                    relative.rsplit_once('/').unwrap_or(("", relative.as_str()));
                                let mut found = None;
                                for n in 2..=10000 {
                                    check(stop)?;
                                    let name = copy_name(name, entry.attrs.is_dir(), n);
                                    crate::file_ops::validate_creation_name(
                                        &name,
                                        crate::file_ops::Side::Local,
                                    )?;
                                    let renamed = if parent.is_empty() {
                                        name
                                    } else {
                                        format!("{parent}/{name}")
                                    };
                                    let p = local.join(renamed.replace('/', "\\"));
                                    if local_lookup(&p)?.is_none() {
                                        found = Some((renamed, p));
                                        break;
                                    }
                                }
                                let (renamed, p) = found.ok_or("No available keep-both name")?;
                                mappings
                                    .renamed
                                    .push((entry.relative.clone(), renamed.clone()));
                                target = p;
                                existing = None;
                            }
                            Choice::Overwrite => {
                                if entry.attrs.is_dir() || attrs.directory {
                                    return Err("File/directory replacement refused".into());
                                }
                            }
                            Choice::Cancel => return Err("Transfer cancelled".into()),
                        }
                    }
                }
                let parent = target.parent().ok_or("Destination parent unavailable")?;
                let parent_guard = crate::local_publish::lock_dir(parent)
                    .map_err(|_| "Cannot lock destination parent")?;
                local_unchanged(&target, existing.as_ref().map(|(a, _)| a))?;
                if entry.attrs.is_dir() {
                    if existing.is_none() {
                        std::fs::create_dir(&target)
                            .map_err(|_| "Directory appeared or creation failed")?;
                    }
                    guards.push(
                        crate::local_publish::lock_dir(&target)
                            .map_err(|_| "Created directory changed")?,
                    );
                    completed += 1;
                    if let Some(p)=&progress {p.committed();}
                    continue;
                }
                let budget = crate::zip_preflight::Budget::new(stop);
                let mut stage = DownloadStage(
                    crate::local_publish::OwnedStage::create(parent, false, &budget)
                        .map_err(|e| format!("Local staging failed: {}", e.code))?,
                );
                let handle = s
                    .raw
                    .open(entry.path.clone(), OpenFlags::READ, FileAttributes::empty())
                    .await
                    .map_err(|_| "Remote source open failed")?
                    .handle;
                let transfer = async {
                    let attrs = s
                        .raw
                        .fstat(handle.clone())
                        .await
                        .map_err(|_| "Remote handle metadata failed")?
                        .attrs;
                    if !same(&attrs, &entry.attrs) {
                        return Err("Remote source changed".into());
                    }
                    let size = entry.attrs.size.ok_or("Remote size unavailable")?;
                    let mut offset = 0;
                    while offset < size {
                        check(stop)?;
                        let data = s
                            .raw
                            .read(handle.clone(), offset, (size - offset).min(32768) as u32)
                            .await
                            .map_err(|_| "Remote read failed")?
                            .data;
                        if data.is_empty() || data.len() as u64 > size - offset {
                            return Err("Remote source size changed".into());
                        }
                        stage
                            .0
                            .handle
                            .write_all(&data)
                            .map_err(|_| "Local write failed")?;
                        offset += data.len() as u64;
                        transferred_bytes += data.len() as u64;
                        if let Some(p)=&progress {p.bytes(data.len() as u64);}
                    }
                    if let Some(p)=&progress {p.phase("finalizing");}
                    stage
                        .0
                        .handle
                        .sync_all()
                        .map_err(|_| "Local staging flush failed")?;
                    unchanged(&s, &entry.path, Some(&entry.attrs)).await?;
                    Ok::<(), String>(())
                }
                .await;
                let close = s.raw.close(handle).await.map_err(|_| "Remote close failed");
                transfer?;
                close?;
                check(stop)?;
                validate_local_target(&target)?;
                local_unchanged(&target, existing.as_ref().map(|(a, _)| a))?;
                if existing.is_some() {
                    stage.0.publish_replacing(&target, &budget)
                } else {
                    stage.0.publish(&target, &budget)
                }
                .map_err(|e| {
                    format!(
                        "Local publication failed: {}; staging {}",
                        e.code,
                        stage.0.path.display()
                    )
                })?;
                drop(parent_guard);
                completed += 1;
                bytes += entry.attrs.size.ok_or("Remote size unavailable")?;
                if let Some(p)=&progress {p.committed();}
            }
            if let Some(p)=&progress {p.phase("finalizing");}
            Ok(())
        }
        .await;
        Ok(result(outcome, stop, completed, bytes, transferred_bytes, skipped))
    });
    match execution {
        Ok(outcome) => Ok(outcome),
        Err(error) => Ok(result(Err(error), stop, completed, bytes, transferred_bytes, skipped)),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outcomes_keep_items_committed_bytes_staged_bytes_and_skips_distinct() {
        let stop = AtomicBool::new(false);
        let partial = result(Err("publish rejected".into()), &stop, 1, 392, 520, 2);
        assert_eq!(partial.status, UploadStatus::Partial);
        let json = serde_json::to_value(&partial).unwrap();
        assert_eq!(json["completed"], 1);
        assert_eq!(json["bytes"], 392);
        assert_eq!(json["transferredBytes"], 520);
        assert_eq!(json["skipped"], 2);
        stop.store(true, Ordering::SeqCst);
        let cancelled = result(Err("cancelled".into()), &stop, 0, 0, 128, 0);
        assert_eq!(cancelled.status, UploadStatus::Cancelled);
        assert_eq!(cancelled.bytes, 0);
        assert_eq!(cancelled.transferred_bytes, 128);
    }
    #[test]
    fn renamed_parent_maps_descendants_and_skipped_parent_never_leaks_children() {
        let mut paths = Mappings::default();
        paths.renamed.push(("tree".into(), "tree (2)".into()));
        assert_eq!(
            paths.map("tree/nested/file.txt"),
            Some("tree (2)/nested/file.txt".into())
        );
        assert_eq!(
            paths.map("tree-other/file.txt"),
            Some("tree-other/file.txt".into())
        );
        paths.skipped.push("tree/nested".into());
        assert_eq!(paths.map("tree/nested/file.txt"), None);
    }
    #[test]
    fn keep_both_names_preserve_extensions_and_directory_dots() {
        assert_eq!(copy_name("file.tar.gz", false, 2), "file.tar (2).gz");
        assert_eq!(copy_name("folder.ext", true, 2), "folder.ext (2)");
        assert_eq!(copy_name(".env", false, 2), ".env (2)");
    }
}
#[cfg(test)]
mod generated {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };
    fn fixture() -> (serde_json::Value, PathBuf, PathBuf, crate::sftp::Profile) {
        let v: serde_json::Value = serde_json::from_slice(
            &fs::read(std::env::var("NEARLY_TRANSFER_FIXTURE").expect("generated fixture only"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(v["generatedOnly"], true);
        let root = PathBuf::from(v["root"].as_str().unwrap());
        assert!(root.starts_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("test-results")
        ));
        let remote = PathBuf::from(v["remote"].as_str().unwrap());
        assert_eq!(remote, root.join("remote"));
        assert_eq!(
            PathBuf::from(v["key"].as_str().unwrap()),
            root.join("fixture-v3.ppk")
        );
        let profile = crate::sftp::Profile {
            id: "transfer-fixture".into(),
            name: "Generated localhost".into(),
            host: "127.0.0.1".into(),
            port: v["port"].as_u64().unwrap() as u16,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: v["key"].as_str().unwrap().into(),
            host_key: v["fingerprint"].as_str().unwrap().into(),
        };
        (v, root, remote, profile)
    }
    fn upload_case(
        v: &serde_json::Value,
        profile: &crate::sftp::Profile,
        id: &str,
        sources: Vec<String>,
        remote: &str,
        policy: &Exchange,
    ) -> UploadOutcome {
        let engine = crate::engine::Engine::default();
        engine.prepare_operation(id).unwrap();
        let stop = engine.claim_prepared_upload(id).unwrap();
        let request = crate::upload::UploadRequest {
            id: id.into(),
            session_id: "generated".into(),
            sources,
            remote: remote.into(),
            recursive: true,
            interactive: true,
        };
        let result = crate::upload::run_interactive(
            &engine,
            request,
            profile,
            v["passphrase"].as_str().unwrap(),
            &stop,
            policy,
        )
        .unwrap();
        engine.finish_operation(id);
        eprintln!("{id}: {:?} {}", result.status, result.message);
        result
    }
    fn download_case(
        v: &serde_json::Value,
        profile: &crate::sftp::Profile,
        id: &str,
        sources: Vec<String>,
        local: &std::path::Path,
        policy: &Exchange,
    ) -> UploadOutcome {
        let engine = crate::engine::Engine::default();
        engine.prepare_operation(id).unwrap();
        let stop = engine.claim_prepared_upload(id).unwrap();
        let request = DownloadRequest {
            id: id.into(),
            session_id: "generated".into(),
            sources,
            local: local.to_str().unwrap().into(),
        };
        let result = download(
            &engine,
            request,
            profile,
            v["passphrase"].as_str().unwrap(),
            &stop,
            policy,
        )
        .unwrap();
        engine.finish_operation(id);
        eprintln!("{id}: {:?} {}", result.status, result.message);
        result
    }
    #[test]
    #[ignore = "generated localhost fixture runner only"]
    fn generated_transfer_upload_conflicts_merge_races_and_failed_replacement() {
        let (v, root, remote, profile) = fixture();
        let sources = root.join("sources");
        fs::create_dir_all(sources.join("tree/nested")).unwrap();
        fs::write(sources.join("one.txt"), b"new upload bytes").unwrap();
        fs::write(sources.join("large.bin"), vec![7; 100000]).unwrap();
        fs::write(sources.join("tree/nested/child.txt"), b"nested upload").unwrap();
        let overwrite = Exchange::test_policy(Choice::Overwrite);
        let skip = Exchange::test_policy(Choice::Skip);
        let both = Exchange::test_policy(Choice::KeepBoth);
        for p in [
            "up-overwrite",
            "up-skip",
            "up-both",
            "up-merge/tree/nested",
            "up-type",
            "up-type-skip",
            "up-fail",
            "up-race",
            "up-changed",
        ] {
            fs::create_dir_all(remote.join(p)).unwrap();
        }
        for p in ["up-overwrite", "up-skip", "up-both", "up-changed"] {
            fs::write(remote.join(p).join("one.txt"), b"original sentinel").unwrap();
        }
        let source = || vec![sources.join("one.txt").to_str().unwrap().into()];
        assert_eq!(
            upload_case(
                &v,
                &profile,
                "overwrite",
                source(),
                "/up-overwrite",
                &overwrite
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(remote.join("up-overwrite/one.txt")).unwrap(),
            b"new upload bytes"
        );
        let skipped = upload_case(&v, &profile, "skip", source(), "/up-skip", &skip);
        assert_eq!(skipped.status, UploadStatus::Completed);
        assert_eq!(skipped.completed, 0);
        assert_eq!(skipped.bytes, 0);
        assert_eq!(skipped.transferred_bytes, 0);
        assert_eq!(skipped.skipped, 1);
        assert_eq!(
            fs::read(remote.join("up-skip/one.txt")).unwrap(),
            b"original sentinel"
        );
        assert_eq!(
            upload_case(&v, &profile, "both", source(), "/up-both", &both).status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(remote.join("up-both/one (2).txt")).unwrap(),
            b"new upload bytes"
        );
        assert_eq!(
            fs::read(remote.join("up-both/one.txt")).unwrap(),
            b"original sentinel"
        );
        fs::write(remote.join("up-merge/tree/unrelated.txt"), b"unrelated").unwrap();
        fs::write(remote.join("up-merge/tree/nested/child.txt"), b"old child").unwrap();
        let tree = || vec![sources.join("tree").to_str().unwrap().into()];
        assert_eq!(
            upload_case(&v, &profile, "merge", tree(), "/up-merge", &overwrite).status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(remote.join("up-merge/tree/unrelated.txt")).unwrap(),
            b"unrelated"
        );
        assert_eq!(
            fs::read(remote.join("up-merge/tree/nested/child.txt")).unwrap(),
            b"nested upload"
        );
        for p in ["up-type", "up-type-skip"] {
            fs::write(remote.join(p).join("tree"), b"file sentinel").unwrap();
        }
        assert_eq!(
            upload_case(&v, &profile, "type-both", tree(), "/up-type", &both).status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(remote.join("up-type/tree (2)/nested/child.txt")).unwrap(),
            b"nested upload"
        );
        assert_eq!(
            fs::read(remote.join("up-type/tree")).unwrap(),
            b"file sentinel"
        );
        assert_eq!(
            upload_case(&v, &profile, "type-skip", tree(), "/up-type-skip", &skip).status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read_dir(remote.join("up-type-skip")).unwrap().count(),
            1
        );
        fs::write(
            remote.join("up-fail/large.bin"),
            b"keep old on failed upload",
        )
        .unwrap();
        let failed = upload_case(
            &v,
            &profile,
            "fail",
            vec![sources.join("large.bin").to_str().unwrap().into()],
            "/up-fail",
            &overwrite,
        );
        assert_eq!(failed.status, UploadStatus::Partial);
        assert_eq!(failed.completed, 0);
        assert_eq!(failed.bytes, 0, "failed staging is not a completed copy");
        assert!(failed.transferred_bytes > 0, "fixture fails after streaming a chunk");
        assert_eq!(
            fs::read(remote.join("up-fail/large.bin")).unwrap(),
            b"keep old on failed upload"
        );
        assert_eq!(
            fs::read_dir(remote.join("up-fail")).unwrap().count(),
            1,
            "owned stage cleaned after ordinary transfer failure"
        );
        assert_eq!(
            upload_case(&v, &profile, "race", source(), "/up-race", &overwrite).status,
            UploadStatus::Partial
        );
        assert_eq!(
            fs::read(remote.join("up-race/one.txt")).unwrap(),
            b"external race sentinel"
        );
        let broker = Arc::new(crate::transfer_choices::Broker::default());
        let operation = broker.begin("changed", "fixture").unwrap();
        let responder = broker.clone();
        let target = remote.join("up-changed/one.txt");
        let worker = std::thread::spawn(move || {
            let start = Instant::now();
            loop {
                if let Some(prompt) = responder.pending("changed", "fixture").unwrap() {
                    fs::write(&target, b"changed after captured confirmation").unwrap();
                    responder
                        .choose(
                            "changed",
                            "fixture",
                            crate::transfer_choices::Decision {
                                token: prompt.token,
                                action: Choice::Overwrite,
                                apply_all: false,
                            },
                        )
                        .unwrap();
                    break;
                }
                assert!(start.elapsed() < Duration::from_secs(30));
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let changed = upload_case(
            &v,
            &profile,
            "changed",
            source(),
            "/up-changed",
            &operation.exchange,
        );
        worker.join().unwrap();
        assert_eq!(changed.status, UploadStatus::Partial);
        assert_eq!(
            fs::read(remote.join("up-changed/one.txt")).unwrap(),
            b"changed after captured confirmation"
        );
        drop(operation);
        let mut no_posix = profile.clone();
        no_posix.port = v["noPosixPort"].as_u64().unwrap() as u16;
        no_posix.key_file = v["noPosixKey"].as_str().unwrap().into();
        no_posix.host_key = v["noPosixFingerprint"].as_str().unwrap().into();
        fs::write(root.join("no-posix/remote/upload/one.txt"), b"no posix old").unwrap();
        assert_eq!(
            upload_case(&v, &no_posix, "no-posix", source(), "/upload", &overwrite).status,
            UploadStatus::Partial
        );
        assert_eq!(
            fs::read(root.join("no-posix/remote/upload/one.txt")).unwrap(),
            b"no posix old"
        );
        assert_eq!(
            fs::read(sources.join("one.txt")).unwrap(),
            b"new upload bytes"
        );
    }
    #[test]
    #[ignore = "generated localhost fixture runner only"]
    fn generated_transfer_download_conflicts_merge_type_and_cleanup() {
        let (v, root, remote, profile) = fixture();
        let output = root.join("downloads");
        fs::create_dir_all(remote.join("down/tree/nested")).unwrap();
        fs::create_dir_all(remote.join("down-fail")).unwrap();
        fs::write(remote.join("down/one.txt"), b"download bytes").unwrap();
        fs::write(remote.join("down/tree/nested/child.txt"), b"download child").unwrap();
        fs::write(remote.join("down-fail/one.txt"), b"will fail open").unwrap();
        let overwrite = Exchange::test_policy(Choice::Overwrite);
        let skip = Exchange::test_policy(Choice::Skip);
        let both = Exchange::test_policy(Choice::KeepBoth);
        for name in [
            "overwrite",
            "skip",
            "both",
            "merge/tree/nested",
            "type",
            "type-skip",
            "fail",
            "cancel",
        ] {
            fs::create_dir_all(output.join(name)).unwrap();
        }
        for name in ["overwrite", "skip", "both", "fail"] {
            fs::write(output.join(name).join("one.txt"), b"local original").unwrap();
        }
        let source = || vec!["/down/one.txt".into()];
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-overwrite",
                source(),
                &output.join("overwrite"),
                &overwrite
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(output.join("overwrite/one.txt")).unwrap(),
            b"download bytes"
        );
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-skip",
                source(),
                &output.join("skip"),
                &skip
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(output.join("skip/one.txt")).unwrap(),
            b"local original"
        );
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-both",
                source(),
                &output.join("both"),
                &both
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(output.join("both/one (2).txt")).unwrap(),
            b"download bytes"
        );
        assert_eq!(
            fs::read(output.join("both/one.txt")).unwrap(),
            b"local original"
        );
        fs::write(output.join("merge/tree/unrelated.txt"), b"local unrelated").unwrap();
        fs::write(output.join("merge/tree/nested/child.txt"), b"old child").unwrap();
        let tree = || vec!["/down/tree".into()];
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-merge",
                tree(),
                &output.join("merge"),
                &overwrite
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(output.join("merge/tree/unrelated.txt")).unwrap(),
            b"local unrelated"
        );
        assert_eq!(
            fs::read(output.join("merge/tree/nested/child.txt")).unwrap(),
            b"download child"
        );
        for name in ["type", "type-skip"] {
            fs::write(output.join(name).join("tree"), b"local type sentinel").unwrap();
        }
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-type",
                tree(),
                &output.join("type"),
                &both
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(
            fs::read(output.join("type/tree (2)/nested/child.txt")).unwrap(),
            b"download child"
        );
        assert_eq!(
            fs::read(output.join("type/tree")).unwrap(),
            b"local type sentinel"
        );
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-type-skip",
                tree(),
                &output.join("type-skip"),
                &skip
            )
            .status,
            UploadStatus::Completed
        );
        assert_eq!(fs::read_dir(output.join("type-skip")).unwrap().count(), 1);
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-fail",
                vec!["/down-fail/one.txt".into()],
                &output.join("fail"),
                &overwrite
            )
            .status,
            UploadStatus::Partial
        );
        assert_eq!(
            fs::read(output.join("fail/one.txt")).unwrap(),
            b"local original"
        );
        assert_eq!(
            fs::read_dir(output.join("fail")).unwrap().count(),
            1,
            "owned local stage removed after source-open failure"
        );
        let cancel = Exchange::test_policy(Choice::Cancel);
        fs::write(output.join("cancel/one.txt"), b"cancel sentinel").unwrap();
        assert_eq!(
            download_case(
                &v,
                &profile,
                "down-cancel",
                source(),
                &output.join("cancel"),
                &cancel
            )
            .status,
            UploadStatus::Cancelled
        );
        assert_eq!(
            fs::read(output.join("cancel/one.txt")).unwrap(),
            b"cancel sentinel"
        );
        assert_eq!(
            fs::read(remote.join("down/one.txt")).unwrap(),
            b"download bytes"
        );
        assert_eq!(
            fs::read(remote.join("down/tree/nested/child.txt")).unwrap(),
            b"download child"
        );
    }
}

#[cfg(test)]
mod progress_fixture {
    use super::*;
    #[test]
    #[ignore = "generated localhost fixture runner only"]
    fn generated_transfer_progress_rejects_invalid_metadata_before_mutation() {
        let v: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var("NEARLY_PROGRESS_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(v["generatedOnly"], true);
        let root = std::path::PathBuf::from(v["root"].as_str().unwrap());
        assert!(root.starts_with(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("test-results")
        ));
        let profile = crate::sftp::Profile {
            id: "metadata".into(),
            name: "Generated localhost".into(),
            host: "127.0.0.1".into(),
            port: v["port"].as_u64().unwrap() as u16,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: v["key"].as_str().unwrap().into(),
            host_key: v["fingerprint"].as_str().unwrap().into(),
        };
        let mut evidence = Vec::new();
        for mode in ["missing", "overflow", "imprecise"] {
            let source = root.join("remote").join(format!("metadata-{mode}"));
            std::fs::create_dir_all(&source).unwrap();
            for name in ["first.bin", "second.bin"] {
                std::fs::write(source.join(name), b"generated metadata fixture").unwrap();
            }
            let destination = root.join(format!("metadata-output-{mode}"));
            std::fs::create_dir_all(&destination).unwrap();
            let engine = crate::engine::Engine::default();
            engine.prepare_operation(mode).unwrap();
            let stop = engine.claim_prepared_upload(mode).unwrap();
            let outcome = download(
                &engine,
                DownloadRequest {
                    id: mode.into(),
                    session_id: "fixture".into(),
                    sources: vec![
                        format!("/metadata-{mode}/first.bin"),
                        format!("/metadata-{mode}/second.bin"),
                    ],
                    local: destination.to_string_lossy().into(),
                },
                &profile,
                v["passphrase"].as_str().unwrap(),
                &stop,
                &Exchange::test_policy(Choice::Overwrite),
            )
            .unwrap();
            assert_eq!(outcome.status, UploadStatus::Partial, "{mode}");
            assert_eq!(
                (outcome.completed, outcome.bytes, outcome.transferred_bytes),
                (0, 0, 0)
            );
            assert_eq!(
                std::fs::read_dir(&destination).unwrap().count(),
                0,
                "no owned stage or destination before validated plan"
            );
            let snapshot = engine.operation_progress(mode).unwrap().snapshot();
            assert_eq!(snapshot.total, None);
            assert_eq!(snapshot.done, 0);
            assert!(outcome.message.contains(if mode == "missing" {
                "Source size/timestamp unavailable"
            } else {
                crate::operation_progress::BYTE_TOTAL_LIMIT_ERROR
            }));
            evidence.push(serde_json::json!({"mode":mode,"outcome":outcome,"snapshot":snapshot}));
            engine.finish_operation(mode);
        }
        std::fs::write(
            root.join("metadata-limits.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }
    #[test]
    #[ignore = "generated localhost fixture runner only"]
    fn generated_transfer_progress_acknowledgements_and_aggregate() {
        let manifest = std::env::var("NEARLY_PROGRESS_FIXTURE").unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        assert_eq!(v["generatedOnly"], true);
        let root = std::path::PathBuf::from(v["root"].as_str().unwrap());
        assert!(
            root.starts_with(std::env::current_dir().unwrap().join("test-results"))
                || root.starts_with(
                    std::env::current_dir()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("test-results")
                )
        );
        let profile = crate::sftp::Profile {
            id: "progress".into(),
            name: "Generated localhost".into(),
            host: "127.0.0.1".into(),
            port: v["port"].as_u64().unwrap() as u16,
            user: "fixture".into(),
            auth: "key".into(),
            mode: "sftp".into(),
            key_file: v["key"].as_str().unwrap().into(),
            host_key: v["fingerprint"].as_str().unwrap().into(),
        };
        let local = root.join("sources");
        std::fs::create_dir_all(local.join("empty")).unwrap();
        std::fs::write(local.join("first.bin"), vec![17; 100000]).unwrap();
        std::fs::write(local.join("second.bin"), vec![23; 70000]).unwrap();
        let mut evidence = vec![];
        for mode in [
            "upload",
            "legacy",
            "download",
            "download-failed",
            "download-cancel",
            "failed",
            "cancel",
            "skip",
            "publish-failed",
            "empty",
        ] {
            let engine = crate::engine::Engine::default();
            engine.prepare_operation(mode).unwrap();
            let stop = engine.claim_prepared_upload(mode).unwrap();
            let progress = engine.operation_progress(mode).unwrap();
            let watch = progress.clone();
            let halted = stop.clone();
            let finished = std::sync::Arc::new(AtomicBool::new(false));
            let done = finished.clone();
            let cancel = mode.ends_with("cancel");
            let observer = std::thread::spawn(move || {
                let mut samples = vec![];
                while !done.load(Ordering::SeqCst) {
                    let s = watch.snapshot();
                    if cancel && s.done > 0 {
                        halted.store(true, Ordering::SeqCst);
                    }
                    samples.push(s);
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                samples
            });
            if mode == "skip" {
                let target = root.join("remote/skip");
                std::fs::write(target.join("first.bin"), b"sentinel").unwrap();
                std::fs::write(target.join("second.bin"), b"sentinel").unwrap();
            }
            let outcome = if mode.starts_with("download") {
                let dest = root.join(mode);
                let remote = if mode == "download" { "upload" } else { mode };
                if mode != "download" {
                    let source = root.join("remote").join(mode);
                    std::fs::create_dir_all(source.join("empty")).unwrap();
                    std::fs::copy(local.join("first.bin"), source.join("first.bin")).unwrap();
                    std::fs::copy(local.join("second.bin"), source.join("second.bin")).unwrap();
                }
                std::fs::create_dir_all(&dest).unwrap();
                download(
                    &engine,
                    DownloadRequest {
                        id: mode.into(),
                        session_id: "fixture".into(),
                        sources: vec![
                            format!("/{remote}/first.bin"),
                            format!("/{remote}/second.bin"),
                            format!("/{remote}/empty"),
                        ],
                        local: dest.to_string_lossy().into(),
                    },
                    &profile,
                    v["passphrase"].as_str().unwrap(),
                    &stop,
                    &Exchange::test_policy(Choice::Overwrite),
                )
            } else {
                let request = crate::upload::UploadRequest {
                    id: mode.into(),
                    session_id: "fixture".into(),
                    sources: if mode == "empty" {
                        vec![local.join("empty").to_string_lossy().into()]
                    } else {
                        vec![
                            local.join("first.bin").to_string_lossy().into(),
                            local.join("second.bin").to_string_lossy().into(),
                            local.join("empty").to_string_lossy().into(),
                        ]
                    },
                    remote: format!("/{mode}"),
                    recursive: true,
                    interactive: mode != "legacy",
                };
                if mode == "legacy" {
                    crate::upload::run(
                        &engine,
                        request,
                        &profile,
                        v["passphrase"].as_str().unwrap(),
                        &stop,
                    )
                } else {
                    crate::upload::run_interactive(
                        &engine,
                        request,
                        &profile,
                        v["passphrase"].as_str().unwrap(),
                        &stop,
                        &Exchange::test_policy(if mode == "skip" {
                            Choice::Skip
                        } else {
                            Choice::Overwrite
                        }),
                    )
                }
            }
            .unwrap();
            finished.store(true, Ordering::SeqCst);
            let samples = observer.join().unwrap();
            let snapshot = progress.snapshot();
            assert_eq!(
                snapshot.total,
                Some(if mode == "skip" || mode == "empty" {
                    0
                } else {
                    170000
                }),
                "{mode}: aggregate planned bytes"
            );
            assert_eq!(
                snapshot.done, outcome.transferred_bytes,
                "{mode}: acknowledged bytes only"
            );
            if mode != "skip" && mode != "empty" {
                assert!(
                    samples.iter().any(|s| s.done > 0 && s.done < 170000),
                    "{mode}: live intermediate progress"
                );
            }
            let mut previous = 0;
            for s in &samples {
                assert!(s.done >= previous, "aggregate must never reset per file");
                previous = s.done;
                assert!(s.done <= 170000);
            }
            if mode == "failed"
                || mode == "cancel"
                || mode == "download-failed"
                || mode == "download-cancel"
            {
                assert_eq!(
                    outcome.status,
                    if mode.ends_with("cancel") {
                        UploadStatus::Cancelled
                    } else {
                        UploadStatus::Partial
                    }
                );
                assert!(snapshot.done < 170000);
                assert_eq!(outcome.bytes, 0);
            } else if mode == "publish-failed" {
                assert_eq!(outcome.status, UploadStatus::Partial);
                assert_eq!(snapshot.done, 170000);
                assert_eq!(outcome.bytes, 100000);
                assert_eq!(snapshot.phase, "finalizing");
            } else {
                assert_eq!(outcome.status, UploadStatus::Completed);
                assert_eq!(
                    snapshot.done,
                    if mode == "skip" || mode == "empty" {
                        0
                    } else {
                        170000
                    }
                );
                assert_eq!(
                    snapshot.entries,
                    if mode == "skip" || mode == "empty" {
                        1
                    } else {
                        3
                    }
                );
                assert_eq!(snapshot.phase, "finalizing");
            }
            evidence.push(serde_json::json!({"mode":mode,"snapshot":snapshot,"outcome":outcome,"samples":samples}));
            engine.finish_operation(mode);
        }
        std::fs::write(
            root.join("progress.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }
}
