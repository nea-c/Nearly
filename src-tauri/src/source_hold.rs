//! Windows synchronization input lifetime and post-transfer observations.
use std::{fs::File,path::Path};
#[cfg(test)]use std::sync::atomic::{AtomicUsize,Ordering};
#[cfg(test)]pub(crate)static OPENS:AtomicUsize=AtomicUsize::new(0);
#[cfg(test)]pub(crate)static OBSERVATIONS:AtomicUsize=AtomicUsize::new(0);
#[cfg(test)]pub(crate)static DELETE_BARRIERS:AtomicUsize=AtomicUsize::new(0);
// The reviewed Windows synchronization policy is active in ordinary builds.
// Path/root admission is performed by the existing Engine/source validation.
pub(crate)fn enabled(_host:&str,_root:&Path)->Result<bool,String>{Ok(cfg!(windows))}
pub(crate)fn opened(){#[cfg(test)]OPENS.fetch_add(1,Ordering::Relaxed);}
pub(crate)fn changed(snapshot:&crate::source_change::Snapshot,input:&File,bytes:u64,validate:&dyn Fn(&Path,bool)->Result<(),String>)->Result<bool,String>{
 // Keep the original fresh root veto. Already granted input access is not a
 // fresh pathname/parent ACL authorization; that distinction is intentional.
 if validate(Path::new(""),true).is_err(){return Ok(true)}
 #[cfg(test)]OBSERVATIONS.fetch_add(1,Ordering::Relaxed);
 Ok(snapshot.changed_opened(input,bytes)?.is_some())
}
pub(crate)fn before_delete(root:&Path,scope:&Path,stop:&std::sync::atomic::AtomicBool,rules:&crate::exclusion::Rules,recursive:bool,validate:&dyn Fn(&Path,bool)->Result<(),String>)->Result<(),String>{
 #[cfg(test)]DELETE_BARRIERS.fetch_add(1,Ordering::Relaxed);
 crate::file_ops::check(stop)?;
 if scope.components().any(|p|!matches!(p,std::path::Component::Normal(_))){return Err("Invalid pre-delete local scope".into())}
 validate(Path::new(""),true)?;
 // A removed dirty directory is a legitimate deletion scope. Its surviving
 // root must be read freshly; never equate a missing scope with failed listing.
 let scan_scope=if scope.as_os_str().is_empty(){scope}else{match std::fs::symlink_metadata(root.join(scope)){
  Ok(m)if m.is_dir()=>scope,
  Err(e)if e.kind()==std::io::ErrorKind::NotFound=>Path::new(""),
  _=>return Err("Pre-delete local scope changed or inaccessible; deletion refused".into())
 }};
 crate::initial_scan::walk_scoped(root,scan_scope,stop,rules,recursive,|_,_|Ok(())).map_err(|e|format!("Pre-delete local verification failed; deletion refused: {}",e.reason))?;
 validate(Path::new(""),true)
}
#[cfg(all(test,windows))]#[path="held_source_unit_tests.rs"]mod tests;
