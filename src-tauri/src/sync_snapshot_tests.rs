use super::*;
fn concurrent_paths(f:&Fixture)->Vec<PathBuf>{
 (0..8).map(|i|{let p=PathBuf::from(format!("dir{i}/file{i}.txt"));let target=f.remote.join("upload/job").join(&p);fs::create_dir_all(target.parent().unwrap()).unwrap();fs::write(&target,b"generated").unwrap();p}).collect()
}
#[test]fn directory_comparison_overlaps_independent_guards_with_bounded_server_cap(){
 for(mode,cap)in[("compare-snapshot-concurrent",4u64),("compare-snapshot-concurrent-one",1),("compare-snapshot-concurrent-two",2)]{
  let f=Fixture::start(mode);let paths=concurrent_paths(&f);let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
  let snapshot=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,1,&stop).unwrap().unwrap();assert_eq!(snapshot.hints.len(),8);assert_eq!(snapshot.directories,8);assert!(snapshot.missing.is_empty());
  let metrics=f.metrics();let active=metrics["maxInflight"].as_u64().unwrap();if cap>1{assert!(active>1,"independent directory guards must overlap: {metrics}");}assert!(active<=cap,"server/request bound: {metrics}");assert_eq!(metrics["authenticated"],1);assert!(metrics["maxOpenDirectoryHandles"].as_u64().unwrap()<=cap);assert_eq!(metrics["openDirectoryHandles"],0);
  for op in["WRITE","REMOVE","RMDIR","RENAME","OPEN","MKDIR"]{assert!(metrics["counts"][op].is_null(),"{op}: {metrics}");}
  if cap<4{assert_eq!(metrics["counts"]["EXTENDED"],1,"read-only limits negotiation");}else{assert!(metrics["counts"]["EXTENDED"].is_null());}
 }
}
#[test]fn directory_comparison_discards_all_peers_on_partial_ambiguous_or_mutated_listing(){
 for mode in["compare-snapshot-concurrent-unavailable","compare-snapshot-concurrent-partial","compare-snapshot-concurrent-parent","compare-snapshot-concurrent-close-last","compare-snapshot-concurrent-budget"]{
  let f=Fixture::start(mode);let paths=concurrent_paths(&f);let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();let result=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,1,&stop);
  if mode.ends_with("-unavailable")||mode.ends_with("-budget"){assert!(result.unwrap().is_none(),"whole-pass fallback");}else{assert!(result.is_err(),"whole-pass error");}
  let mut metrics=f.metrics();let deadline=Instant::now()+Duration::from_secs(1);let mut attempt=0;while metrics["openDirectoryHandles"]!=0{assert!(Instant::now()<deadline,"read handles must settle or disconnect: {metrics}");attempt+=1;thread::sleep(Duration::from_millis(10));metrics=f.metrics_for(&format!("settled{attempt}"));}
  assert!(metrics["maxOpenDirectoryHandles"].as_u64().unwrap()<=4);assert!(metrics["maxInflight"].as_u64().unwrap()<=4);for op in["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(metrics["counts"][op].is_null());}
 }
}
#[test]fn directory_comparison_cancellation_in_serial_and_concurrent_passes_publishes_nothing(){
 for first_missing in [false,true]{
 use std::sync::{Arc,atomic::Ordering};
 let f=Fixture::start("compare-snapshot-concurrent-cancel");let mut paths=concurrent_paths(&f);if first_missing{paths.push(PathBuf::from("a-uncreated/file.txt"));}let stop=Arc::new(AtomicBool::new(false));let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();let signal=stop.clone();let held=f.root.join("server/concurrent-list-held");
 let cancel=thread::spawn(move||{let deadline=Instant::now()+Duration::from_secs(10);while !held.exists(){assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(2));}let start=Instant::now();signal.store(true,Ordering::SeqCst);start});
 assert!(crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,1,&stop).is_err());assert!(cancel.join().unwrap().elapsed()<Duration::from_secs(1));
 }
}
use std::sync::atomic::AtomicBool;
fn caught(e:&Engine,id:&str,sent:u64){let start=Instant::now();loop{let s=e.status(id).unwrap();assert!(s.failure.is_none(),"{:?}",s.logs);if s.sent>=sent&&serde_json::to_value(&s).unwrap()["syncPhase"]=="caught_up"{return;}assert!(start.elapsed()<Duration::from_secs(20),"{:?}",s.logs);thread::sleep(Duration::from_millis(5));}}
fn paths()->Vec<PathBuf>{(0..8).map(|i|PathBuf::from(format!("nested/file{i}.txt"))).collect()}
#[test]
fn initial_comparison_lists_only_requested_parent_once_without_mutation_authority(){
 let f=Fixture::start("compare-snapshot-good");stable_comparison_candidates(&f);let stop=AtomicBool::new(false);
 let(mut connection,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let snapshot=crate::sftp::comparison_snapshot(&mut connection,"/upload/job",&paths(),1,&stop).unwrap().unwrap();
 assert_eq!(snapshot.directories,1);assert_eq!(snapshot.hints.len(),8);assert!(snapshot.missing.is_empty());
 let root=f.root.join("local").canonicalize().unwrap();for(path,hint)in snapshot.hints{assert_eq!(crate::sftp::listing_candidate(&root,&path,&hint,1,&stop).unwrap(),crate::listing_hint::Candidate::ListedUnchanged);assert_eq!(crate::sftp::listing_candidate(&root,&path,&hint,2,&stop).unwrap(),crate::listing_hint::Candidate::FreshComparison);}
 let m=f.metrics();assert_eq!(m["counts"]["OPENDIR"],1);assert_eq!(m["counts"]["LSTAT"],8,"two fresh strict walks of four ancestors; no separate existence walk");assert_eq!(m["counts"]["REALPATH"],2);
 for op in ["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(m["counts"][op].is_null());}
 assert!(crate::sftp::comparison_snapshot(&mut connection,"/upload/job",&vec![PathBuf::from("nested/file0.txt");10001],1,&stop).unwrap().is_none());
 assert!(crate::sftp::comparison_snapshot(&mut connection,"/upload/job",&["../escape".into()],1,&stop).is_err());
}
#[test]
fn comparison_pass_is_not_reused_after_restart_or_remote_file_change_and_absence(){
 let f=Fixture::start("compare-snapshot-restart");stable_comparison_candidates(&f);let e=Engine::default();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);caught(&e,"listing",0);assert_eq!(e.status("listing").unwrap().sent,0);e.stop("listing").unwrap();
 fs::write(f.remote.join("upload/job/nested/file0.txt"),b"external different metadata").unwrap();fs::remove_file(f.remote.join("upload/job/nested/file1.txt")).unwrap();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);let conflict=f.wait_failed(&e,"listing");assert_eq!(conflict["failure"]["operation"],"conflict");assert_eq!(conflict["sent"],0);assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(),b"external different metadata");e.stop("listing").unwrap();
 // Explicitly resolve toward a newer local source; a fresh pass must also
 // detect the independently missing remote peer rather than reuse old hints.
 let newer=fs::metadata(f.remote.join("upload/job/nested/file0.txt")).unwrap().modified().unwrap()+Duration::from_secs(40);
 fs::File::options().write(true).open(f.root.join("local/nested/file0.txt")).unwrap().set_times(fs::FileTimes::new().set_modified(newer)).unwrap();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);caught(&e,"listing",2);assert_eq!(e.status("listing").unwrap().sent,2);for i in 0..8{assert_eq!(fs::read(f.remote.join(format!("upload/job/nested/file{i}.txt"))).unwrap(),b"stable");}e.stop("listing").unwrap();
 // A new same-name file/directory type cannot inherit the previous pass's hint.
 fs::remove_file(f.remote.join("upload/job/nested/file2.txt")).unwrap();fs::create_dir(f.remote.join("upload/job/nested/file2.txt")).unwrap();
 f.start_job(&e,"listing",f.root.join("local"),"/upload/job",false);let s=f.wait_failed(&e,"listing");assert_eq!(s["sent"],0);assert!(f.remote.join("upload/job/nested/file2.txt").is_dir());e.stop("listing").unwrap();
}
#[test]
fn incomplete_listing_and_changed_parent_or_entry_type_publish_no_skip_or_write(){
 for mode in ["compare-snapshot-partial","compare-snapshot-parent","compare-snapshot-entry-type"]{
  let f=Fixture::start(mode);stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"bad-list",f.root.join("local"),"/upload/job",false);
  let s=f.wait_failed(&e,"bad-list");assert_eq!(s["sent"],0);assert!(!s["logs"].as_array().unwrap().iter().any(|s|s.as_str().unwrap().starts_with("Skipped unchanged")));
  let m=f.metrics();for op in ["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(m["counts"][op].is_null(),"{mode}: {op}");}e.stop("bad-list").unwrap();
 }
}
#[test]
fn comparison_listing_cancel_does_not_publish_cached_skips_or_mutate(){
 let f=Fixture::start("compare-snapshot-cancel");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"cancel-list",f.root.join("local"),"/upload/job",false);
 let start=Instant::now();while !f.root.join("server/listing-held").exists(){assert!(start.elapsed()<Duration::from_secs(10));thread::sleep(Duration::from_millis(5));}
 let start=Instant::now();e.stop("cancel-list").unwrap();assert!(start.elapsed()<Duration::from_secs(1));
 let m=f.metrics();for op in ["WRITE","REMOVE","RMDIR","EXTENDED"]{assert!(m["counts"][op].is_null());}
}
#[test]
fn ambiguous_listing_discards_the_entire_pass_and_uses_fresh_comparison(){
 let f=Fixture::start("compare-snapshot-duplicate");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"duplicate",f.root.join("local"),"/upload/job",false);caught(&e,"duplicate",0);
 let m=f.metrics();assert!(m["counts"]["LSTAT"].as_u64().unwrap()>=64,"fallback must actually recompare files");assert!(m["counts"]["WRITE"].is_null());e.stop("duplicate").unwrap();
}
#[test]
fn external_target_type_change_after_comparison_is_checked_before_staging(){
 let f=Fixture::start("compare-snapshot-target-race");changed_worker_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"target-race",f.root.join("local"),"/upload/job",false);
 let s=f.wait_failed(&e,"target-race");assert_eq!(s["failure"]["operation"],"conflict");assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(),b"stable");e.stop("target-race").unwrap();
}
#[test]
fn actual_junction_ancestor_is_refused_without_listing_or_querying_its_descendants(){
 let f=Fixture::start("compare-snapshot-junction");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"junction",f.root.join("local"),"/upload/job",false);let s=f.wait_failed(&e,"junction");assert_eq!(s["sent"],0);
 assert!(f.root.join("server/junction-ready").exists());assert!(!f.root.join("server/escape-query").exists());assert_eq!(fs::read(f.remote.join("other/escape/sentinel.txt")).unwrap(),b"generated outside-selected-root sentinel");let m=f.metrics();assert!(m["counts"]["OPENDIR"].is_null());assert!(m["counts"]["WRITE"].is_null());e.stop("junction").unwrap();
}
#[test]
fn optional_listing_denial_falls_back_to_original_file_access_without_inventing_absence(){
 let f=Fixture::start("compare-snapshot-unavailable");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"no-list",f.root.join("local"),"/upload/job",false);caught(&e,"no-list",0);
 assert!(e.status("no-list").unwrap().logs.iter().any(|l|l.contains("using fresh per-file comparison")));assert!(f.metrics()["counts"]["WRITE"].is_null());e.stop("no-list").unwrap();
 fs::write(f.root.join("local/nested/file0.txt"),b"new local content with listing denied").unwrap();f.start_job(&e,"no-list",f.root.join("local"),"/upload/job",false);caught(&e,"no-list",1);assert_eq!(e.status("no-list").unwrap().sent,1);assert_eq!(fs::read(f.remote.join("upload/job/nested/file0.txt")).unwrap(),b"new local content with listing denied");e.stop("no-list").unwrap();
}
#[test]
fn optional_snapshot_depth_bound_falls_back_without_rejecting_64_directory_source_paths(){
 let f=Fixture::start("compare-snapshot-depth");let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
 let mut deep=PathBuf::new();for _ in 0..64{deep.push("d");}deep.push("file.txt");
 assert!(crate::sftp::comparison_snapshot(&mut c,"/upload/job",&[deep],1,&stop).unwrap().is_none(),"optional listing limit must fall back; initial_scan permits64 directories plus a filename");
}
#[test]
fn omitted_readdir_attributes_require_fresh_file_checks_and_cannot_hide_a_directory(){
 let f=Fixture::start("compare-snapshot-attrs-unknown");stable_comparison_candidates(&f);let e=Engine::default();f.start_job(&e,"unknown-attrs",f.root.join("local"),"/upload/job",false);caught(&e,"unknown-attrs",0);
 let m=f.metrics();assert!(m["counts"]["LSTAT"].as_u64().unwrap()>=64);assert!(m["counts"]["WRITE"].is_null());e.stop("unknown-attrs").unwrap();
 fs::remove_file(f.remote.join("upload/job/nested/file0.txt")).unwrap();fs::create_dir(f.remote.join("upload/job/nested/file0.txt")).unwrap();f.start_job(&e,"unknown-attrs",f.root.join("local"),"/upload/job",false);let s=f.wait_failed(&e,"unknown-attrs");assert_eq!(s["sent"],0);assert!(f.remote.join("upload/job/nested/file0.txt").is_dir());e.stop("unknown-attrs").unwrap();
}

#[test]
fn combined_comparison_walk_distinguishes_missing_descendant_from_lost_root_and_never_caches_across_passes(){
 for absent in ["nested","root","above-root"]{
  let f=Fixture::start("compare-snapshot-walk-missing");stable_comparison_candidates(&f);
  let target=f.remote.join(match absent{"nested"=>"upload/job/nested","root"=>"upload/job",_=>"upload"});
  let saved=f.remote.join("generated-saved");fs::rename(&target,&saved).unwrap();
  let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
  let result=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths(),1,&stop);
  if absent=="nested"{let snapshot=result.unwrap().unwrap();assert_eq!(snapshot.missing.len(),8);assert_eq!(snapshot.directories,0);assert!(snapshot.hints.is_empty());}
  else{assert!(matches!(result,Err(ref error) if error.contains("root disappeared")));}
  let before=f.metrics_for("missing");assert!(before["counts"]["OPENDIR"].is_null());assert!(before["counts"]["REALPATH"].is_null());
  fs::rename(&saved,&target).unwrap();
  // A fatal lost-root error intentionally closes the transport. Only the
  // successful descendant-missing case may reuse the existing connection.
  if absent!="nested"{c=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap().0;}
  let snapshot=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths(),2,&stop).unwrap().unwrap();assert_eq!(snapshot.hints.len(),8);assert!(snapshot.missing.is_empty());
  let after=f.metrics_for("restored");for op in ["WRITE","REMOVE","RMDIR","RENAME","EXTENDED"]{assert!(after["counts"][op].is_null());}
 }
}

#[test]
fn combined_comparison_walk_refuses_errors_types_canonical_alias_and_post_listing_permission_change(){
 for mode in ["compare-snapshot-walk-denied","compare-snapshot-walk-server-error","compare-snapshot-walk-unknown","compare-snapshot-walk-canonical-before","compare-snapshot-walk-canonical-after","compare-snapshot-walk-post-permissions","compare-snapshot-walk-file"]{
  let f=Fixture::start(mode);stable_comparison_candidates(&f);
  if mode.ends_with("-file"){fs::rename(f.remote.join("upload/job/nested"),f.remote.join("generated-saved")).unwrap();fs::write(f.remote.join("upload/job/nested"),b"not a directory").unwrap();}
  let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
  assert!(crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths(),1,&stop).is_err(),"{mode}: never report denied/unsafe as missing or fallback");
  let metrics=f.metrics();for op in ["WRITE","REMOVE","RMDIR","RENAME","EXTENDED"]{assert!(metrics["counts"][op].is_null(),"{mode}/{op}");}
  if !mode.ends_with("-after")&&!mode.ends_with("-permissions"){assert!(metrics["counts"]["OPENDIR"].is_null(),"{mode}: no listing after failed first guard");}
  else{assert_eq!(metrics["counts"]["OPENDIR"],1,"{mode}: reject the changed post-list guard");}
 }
}

#[test]
fn combined_comparison_walk_cancel_is_prompt_and_publishes_no_snapshot(){
 use std::sync::{Arc,atomic::Ordering};
 let f=Fixture::start("compare-snapshot-walk-cancel");stable_comparison_candidates(&f);let stop=Arc::new(AtomicBool::new(false));
 let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();let signal=stop.clone();let held=f.root.join("server/walk-held");
 let cancel=thread::spawn(move||{let deadline=Instant::now()+Duration::from_secs(10);while !held.exists(){assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(2));}let started=Instant::now();signal.store(true,Ordering::SeqCst);started});
 assert!(crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths(),1,&stop).is_err());assert!(cancel.join().unwrap().elapsed()<Duration::from_secs(1));
 let metrics=f.metrics();for op in ["OPENDIR","WRITE","REMOVE","RMDIR","RENAME","EXTENDED"]{assert!(metrics["counts"][op].is_null());}
}

#[test]
fn directory_comparison_missing_first_parent_avoids_speculative_duplicate_walks(){
 let f=Fixture::start("compare-snapshot-concurrent");let paths:Vec<_>=(0..8).map(|i|PathBuf::from(format!("uncreated/sub{i}/file{i}.txt"))).collect();let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();let snapshot=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,1,&stop).unwrap().unwrap();assert_eq!(snapshot.missing.len(),8);assert!(snapshot.hints.is_empty());assert_eq!(snapshot.directories,0);let m=f.metrics();assert_eq!(m["maxInflight"],1,"first missing parent should keep this pass serial");assert_eq!(m["counts"]["LSTAT"],4,"fresh ancestor walk once, then original pass-local missing-parent cache");assert!(m["counts"]["OPENDIR"].is_null());
}

#[test]
fn adaptive_directory_choice_does_not_classify_other_parents_or_survive_a_pass(){
 for first_missing in [false,true]{
  let f=Fixture::start("compare-snapshot-concurrent");let existing=PathBuf::from(if first_missing{"z-existing/sub/file.txt"}else{"a-existing/sub/file.txt"});let missing=PathBuf::from(if first_missing{"a-missing/sub/file.txt"}else{"z-missing/sub/file.txt"});let target=f.remote.join("upload/job").join(&existing);fs::create_dir_all(target.parent().unwrap()).unwrap();fs::write(&target,b"generated").unwrap();let paths=vec![existing.clone(),missing.clone()];let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();
  let a=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,1,&stop).unwrap().unwrap();assert!(a.hints.contains_key(&existing));assert_eq!(a.missing,vec![missing.clone()]);assert_eq!(a.directories,1);
  fs::remove_file(&target).unwrap();let created=f.remote.join("upload/job").join(&missing);fs::create_dir_all(created.parent().unwrap()).unwrap();fs::write(created,b"newly present").unwrap();
  let b=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,2,&stop).unwrap().unwrap();assert!(b.hints.contains_key(&missing));assert!(!b.hints.contains_key(&existing));assert_eq!(b.missing,vec![existing.clone()]);assert_eq!(b.directories,2);drop(c);
  let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();let r=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,3,&stop).unwrap().unwrap();assert!(r.hints.contains_key(&missing));assert_eq!(r.missing,vec![existing]);assert_eq!(f.metrics()["connections"],2);
 }
}
#[test]
fn missing_first_parent_does_not_hide_later_partial_or_symlink_listing_errors(){
 for mode in ["compare-snapshot-concurrent-unavailable","compare-snapshot-concurrent-partial","compare-snapshot-concurrent-parent"]{
  let f=Fixture::start(mode);let all=concurrent_paths(&f);let paths=vec![PathBuf::from("a-uncreated/sub/file.txt"),all[3].clone()];let stop=AtomicBool::new(false);let(mut c,_)=crate::sftp::connect(&f.profile,&f.secret,&stop).unwrap();let r=crate::sftp::comparison_snapshot(&mut c,"/upload/job",&paths,1,&stop);if mode.ends_with("unavailable"){assert!(r.unwrap().is_none());}else{assert!(r.is_err());}
 }
}
