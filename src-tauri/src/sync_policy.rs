//! Job-local comparison evidence. Never an authorization/path guard.
use super::*;
use std::collections::HashMap;
const MAX_ENTRIES:usize=10000;
const MAX_BYTES:usize=16*1024*1024;
const PREFIX:&str="Sync conflict: ";
pub(crate) fn conflict(message:&str)->String{format!("{PREFIX}{message}")}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub(crate) struct Version { pub(crate) size:u64,pub(crate) mtime:u32 }
impl Version {
    pub(crate) fn attrs(attrs:&FileAttributes)->Result<Self,String>{
        if !attrs.file_type().is_file()||attrs.is_symlink(){return Err(conflict("remote target is not a regular file; no overwrite attempted"));}
        Ok(Self{size:attrs.size.ok_or_else(||conflict("remote metadata unavailable; no overwrite attempted"))?,mtime:attrs.mtime.filter(|v|*v!=0).ok_or_else(||conflict("remote metadata unavailable; no overwrite attempted"))?})
    }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum Expected { Unknown,Absent,Present(Version) }
#[derive(Clone)]
struct Local { snapshot:crate::source_change::Snapshot,digest:ring::digest::Digest,initial_boundary:Option<std::time::Instant> }
struct Entry { remote:Expected,local:Option<Local>,early_notice:Option<std::time::Instant> }
#[derive(Default)] struct State { entries:HashMap<String,Entry>,bytes:usize }
#[derive(Clone,Default)] pub(crate) struct Policy(std::sync::Arc<std::sync::Mutex<State>>);
#[derive(Clone,Copy,Debug,PartialEq,Eq)] pub(crate) enum Initial { Upload,Unchanged,RetainRemote }
pub(crate) fn classify(size:u64,time:Option<u32>,remote:Option<Version>)->Result<Initial,String>{
    let time=time.ok_or_else(||conflict("local timestamp unavailable; no overwrite attempted"))?;
    let Some(remote)=remote else{return Ok(Initial::Upload);};
    if time>remote.mtime{return Ok(Initial::Upload);}
    if size!=remote.size{return Err(conflict("size differs while remote timestamp is equal or newer; review both files"));}
    Ok(if time==remote.mtime{Initial::Unchanged}else{Initial::RetainRemote})
}
impl State {
    fn put(&mut self,target:&str,entry:Entry)->Result<(),String>{
        if !self.entries.contains_key(target){
            let cost=target.len().saturating_add(512);
            if self.entries.len()>=MAX_ENTRIES||self.bytes.saturating_add(cost)>MAX_BYTES{return Err(conflict("sync baseline limit reached; stop and narrow the sync scope"));}
            self.bytes+=cost;
        }
        self.entries.insert(target.to_owned(),entry);Ok(())
    }
}
impl Policy {
    pub(crate) fn mark_initial(&self,target:&str)->Result<(),String>{
        let mut s=self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?;
        if !s.entries.contains_key(target){s.put(target,Entry{remote:Expected::Unknown,local:None,early_notice:None})?;}Ok(())
    }
    pub(crate) fn needs_initial(&self,target:&str)->bool{
        self.0.lock().map_or(true,|s|s.entries.get(target).is_some_and(|e|e.remote==Expected::Unknown))
    }
    fn initialize(&self,target:&str,remote:Option<Version>)->Result<(),String>{
        let mut s=self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?;
        let observed=remote.map_or(Expected::Absent,Expected::Present);
        if let Some(e)=s.entries.get(target){if e.remote!=Expected::Unknown&&e.remote!=observed{return Err(conflict("remote changed since sync baseline; no overwrite attempted"));}}
        let early_notice=s.entries.get(target).and_then(|e|e.early_notice);
        s.put(target,Entry{remote:observed,local:None,early_notice})
    }
    pub(crate) fn missing_initial(&self,target:&str)->Result<(),String>{self.initialize(target,None)}
    fn local(&self,target:&str)->Result<Option<Local>,String>{Ok(self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?.entries.get(target).and_then(|e|e.local.clone()))}
    pub(crate) fn has_local(&self,target:&str)->bool{self.0.lock().map_or(true,|s|s.entries.get(target).is_some_and(|e|e.local.is_some()))}
    fn set_local(&self,target:&str,local:Local)->Result<(),String>{
        let mut s=self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?;
        let entry=s.entries.get_mut(target).ok_or_else(||conflict("sync baseline unavailable"))?;
        if local.initial_boundary.zip(entry.early_notice).is_some_and(|(boundary,notice)|notice<=boundary){return Err(conflict("local source changed while preparing baseline; restart to rescan"));}
        entry.local=Some(local);entry.early_notice=None;Ok(())
    }
    pub(crate) fn observe_notice(&self,target:&str,detected:std::time::Instant)->Result<(),String>{
        let mut s=self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?;
        let Some(entry)=s.entries.get_mut(target)else{return Ok(());};
        if entry.remote==Expected::Unknown{entry.early_notice=Some(entry.early_notice.map_or(detected,|old|old.min(detected)));}
        if entry.local.as_ref().and_then(|l|l.initial_boundary).is_some_and(|boundary|detected<=boundary){return Err(conflict("local source changed while preparing baseline; restart to rescan"));}Ok(())
    }
    pub(crate) fn check_write(&self,target:&str,observed:Option<Version>)->Result<(),String>{
        let mut s=self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?;
        let actual=observed.map_or(Expected::Absent,Expected::Present);
        match s.entries.get(target){
            Some(e) if e.remote==actual=>Ok(()),
            Some(e) if e.remote==Expected::Unknown=>Err(conflict("initial comparison is incomplete; no overwrite attempted")),
            Some(_)=>Err(conflict("remote changed since sync baseline; no overwrite attempted")),
            None if actual==Expected::Absent=>s.put(target,Entry{remote:actual,local:None,early_notice:None}),
            None=>Err(conflict("new local file already exists remotely; review both files")),
        }
    }
    pub(crate) fn committed(&self,target:&str,version:Version,snapshot:crate::source_change::Snapshot,digest:ring::digest::Digest)->Result<(),String>{
        self.0.lock().map_err(|_|conflict("sync baseline unavailable"))?.put(target,Entry{remote:Expected::Present(version),local:Some(Local{snapshot,digest,initial_boundary:None}),early_notice:None})
    }
    pub(crate) fn forget(&self,target:&str,descendants:bool){
        if let Ok(mut s)=self.0.lock(){let prefix=format!("{target}/");let mut removed=0usize;s.entries.retain(|key,_|{let drop=key==target||descendants&&key.starts_with(&prefix);if drop{removed=removed.saturating_add(key.len()+512);}!drop});s.bytes=s.bytes.saturating_sub(removed);}
    }
}
fn capture_local(root:&Path,source:&Path,snapshot:crate::source_change::Snapshot,stop:&AtomicBool)->Result<Local,String>{
    let mut observation=ObservedComparison{comparison:FileComparison::Upload{remote_newer:false},source:source.to_owned(),root:root.to_owned(),snapshot:snapshot.clone()};
    observation.revalidate()?;
    let mut input=std::fs::File::open(source).map_err(|_|conflict("local baseline unavailable; restart to rescan"))?;
    if crate::source_change::Snapshot::capture(&input)?!=snapshot{return Err(conflict("local source changed while preparing baseline; restart to rescan"));}
    let mut context=ring::digest::Context::new(&ring::digest::SHA256);let mut buffer=[0u8;32768];let mut bytes=0u64;
    loop{crate::file_ops::check(stop)?;let n=input.read(&mut buffer).map_err(|_|conflict("local baseline read failed; restart to rescan"))?;if n==0{break;}bytes=bytes.saturating_add(n as u64);if bytes>snapshot.length(){return Err(conflict("local source changed while preparing baseline; restart to rescan"));}context.update(&buffer[..n]);}
    observation.revalidate()?;crate::file_ops::check(stop)?;
    if bytes!=snapshot.length()||matches!(observation.comparison,FileComparison::SourceChanged){return Err(conflict("local source changed while preparing baseline; restart to rescan"));}
    Ok(Local{snapshot,digest:context.finish(),initial_boundary:None})
}
pub(crate) fn initialize(s:&Connection,root:&Path,relative:&Path,snapshot:&crate::source_change::Snapshot,remote:&str,version:Option<Version>,stop:&AtomicBool)->Result<Option<Initial>,String>{
    let Some(policy)=&s.sync_policy else{return Ok(None);};let target=recorded_target(remote,relative)?;
    if !policy.needs_initial(&target){return Ok(None);}
    let decision=classify(snapshot.length(),protocol_seconds(snapshot.modified()),version)?;
    policy.initialize(&target,version)?;
    if decision!=Initial::Upload{let mut local=capture_local(root,&root.join(relative),snapshot.clone(),stop)?;local.initial_boundary=Some(std::time::Instant::now());policy.set_local(&target,local)?;}
    Ok(Some(decision))
}
pub(crate) async fn observed(s:&Connection,target:&str)->Result<Option<Version>,String>{
    match s.raw.lstat(target.to_owned()).await{
        Ok(a)=>Ok(Some(Version::attrs(&a.attrs)?)),
        Err(SftpError::Status(status)) if status.status_code==StatusCode::NoSuchFile=>Ok(None),
        Err(_)=>Err("Remote sync baseline lookup failed; no overwrite attempted".into()),
    }
}
pub(crate) fn unchanged_notice(s:&mut Connection,root:&Path,relative:&Path,remote:&str,stop:&AtomicBool)->Result<bool,String>{
    let Some(policy)=s.sync_policy.clone()else{return Ok(false);};let target=recorded_target(remote,relative)?;
    let Some(before)=policy.local(&target)? else{return Ok(false);};
    let input=std::fs::File::open(root.join(relative)).map_err(|_|"Local notice source unavailable")?;let snapshot=crate::source_change::Snapshot::capture(&input)?;drop(input);
    let mut now=capture_local(root,&root.join(relative),snapshot,stop)?;now.initial_boundary=before.initial_boundary;
    if now.digest.as_ref()!=before.digest.as_ref(){return Ok(false);}
    s.run(stop,async{
        let parent=target.rsplit_once('/').map(|(p,_)|if p.is_empty(){"/"}else{p}).ok_or("Invalid sync target")?;
        directory_guard(&s.raw,parent).await?;policy.check_write(&target,observed(s,&target).await?)?;
        let mut final_local=ObservedComparison{comparison:FileComparison::Upload{remote_newer:false},source:root.join(relative),root:root.to_owned(),snapshot:now.snapshot.clone()};final_local.revalidate()?;crate::file_ops::check(stop)?;
        if matches!(final_local.comparison,FileComparison::SourceChanged){return Ok(false);}
        policy.set_local(&target,now)?;Ok(true)
    })
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn early_notices_survive_unknown_initialization_but_acknowledged_uploads_cover_older_notices(){
        let root=std::env::temp_dir().join(format!("nearly-policy-order-{}-{}",std::process::id(),getrandom::u64().unwrap()));std::fs::create_dir(&root).unwrap();let file=root.join("f");std::fs::write(&file,b"x").unwrap();let input=std::fs::File::open(&file).unwrap();let snapshot=crate::source_change::Snapshot::capture(&input).unwrap();let digest=ring::digest::digest(&ring::digest::SHA256,b"x");
        let now=std::time::Instant::now();let boundary=now+Duration::from_millis(1);let version=Version{size:1,mtime:100};
        let p=Policy::default();p.mark_initial("/f").unwrap();p.observe_notice("/f",now).unwrap();p.initialize("/f",Some(version)).unwrap();assert!(p.set_local("/f",Local{snapshot:snapshot.clone(),digest:digest.clone(),initial_boundary:Some(boundary)}).is_err());
        let p=Policy::default();p.mark_initial("/f").unwrap();p.initialize("/f",Some(version)).unwrap();p.set_local("/f",Local{snapshot:snapshot.clone(),digest:digest.clone(),initial_boundary:Some(boundary)}).unwrap();assert!(p.observe_notice("/f",now).is_err());p.observe_notice("/f",boundary+Duration::from_millis(1)).unwrap();p.committed("/f",version,snapshot,digest).unwrap();p.observe_notice("/f",now).unwrap();
        drop(input);std::fs::remove_file(file).unwrap();std::fs::remove_dir(root).unwrap();
    }
    #[test] fn exact_initial_direction_size_and_missing(){let r=Some(Version{size:469,mtime:140});assert_eq!(classify(469,Some(100),r).unwrap(),Initial::RetainRemote);assert_eq!(classify(469,Some(140),r).unwrap(),Initial::Unchanged);assert_eq!(classify(351,Some(141),r).unwrap(),Initial::Upload);assert!(classify(351,Some(140),r).is_err());assert!(classify(351,Some(100),r).is_err());assert_eq!(classify(469,Some(141),r).unwrap(),Initial::Upload);assert_eq!(classify(469,Some(100),None).unwrap(),Initial::Upload);assert!(classify(469,None,r).is_err());}
    #[test] fn unknown_changed_new_existing_and_memory_limits_fail_closed(){let p=Policy::default();p.mark_initial("/a").unwrap();assert!(p.check_write("/a",None).is_err());p.missing_initial("/a").unwrap();p.check_write("/a",None).unwrap();assert!(p.check_write("/a",Some(Version{size:1,mtime:1})).is_err());assert!(p.check_write("/new",Some(Version{size:1,mtime:1})).is_err());p.check_write("/new",None).unwrap();p.forget("/a",false);p.check_write("/a",None).unwrap();for i in 0..MAX_ENTRIES-2{p.mark_initial(&format!("/g/{i}")).unwrap();}assert!(p.mark_initial("/overflow").is_err());p.forget("/g",true);assert!(!p.needs_initial("/g/1"));p.mark_initial("/after").unwrap();assert!(p.0.lock().unwrap().bytes<=MAX_BYTES);}
}
