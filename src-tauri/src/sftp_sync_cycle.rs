use super::*;
use checklist::{Inventory,Node,Kind};
use std::{collections::{BTreeMap,HashSet},path::PathBuf};
fn target(remote:&str,rel:&Path)->Result<String,String>{if rel.as_os_str().is_empty(){normalize(remote)}else{recorded_target(remote,rel)}}
fn reserved(name:&str)->bool{name.strip_prefix(".nearly-sync-").and_then(|s|s.strip_suffix(".part")).is_some_and(|s|s.len()==32&&s.bytes().all(|b|b.is_ascii_hexdigit()))}
#[cfg(test)]mod integration_review_tests{
 use super::*;
 #[cfg(windows)]#[test]fn source_root_authority_error_remains_fail_closed(){let root=std::env::temp_dir().join(format!("nearly-source-authority-{}",getrandom::u64().unwrap()));std::fs::create_dir_all(root.join("dir")).unwrap();std::fs::write(root.join("dir/item"),b"generated").unwrap();let root=root.canonicalize().unwrap();let result=source(&root,Path::new("dir/item"),&|_,_|Err("generated root authority refusal".into()));assert!(result.err().unwrap().contains("generated root authority refusal"));assert_eq!(std::fs::read(root.join("dir/item")).unwrap(),b"generated");assert!(root.starts_with(std::env::temp_dir().canonicalize().unwrap()));std::fs::remove_dir_all(root).unwrap();}
 #[cfg(windows)]#[test]fn source_final_junction_inserted_at_validation_is_refused(){let root=std::env::temp_dir().join(format!("nearly-source-final-reparse-{}",getrandom::u64().unwrap()));std::fs::create_dir_all(root.join("dir")).unwrap();std::fs::create_dir(root.join("outside")).unwrap();std::fs::write(root.join("outside/sentinel"),b"must remain").unwrap();std::fs::write(root.join("dir/item"),b"generated").unwrap();let root=root.canonicalize().unwrap();let result=source(&root,Path::new("dir/item"),&|_,_|{let output=std::process::Command::new("node").args(["-e","const fs=require('fs');fs.unlinkSync(process.argv[1]);fs.symlinkSync(process.argv[2],process.argv[1],'junction');"]).arg(root.join("dir/item")).arg(root.join("outside")).output().unwrap();assert!(output.status.success());Ok(())});assert!(result.is_err(),"final reparse must never become an accepted source handle");assert_eq!(std::fs::read(root.join("outside/sentinel")).unwrap(),b"must remain");std::fs::remove_dir(root.join("dir/item")).unwrap();assert!(root.starts_with(std::env::temp_dir().canonicalize().unwrap()));std::fs::remove_dir_all(root).unwrap();}
 #[test]fn integration_review_reserves_only_generated_stage_shape(){assert!(reserved(".nearly-sync-0123456789abcdef0123456789abcdef.part"));for n in [".nearly-sync-not-a-stage.part",".nearly-sync-.part",".nearly-sync-0123456789abcdef0123456789abcdeg.part"]{assert!(!reserved(n),"ordinary name {n}");}}
 #[cfg(windows)]#[test]fn integration_review_source_parent_cannot_be_replaced_at_preopen_boundary(){let root=std::env::temp_dir().join(format!("nearly-review-parent-{}",getrandom::u64().unwrap()));std::fs::create_dir_all(root.join("dir")).unwrap();std::fs::write(root.join("dir/item"),b"authorized generated source").unwrap();let root=root.canonicalize().unwrap();let result=source(&root,Path::new("dir/item"),&|_,_|{assert!(std::fs::rename(root.join("dir"),root.join("moved")).is_err(),"checked source parent was replaceable before open");Ok(())});let mut f=result.unwrap();let mut bytes=Vec::new();f.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"authorized generated source");drop(f);assert!(root.starts_with(std::env::temp_dir().canonicalize().unwrap()));std::fs::remove_dir_all(root).unwrap();}
}
pub(crate) fn source(root:&Path,rel:&Path,validate:&dyn Fn(&Path,bool)->Result<(),String>)->Result<std::fs::File,String>{
 if !root.is_absolute()||rel.as_os_str().is_empty()||rel.components().any(|p|!matches!(p,std::path::Component::Normal(_))){return Err("Unsafe local source".into())}
 let _parents=crate::engine::compatible_deletion_parents(root,rel)?;if _parents.len()!=rel.components().count(){return Err("Local source parent disappeared before open".into())}
 #[cfg(windows)]{
  // Every root/ancestor is opened as itself, checked non-reparse, and held
  // against rename. This is not a guarantee against in-place reparse attribute
  // changes by another local process. Use the selected WinSCP-like path policy:
  // Root identity is checked while held. The Engine shares its upload check
  // with this open; generic callback callers retain their separate veto.
  validate(Path::new(""),true)?;
  use std::os::windows::fs::OpenOptionsExt;
  let file=std::fs::OpenOptions::new().read(true).share_mode(7).custom_flags(0x00200000).open(root.join(rel)).map_err(|_|"Local source open failed")?;
  // Validate the opened final object BEFORE returning a readable handle or any
  // remote OPEN. A final reparse/type replacement cannot inherit the parent proof.
  crate::source_change::Snapshot::capture(&file)?;
  Ok(file)
 }
 #[cfg(not(windows))]{
  // Plain Unix directory handles do not prevent rename. Keep the previous
  // checks until an equivalent handle-relative/no-follow implementation exists.
  let canonical=root.join(rel).canonicalize().map_err(|_|"Local source unavailable")?;if !canonical.starts_with(root){return Err("Local source escaped root".into())}
  let mut p=root.to_owned();for c in rel.components(){p.push(c);let m=std::fs::symlink_metadata(&p).map_err(|_|"Local source parent unavailable")?;if m.file_type().is_symlink(){return Err("Local symlink refused".into())}}
  validate(rel,false)?;std::fs::OpenOptions::new().read(true).open(canonical).map_err(|_|"Local source open failed".into())
 }
}
fn scan_remote(c:&Connection,remote:&str,scope:&Path,rules:&crate::exclusion::Rules,recursive:bool,stop:&AtomicBool)->Result<Inventory,String>{
 c.run(stop,async{
  let full=target(remote,scope)?;match inspect_directory(&c.raw,&full).await?{DirectoryInspection::Missing(_)=>return Ok(Inventory::default()),DirectoryInspection::Present(_)=>()}
  let mut out=Inventory::default();
  if !scope.as_os_str().is_empty(){let a=c.raw.lstat(full.clone()).await.map_err(|_|"Remote scope metadata unavailable")?.attrs;out.insert(scope.to_owned(),Node{kind:Kind::Directory,version:None,permissions:a.permissions})?;}
  let mut todo=vec![scope.to_owned()];let mut batches=0usize;
  while let Some(dir)=todo.pop(){crate::file_ops::check(stop)?;let h=c.raw.opendir(target(remote,&dir)?).await.map_err(|_|"Remote listing open failed; deletion refused")?.handle;
   loop{crate::file_ops::check(stop)?;batches+=1;if batches>20000{return Err("Remote listing response budget exceeded; deletion refused".into())}match c.raw.readdir(h.clone()).await{
    Ok(names)=>for e in names.files{if e.filename=="."||e.filename==".."{continue;}if e.filename.contains(['/', '\\','\0']){return Err("Invalid remote name; deletion refused".into())}let rel=dir.join(&e.filename);let mut attrs=e.attrs;if attrs.permissions.is_none()||(attrs.file_type().is_file()&&(attrs.size.is_none()||attrs.mtime.is_none())){crate::file_ops::check(stop)?;attrs=c.raw.lstat(target(remote,&rel)?).await.map_err(|_|"Remote listing attributes unavailable; deletion refused")?.attrs;}let isdir=attrs.is_dir()&&!attrs.is_symlink();
     let blocked=reserved(&e.filename)||crate::file_ops::validate_creation_name(&e.filename,crate::file_ops::Side::Local).is_err()||rules.excludes(&rel,isdir)?||attrs.is_symlink()||(!isdir&&!attrs.file_type().is_file())||(!recursive&&isdir);
     let kind=if blocked{Kind::Blocked}else if isdir{Kind::Directory}else{Kind::File};let version=if kind==Kind::File{attrs.size.zip(attrs.mtime)}else{None};out.insert(rel.clone(),Node{kind,version,permissions:attrs.permissions})?;if kind==Kind::Directory{todo.push(rel);}
    },Err(SftpError::Status(s))if s.status_code==StatusCode::Eof=>break,Err(_)=>return Err("Remote listing incomplete; deletion refused".into()),
   }}c.raw.close(h).await.map_err(|_|"Remote listing close failed; deletion refused")?;
  }Ok(out)
 })
}
fn mkdir(c:&Connection,remote:&str,rel:&Path,stop:&AtomicBool)->Result<bool,String>{
 crate::file_ops::check(stop)?;let full=target(remote,rel)?;c.run(&AtomicBool::new(false),async{
  match c.raw.lstat(full.clone()).await{Ok(a)if a.attrs.is_dir()&&!a.attrs.is_symlink()=>return Ok(false),Err(SftpError::Status(s))if s.status_code==StatusCode::NoSuchFile=>(),_=>return Err("Remote directory type conflict".into())}
  // Resolve only the directory being created and restore its known parent, as in the measured profile.
  match c.raw.realpath(full.clone()).await{Ok(_)=>(),Err(SftpError::Status(s))if s.status_code==StatusCode::NoSuchFile=>(),Err(_)=>return Err("Remote directory resolution failed".into())}
  c.raw.realpath(target(remote,rel.parent().unwrap_or(Path::new("")))?).await.map_err(|_|"Remote parent unavailable")?;crate::file_ops::check(stop)?;
  c.raw.mkdir(full,FileAttributes::empty()).await.map_err(|_|"Remote MKDIR outcome is uncertain; restart to reconcile")?;Ok(true)
 })
}
enum Transfer{Complete(u64),Changed{committed:Option<u64>,expected:Option<(u64,u32)>}}
fn upload(c:&Connection,root:&Path,remote:&str,rel:&Path,existing:Option<Node>,stop:&AtomicBool,validate:&dyn Fn(&Path,bool)->Result<(),String>,mut input:std::fs::File,next:Option<&Path>,prepared_next:&mut Option<crate::parent_lookahead::Parents>)->Result<Transfer,String>{
 let possible_final_change=std::cell::Cell::new(false);let snapshot=crate::source_change::Snapshot::capture(&input)?;let small=snapshot.length()<102400;let final_path=target(remote,rel)?;
 let mut attrs=FileAttributes::empty();let time=protocol_seconds(snapshot.modified()).ok_or("Local timestamp unsupported by SFTPv3")?;attrs.mtime=Some(time);attrs.atime=Some(time);if !small{attrs.permissions=existing.and_then(|e|e.permissions);}
 if !small&&existing.is_some()&&!c.posix_rename{return Err("Server lacks atomic replacement for large existing file; old target retained".into())}
 let parent=final_path.rsplit_once('/').ok_or("Invalid sync target")?.0.to_owned();let stage=if small{final_path.clone()}else{format!("{parent}/.nearly-sync-{:016x}{:016x}.part",getrandom::u64().map_err(|_|"Stage randomness unavailable")?,getrandom::u64().map_err(|_|"Stage randomness unavailable")?)};
 crate::file_ops::check(stop)?;
 c.run(&AtomicBool::new(false),async{
  if small&&existing.is_some(){possible_final_change.set(true);}
  let flags=OpenFlags::WRITE|OpenFlags::CREATE|if small{OpenFlags::TRUNCATE}else{OpenFlags::EXCLUDE};let h=c.raw.open(stage.clone(),flags,FileAttributes::empty()).await.map_err(|_|"Sync OPEN outcome is uncertain; restart to reconcile")?.handle;
  if small{
   let mut bytes=Vec::with_capacity(snapshot.length()as usize);let read=(&mut input).take(102400).read_to_end(&mut bytes);
   if read.is_err()||bytes.len()>=102400{c.raw.close(h).await.map_err(|_|"Small source changed/read failed; CLOSE outcome uncertain")?;c.raw.remove(stage).await.map_err(|_|"Small source changed/read failed; cleanup outcome uncertain")?;if read.is_err(){return Err("Small sync source read failed; partial final removed".into())}return Ok(Transfer::Changed{committed:None,expected:None})}
   let count=bytes.len()as u64;
   // Prepare only parents, during the issued current ACK future. Current
   // settlement/cleanup remains uncancelled; no next remote operation is issued.
   if let Some(next)=next.filter(|_|existing.is_none()){
    let((),slot)=crate::parent_lookahead::during_current(root,next,stop,direct(&c.raw,h,final_path,bytes,attrs,stop)).await?;
    *prepared_next=slot;
   }else{direct(&c.raw,h,final_path,bytes,attrs,stop).await?;}
   possible_final_change.set(true);
   let changed=match source(root,rel,validate){Ok(f)=>snapshot.changed(&input,&f,count)?.is_some(),Err(_)=>true};
   if changed{return Ok(Transfer::Changed{committed:Some(count),expected:Some((count,time))})}return Ok(Transfer::Complete(count))
  }
  let mut offset=0;let mut reason=None;let mut source_changed=false;loop{
   if stop.load(Ordering::SeqCst){reason=Some("Operation stopped during staged sync".to_string());break;}
   let mut chunks=Vec::new();for _ in 0..8{let mut b=vec![0;32768];match input.read(&mut b){Ok(0)=>break,Ok(n)=>{b.truncate(n);chunks.push((offset,b));offset+=n as u64;},Err(_)=>{reason=Some("Local staged source read failed".into());break;}}}
   if reason.is_some()||chunks.is_empty(){break;}let replies=futures_util::future::join_all(chunks.into_iter().map(|(at,b)|c.raw.write(h.clone(),at,b))).await;if replies.iter().any(Result::is_err){reason=Some("Staged sync WRITE failed".into());break;}
  }
  // Settle CLOSE even on cancel/error. Only a known closed handle permits cleanup.
  c.raw.close(h).await.map_err(|_|"Staged sync CLOSE outcome is uncertain; unique partial may remain")?;
  let current=source(root,rel,validate);if reason.is_none(){match current{Ok(ref f)=>if snapshot.changed(&input,f,offset)?.is_some(){source_changed=true;reason=Some("Local staged source changed; no final rename".into())},Err(_)=>{source_changed=true;reason=Some("Local staged source disappeared; no final rename".into())}}}
  if stop.load(Ordering::SeqCst)&&reason.is_none(){reason=Some("Operation stopped before staged commit".into())}
  if let Some(reason)=reason{c.raw.remove(stage).await.map_err(|_|"Staged sync cleanup outcome is uncertain; unique partial may remain")?;if source_changed&&!stop.load(Ordering::SeqCst){return Ok(Transfer::Changed{committed:None,expected:existing.and_then(|n|n.version)})}return Err(reason)}
  c.raw.setstat(stage.clone(),attrs).await.map_err(|_|"Staged timestamp/permissions failed; old final retained, unique partial remains")?;
  // Large-only final path guard. Never trade containment for partial-resume speed.
  directory_guard(&c.raw,&parent).await?;
  // SETSTAT and parent checks awaited network replies. Re-observe the opened
  // source and current pathname AFTER those waits, immediately before rename.
  let changed=match source(root,rel,validate){Ok(f)=>snapshot.changed(&input,&f,offset)?.is_some(),Err(_)=>true};
  if changed||stop.load(Ordering::SeqCst){c.raw.remove(stage).await.map_err(|_|"Stopped/changed staging cleanup outcome is uncertain; unique partial may remain")?;if changed&&!stop.load(Ordering::SeqCst){return Ok(Transfer::Changed{committed:None,expected:existing.and_then(|n|n.version)})}return Err("Operation stopped before final rename; stage removed".into())}
  possible_final_change.set(true);
  if c.posix_rename{let mut data=Vec::new();for p in [&stage,&final_path]{data.extend_from_slice(&(p.len()as u32).to_be_bytes());data.extend_from_slice(p.as_bytes());}match c.raw.extended("posix-rename@openssh.com",data).await.map_err(|_|"Final rename outcome is uncertain; restart to reconcile")?{Packet::Status(s)if s.status_code==StatusCode::Ok=>(),_=>return Err("Final rename rejected; outcome is uncertain; reconcile final and unique partial before retry".into())}}
  else{c.raw.rename(stage,final_path).await.map_err(|_|"Final rename outcome is uncertain; unique partial may remain")?;}
  let changed=match source(root,rel,validate){Ok(f)=>snapshot.changed(&input,&f,offset)?.is_some(),Err(_)=>true};
  if changed{Ok(Transfer::Changed{committed:Some(offset),expected:Some((offset,time))})}else{Ok(Transfer::Complete(offset))}
 }).map_err(|error|if possible_final_change.get(){format!("Final target may have changed; outcome is uncertain: {error}")}else{error})
}
pub(crate) fn cycle(c:&mut Connection,root:&Path,remote:&str,scope:&Path,rules:&crate::exclusion::Rules,recursive:bool,delete:bool,stop:&AtomicBool,retry:&RetryHints,validate:&dyn Fn(&Path,bool)->Result<(),String>,notify:&dyn Fn(&Path,Event))->Result<Outcome,String>{
 cycle_with_validation(c,root,remote,scope,rules,recursive,delete,stop,retry,&CallbackValidation(validate),notify)
}
pub(crate) fn cycle_with_validation(c:&mut Connection,root:&Path,remote:&str,scope:&Path,rules:&crate::exclusion::Rules,recursive:bool,delete:bool,stop:&AtomicBool,retry:&RetryHints,validation:&dyn LocalValidation,notify:&dyn Fn(&Path,Event))->Result<Outcome,String>{
 let validate=|p:&Path,d:bool|validation.check(p,d);
 let remote=normalize(remote)?;validate(Path::new(""),true)?;if scope.components().any(|p|!matches!(p,std::path::Component::Normal(_))){return Err("Invalid sync scope".into())}if !scope.as_os_str().is_empty()&&rules.excludes(scope,true)?{return Ok(Outcome::Complete)}
 let mut locals=BTreeMap::new();match std::fs::symlink_metadata(root.join(scope)){
  Ok(m)if m.is_dir()=>{let mut prefix=PathBuf::new();for part in scope.components(){prefix.push(part);locals.insert(prefix.clone(),true);}crate::initial_scan::walk_scoped(root,scope,stop,rules,recursive,|p,dir|{locals.insert(p,dir);Ok(())}).map_err(|e|e.reason)?;},
  Err(e)if e.kind()==std::io::ErrorKind::NotFound&&!scope.as_os_str().is_empty()=>(),_=>return Err("Local sync scope unavailable; deletion refused".into()),
 }
 let inventory=scan_remote(c,&remote,scope,rules,recursive,stop)?;validate(Path::new(""),true)?;if locals.keys().any(|p|p.components().any(|c|reserved(&c.as_os_str().to_string_lossy()))){return Err("Local source uses reserved generated-stage name".into())}let local_paths=locals.keys().cloned().collect::<HashSet<_>>();inventory.validate_locals(&local_paths)?;let deletions=if delete{inventory.deletions(&local_paths)}else{Vec::new()};let total=locals.len()+deletions.len();notify(scope,Event::Plan(total));
 // A changing source must not starve stable peers on each rescan. Defer only
 // known retry files; parents and fresh candidates keep their checklist order.
 // This changes scheduling, never the fresh-inventory comparison/authorization.
 let(deferred,mut ready):(Vec<_>,Vec<_>)=locals.into_iter().partition(|(p,dir)|!*dir&&retry.contains_key(p));ready.extend(deferred);
 let mut ready=ready.into_iter().peekable();
 let mut prepared_next=None;
 while let Some((p,dir))=ready.next(){crate::file_ops::check(stop)?;
  // A token is bound to the immediate item, never a later retry/directory.
  let prepared_for_current=prepared_next.take();notify(&p,Event::Begin(if dir{"directory"}else{"compare"}));if dir||!validation.shares_upload_check(){validate(&p,dir)?;}let entry=inventory.entries.get(&p).copied();if entry.is_some_and(|e|e.kind==Kind::Blocked||dir!=(e.kind==Kind::Directory)){return Err("Sync target type conflict; no overwrite attempted".into())}
  if dir{if entry.is_none()&&mkdir(c,&remote,&p,stop)?{notify(&p,Event::Created);}else{notify(&p,Event::Skipped);}continue;}
  let meta=std::fs::metadata(root.join(&p)).map_err(|_|"Local sync source unavailable")?;let time=meta.modified().ok().and_then(protocol_seconds).ok_or("Local timestamp unavailable")?;let version=match entry{Some(e)=>Some(e.version.ok_or("Remote comparison attributes unavailable")?),None=>None};let decision=if retry.get(&p).is_some_and(|expected|*expected==version){Decision::Upload}else{classify((meta.len(),time),version)};
  if decision!=Decision::Upload&&validation.shares_upload_check(){validate(&p,false)?;}
  if let Some(d)=&c.diagnostics{use crate::engine::sync_decisions::{Reason,Metadata};let m=Metadata::new(meta.len(),Some(time),version.map(|v|v.0),version.map(|v|v.1));d.compared(&p,m);match decision{Decision::Upload=>d.record(&p,Reason::Dispatch,m),Decision::Skip=>(),Decision::Retain=>d.record(&p,Reason::RetainedRemote,m)};}
  if decision==Decision::Upload{notify(&p,Event::Begin("upload"));let prepared=if validation.can_prepare_next(){validation.open_with_parents(root,&p,prepared_for_current)?}else if validation.shares_upload_check(){drop(prepared_for_current);validation.open_source(root,&p)?}else{drop(prepared_for_current);source(root,&p,&validate)?};
   let next=if validation.can_prepare_next()&&entry.is_none()&&meta.len()<102400{
    ready.peek().filter(|(next,is_dir)|!*is_dir&&!retry.contains_key(next)&&!inventory.entries.contains_key(next))
     .and_then(|(next,_)|std::fs::symlink_metadata(root.join(next)).ok().filter(|m|m.is_file()&&!m.file_type().is_symlink()&&m.len()<102400).map(|_|next.as_path()))
   }else{None};
   match upload(c,root,&remote,&p,entry,stop,&validate,prepared,next,&mut prepared_next)?{Transfer::Complete(n)=>notify(&p,Event::Uploaded(n)),Transfer::Changed{committed,expected}=>{if let Some(n)=committed{notify(&p,Event::Uploaded(n));}else if expected.is_none()&&entry.is_some(){notify(&p,Event::Deleted(false));}if let Some(d)=&c.diagnostics{d.record(&p,crate::engine::sync_decisions::Reason::SourceChanged,Default::default());}return Ok(Outcome::Rescan{relative:p,expected})}}}else{notify(&p,Event::Skipped);}
 }
 for p in deletions{let entry=inventory.entries[&p];let dir=entry.kind==Kind::Directory;notify(&p,Event::Begin("delete"));validate(&p,dir)?;if root.join(&p).try_exists().map_err(|_|"Local deletion state inaccessible")?{return Err("Local entry recreated; deletion deferred for rescan".into())}let _parents=crate::engine::compatible_deletion_parents(root,&p)?;crate::file_ops::check(stop)?;let t=target(&remote,&p)?;
  c.run(&AtomicBool::new(false),async{if dir{c.raw.rmdir(t).await.map_err(|_|"Sync RMDIR failed or outcome is uncertain; restart to reconcile")?;}else{c.raw.remove(t).await.map_err(|_|"Sync REMOVE failed or outcome is uncertain; restart to reconcile")?;}Ok(())})?;notify(&p,Event::Deleted(dir));
 }Ok(Outcome::Complete)
}
